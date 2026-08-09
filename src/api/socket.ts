import type { Chat, Message, MessageAttachment, MessageEncryptionData } from '../types'
import { apiUrl, getToken } from './client'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export type SocketEvent =
  | { type: 'chat_created'; chat: Chat }
  | { type: 'chat_updated'; chat: Chat }
  | { type: 'chat_left'; chatId: number }
  | { type: 'message'; message: Message }
  | { type: 'message_edited'; message: Message }
  | { type: 'message_deleted'; chatId: number; messageId: number; lastMessage: Message | null }
  | { type: 'messages_expired'; chatId: number; messageIds: number[] }
  | { type: 'presence'; userId: number; online: boolean }
  | { type: 'typing'; chatId: number; userId: number }
  | { type: 'read'; chatId: number; userId: number; messageId: number }
  | { type: 'reactions'; messageId: number; reactions: { emoji: string; userIds: number[] }[] }
  | { type: 'pinned'; chatId: number; messageId: number | null }
  | { type: 'call_invite'; callId: string; chatId: number; fromUserId: number; video: boolean; sdp: RTCSessionDescriptionInit }
  | { type: 'call_answer'; callId: string; fromUserId: number; sdp: RTCSessionDescriptionInit }
  | { type: 'call_ice'; callId: string; fromUserId: number; candidate: RTCIceCandidateInit }
  | { type: 'call_ringing'; callId: string; fromUserId: number }
  | { type: 'call_negotiate'; callId: string; fromUserId: number; sdp: RTCSessionDescriptionInit }
  | { type: 'call_state'; callId: string; fromUserId: number; state: RemoteCallState }
  | { type: 'call_end'; callId: string; fromUserId: number; reason: string }
  | { type: 'error'; message: string }

/** Что собеседник делает со своими микрофоном, камерой и экраном. */
export interface RemoteCallState {
  muted: boolean
  cameraOff: boolean
  video: boolean
  screenSharing: boolean
}

export type SocketApi = ReturnType<typeof connectSocket>

type Listener = (event: SocketEvent) => void
type StatusListener = (status: ConnectionStatus) => void

export function connectSocket(_session: string, onEvent: Listener, onStatus: StatusListener) {
  const base = apiUrl() || window.location.origin
  const wsUrl = base.replace(/^http/, 'ws') + '/ws'
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let manuallyClosed = false

  function connect() {
    if (manuallyClosed) return
    onStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting')
    // Заголовок Authorization браузерному WebSocket задать нельзя, а куки в
    // нативной сборке на домен API не уходят — там сессию передаём subprotocol'ом.
    const token = getToken()
    socket = token ? new WebSocket(wsUrl, ['bearer', token]) : new WebSocket(wsUrl)

    socket.addEventListener('open', () => {
      reconnectAttempt = 0
      onStatus('connected')
    })

    socket.addEventListener('message', (e) => {
      try {
        onEvent(JSON.parse(e.data) as SocketEvent)
      } catch {
        // Ignore malformed frames without breaking the connection.
      }
    })

    socket.addEventListener('close', () => {
      socket = null
      if (manuallyClosed) {
        onStatus('disconnected')
        return
      }
      onStatus('reconnecting')
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000)
      reconnectAttempt += 1
      reconnectTimer = setTimeout(connect, delay)
    })
  }

  function send(payload: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  /**
   * Возврат приложения из фона. iOS усыпляет процесс, и соединение к этому
   * моменту почти наверняка порвано, а таймер переподключения ждёт до десяти
   * секунд — всё это время сообщения не приходят. Событие присылает
   * native/shell.ts сразу, как приложение проснулось.
   */
  function handleAppResume(event: Event) {
    if (!(event as CustomEvent<{ isActive: boolean }>).detail?.isActive) return
    if (manuallyClosed) return
    if (socket && socket.readyState !== WebSocket.CLOSED) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempt = 0
    connect()
  }

  document.addEventListener('native:appstate', handleAppResume)

  connect()

  return {
    sendMessage: (
      chatId: number,
      text: string,
      attachment?: MessageAttachment,
      replyToId?: number,
      encrypted?: MessageEncryptionData,
    ) =>
      send({
        type: 'send',
        chatId,
        text: encrypted ? '' : text,
        attachmentUrl: attachment?.url,
        attachment: attachment ? {
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          duration: attachment.duration,
        } : undefined,
        messageType: attachment?.messageType,
        replyToId,
        encrypted,
      }),
    editMessage: (messageId: number, text: string, encrypted?: MessageEncryptionData) =>
      send({ type: 'edit', messageId, text: encrypted ? '' : text, encrypted }),
    createPoll: (chatId: number, poll: { question: string; options: string[]; anonymous: boolean; multipleChoice: boolean }) =>
      send({ type: 'poll_create', chatId, poll }),
    votePoll: (messageId: number, optionId: number) => send({ type: 'poll_vote', messageId, optionId }),
    closePoll: (messageId: number) => send({ type: 'poll_close', messageId }),
    deleteMessage: (messageId: number) => send({ type: 'delete', messageId }),
    sendTyping: (chatId: number) => send({ type: 'typing', chatId }),
    sendRead: (chatId: number, messageId: number) => send({ type: 'read', chatId, messageId }),
    react: (messageId: number, emoji: string) => send({ type: 'react', messageId, emoji }),
    forward: (sourceMessageId: number, targetChatId: number) => send({ type: 'forward', sourceMessageId, targetChatId }),
    pin: (chatId: number, messageId: number | null) => send({ type: 'pin', chatId, messageId }),
    callInvite: (targetUserId: number, chatId: number, callId: string, video: boolean, sdp: RTCSessionDescriptionInit) =>
      send({ type: 'call_invite', targetUserId, chatId, callId, video, sdp }),
    callAnswer: (callId: string, sdp: RTCSessionDescriptionInit) => send({ type: 'call_answer', callId, sdp }),
    /** Разбуженное VoIP-пушем устройство забирает у сервера отложенное приглашение. */
    callClaim: (callId: string) => send({ type: 'call_claim', callId }),
    callIce: (callId: string, candidate: RTCIceCandidateInit) => send({ type: 'call_ice', callId, candidate }),
    callRinging: (callId: string) => send({ type: 'call_ringing', callId }),
    callNegotiate: (callId: string, sdp: RTCSessionDescriptionInit) => send({ type: 'call_negotiate', callId, sdp }),
    callState: (callId: string, state: RemoteCallState) => send({ type: 'call_state', callId, state }),
    callEnd: (callId: string, reason: string) => send({ type: 'call_end', callId, reason }),
    close() {
      manuallyClosed = true
      document.removeEventListener('native:appstate', handleAppResume)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
      onStatus('disconnected')
    },
  }
}
