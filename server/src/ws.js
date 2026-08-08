import { WebSocketServer } from 'ws'
import { userFromToken, touchLastSeen } from './auth.js'
import { audit } from './audit.js'
import { createTokenBucket } from './rateLimiter.js'
import {
  addMessage,
  isMember,
  membersOf,
  editMessage,
  deleteMessage,
  markRead,
  toggleReaction,
  forwardMessage,
  pinMessage,
  getChatForViewer,
  otherDirectMemberId,
} from './chats.js'
import { isBlockedEitherWay } from './blocking.js'
import {
  answerCall,
  configureCallRuntime,
  finishCall,
  getCall,
  isParticipant,
  peerSocketsFor,
  registerCall,
  releaseSocket,
  userBusy,
} from './calls.js'

const MAX_TEXT_LENGTH = 4000
const HEARTBEAT_INTERVAL_MS = 30000
const MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'file'])
const SESSION_COOKIE = 'connecto_session'
/** Кадр крупнее этого браузер никогда не отправит осмысленно (SDP с кучей кандидатов — пара КБ). */
const WS_MAX_PAYLOAD_BYTES = 128 * 1024
/** Сверх этого числа "провалов" лимита за сессию — соединение явно флудит, а не просто торопится. */
const RATE_LIMIT_VIOLATIONS_BEFORE_KICK = 60

const connections = new Map()
/** Ограничивает число одновременных вкладок/устройств одного пользователя — не про удобство, а про то, чтобы один аккаунт не мог открыть тысячи сокетов. */
const MAX_SOCKETS_PER_USER = 12

function sessionTokenFromCookie(header = '') {
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function websocketOriginAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const originUrl = new URL(origin)
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
    const requestHost = forwardedHost || req.headers.host
    if (originUrl.host === requestHost) return true
    const configured = [process.env.APP_ORIGIN, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')].map((value) => value?.trim()).filter(Boolean)
    if (configured.includes(origin)) return true
    return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(originUrl.hostname)
  } catch {
    return false
  }
}

export function isOnline(userId) {
  return connections.has(userId) && connections.get(userId).size > 0
}

export function disconnectSession(token) {
  if (!token) return
  for (const sockets of connections.values()) {
    for (const ws of sockets) {
      if (ws.authToken === token) ws.close(4001, 'Session ended')
    }
  }
}

