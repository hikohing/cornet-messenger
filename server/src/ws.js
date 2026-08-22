import { WebSocketServer } from 'ws'
import { userFromToken, touchLastSeen, touchSessionSeen, sessionTokenHash } from './auth.js'
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
  getMessageById,
  otherDirectMemberId,
  contactIdsForUser,
} from './chats.js'
import { assertPollAllowed, createPoll, votePoll, closePoll } from './polls.js'
import { isBlockedEitherWay } from './blocking.js'
import { NATIVE_ORIGINS } from './origins.js'
import { publicErrorMessage } from './errors.js'
import { configurePushRuntime, notifyIncomingCall, notifyNewMessage, voipDeviceCount } from './push.js'
import {
  answerCall,
  attachCalleeSocket,
  bufferSignal,
  configureCallRuntime,
  finishCall,
  getCall,
  isAwaitingWake,
  isParticipant,
  peerSocketsFor,
  registerCall,
  releaseSocket,
  userBusy,
} from './calls.js'

const MAX_TEXT_LENGTH = 4000
const HEARTBEAT_INTERVAL_MS = 30000
const MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'file'])

/** Ширина/высота кадра: целое в пределах здравого смысла, иначе — не сохраняем. */
function clampDimension(value) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.min(number, 20000)
}
/** События, каждое из которых заводит новое сообщение в чате — им положен строгий лимит. */
const MESSAGE_CREATING_TYPES = new Set(['send', 'forward', 'poll_create'])
const SESSION_COOKIE = 'connecto_session'
/** Кадр крупнее этого браузер никогда не отправит осмысленно (SDP с кучей кандидатов — пара КБ). */
const WS_MAX_PAYLOAD_BYTES = 128 * 1024
/** Сверх этого числа "провалов" лимита за сессию — соединение явно флудит, а не просто торопится. */
const RATE_LIMIT_VIOLATIONS_BEFORE_KICK = 60

const connections = new Map()
/** Ограничивает число одновременных вкладок/устройств одного пользователя — не про удобство, а про то, чтобы один аккаунт не мог открыть тысячи сокетов. */
const MAX_SOCKETS_PER_USER = 12

/**
 * Validates the shape of a client-supplied encrypted envelope without
 * inspecting its content — the server can't verify signatures (it has no
 * private keys) so this only guards against malformed/oversized junk before
 * it's persisted and relayed. Recipients verify authenticity themselves.
 */
function sanitizeSelfEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.ciphertext !== 'string' || raw.ciphertext.length < 1 || raw.ciphertext.length > 20000) return null
  if (typeof raw.iv !== 'string' || raw.iv.length < 1 || raw.iv.length > 64) return null
  if (typeof raw.ephemeralPublicKey !== 'object' || raw.ephemeralPublicKey === null) return null
  return { ciphertext: raw.ciphertext, iv: raw.iv, ephemeralPublicKey: raw.ephemeralPublicKey }
}

function sanitizeEncryptionEnvelope(raw, senderId) {
  if (raw.version !== 1) return null
  if (typeof raw.ciphertext !== 'string' || raw.ciphertext.length < 1 || raw.ciphertext.length > 20000) return null
  if (typeof raw.iv !== 'string' || raw.iv.length < 1 || raw.iv.length > 64) return null
  if (typeof raw.signature !== 'string' || raw.signature.length < 1 || raw.signature.length > 2048) return null
  if (raw.senderId !== senderId) return null

  const base = { version: 1, ciphertext: raw.ciphertext, iv: raw.iv, signature: raw.signature, senderId }

  // `self` is a convenience copy of the same plaintext encrypted to the
  // sender's own key (see src/crypto/session.ts) so they can read their own
  // sent history back after a reload — without it, only the recipient could
  // ever decrypt this message.
  if (raw.self !== undefined) {
    const self = sanitizeSelfEnvelope(raw.self)
    if (!self) return null
    base.self = self
  }

  // Групповое сообщение шифруется ключом поколения, а не одноразовым ECDH.
  // Номер поколения нужен получателю, чтобы понять, какой из своих ключей брать:
  // после ухода участника в одном чате сосуществуют сообщения разных поколений.
  if (raw.rotation !== undefined) {
    if (!Number.isInteger(raw.rotation) || raw.rotation < 1) return null
    base.rotation = raw.rotation
  }

  if (raw.ephemeralPublicKey !== undefined) {
    if (typeof raw.ephemeralPublicKey !== 'object' || raw.ephemeralPublicKey === null) return null
    return { ...base, ephemeralPublicKey: raw.ephemeralPublicKey }
  }

  return base
}

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

