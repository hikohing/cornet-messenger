import { useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import { connectSocket, type ConnectionStatus } from '../api/socket'
import type { Chat, Message, MessageAttachment, User } from '../types'
import { useCallSession } from './useCallSession'
import type { AppPreferences } from './usePreferences'

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
    })

    void callSession.loadIceServers()

    const socket = connectSocket(token, (event) => {
      if (event.type.startsWith('call_')) {
        void callSession.handleEvent(event)
        return
      }
      if (event.type === 'chat_created') {
        setChats((prev) => sortChats([event.chat, ...prev.filter((chat) => chat.id !== event.chat.id)]))
      } else if (event.type === 'chat_updated') {
        setChats((prev) => sortChats(prev.map((chat) => (chat.id === event.chat.id ? event.chat : chat))))
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
        if (
          document.hidden &&
          message.senderId !== currentUserIdRef.current &&
          notificationPreferences.notifications &&
          'Notification' in window &&
          Notification.permission === 'granted'
          && notificationTypeAllowed
        ) {
          new Notification('Новое сообщение в CorNet', {
            body: notificationPreferences.messagePreview ? (message.text || (
              message.type === 'voice' ? 'Голосовое сообщение'
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
            item.pending && item.senderId === message.senderId && item.text === message.text && item.attachmentUrl === message.attachmentUrl,
          )
          const updated = optimisticIndex === -1
            ? [...current, message]
            : current.map((item, index) => index === optimisticIndex ? message : item)
          return { ...prev, [message.chatId]: updated }
        })
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
          [message.chatId]: (prev[message.chatId] ?? []).map((m) => (m.id === message.id ? message : m)),
        }))
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
      const res = await api.getMessages(chatId)
      setMessagesByChat((prev) => ({ ...prev, [chatId]: res.messages }))
    } finally {
      setLoadingChatIds((prev) => {
        const next = new Set(prev)
        next.delete(chatId)
        return next
      })
    }
  }

  function sendMessage(chatId: number, text: string, attachment?: MessageAttachment, replyToId?: number) {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return false
    const sent = socketRef.current?.sendMessage(chatId, trimmed, attachment, replyToId) ?? false
    if (!sent || currentUserIdRef.current === null) return false
    const optimisticMessage: Message = {
      id: nextOptimisticId(),
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
    }
    setMessagesByChat((prev) => ({ ...prev, [chatId]: [...(prev[chatId] ?? []), optimisticMessage] }))
    setChats((prev) => sortChats(prev.map((chat) => chat.id === chatId ? { ...chat, lastMessage: optimisticMessage } : chat)))
    return true
  }

  function editMessage(messageId: number, text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    socketRef.current?.editMessage(messageId, trimmed)
  }

  function deleteMessage(messageId: number) {
    socketRef.current?.deleteMessage(messageId)
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
    sendTyping,
    markRead,
    react,
    forwardMessage,
    pinMessage,
    searchInChat,
    startChat,
    startGroupChat,
    toggleChatPinned,
    updateChatInfo,
    leaveChat,
    callSession,
  }
}
