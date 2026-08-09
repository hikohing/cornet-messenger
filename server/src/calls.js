import { addMessage } from './chats.js'

/**
 * Реестр звонков живёт только в памяти процесса: он нужен, чтобы сигналинг шёл
 * ровно в тот сокет, который держит peer connection, и чтобы каждый звонок
 * гарантированно оставил ровно одну запись в истории чата.
 */

/** Дольше этого звонок не «звонит» даже если клиент замолчал. */
const RING_TIMEOUT_MS = 60_000
/** Страховка от зависших записей, если оба клиента исчезли без close. */
const MAX_CALL_MS = 6 * 60 * 60 * 1000
/**
 * Сколько ждём, пока разбуженное VoIP-пушем устройство поднимет сокет и заберёт
 * звонок. Речь только про «ожило ли устройство» — на раздумья человека
 * отводится общий RING_TIMEOUT_MS. Если за это время никто не отозвался, пуш
 * не дошёл, и честнее сказать звонящему «недоступен».
 */
const WAKE_TIMEOUT_MS = 25_000
/**
 * Пока устройство просыпается, ICE-кандидаты звонящего копятся здесь. Их
 * десятки, а не тысячи; предел — защита от клиента, который решит слать их
 * бесконечно в звонок, который никто не заберёт.
 */
const MAX_BUFFERED_SIGNALS = 80

const calls = new Map()
const callsBySocket = new Map()

let runtime = {
  sendTo: () => {},
  onCallMessage: async () => {},
}

export function configureCallRuntime(next) {
  runtime = { ...runtime, ...next }
}

function trackSocket(ws, callId) {
  if (!ws) return
  if (!callsBySocket.has(ws)) callsBySocket.set(ws, new Set())
  callsBySocket.get(ws).add(callId)
}

function untrackCall(call) {
  for (const ws of [call.callerSocket, ...call.ringingSockets]) {
    const owned = callsBySocket.get(ws)
    if (!owned) continue
    owned.delete(call.id)
    if (owned.size === 0) callsBySocket.delete(ws)
  }
}

export function userBusy(userId) {
  for (const call of calls.values()) {
    if (call.ended) continue
    if (call.callerId === userId || call.calleeId === userId) return true
  }
  return false
}

export function getCall(callId) {
  return calls.get(callId) ?? null
}

/** Участвует ли пользователь в этом звонке — проверка перед пересылкой сигналинга. */
export function isParticipant(call, userId) {
  return Boolean(call) && !call.ended && (call.callerId === userId || call.calleeId === userId)
}

export function registerCall({ callId, chatId, callerId, calleeId, video, callerSocket, calleeSockets, offer }) {
  const call = {
    id: callId,
    chatId,
    callerId,
    calleeId,
    video: Boolean(video),
    callerSocket,
    calleeSocket: null,
    ringingSockets: new Set(calleeSockets),
    createdAt: Date.now(),
    answeredAt: null,
    ended: false,
    ringTimer: null,
    maxTimer: null,
    wakeTimer: null,
    // Оффер нужен, только пока звонок ждёт разбуженное устройство: у сокета,
    // который был онлайн, он уже есть — его отправили вместе с приглашением.
    offer: offer ?? null,
    bufferedSignals: [],
  }
  calls.set(callId, call)
  trackSocket(callerSocket, callId)
  for (const ws of call.ringingSockets) trackSocket(ws, callId)

  call.ringTimer = setTimeout(() => {
    void finishCall(callId, null, 'no_answer')
  }, RING_TIMEOUT_MS)
  call.maxTimer = setTimeout(() => {
    void finishCall(callId, null, 'hangup')
  }, MAX_CALL_MS)
  if (call.ringingSockets.size === 0) {
    call.wakeTimer = setTimeout(() => {
      void finishCall(callId, null, 'unavailable')
    }, WAKE_TIMEOUT_MS)
  }

  return call
}

/** Ждёт ли звонок устройство, которое сейчас будят VoIP-пушем. */
export function isAwaitingWake(call) {
  return Boolean(call) && !call.ended && !call.answeredAt && call.ringingSockets.size === 0
}

/**
 * Сигналинг звонящего, пока забирать его некому. Без буфера ICE-кандидаты,
 * присланные за время пробуждения устройства, просто пропадали бы, и соединение
 * собиралось бы дольше — а то и не собиралось вовсе.
 */
export function bufferSignal(call, payload) {
  if (!call || call.ended) return
  if (call.bufferedSignals.length >= MAX_BUFFERED_SIGNALS) return
  call.bufferedSignals.push(payload)
}