/**
 * Нативный клиент авторизуется не кукой, а токеном в subprotocol: браузерный
 * WebSocket API не позволяет задать заголовок Authorization, а куки домена API
 * из WebView со схемы capacitor:// не уходят. Клиент открывает сокет как
 * `new WebSocket(url, ['bearer', token])`, что приходит сюда одной строкой.
 */
function sessionTokenFromProtocol(header = '') {
  const parts = header.split(',').map((part) => part.trim())
  if (parts[0] !== 'bearer') return null
  return parts[1] || null
}

function websocketOriginAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (NATIVE_ORIGINS.has(origin)) return true
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

/**
 * Есть ли у конкретной сессии живой сокет. Пуши смотрят именно на сессию, а не
 * на пользователя: открытая вкладка на компьютере не повод молчать в телефон.
 */
export function isSessionOnline(sessionHash) {
  if (!sessionHash) return false
  for (const sockets of connections.values()) {
    for (const ws of sockets) {
      if (ws.sessionHash === sessionHash) return true
    }
  }
  return false
}

configurePushRuntime({ isSessionOnline })

export function disconnectSession(token) {
  if (!token) return
  for (const sockets of connections.values()) {
    for (const ws of sockets) {
      if (ws.authToken === token) ws.close(4001, 'Session ended')
    }
  }
}

/** Same as disconnectSession, but by the hashed session id — used when revoking a
 *  session we only know the hash of (e.g. from the "manage sessions" list, where the
 *  raw bearer token was never exposed to the viewer in the first place). */