export function disconnectUser(userId) {
  for (const ws of connections.get(userId) ?? []) ws.close(4001, 'Sessions revoked')
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function broadcastToUsers(userIds, payload) {
  for (const userId of userIds) {
    const sockets = connections.get(userId)
    if (!sockets) continue
    for (const ws of sockets) send(ws, payload)
  }
}

async function notifyChatChanged(chatId, eventType) {
  const userIds = await membersOf(chatId)
  await Promise.all(
    userIds.map(async (userId) => {
      const chat = await getChatForViewer(chatId, userId)
      chat.members = chat.members.map((member) => ({ ...member, online: isOnline(member.id) }))
      broadcastToUsers([userId], { type: eventType, chat })
    }),
  )
}

export function notifyChatCreated(chatId) {
  return notifyChatChanged(chatId, 'chat_created')
}

export function notifyChatUpdated(chatId) {
  return notifyChatChanged(chatId, 'chat_updated')
}

export function notifyChatLeft(userId, chatId) {
  broadcastToUsers([userId], { type: 'chat_left', chatId })
}

function broadcastPresence(userId, online) {
  const allConnectedUsers = [...connections.keys()]
  broadcastToUsers(allConnectedUsers, { type: 'presence', userId, online })
}

configureCallRuntime({
  sendTo(sockets, payload) {
    for (const ws of sockets) send(ws, payload)
  },
  async onCallMessage(chatId, message) {
    broadcastToUsers(await membersOf(chatId), { type: 'message', message })
  },
})

export function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: WS_MAX_PAYLOAD_BYTES })
  wss.on('error', (err) => audit('socket.server_error', { message: err?.message }))

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  wss.on('close', () => clearInterval(heartbeat))

  wss.on('connection', async (ws, req) => {
    // Ставим обработчик 'error' раньше любого await: без него превышение maxPayload
    // (и любая другая ошибка протокола) — неперехваченное событие, валящее весь
    // процесс Node. Один клиент с кадром больше лимита мог положить сервер целиком.
    let auditActor = null
    ws.on('error', (err) => {
      audit('socket.error', { userId: auditActor?.id, username: auditActor?.username, message: err?.message })
    })

    if (!websocketOriginAllowed(req)) {
      ws.close(4003, 'Forbidden')
      return
    }
    const token = sessionTokenFromCookie(req.headers.cookie)
    const user = await userFromToken(token)

    if (!user) {
      ws.close(4001, 'Unauthorized')
      return
    }
    auditActor = user

    ws.isAlive = true
    ws.authToken = token
    // Общий лимит на все события WS плюс отдельный, более строгий — на сами
    // сообщения чата (самая тяжёлая и заметная жертвам операция: запись в БД + рассылка).
    const generalLimiter = createTokenBucket({ capacity: 30, refillPerSec: 6 })
    const sendLimiter = createTokenBucket({ capacity: 6, refillPerSec: 1.5 })
    let rateLimitViolations = 0
    ws.on('pong', () => {
      ws.isAlive = true
    })

    if (!connections.has(user.id)) connections.set(user.id, new Set())
    const userSockets = connections.get(user.id)
    if (userSockets.size >= MAX_SOCKETS_PER_USER) {
      const oldest = userSockets.values().next().value
      userSockets.delete(oldest)
      oldest?.close(4008, 'Too many connections')
    }
    const wasOffline = userSockets.size === 0
    userSockets.add(ws)
    if (wasOffline) broadcastPresence(user.id, true)
    audit('socket.connected', { userId: user.id, username: user.username })

    ws.on('message', async (raw) => {
      let data
      try {
        data = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (!generalLimiter.take()) {
        rateLimitViolations++
        if (rateLimitViolations > RATE_LIMIT_VIOLATIONS_BEFORE_KICK) {
          audit('socket.rate_limited', { userId: user.id, username: user.username })
          ws.close(4008, 'Rate limit exceeded')
        }
        return
      }
      // Спам-сообщения в чат режем молча: собеседники не должны видеть ни самих
      // сообщений, ни служебных ошибок из-за чужого флуда.
      if (data.type === 'send' && !sendLimiter.take()) return

      try {
        if (data.type === 'send') {
          const chatId = Number(data.chatId)
          const text = String(data.text || '').trim().slice(0, MAX_TEXT_LENGTH)
          const attachmentUrl = data.attachmentUrl ? String(data.attachmentUrl) : null
          const requestedType = String(data.messageType || '')
          const messageType = attachmentUrl && MESSAGE_TYPES.has(requestedType) ? requestedType : attachmentUrl ? 'file' : 'text'
          const rawAttachment = data.attachment && typeof data.attachment === 'object' ? data.attachment : null
          const attachment = attachmentUrl && rawAttachment ? {
            name: String(rawAttachment.name || 'Файл').slice(0, 255),
            mimeType: String(rawAttachment.mimeType || 'application/octet-stream').slice(0, 120),
            size: Math.max(0, Math.min(Number(rawAttachment.size) || 0, 25 * 1024 * 1024)),
            duration: Math.max(0, Math.min(Number(rawAttachment.duration) || 0, 60 * 60)),
          } : null
          const replyToId = data.replyToId ? Number(data.replyToId) : null
          if (!chatId || (!text && !attachmentUrl)) return
          if (!(await isMember(chatId, user.id))) return
          const otherId = await otherDirectMemberId(chatId, user.id)
          if (otherId && (await isBlockedEitherWay(user.id, otherId))) {
            send(ws, { type: 'error', message: 'Сообщение не доставлено: переписка недоступна' })
            return
          }
          const message = await addMessage(chatId, user.id, {
            type: messageType,
            text,
            attachmentUrl,
            attachment,
            replyToId,
          })
          broadcastToUsers(await membersOf(chatId), { type: 'message', message })
          audit('message.sent', { userId: user.id, username: user.username, chatId, messageId: message.id, messageType, hasAttachment: Boolean(attachmentUrl) })
          return
        }

        if (data.type === 'edit') {
          const messageId = Number(data.messageId)
          const text = String(data.text || '').trim().slice(0, MAX_TEXT_LENGTH)
          if (!messageId || !text) return
          const updated = await editMessage(messageId, user.id, text)
          if (!updated) return
          broadcastToUsers(await membersOf(updated.chatId), { type: 'message_edited', message: updated })
          audit('message.edited', { userId: user.id, username: user.username, chatId: updated.chatId, messageId })
          return
        }

        if (data.type === 'delete') {
          const messageId = Number(data.messageId)
          if (!messageId) return
          const result = await deleteMessage(messageId, user.id)
          if (!result) return
          broadcastToUsers(await membersOf(result.chatId), {
            type: 'message_deleted',
            chatId: result.chatId,
            messageId: result.messageId,
            lastMessage: result.lastMessage,
          })
          audit('message.deleted', { userId: user.id, username: user.username, chatId: result.chatId, messageId: result.messageId })
          return
        }

        if (data.type === 'typing') {
          const chatId = Number(data.chatId)
          if (!chatId || !(await isMember(chatId, user.id))) return
          const members = (await membersOf(chatId)).filter((id) => id !== user.id)
          broadcastToUsers(members, { type: 'typing', chatId, userId: user.id })
          return
        }

        if (data.type === 'read') {
          const chatId = Number(data.chatId)
          const messageId = Number(data.messageId)
          if (!chatId || !messageId || !(await isMember(chatId, user.id))) return
          await markRead(chatId, user.id, messageId)
          const members = (await membersOf(chatId)).filter((id) => id !== user.id)
          broadcastToUsers(members, { type: 'read', chatId, userId: user.id, messageId })
          return
        }

        if (data.type === 'react') {
          const messageId = Number(data.messageId)
          const emoji = String(data.emoji || '')
          if (!messageId || !emoji) return
          const result = await toggleReaction(messageId, user.id, emoji)
          if (!result) return
          broadcastToUsers(await membersOf(result.chatId), {
            type: 'reactions',
            messageId: result.messageId,
            reactions: result.reactions,
          })
          audit('message.reaction', { userId: user.id, username: user.username, chatId: result.chatId, messageId: result.messageId })
          return
        }

        if (data.type === 'forward') {
          const sourceMessageId = Number(data.sourceMessageId)
          const targetChatId = Number(data.targetChatId)
          if (!sourceMessageId || !targetChatId) return
          const message = await forwardMessage(user.id, sourceMessageId, targetChatId)
          broadcastToUsers(await membersOf(targetChatId), { type: 'message', message })
          audit('message.forwarded', { userId: user.id, username: user.username, sourceMessageId, targetChatId, messageId: message.id })
          return
        }

        if (data.type === 'pin') {
          const chatId = Number(data.chatId)
          const messageId = data.messageId ? Number(data.messageId) : null
          if (!chatId) return
          await pinMessage(chatId, user.id, messageId)
          broadcastToUsers(await membersOf(chatId), { type: 'pinned', chatId, messageId })
          audit('message.pinned', { userId: user.id, username: user.username, chatId, messageId, unpinned: !messageId })
          return
        }

        if (data.type === 'call_invite') {
          const targetUserId = Number(data.targetUserId)
          const chatId = Number(data.chatId)
          const callId = String(data.callId || '')
          const refuse = (reason) => send(ws, { type: 'call_end', callId: callId || 'invalid', fromUserId: targetUserId || 0, reason })
          if (!targetUserId || !chatId || !callId || !data.sdp || getCall(callId)) return refuse('invalid')
          if (targetUserId === user.id) return refuse('invalid')
          if (!(await isMember(chatId, user.id)) || !(await isMember(chatId, targetUserId))) return refuse('not_member')
          if (await isBlockedEitherWay(user.id, targetUserId)) return refuse('not_member')
          if (!isOnline(targetUserId)) return refuse('unavailable')
          if (userBusy(user.id)) return refuse('already_in_call')
          if (userBusy(targetUserId)) return refuse('busy')

          const calleeSockets = [...(connections.get(targetUserId) ?? [])]
          registerCall({
            callId,
            chatId,
            callerId: user.id,
            calleeId: targetUserId,
            video: Boolean(data.video),
            callerSocket: ws,
            calleeSockets,
          })
          for (const target of calleeSockets) {
            send(target, {
              type: 'call_invite',
              callId,
              chatId,
              fromUserId: user.id,
              video: Boolean(data.video),
              sdp: data.sdp,
            })
          }
          audit('call.started', { userId: user.id, username: user.username, chatId, targetUserId, video: Boolean(data.video) })
          return
        }

        if (data.type === 'call_answer') {
          const callId = String(data.callId || '')
          if (!callId || !data.sdp) return
          const call = answerCall(callId, user.id, ws)
          if (!call) return
          send(call.callerSocket, { type: 'call_answer', callId, fromUserId: user.id, sdp: data.sdp })
          audit('call.answered', { userId: user.id, username: user.username, chatId: call.chatId })
          return
        }

        if (data.type === 'call_ringing' || data.type === 'call_ice' || data.type === 'call_negotiate' || data.type === 'call_state') {
          const callId = String(data.callId || '')
          const call = getCall(callId)
          if (!callId || !isParticipant(call, user.id)) return
          const payload = { type: data.type, callId, fromUserId: user.id }
          if (data.type === 'call_ice') {
            if (!data.candidate) return
            payload.candidate = data.candidate
          } else if (data.type === 'call_negotiate') {
            if (!data.sdp) return
            payload.sdp = data.sdp
          } else if (data.type === 'call_state') {
            payload.state = {
              muted: Boolean(data.state?.muted),
              cameraOff: Boolean(data.state?.cameraOff),
              video: Boolean(data.state?.video),
              screenSharing: Boolean(data.state?.screenSharing),
            }
          }
          for (const target of peerSocketsFor(call, user.id)) send(target, payload)
          return
        }

        if (data.type === 'call_end') {
          const callId = String(data.callId || '')
          const call = getCall(callId)
          if (!callId || !isParticipant(call, user.id)) return
          await finishCall(callId, user.id, String(data.reason || 'hangup'))
          audit('call.ended', { userId: user.id, username: user.username, chatId: call.chatId, reason: String(data.reason || 'hangup').slice(0, 32) })
          return
        }
      } catch (err) {
        send(ws, { type: 'error', message: err.message })
      }
    })

    ws.on('close', async () => {
      await releaseSocket(ws, user.id)
      const sockets = connections.get(user.id)
      if (!sockets) return
      sockets.delete(ws)
      if (sockets.size === 0) {
        connections.delete(user.id)
        await touchLastSeen(user.id)
        broadcastPresence(user.id, false)
        audit('socket.disconnected', { userId: user.id, username: user.username })
      }
    })
  })

  return wss
}