/**
 * Разбуженное устройство забирает звонок: его сокет становится «звонящим», а
 * накопленный сигналинг уезжает ему одним куском.
 *
 * @returns {{ call: object, offer: unknown, signals: unknown[] } | null}
 */
export function attachCalleeSocket(callId, userId, socket) {
  const call = calls.get(callId)
  if (!call || call.ended || call.calleeId !== userId) return null
  // Звонок, который уже приняли на другом устройстве, забрать нельзя.
  if (call.answeredAt) return null

  if (call.wakeTimer) {
    clearTimeout(call.wakeTimer)
    call.wakeTimer = null
  }
  call.ringingSockets.add(socket)
  trackSocket(socket, callId)

  const signals = call.bufferedSignals
  call.bufferedSignals = []
  return { call, offer: call.offer, signals }
}

/**
 * Первый ответивший сокет получает звонок целиком, остальные устройства
 * пользователя перестают звонить.
 */
export function answerCall(callId, userId, socket) {
  const call = calls.get(callId)
  if (!call || call.ended || call.calleeId !== userId) return null
  if (call.answeredAt) return call.calleeSocket === socket ? call : null

  call.answeredAt = Date.now()
  call.calleeSocket = socket
  if (call.ringTimer) {
    clearTimeout(call.ringTimer)
    call.ringTimer = null
  }

  const others = [...call.ringingSockets].filter((ws) => ws !== socket)
  if (others.length > 0) {
    runtime.sendTo(others, { type: 'call_end', callId, fromUserId: userId, reason: 'answered_elsewhere' })
  }
  call.ringingSockets = new Set([socket])
  trackSocket(socket, callId)
  return call
}

/** Куда доставлять сигналинг: точному сокету собеседника, пока звонок не принят — всем его устройствам. */
export function peerSocketsFor(call, fromUserId) {
  if (fromUserId === call.callerId) {
    return call.calleeSocket ? [call.calleeSocket] : [...call.ringingSockets]
  }
  return call.callerSocket ? [call.callerSocket] : []
}

function outcomeFor(call, byUserId, reason) {
  if (call.answeredAt) return 'answered'
  switch (reason) {
    case 'reject':
      return 'declined'
    case 'busy':
    case 'dnd':
    case 'unavailable':
    case 'timeout':
    case 'no_answer':
      return 'missed'
    case 'failed':
      return 'failed'
    default:
      return byUserId === call.calleeId ? 'declined' : 'cancelled'
  }
}

/**
 * Завершает звонок: гасит таймеры, уведомляет второго участника и пишет
 * единственную запись в историю чата.
 */
export async function finishCall(callId, byUserId, reason) {
  const call = calls.get(callId)
  if (!call || call.ended) return null
  call.ended = true
  calls.delete(callId)
  untrackCall(call)
  if (call.ringTimer) clearTimeout(call.ringTimer)
  if (call.maxTimer) clearTimeout(call.maxTimer)
  if (call.wakeTimer) clearTimeout(call.wakeTimer)

  const targets = new Set()
  if (byUserId !== call.callerId && call.callerSocket) targets.add(call.callerSocket)
  if (byUserId !== call.calleeId) {
    for (const ws of call.calleeSocket ? [call.calleeSocket] : call.ringingSockets) targets.add(ws)
  }
  if (targets.size > 0) {
    runtime.sendTo([...targets], { type: 'call_end', callId, fromUserId: byUserId ?? 0, reason })
  }

  const outcome = outcomeFor(call, byUserId, reason)
  const duration = call.answeredAt ? Math.max(0, Math.round((Date.now() - call.answeredAt) / 1000)) : 0
  try {
    const message = await addMessage(call.chatId, call.callerId, {
      type: 'call',
      callMeta: {
        video: call.video,
        outcome,
        duration,
        interrupted: outcome === 'answered' && reason === 'failed',
      },
    })
    await runtime.onCallMessage(call.chatId, message)
  } catch {
    // История звонка не должна ронять сам звонок.
  }
  return { call, outcome, duration }
}

/** Обрыв сокета: звонки этого устройства закрываются, если их некому продолжить. */
export async function releaseSocket(ws, userId) {
  const owned = callsBySocket.get(ws)
  if (!owned) return
  callsBySocket.delete(ws)
  for (const callId of owned) {
    const call = calls.get(callId)
    if (!call || call.ended) continue
    if (call.callerSocket === ws) {
      await finishCall(callId, userId, call.answeredAt ? 'failed' : 'hangup')
      continue
    }
    if (call.calleeSocket === ws) {
      await finishCall(callId, userId, 'failed')
      continue
    }
    call.ringingSockets.delete(ws)
    if (!call.answeredAt && call.ringingSockets.size === 0) {
      await finishCall(callId, userId, 'unavailable')
    }
  }
}