export function disconnectSessionByHash(hash) {
  if (!hash) return
  for (const sockets of connections.values()) {
    for (const ws of sockets) {
      if (ws.sessionHash === hash) ws.close(4001, 'Session ended')
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

/**
 * Рассылает сообщение с опросом каждому участнику отдельно: отметка «мой
 * голос» и списки проголосовавших зависят от того, кто смотрит, поэтому одним
 * общим payload обойтись нельзя.
 */
async function broadcastPollMessage(chatId, messageId, eventType) {
  const members = await membersOf(chatId)
  await Promise.all(
    members.map(async (userId) => {
      const message = await getMessageById(messageId, userId)
      if (message) broadcastToUsers([userId], { type: eventType, message })
    }),
  )
}

/** Сообщает участникам, что сообщения исчезли по таймеру — их надо убрать из ленты. */
export async function notifyMessagesExpired(swept) {
  for (const { chatId, messageIds } of swept) {
    const members = await membersOf(chatId)
    broadcastToUsers(members, { type: 'messages_expired', chatId, messageIds })
    // Превью чата в списке слева тоже могло указывать на исчезнувшее сообщение.
    await notifyChatUpdated(chatId)
  }
}

/**
 * Присутствие видят только собеседники. Раньше событие уходило вообще всем, кто
 * в этот момент онлайн: посторонние узнавали распорядок дня незнакомых людей, а
 * заблокировавший — что его собеседник зашёл. Заодно это снимает рассылку
 * «каждому о каждом», которая росла квадратично от числа подключений.
 */
async function broadcastPresence(userId, online) {
  const contacts = await contactIdsForUser(userId)
  broadcastToUsers(contacts, { type: 'presence', userId, online })
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
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    // Подтверждаем subprotocol, иначе Safari/WKWebView рвёт соединение, когда
    // сервер не выбрал ни один из предложенных клиентом.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  })
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

    // Клиент считает соединение готовым по 'open', то есть сразу после
    // рукопожатия — а обработчик 'message' навешивается ниже, уже после
    // проверки токена в базе. Без паузы всё, что пришло в этом промежутке,
    // молча терялось. Возобновляем чтение, когда слушатели на месте.
    ws.pause()

    if (!websocketOriginAllowed(req)) {
      ws.close(4003, 'Forbidden')
      return
    }
    const token = sessionTokenFromCookie(req.headers.cookie) ?? sessionTokenFromProtocol(req.headers['sec-websocket-protocol'])
    const user = await userFromToken(token)

    if (!user) {
      ws.close(4001, 'Unauthorized')
      return
    }
    auditActor = user

    ws.isAlive = true
    ws.authToken = token
    ws.sessionHash = sessionTokenHash(token)
    void touchSessionSeen(token)
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
    if (wasOffline) await broadcastPresence(user.id, true)
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
      // сообщений, ни служебных ошибок из-за чужого флуда. Пересылка и опрос
      // тоже создают сообщение и тоже будят пуши у всех участников, поэтому
      // платят из того же ведра — иначе строгий лимит обходился бы в один клик.
      if (MESSAGE_CREATING_TYPES.has(data.type) && !sendLimiter.take()) return

      try {
        if (data.type === 'send') {
          const chatId = Number(data.chatId)
          // Encrypted envelopes carry no server-readable text: the server stores
          // and relays the ciphertext blob (encryptionData) without ever seeing
          // plaintext. `text` stays empty in the DB row for encrypted messages.
          const rawEncryption = data.encrypted && typeof data.encrypted === 'object' ? data.encrypted : null
          const encrypted = Boolean(rawEncryption)
          const encryptionData = encrypted ? sanitizeEncryptionEnvelope(rawEncryption, user.id) : null
          if (encrypted && !encryptionData) return
          const text = encrypted ? '' : String(data.text || '').trim().slice(0, MAX_TEXT_LENGTH)
          const attachmentUrl = data.attachmentUrl ? String(data.attachmentUrl) : null
          const requestedType = String(data.messageType || '')
          const messageType = attachmentUrl && MESSAGE_TYPES.has(requestedType) ? requestedType : attachmentUrl ? 'file' : 'text'
          const rawAttachment = data.attachment && typeof data.attachment === 'object' ? data.attachment : null
          const attachment = attachmentUrl && rawAttachment ? {
            name: String(rawAttachment.name || 'Файл').slice(0, 255),
            mimeType: String(rawAttachment.mimeType || 'application/octet-stream').slice(0, 120),
            size: Math.max(0, Math.min(Number(rawAttachment.size) || 0, 25 * 1024 * 1024)),
            duration: Math.max(0, Math.min(Number(rawAttachment.duration) || 0, 60 * 60)),
            // Размеры кадра приходят от клиента и нужны только для вёрстки —
            // зажимаем в разумный диапазон, чтобы кривое значение не ломало ленту.
            width: clampDimension(rawAttachment.width),
            height: clampDimension(rawAttachment.height),
          } : null
          const replyToId = data.replyToId ? Number(data.replyToId) : null
          if (!chatId || (!text && !attachmentUrl && !encrypted)) return
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
            encrypted,
            encryptionData,
          })
          broadcastToUsers(await membersOf(chatId), { type: 'message', message })
          // Без await: доставка пушей ходит в APNs и push-сервисы браузеров,
          // рассылка по сокетам не должна её ждать.
          void notifyNewMessage({ chatId, message, senderId: user.id, senderName: user.displayName || user.username })
            .catch((err) => audit('push.error', { userId: user.id, chatId, message: err?.message }))
          return
        }

        if (data.type === 'edit') {
          const messageId = Number(data.messageId)
          const rawEncryption = data.encrypted && typeof data.encrypted === 'object' ? data.encrypted : null
          const encryptionData = rawEncryption ? sanitizeEncryptionEnvelope(rawEncryption, user.id) : undefined
          if (rawEncryption && !encryptionData) return
          const text = encryptionData ? '' : String(data.text || '').trim().slice(0, MAX_TEXT_LENGTH)
          if (!messageId || (!text && !encryptionData)) return
          const updated = await editMessage(messageId, user.id, text, encryptionData)
          if (!updated) return
          broadcastToUsers(await membersOf(updated.chatId), { type: 'message_edited', message: updated })
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
          return
        }

        if (data.type === 'forward') {
          const sourceMessageId = Number(data.sourceMessageId)
          const targetChatId = Number(data.targetChatId)
          if (!sourceMessageId || !targetChatId) return
          const message = await forwardMessage(user.id, sourceMessageId, targetChatId)
          broadcastToUsers(await membersOf(targetChatId), { type: 'message', message })
          void notifyNewMessage({ chatId: targetChatId, message, senderId: user.id, senderName: user.displayName || user.username })
            .catch((err) => audit('push.error', { userId: user.id, chatId: targetChatId, message: err?.message }))
          return
        }

        if (data.type === 'poll_create') {
          const chatId = Number(data.chatId)
          if (!chatId) return
          await assertPollAllowed(chatId, user.id)
          const messageId = await createPoll(chatId, user.id, data.poll)
          await broadcastPollMessage(chatId, messageId, 'message')
          return
        }

        if (data.type === 'poll_vote') {
          const messageId = Number(data.messageId)
          const optionId = Number(data.optionId)
          if (!messageId || !optionId) return
          const chatId = await votePoll(messageId, user.id, optionId)
          await broadcastPollMessage(chatId, messageId, 'message_edited')
          return
        }

        if (data.type === 'poll_close') {
          const messageId = Number(data.messageId)
          if (!messageId) return
          const chatId = await closePoll(messageId, user.id)
          await broadcastPollMessage(chatId, messageId, 'message_edited')
          return
        }

        if (data.type === 'pin') {
          const chatId = Number(data.chatId)
          const messageId = data.messageId ? Number(data.messageId) : null
          if (!chatId) return
          await pinMessage(chatId, user.id, messageId)
          broadcastToUsers(await membersOf(chatId), { type: 'pinned', chatId, messageId })
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
          if (userBusy(user.id)) return refuse('already_in_call')
          if (userBusy(targetUserId)) return refuse('busy')

          const calleeSockets = [...(connections.get(targetUserId) ?? [])]
          // Приложение на телефоне может быть выгружено из памяти — его ещё
          // можно разбудить VoIP-пушем. Если будить нечего (собеседник только в
          // браузере), сразу говорим звонящему, что абонент недоступен.
          const wakeNeeded = calleeSockets.length === 0
          if (wakeNeeded && (await voipDeviceCount(targetUserId)) === 0) return refuse('unavailable')

          registerCall({
            callId,
            chatId,
            callerId: user.id,
            calleeId: targetUserId,
            video: Boolean(data.video),
            callerSocket: ws,
            calleeSockets,
            // Оффер придётся подержать: отдать его будет некому, пока устройство
            // не проснётся и не заберёт звонок сообщением call_claim.
            offer: wakeNeeded ? data.sdp : null,
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
          if (wakeNeeded) {
            const woken = await notifyIncomingCall({
              callId,
              chatId,
              callerId: user.id,
              callerName: user.displayName || user.username,
              calleeId: targetUserId,
              video: Boolean(data.video),
            })
            if (woken === 0) {
              await finishCall(callId, null, 'unavailable')
              return
            }
          }
          return
        }

        // Устройство, разбуженное VoIP-пушем, забирает звонок: до этого момента
        // сокета у него не было, и приглашение с оффером ждало на сервере.
        if (data.type === 'call_claim') {
          const callId = String(data.callId || '')
          const claimed = attachCalleeSocket(callId, user.id, ws)
          if (!claimed) {
            // Звонок успели отменить, принять на другом устройстве или он
            // просто протух — приложение должно убрать экран входящего.
            send(ws, { type: 'call_end', callId: callId || 'invalid', fromUserId: 0, reason: 'unavailable' })
            return
          }
          send(ws, {
            type: 'call_invite',
            callId,
            chatId: claimed.call.chatId,
            fromUserId: claimed.call.callerId,
            video: claimed.call.video,
            sdp: claimed.offer,
          })
          for (const signal of claimed.signals) send(ws, signal)
          return
        }

        if (data.type === 'call_answer') {
          const callId = String(data.callId || '')
          if (!callId || !data.sdp) return
          const call = answerCall(callId, user.id, ws)
          if (!call) return
          send(call.callerSocket, { type: 'call_answer', callId, fromUserId: user.id, sdp: data.sdp })
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
          const targets = peerSocketsFor(call, user.id)
          // Устройство собеседника ещё просыпается — сигналинг звонящего копим,
          // иначе ICE-кандидаты этих секунд просто пропали бы.
          if (targets.length === 0 && user.id === call.callerId && isAwaitingWake(call)) {
            bufferSignal(call, payload)
            return
          }
          for (const target of targets) send(target, payload)
          return
        }

        if (data.type === 'call_end') {
          const callId = String(data.callId || '')
          const call = getCall(callId)
          if (!callId || !isParticipant(call, user.id)) return
          await finishCall(callId, user.id, String(data.reason || 'hangup'))
          return
        }
      } catch (err) {
        // Наружу уходит только то, что задумано как сообщение пользователю.
        // Ошибка драйвера базы или упавшая строка кода — это внутренности
        // сервера, и клиенту их видеть незачем; publicErrorMessage их залогирует
        // и подменит общей формулировкой, как это уже делают HTTP-маршруты.
        send(ws, { type: 'error', message: publicErrorMessage(err) })
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
        await broadcastPresence(user.id, false)
        audit('socket.disconnected', { userId: user.id, username: user.username })
      }
    })

    ws.resume()
  })

  return wss
}
