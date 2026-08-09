import { useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import { connectSocket, type ConnectionStatus } from '../api/socket'
import type { Chat, ChatFolder, Message, MessageAttachment, User } from '../types'
import { useCallSession } from './useCallSession'
import type { AppPreferences } from './usePreferences'
import { decryptIncoming, encryptOutgoing, ensureChatKeysLoaded } from '../crypto/session'
import { ENCRYPTED_UPLOAD_MIME, ENCRYPTED_UPLOAD_NAME } from '../crypto/files'

const TYPING_TIMEOUT_MS = 3000

// Negative, monotonically decreasing so two optimistic messages sent within
// the same millisecond never collide on id (unlike a bare -Date.now()).
let optimisticIdCounter = 0
function nextOptimisticId(): number {
  optimisticIdCounter -= 1
  return -Date.now() * 1000 + optimisticIdCounter
}

function sortChats(chats: Chat[]) {
  return [...chats].sort((a, b) => {
    if (a.type === 'saved') return -1
    if (b.type === 'saved') return 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0)
  })
}

export function useChats(
  token: string | null,
  currentUserId: number | null,
  preferences: AppPreferences,
  updatePreferences: (patch: Partial<AppPreferences>) => void,
) {
  const [chats, setChats] = useState<Chat[]>([])
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [chatsLoaded, setChatsLoaded] = useState(false)
  const [messagesByChat, setMessagesByChat] = useState<Record<number, Message[]>>({})
  const [loadingChatIds, setLoadingChatIds] = useState<Set<number>>(new Set())
  const [typingByChat, setTypingByChat] = useState<Record<number, number[]>>({})
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null)
  const typingTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const activeChatIdRef = useRef<number | null>(null)
  const currentUserIdRef = useRef(currentUserId)
  const preferencesRef = useRef(preferences)
  const chatsRef = useRef(chats)
  currentUserIdRef.current = currentUserId
  preferencesRef.current = preferences
  chatsRef.current = chats

  /** Звонок может прийти из чата, которого ещё нет в списке — тогда список обновляется. */
  async function resolveCallPeer(chatId: number, userId: number): Promise<User | null> {
    const localOtherUser = chatsRef.current.find((c) => c.id === chatId)?.members.find((m) => m.id === userId)
    if (localOtherUser) return localOtherUser
    try {
      const res = await api.getChats()
      setChats(sortChats(res.chats))
      chatsRef.current = res.chats
      return res.chats.find((c) => c.id === chatId)?.members.find((m) => m.id === userId) ?? null
    } catch {
      return null
    }
  }

  const callSession = useCallSession({
    getSocket: () => socketRef.current,
    getPreferences: () => preferencesRef.current,
    updatePreferences,
    resolvePeer: resolveCallPeer,
  })

  async function decryptAndPatch(message: Message) {
    const patch = await decryptIncoming(message, currentUserIdRef.current)
    if (Object.keys(patch).length === 0) return
    setMessagesByChat((prev) => ({
      ...prev,
      [message.chatId]: (prev[message.chatId] ?? []).map((m) => {
        // Это же сообщение может быть процитировано в ответе — там текст тоже
        // нужно подставить, иначе цитата осталась бы заглушкой с замком.
        const next = m.replyTo?.id === message.id && m.replyTo.decryptedText === undefined
          ? { ...m, replyTo: { ...m.replyTo, ...patch } }
          : m
        if (next.id !== message.id) return next
        // A row that already carries plaintext (our own message, kept from the
        // optimistic row) must not be clobbered by a slower decryption pass.
        if (next.decryptedText !== undefined) return next
        // An edit swaps in new ciphertext; a decryption still in flight for the
        // previous version must not overwrite it with the pre-edit text.
        if (next.encryptionData?.ciphertext !== message.encryptionData?.ciphertext) return next
        return { ...next, ...patch }
      }),
    }))
    // То же сообщение может быть превью чата в списке слева — его тоже надо
    // подставить расшифрованным, иначе там останется заглушка с замком.
    setChats((prev) =>
      prev.map((c) =>
        c.lastMessage?.id === message.id ? { ...c, lastMessage: { ...c.lastMessage, ...patch } } : c,
      ),
    )
  }

  /**
   * Превью в списке чатов берётся из chat.lastMessage, который приходит с
   * сервера в зашифрованном виде (text пустой). Расшифровываем его отдельно,
   * иначе в списке была бы пустая строка вместо текста.
   */
  async function decryptChatPreviews(list: Chat[]) {
    const encrypted = list.filter((c) => c.lastMessage?.encrypted && c.lastMessage.decryptedText === undefined)
    if (encrypted.length === 0) return
    const patches = await Promise.all(
      encrypted.map(async (c) => ({
        chatId: c.id,
        messageId: c.lastMessage!.id,
        patch: await decryptIncoming(c.lastMessage!, currentUserIdRef.current),
      })),
    )
    setChats((prev) =>
      prev.map((c) => {
        const found = patches.find((p) => p.chatId === c.id && p.messageId === c.lastMessage?.id)
        if (!found || Object.keys(found.patch).length === 0) return c
        return { ...c, lastMessage: { ...c.lastMessage!, ...found.patch } }
      }),
    )
  }

  useEffect(() => {
    const pendingTypingTimeouts = typingTimeouts.current
    if (!token) {
      setChats([])
      setMessagesByChat({})
      return
    }

    api.getChats().then((res) => {
      setChats(sortChats(res.chats))
      setChatsLoaded(true)
      void decryptChatPreviews(res.chats)
    })
    api.getFolders().then((res) => setFolders(res.folders)).catch(() => setFolders([]))

    void callSession.loadIceServers()

    const socket = connectSocket(token, (event) => {
      if (event.type.startsWith('call_')) {
        void callSession.handleEvent(event)
        return
      }
      if (event.type === 'chat_created') {
        setChats((prev) => sortChats([event.chat, ...prev.filter((chat) => chat.id !== event.chat.id)]))
      } else if (event.type === 'chat_updated') {
        setChats((prev) =>
          sortChats(prev.map((chat) => {
            if (chat.id !== event.chat.id) return chat
            // Сервер присылает превью в зашифрованном виде. Если просто взять
            // его целиком, уже расшифрованный текст в списке слева сменялся бы
            // обратно на заглушку с замком при любом обновлении чата — смене
            // аватарки, голосовании в опросе и т.п.
            const keepDecrypted =
              chat.lastMessage?.id === event.chat.lastMessage?.id
                ? chat.lastMessage?.decryptedText
                : undefined
            if (!event.chat.lastMessage || keepDecrypted === undefined) return event.chat
            return { ...event.chat, lastMessage: { ...event.chat.lastMessage, decryptedText: keepDecrypted } }
          })),
        )
        void decryptChatPreviews([event.chat])
      } else if (event.type === 'chat_left') {
        setChats((prev) => prev.filter((chat) => chat.id !== event.chatId))
        setMessagesByChat((prev) => {
          const next = { ...prev }
          delete next[event.chatId]
          return next
        })
      } else if (event.type === 'message') {
        const { message } = event
        const notificationPreferences = preferencesRef.current
        const notificationChat = chatsRef.current.find((chat) => chat.id === message.chatId)
        const notificationTypeAllowed = notificationChat?.type === 'group'
          ? notificationPreferences.groupNotifications
          : notificationPreferences.directNotifications
        // Беззвучный режим чата перекрывает общие настройки уведомлений.
        const chatMuted = Boolean(notificationChat?.mutedUntil && notificationChat.mutedUntil > Date.now())
        if (
          document.hidden &&
          message.senderId !== currentUserIdRef.current &&
          notificationPreferences.notifications &&
          'Notification' in window &&
          Notification.permission === 'granted'
          && notificationTypeAllowed
          && !chatMuted
        ) {
          new Notification('Новое сообщение в CorNet', {
            body: notificationPreferences.messagePreview ? (message.text || (
              // У зашифрованного сообщения серверный text пуст, а расшифровать
              // его прямо здесь нельзя — без этой ветки текстовое сообщение
              // проваливалось в конец цепочки и подписывалось «Изображение».
              message.encrypted ? '🔒 Зашифрованное сообщение'
                : message.type === 'poll' ? `📊 ${message.poll?.question ?? 'Опрос'}`
                  : message.type === 'voice' ? 'Голосовое сообщение'
                    : message.type === 'video' ? 'Видео'
                      : message.type === 'audio' ? 'Аудио'
                        : message.type === 'file' ? message.attachment?.name || 'Файл'
                          : 'Изображение'
            )) : 'Откройте CorNet, чтобы прочитать',
          })
          if (notificationPreferences.notificationSound) {
            try {
              const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
              if (AudioContextClass) {
                const context = new AudioContextClass()
                const oscillator = context.createOscillator()
                const gain = context.createGain()
                const frequencies = { soft: 520, ping: 720, crystal: 920, none: 0 }
                oscillator.frequency.value = frequencies[notificationPreferences.notificationSoundStyle]
                gain.gain.setValueAtTime(0.08, context.currentTime)
                gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18)
                oscillator.connect(gain).connect(context.destination)
                oscillator.start()
                oscillator.stop(context.currentTime + 0.18)
                oscillator.addEventListener('ended', () => void context.close())
              }
            } catch {
              // Some browsers block sounds until the page receives a gesture.
            }
          }
        }
        setMessagesByChat((prev) => {
          const current = prev[message.chatId] ?? []
          const optimisticIndex = current.findIndex((item) =>
            item.pending && item.senderId === message.senderId && item.attachmentUrl === message.attachmentUrl &&
            (message.encrypted ? true : item.text === message.text),
          )
          if (optimisticIndex === -1) return { ...prev, [message.chatId]: [...current, message] }
          const updated = current.map((item, index) =>
            // Carry the optimistic row's key and already-known plaintext across
            // so the row is updated in place rather than remounted.
            index === optimisticIndex
              ? { ...message, clientKey: item.clientKey, decryptedText: item.decryptedText }
              : item,
          )
          return { ...prev, [message.chatId]: updated }
        })
        if (message.encrypted) void decryptAndPatch(message)
        const isActive = activeChatIdRef.current === message.chatId
        setChats((prev) => {
          const index = prev.findIndex((c) => c.id === message.chatId)
          if (index === -1) {
            api.getChats().then((res) => setChats(sortChats(res.chats)))
            return prev
          }
          const updated = {
            ...prev[index],
            lastMessage: message,
            unreadCount: isActive ? 0 : prev[index].unreadCount + 1,
          }
          const rest = prev.filter((c) => c.id !== message.chatId)
          return sortChats([updated, ...rest])
        })
      } else if (event.type === 'message_edited') {
        const { message } = event
        setMessagesByChat((prev) => ({
          ...prev,
          // The edited payload carries fresh ciphertext and no plaintext, so the
          // stale decryptedText has to go — otherwise the bubble would keep
          // showing the pre-edit text. clientKey is kept so the row is not
          // remounted (which would replay its entry animation).
          [message.chatId]: (prev[message.chatId] ?? []).map((m) =>
            m.id === message.id ? { ...message, clientKey: m.clientKey } : m,
          ),
        }))
        if (message.encrypted) void decryptAndPatch(message)
        setChats((prev) =>
          prev.map((c) =>
            c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c,
          ),
        )
      } else if (event.type === 'message_deleted') {
        setMessagesByChat((prev) => ({
          ...prev,
          [event.chatId]: (prev[event.chatId] ?? []).map((m) =>
            m.id === event.messageId ? { ...m, deleted: 1, text: '', attachmentUrl: null, attachment: null } : m,
          ),
        }))
        setChats((prev) =>
          prev.map((c) =>
            c.lastMessage?.id === event.messageId
              ? { ...c, lastMessage: event.lastMessage }
              : c,
          ),
        )
      } else if (event.type === 'messages_expired') {
        // Исчезающие сообщения именно исчезают: убираем строки целиком, а не
        // оставляем «Сообщение удалено», иначе след переписки сохранялся бы.
        const expired = new Set(event.messageIds)
        setMessagesByChat((prev) => ({
          ...prev,
          [event.chatId]: (prev[event.chatId] ?? []).filter((m) => !expired.has(m.id)),
        }))
      } else if (event.type === 'presence') {
        if (!event.online) callSession.handlePeerOffline(event.userId)
        setChats((prev) =>
          prev.map((chat) => ({
            ...chat,
            members: chat.members.map((m) =>
              m.id === event.userId ? { ...m, online: event.online } : m,
            ),
          })),
        )
      } else if (event.type === 'read') {
        setChats((prev) =>
          prev.map((chat) => {
            if (chat.id !== event.chatId) return chat
            const rest = chat.readState.filter((r) => r.userId !== event.userId)
            return { ...chat, readState: [...rest, { userId: event.userId, lastReadMessageId: event.messageId }] }
          }),
        )
      } else if (event.type === 'typing') {
        const key = `${event.chatId}:${event.userId}`
        setTypingByChat((prev) => {
          const existing = prev[event.chatId] ?? []
          if (existing.includes(event.userId)) return prev
          return { ...prev, [event.chatId]: [...existing, event.userId] }
        })
        const existingTimeout = typingTimeouts.current.get(key)
        if (existingTimeout) clearTimeout(existingTimeout)
        typingTimeouts.current.set(
          key,
          setTimeout(() => {
            setTypingByChat((prev) => ({
              ...prev,
              [event.chatId]: (prev[event.chatId] ?? []).filter((id) => id !== event.userId),
            }))
            typingTimeouts.current.delete(key)
          }, TYPING_TIMEOUT_MS),
        )
      } else if (event.type === 'reactions') {
        setMessagesByChat((prev) => {
          const next = { ...prev }
          for (const chatId of Object.keys(next)) {
            next[Number(chatId)] = next[Number(chatId)].map((m) =>
              m.id === event.messageId ? { ...m, reactions: event.reactions } : m,
            )
          }
          return next
        })
      } else if (event.type === 'pinned') {
        api.getChats().then((res) => setChats(sortChats(res.chats)))
      }
    }, setConnectionStatus)
    socketRef.current = socket

    return () => {
      socket.close()
      socketRef.current = null
      callSession.reset()
      for (const timeout of pendingTypingTimeouts.values()) clearTimeout(timeout)
      pendingTypingTimeouts.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  function setActiveChat(chatId: number | null) {
    activeChatIdRef.current = chatId
    if (chatId !== null) {
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)))
    }
  }

  async function loadMessages(chatId: number) {
    if (messagesByChat[chatId]) return
    setLoadingChatIds((prev) => new Set(prev).add(chatId))
    try {
      const chat = chatsRef.current.find((c) => c.id === chatId)
      if (chat) await ensureChatKeysLoaded(chat, currentUserIdRef.current)
      const res = await api.getMessages(chatId)
      setMessagesByChat((prev) => ({ ...prev, [chatId]: res.messages }))
      for (const message of res.messages) {
        if (message.encrypted) void decryptAndPatch(message)
      }
    } finally {
      setLoadingChatIds((prev) => {
        const next = new Set(prev)
        next.delete(chatId)
        return next
      })
    }
  }

  async function sendMessage(chatId: number, text: string, attachment?: MessageAttachment, replyToId?: number) {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return false
    if (currentUserIdRef.current === null) return false

    const chat = chatsRef.current.find((c) => c.id === chatId)
    // Вложение считается зашифрованным, когда у него есть ключ: его положил
    // ChatWindow, зашифровав файл перед загрузкой.
    const filePayload = attachment?.secret
      ? {
        ...attachment.secret,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        duration: attachment.duration,
        messageType: attachment.messageType,
      }
      : undefined
    const encrypted = chat && (trimmed || filePayload)
      ? await encryptOutgoing(chat, trimmed, currentUserIdRef.current, filePayload)
      : null

    // Серверу — только то, что ему нужно для хранения и раздачи файла. Имя и
    // тип обезличены: настоящие уехали внутри конверта.
    const wireAttachment: MessageAttachment | undefined = attachment
      ? encrypted && filePayload
        ? { ...attachment, name: ENCRYPTED_UPLOAD_NAME, mimeType: ENCRYPTED_UPLOAD_MIME, duration: undefined, secret: undefined }
        : attachment
      : undefined

    const sent = socketRef.current?.sendMessage(chatId, trimmed, wireAttachment, replyToId, encrypted ?? undefined) ?? false
    if (!sent) return false
    const optimisticId = nextOptimisticId()
    const optimisticMessage: Message = {
      id: optimisticId,
      clientKey: optimisticId,
      chatId,
      senderId: currentUserIdRef.current,
      type: attachment?.messageType ?? 'text',
      text: trimmed,
      attachmentUrl: attachment?.url ?? null,
      attachment: attachment ? {
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        duration: attachment.duration,
      } : null,
      replyToId: replyToId ?? null,
      forwarded: false,
      editedAt: null,
      deleted: false,
      createdAt: Date.now(),
      reactions: [],
      pending: true,
      encrypted: Boolean(encrypted),
      // We already hold the plaintext, so show it right away instead of
      // making our own message sit at "decrypting…" until the server echo.
      ...(encrypted ? { decryptedText: trimmed } : {}),
      // Ключ у нас уже есть — своё вложение показываем сразу, не дожидаясь,
      // пока сервер вернёт сообщение и мы расшифруем конверт заново.
      ...(encrypted && filePayload ? { decryptedFile: filePayload } : {}),
    }
    setMessagesByChat((prev) => ({ ...prev, [chatId]: [...(prev[chatId] ?? []), optimisticMessage] }))
    setChats((prev) => sortChats(prev.map((chat) => chat.id === chatId ? { ...chat, lastMessage: optimisticMessage } : chat)))
    return true
  }

  async function editMessage(messageId: number, text: string, chatId?: number) {
    const trimmed = text.trim()
    if (!trimmed) return
    const chat = chatId !== undefined ? chatsRef.current.find((c) => c.id === chatId) : undefined
    const encrypted = chat && currentUserIdRef.current !== null
      ? await encryptOutgoing(chat, trimmed, currentUserIdRef.current)
      : null
    socketRef.current?.editMessage(messageId, trimmed, encrypted ?? undefined)
  }

  function deleteMessage(messageId: number) {
    socketRef.current?.deleteMessage(messageId)
  }

  function createPoll(chatId: number, poll: { question: string; options: string[]; anonymous: boolean; multipleChoice: boolean }) {
    socketRef.current?.createPoll(chatId, poll)
  }

  function votePoll(messageId: number, optionId: number) {
    socketRef.current?.votePoll(messageId, optionId)
  }

  function closePoll(messageId: number) {
    socketRef.current?.closePoll(messageId)
  }

  function sendTyping(chatId: number) {
    socketRef.current?.sendTyping(chatId)
  }

  function markRead(chatId: number, messageId: number) {
    socketRef.current?.sendRead(chatId, messageId)
  }

  function react(messageId: number, emoji: string) {
    socketRef.current?.react(messageId, emoji)
  }

  function forwardMessage(sourceMessageId: number, targetChatId: number) {
    socketRef.current?.forward(sourceMessageId, targetChatId)
  }

  function pinMessage(chatId: number, messageId: number | null) {
    socketRef.current?.pin(chatId, messageId)
  }

  async function searchInChat(chatId: number, query: string) {
    const res = await api.searchMessages(chatId, query)
    return res.messages
  }

  async function startChat(username: string) {
    const res = await api.createChat(username)
    setChats((prev) => {
      if (prev.some((c) => c.id === res.chat.id)) return prev
      return [res.chat, ...prev]
    })
    return res.chat
  }

  async function toggleArchived(chatId: number, archived: boolean) {
    setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? { ...c, archived } : c))))
    try {
      const res = await api.archiveChat(chatId, archived)
      setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? res.chat : c))))
    } catch {
      setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? { ...c, archived: !archived } : c))))
    }
  }

  async function toggleMuted(chatId: number, mutedUntil: number | null) {
    const previous = chatsRef.current.find((c) => c.id === chatId)?.mutedUntil ?? null
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, mutedUntil } : c)))
    try {
      const res = await api.muteChat(chatId, mutedUntil)
      setChats((prev) => prev.map((c) => (c.id === chatId ? res.chat : c)))
    } catch {
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, mutedUntil: previous } : c)))
    }
  }

  async function reloadFolders() {
    const res = await api.getFolders()
    setFolders(res.folders)
    return res.folders
  }

  async function saveFolder(name: string, chatIds: number[], folderId?: number) {
    const res = folderId ? await api.updateFolder(folderId, { name, chatIds }) : await api.createFolder(name, chatIds)
    setFolders(res.folders)
  }

  async function removeFolder(folderId: number) {
    const res = await api.deleteFolder(folderId)
    setFolders(res.folders)
  }

  async function toggleChatPinned(chatId: number, pinned: boolean) {
    setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? { ...c, pinned } : c))))
    try {
      const res = await api.pinChat(chatId, pinned)
      setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? res.chat : c))))
    } catch {
      setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? { ...c, pinned: !pinned } : c))))
    }
  }

  async function startGroupChat(name: string, usernames: string[]) {
    const res = await api.createGroupChat(name, usernames)
    setChats((prev) => {
      if (prev.some((c) => c.id === res.chat.id)) return prev
      return [res.chat, ...prev]
    })
    return res.chat
  }

  async function updateChatInfo(chatId: number, patch: { name?: string; description?: string; avatarUrl?: string | null }) {
    const res = await api.updateChatInfo(chatId, patch)
    setChats((prev) => sortChats(prev.map((c) => (c.id === chatId ? res.chat : c))))
    return res.chat
  }

  async function leaveChat(chatId: number) {
    await api.leaveGroup(chatId)
    setChats((prev) => prev.filter((c) => c.id !== chatId))
  }

  return {
    chats,
    folders,
    chatsLoaded,
    connectionStatus,
    messagesForChat: (chatId: number) => messagesByChat[chatId] ?? [],
    isLoadingMessages: (chatId: number) => loadingChatIds.has(chatId),
    typingUsersForChat: (chatId: number) => typingByChat[chatId] ?? [],
    setActiveChat,
    loadMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    createPoll,
    votePoll,
    closePoll,
    sendTyping,
    markRead,
    react,
    forwardMessage,
    pinMessage,
    searchInChat,
    startChat,
    startGroupChat,
    toggleChatPinned,
    toggleArchived,
    toggleMuted,
    reloadFolders,
    saveFolder,
    removeFolder,
    updateChatInfo,
    leaveChat,
    callSession,
  }
}
