import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentMessageType, Chat, Message, MessageAttachment } from '../types'
import { AvatarImage } from './AvatarImage'
import { CallMessage } from './CallMessage'
import { MessageBubble } from './MessageBubble'
import { MediaLightbox } from './MediaLightbox'
import { ForwardModal } from './ForwardModal'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { uploadFile } from '../api/client'
import type { ConnectionStatus } from '../api/socket'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { useContextMenu } from '../hooks/useContextMenu'
import {
  ArrowDownIcon,
  AttachIcon,
  BackIcon,
  ChatBubbleIcon,
  CloseIcon,
  ForwardIcon,
  InfoPanelIcon,
  MicIcon,
  PhoneIcon,
  PinIcon,
  SearchIcon,
  SendIcon,
  SmileIcon,
  SpinnerIcon,
  TrashIcon,
  UsersIcon,
  VideoIcon,
} from './icons'

const COMPOSER_EMOJIS = [
  '😀', '😂', '😍', '🥰', '😉', '😎', '🤔', '😢', '😭', '😡',
  '👍', '👎', '🙏', '👏', '🔥', '🎉', '❤️', '💯', '✅', '🤝',
]

interface ChatWindowProps {
  chat: Chat | undefined
  chats: Chat[]
  messages: Message[]
  currentUserId: number
  typingUserIds: number[]
  isLoadingMessages: boolean
  connectionStatus: ConnectionStatus
  enterToSend: boolean
  sendTypingEnabled: boolean
  sendReadReceipts: boolean
  saveDrafts: boolean
  onBack: () => void
  onSend: (text: string, attachment?: MessageAttachment, replyToId?: number) => boolean
  onEdit: (messageId: number, text: string) => void
  onDelete: (messageId: number) => void
  onTyping: (chatId: number) => void
  onMarkRead: (chatId: number, messageId: number) => void
  onReact: (messageId: number, emoji: string) => void
  onForward: (sourceMessageId: number, targetChatId: number) => void
  onTogglePin: (chatId: number, messageId: number | null) => void
  onSearch: (chatId: number, query: string) => Promise<Message[]>
  showInfoPanel: boolean
  onToggleInfoPanel: () => void
  onStartCall: (video: boolean) => void
}

const GROUP_WINDOW_MS = 5 * 60 * 1000
const TYPING_THROTTLE_MS = 1500

function dayLabel(timestamp: number) {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Сегодня'
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString([], { day: 'numeric', month: 'long' })
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatSearchResultDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightMatch(text: string, query: string) {
  const trimmed = query.trim()
  if (!trimmed) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(trimmed)})`, 'ig'))
  return parts.map((part, i) =>
    part.toLowerCase() === trimmed.toLowerCase() ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
  )
}

function statusLabel(chat: Chat, other: Chat['members'][number] | undefined) {
  if (chat.type === 'group') return `${chat.members.length} участников`
  if (chat.type === 'saved') return 'Личные заметки'
  if (!other) return ''
  if (other.online) return 'в сети'
  if (other.showLastSeen && other.lastSeenAt) return `был(а) в сети в ${formatTime(other.lastSeenAt)}`
  return 'не в сети'
}

export function ChatWindow({
  chat,
  chats,
  messages,
  currentUserId,
  typingUserIds,
  isLoadingMessages,
  connectionStatus,
  enterToSend,
  sendTypingEnabled,
  sendReadReceipts,
  saveDrafts,
  onBack,
  onSend,
  onEdit,
  onDelete,
  onTyping,
  onMarkRead,
  onReact,
  onForward,
  onTogglePin,
  onSearch,
  showInfoPanel,
  onToggleInfoPanel,
  onStartCall,
}: ChatWindowProps) {
  const [draft, setDraft] = useState('')
  const [uploading, setUploading] = useState(false)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  const [forwardingMessages, setForwardingMessages] = useState<Message[] | null>(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Message[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [showComposerEmoji, setShowComposerEmoji] = useState(false)
  const [lightboxImage, setLightboxImage] = useState<{ url: string; name: string } | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const dragCounterRef = useRef(0)
  const {
    menu: selectionContextMenu,
    openFromMouseEvent: openSelectionContextMenu,
    close: closeSelectionContextMenu,
  } = useContextMenu()
  useEscapeToClose(() => {
    if (selectedMessageIds.size > 0) {
      setSelectedMessageIds(new Set())
      return
    }
    if (searchOpen) setSearchOpen(false)
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingStartedAtRef = useRef(0)
  const cancelRecordingRef = useRef(false)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const emojiWrapRef = useRef<HTMLDivElement>(null)
  const lastTypingSentRef = useRef(0)
  const currentChatId = chat?.id ?? null
  const draftChatIdRef = useRef<number | null>(currentChatId)
  const skipDraftSaveRef = useRef(true)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef(0)
  const selectionDragRef = useRef({ active: false, selected: true, visited: new Set<number>() })
  const selectionPointerStartRef = useRef<{ messageId: number; x: number; y: number } | null>(null)
  const selectionClickSuppressUntilRef = useRef(0)

  // Автоскролл «как в мессенджере»: прыгаем вниз только если пользователь уже
  // читает конец ленты или сам отправил сообщение. Иначе не вырываем его из
  // истории, а копим счётчик на кнопке «вниз».
  const atBottomRef = useRef(true)
  const prevChatIdRef = useRef<number | null>(null)
  const prevCountRef = useRef(0)
  const chatSettledRef = useRef(false)
  const [unseenCount, setUnseenCount] = useState(0)
  const [showScrollDown, setShowScrollDown] = useState(false)

  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current
    if (!el) return
    const reduced =
      document.documentElement.dataset.reducedMotion === 'true' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' })
    atBottomRef.current = true
    setUnseenCount(0)
    setShowScrollDown(false)
  }, [])

  const handleListScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom < 80
    atBottomRef.current = atBottom
    setShowScrollDown(!atBottom && el.scrollHeight - el.clientHeight > 160)
    if (atBottom) setUnseenCount(0)
  }, [])

  useEffect(() => {
    if (prevChatIdRef.current !== currentChatId) {
      prevChatIdRef.current = currentChatId
      prevCountRef.current = messages.length
      chatSettledRef.current = messages.length > 0
      atBottomRef.current = true
      setUnseenCount(0)
      setShowScrollDown(false)
      scrollToBottom()
      return
    }

    const grew = messages.length > prevCountRef.current
    const added = messages.length - prevCountRef.current
    prevCountRef.current = messages.length
    if (!grew) return

    // Первая порция истории после открытия чата — встаём внизу без анимации.
    if (!chatSettledRef.current) {
      chatSettledRef.current = true
      scrollToBottom()
      return
    }

    const last = messages[messages.length - 1]
    if (atBottomRef.current || last?.senderId === currentUserId) {
      scrollToBottom(true)
    } else {
      setUnseenCount((n) => n + added)
      setShowScrollDown(true)
    }
  }, [messages, currentChatId, currentUserId, scrollToBottom])

  useEffect(() => {
    if (!showComposerEmoji) return
    function onClickOutside(e: MouseEvent) {
      if (emojiWrapRef.current && !emojiWrapRef.current.contains(e.target as Node)) {
        setShowComposerEmoji(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [showComposerEmoji])

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    cancelRecordingRef.current = true
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  useEffect(() => {
    function stopSelectionDrag() {
      selectionDragRef.current.active = false
      selectionPointerStartRef.current = null
    }
    document.addEventListener('pointerup', stopSelectionDrag)
    document.addEventListener('pointercancel', stopSelectionDrag)
    window.addEventListener('blur', stopSelectionDrag)
    return () => {
      document.removeEventListener('pointerup', stopSelectionDrag)
      document.removeEventListener('pointercancel', stopSelectionDrag)
      window.removeEventListener('blur', stopSelectionDrag)
    }
  }, [])

  useEffect(() => {
    function markReadIfVisible() {
      if (sendReadReceipts && chat && messages.length > 0 && document.visibilityState === 'visible') {
        onMarkRead(chat.id, messages[messages.length - 1].id)
      }
    }
    markReadIfVisible()
    document.addEventListener('visibilitychange', markReadIfVisible)
    return () => document.removeEventListener('visibilitychange', markReadIfVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, messages.length, sendReadReceipts])

  useEffect(() => {
    const previousChatId = draftChatIdRef.current
    if (previousChatId !== null && saveDrafts) localStorage.setItem(`connecto:draft:${previousChatId}`, draft)
    draftChatIdRef.current = currentChatId
    skipDraftSaveRef.current = true
    setDraft(currentChatId !== null && saveDrafts ? (localStorage.getItem(`connecto:draft:${currentChatId}`) ?? '') : '')
    // Draft is intentionally transferred between chat identities here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId, saveDrafts])

  useEffect(() => {
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false
      return
    }
    if (currentChatId !== null && saveDrafts) localStorage.setItem(`connecto:draft:${currentChatId}`, draft)
  }, [draft, currentChatId, saveDrafts])

  useEffect(() => {
    if (recorderRef.current?.state === 'recording') finishRecording(true)
    setReplyingTo(null)
    setSelectedMessageIds(new Set())
    setForwardingMessages(null)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchError('')
    searchRequestRef.current += 1
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id])

  const handleTogglePin = useCallback(
    (messageId: number | null) => {
      if (currentChatId !== null) onTogglePin(currentChatId, messageId)
    },
    [currentChatId, onTogglePin],
  )

  if (!chat) {
    return (
      <main className="chat-panel">
        <div className="empty-panel">
          <div className="empty-panel-icon">
            <ChatBubbleIcon width={26} height={26} />
          </div>
          <h3>Выберите чат</h3>
          <p>Откройте существующий чат слева или начните новую переписку.</p>
        </div>
      </main>
    )
  }

  const other = chat.members.find((m) => m.id !== currentUserId)
  const otherMembers = chat.members.filter((m) => m.id !== currentUserId)
  const typingNames = typingUserIds
    .map((id) => chat.members.find((m) => m.id === id)?.username)
    .filter(Boolean)

  function isMessageRead(message: Message) {
    if (message.senderId !== currentUserId) return false
    if (otherMembers.length === 0) return true
    return otherMembers.every((m) => {
      const state = chat!.readState.find((r) => r.userId === m.id)
      return (state?.lastReadMessageId ?? 0) >= message.id
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    if (!onSend(draft, undefined, replyingTo?.id)) return
    setDraft('')
    setReplyingTo(null)
  }

  function handleDraftChange(value: string) {
    setDraft(value)
    const now = Date.now()
    if (sendTypingEnabled && now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now
      onTyping(chat!.id)
    }
  }

  function messageTypeForFile(file: File): AttachmentMessageType {
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (file.type.startsWith('image/')) return 'image'
    if (file.type.startsWith('video/')) return 'video'
    if (file.type.startsWith('audio/') || file.type === 'application/ogg' || ['ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'webm'].includes(extension ?? '')) return 'audio'
    return 'file'
  }

  async function uploadAndSend(file: File, messageType = messageTypeForFile(file), duration?: number) {
    setUploadError('')
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Файл слишком большой (максимум 25 МБ)')
      return
    }
    setUploading(true)
    try {
      const res = await uploadFile(file)
      if (!onSend('', { ...res, duration, messageType }, replyingTo?.id)) throw new Error('Нет соединения. Повторите отправку после подключения.')
      setReplyingTo(null)
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadAndSend(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleComposerPaste(e: React.ClipboardEvent<HTMLElement>) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const fileItem = items.find((item) => item.kind === 'file')
    if (!fileItem) return
    const file = fileItem.getAsFile()
    if (!file || uploading) return
    e.preventDefault()
    void uploadAndSend(file)
  }

  /** Перетащили один или несколько файлов в окно чата — отправляем по очереди. */
  async function uploadDroppedFiles(files: FileList) {
    for (const file of Array.from(files)) {
      // eslint-disable-next-line no-await-in-loop -- нужна последовательная отправка, не параллельная
      await uploadAndSend(file)
    }
  }

  async function startRecording() {
    setUploadError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setUploadError('Запись голоса не поддерживается этим браузером')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recordingStreamRef.current = stream
      recorderRef.current = recorder
      recordingChunksRef.current = []
      cancelRecordingRef.current = false
      recordingStartedAtRef.current = Date.now()
      setRecordingSeconds(0)
      setIsRecording(true)
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        const cancelled = cancelRecordingRef.current
        const duration = Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1000))
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        stream.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        recorderRef.current = null
        recordingChunksRef.current = []
        if (!cancelled && blob.size > 0) {
          const extension = blob.type.includes('ogg') ? 'ogg' : 'webm'
          const file = new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type })
          void uploadAndSend(file, 'voice', duration)
        }
      })
      recorder.start(250)
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000))
      }, 250)
    } catch (err) {
      setUploadError((err as DOMException).name === 'NotAllowedError' ? 'Разрешите доступ к микрофону' : 'Не удалось начать запись')
    }
  }

  function finishRecording(cancelled: boolean) {
    cancelRecordingRef.current = cancelled
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    recordingTimerRef.current = null
    setIsRecording(false)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  function formatDuration(seconds: number) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    await runSearch(searchQuery)
  }

  async function runSearch(value: string) {
    const query = value.trim()
    if (query.length < 2) return
    const requestId = ++searchRequestRef.current
    setSearching(true)
    setSearchError('')
    try {
      const results = await onSearch(chat!.id, query)
      if (requestId === searchRequestRef.current) setSearchResults(results)
    } catch (err) {
      if (requestId === searchRequestRef.current) setSearchError((err as Error).message)
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }

  function handleSearchQueryChange(value: string) {
    setSearchQuery(value)
    setSearchError('')
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (value.trim().length < 2) {
      searchRequestRef.current += 1
      setSearchResults([])
      setSearching(false)
      return
    }
    searchTimerRef.current = setTimeout(() => void runSearch(value), 300)
  }

  function scrollToMessage(messageId: number) {
    const el = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setSearchOpen(false)
  }

  const headerColor = chat.type === 'group' ? '#3a3a44' : chat.type === 'saved' ? '#4a4a56' : other?.color
  const selectedMessages = messages.filter((message) => selectedMessageIds.has(message.id))
  const deletableSelectedMessages = selectedMessages.filter((message) => !message.pending)

  function toggleMessageSelected(message: Message) {
    if (message.pending || message.deleted) return
    setMessageSelected(message, !selectedMessageIds.has(message.id))
  }

  function setMessageSelected(message: Message, selected: boolean) {
    if (message.pending || message.deleted) return
    setSelectedMessageIds((previous) => {
      const next = new Set(previous)
      if (selected) next.add(message.id)
      else next.delete(message.id)
      return next
    })
  }

  function startSelectionDrag(message: Message, selected: boolean) {
    selectionDragRef.current = { active: true, selected, visited: new Set([message.id]) }
    setMessageSelected(message, selected)
  }

  // Mouse selection only starts once the pointer actually moves past the drag
  // threshold (see activatePreparedSelection) — a plain left-click-and-hold must
  // never by itself drop the user into multi-select, or it fights with normal
  // clicking/text selection. Touch keeps its own long-press path (useLongPress).
  function prepareDirectSelection(message: Message, x: number, y: number) {
    selectionPointerStartRef.current = { messageId: message.id, x, y }
  }

  function activatePreparedSelection(x: number, y: number) {
    const pending = selectionPointerStartRef.current
    if (!pending || Math.hypot(x - pending.x, y - pending.y) < 7) return false
    const message = messages.find((item) => item.id === pending.messageId)
    selectionPointerStartRef.current = null
    if (!message || message.type === 'call') return false
    selectionClickSuppressUntilRef.current = Date.now() + 600
    startSelectionDrag(message, true)
    return true
  }

  function nearestSelectableMessage(y: number) {
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
    let nearest: { message: Message; distance: number } | null = null
    for (const row of rows) {
      const message = messages.find((item) => item.id === Number(row.dataset.messageId))
      if (!message || message.type === 'call' || message.pending || message.deleted) continue
      const rect = row.getBoundingClientRect()
      const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
      if (!nearest || distance < nearest.distance) nearest = { message, distance }
    }
    return nearest?.message ?? null
  }

  function continueSelectionDrag(message: Message) {
    if (!selectionDragRef.current.active) return
    if (selectionDragRef.current.visited.has(message.id)) return
    selectionDragRef.current.visited.add(message.id)
    setMessageSelected(message, selectionDragRef.current.selected)
  }

  function clearSelection() {
    setSelectedMessageIds(new Set())
    closeSelectionContextMenu()
  }

  function forwardSelectedMessages() {
    setForwardingMessages(selectedMessages)
    closeSelectionContextMenu()
  }

  function deleteSelectedMessages() {
    if (deletableSelectedMessages.length === 0) return
    if (!window.confirm(`Удалить выбранные сообщения: ${deletableSelectedMessages.length}?`)) return
    deletableSelectedMessages.forEach((message) => onDelete(message.id))
    clearSelection()
  }

  function selectedMessagesMenuItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        label: `Переслать ${selectedMessages.length}`,
        icon: <ForwardIcon width={15} height={15} />,
        onClick: forwardSelectedMessages,
      },
    ]
    if (deletableSelectedMessages.length > 0) {
      items.push({
        label: `Удалить ${deletableSelectedMessages.length}`,
        icon: <TrashIcon width={15} height={15} />,
        danger: true,
        onClick: deleteSelectedMessages,
      })
    }
    items.push({
      label: 'Снять выделение',
      icon: <CloseIcon width={15} height={15} />,
      onClick: clearSelection,
    })
    return items
  }

  return (
    <main
      className="chat-panel"
      onContextMenuCapture={(event) => {
        if (selectedMessages.length === 0) return
        event.stopPropagation()
        openSelectionContextMenu(event, selectedMessagesMenuItems())
      }}
      onPaste={(event) => {
        const target = event.target as HTMLElement
        // В текстовом поле сначала даём сработать обычной вставке текста —
        // изображение из буфера перехватываем в любом другом месте чата.
        if (target.tagName === 'INPUT' || target.isContentEditable) return
        handleComposerPaste(event)
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        dragCounterRef.current += 1
        setIsDraggingFile(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
        if (dragCounterRef.current === 0) setIsDraggingFile(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.files.length) return
        event.preventDefault()
        dragCounterRef.current = 0
        setIsDraggingFile(false)
        void uploadDroppedFiles(event.dataTransfer.files)
      }}
    >
      <header className="chat-panel__header">
        <button className="icon-btn back-button" onClick={onBack} title="Назад">
          <BackIcon />
        </button>
        <button
          className="chat-panel__header-identity"
          onClick={onToggleInfoPanel}
          title="Открыть информацию о чате"
        >
          <span className="avatar-wrap">
            <span className="avatar avatar--md" style={{ background: headerColor }}>
              {chat.type === 'saved' ? (
                '★'
              ) : chat.type === 'group' ? (
                <AvatarImage url={chat.avatarUrl} fallback={<UsersIcon width={20} height={20} />} />
              ) : other?.avatarUrl ? (
                <AvatarImage url={other.avatarUrl} fallback={chat.name.charAt(0).toUpperCase()} />
              ) : (
                chat.name.charAt(0).toUpperCase()
              )}
            </span>
            {chat.type === 'direct' && other?.online && <span className="online-dot" />}
          </span>
          <span className="chat-panel__header-info">
            <h2>{chat.name}</h2>
            <span className={`chat-status${typingNames.length > 0 ? ' is-typing' : ''}`}>
              {typingNames.length > 0 ? `${typingNames.join(', ')} печатает...` : statusLabel(chat, other)}
            </span>
          </span>
        </button>
        <div className="chat-panel__header-actions">
          {chat.type === 'direct' && (
            <>
              <button className="icon-btn" title="Аудиозвонок" onClick={() => onStartCall(false)}>
                <PhoneIcon width={18} height={18} />
              </button>
              <button className="icon-btn" title="Видеозвонок" onClick={() => onStartCall(true)}>
                <VideoIcon width={18} height={18} />
              </button>
            </>
          )}
          <button
            className={`icon-btn${searchOpen ? ' is-active' : ''}`}
            title="Поиск по чату"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <SearchIcon />
          </button>
          <button
            className={`icon-btn${showInfoPanel ? ' is-active' : ''}`}
            title={showInfoPanel ? 'Закрыть панель информации' : 'Информация о чате'}
            onClick={onToggleInfoPanel}
          >
            <InfoPanelIcon />
          </button>
        </div>
      </header>

      {selectedMessages.length > 0 && (
        <div className="selection-toolbar" role="toolbar" aria-label="Действия с выбранными сообщениями">
          <div className="selection-toolbar__count">
            <span>{selectedMessages.length}</span>
            <div>
              выбрано
              <small>Зажмите мышь и проведите по сообщениям</small>
            </div>
          </div>
          <button type="button" className="selection-toolbar__action" onClick={forwardSelectedMessages}>
            <ForwardIcon width={17} height={17} />
            Переслать {selectedMessages.length}
          </button>
          <button
            type="button"
            className="selection-toolbar__action selection-toolbar__action--danger"
            disabled={deletableSelectedMessages.length === 0}
            onClick={deleteSelectedMessages}
          >
            <TrashIcon width={17} height={17} />
            Удалить {deletableSelectedMessages.length}
          </button>
          <button type="button" className="selection-toolbar__cancel" onClick={clearSelection}>Отмена</button>
        </div>
      )}

      {connectionStatus !== 'connected' && (
        <div className="connection-banner" role="status" aria-live="polite">
          <span className="connection-dot" />
          {connectionStatus === 'connecting' ? 'Подключение…' : connectionStatus === 'reconnecting' ? 'Соединение потеряно. Переподключаемся…' : 'Нет соединения'}
        </div>
      )}

      {chat.pinnedMessage && (
        <div className="pinned-banner" onClick={() => scrollToMessage(chat.pinnedMessage!.id)}>
          <PinIcon width={15} height={15} />
          <span className="pinned-text">{chat.pinnedMessage.text || chat.pinnedMessage.attachment?.name || (chat.pinnedMessage.type === 'voice' ? 'Голосовое сообщение' : chat.pinnedMessage.type === 'video' ? 'Видео' : chat.pinnedMessage.type === 'audio' ? 'Аудио' : chat.pinnedMessage.type === 'image' ? 'Фото' : 'Файл')}</span>
          <button
            className="icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin(chat.id, null)
            }}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="chat-search-panel">
          <form onSubmit={handleSearchSubmit}>
            <SearchIcon width={16} height={16} className="chat-search-panel__icon" />
            <input
              type="text"
              className="text-input"
              placeholder="Поиск по чату..."
              value={searchQuery}
              onChange={(e) => handleSearchQueryChange(e.target.value)}
              autoFocus
            />
          </form>
        </div>
      )}

      {searchOpen && searchQuery.trim().length > 0 ? (
        <div className="search-results-panel">
          {searchQuery.trim().length === 1 ? (
            <div className="search-feedback">Введите ещё один символ</div>
          ) : searching ? (
            <div className="search-feedback"><SpinnerIcon width={14} height={14} /> Поиск…</div>
          ) : searchError ? (
            <div className="search-feedback search-feedback--error">{searchError}</div>
          ) : searchResults.length === 0 ? (
            <div className="search-feedback">Ничего не найдено по запросу «{searchQuery.trim()}»</div>
          ) : (
            <>
              <div className="search-results-count">Найдено сообщений: {searchResults.length}</div>
              <ul className="chat-search-results">
                {searchResults.map((m) => {
                  const sender = chat.type === 'group' ? chat.members.find((mem) => mem.id === m.senderId) : undefined
                  return (
                    <li key={m.id}>
                      <button onClick={() => scrollToMessage(m.id)}>
                        {sender && <span className="chat-search-results__sender">{sender.displayName?.trim() || sender.username}</span>}
                        <span className="chat-search-results__snippet">{m.text ? highlightMatch(m.text, searchQuery) : m.attachment?.name || 'Медиа'}</span>
                        <span className="chat-search-results__date">{formatSearchResultDate(m.createdAt)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      ) : (
      <div
        className={`message-list${selectedMessages.length > 0 ? ' is-selecting' : ''}`}
        ref={containerRef}
        onScroll={handleListScroll}
        onClickCapture={(event) => {
          if (Date.now() >= selectionClickSuppressUntilRef.current) return
          selectionClickSuppressUntilRef.current = 0
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={(event) => {
          if (selectedMessages.length > 0 || event.pointerType !== 'mouse' || event.button !== 0) return
          const target = event.target as Element
          if (target.closest('button, a, input, textarea, audio, video, .message-text')) return
          const row = target.closest<HTMLElement>('[data-message-id]')
          const message = row
            ? messages.find((item) => item.id === Number(row.dataset.messageId))
            : nearestSelectableMessage(event.clientY)
          if (!message || message.type === 'call' || message.pending || message.deleted) return
          prepareDirectSelection(message, event.clientX, event.clientY)
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== 'mouse' || (event.buttons & 1) !== 1) return
          const activated = activatePreparedSelection(event.clientX, event.clientY)
          if (!selectionDragRef.current.active && !activated) return
          event.preventDefault()
          const row = (event.target as Element).closest<HTMLElement>('[data-message-id]')
          if (!row) return
          const messageId = Number(row.dataset.messageId)
          const hoveredMessage = messages.find((message) => message.id === messageId)
          if (hoveredMessage && hoveredMessage.type !== 'call') continueSelectionDrag(hoveredMessage)
        }}
      >
        {isLoadingMessages ? (
          <div className="message-skeleton" aria-hidden="true">
            {[true, false, false, true, false].map((own, i) => (
              <div key={i} className={`message-skeleton-row${own ? ' own' : ''}`}>
                <span className="skeleton message-skeleton-bubble" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="empty-panel">
            <div className="empty-panel-icon">
              <ChatBubbleIcon width={24} height={24} />
            </div>
            <h3>Нет сообщений</h3>
            <p>Напишите первым — начните разговор.</p>
          </div>
        ) : (
          messages.map((message, i) => {
            const prev = messages[i - 1]
            const showSeparator = !prev || dayLabel(prev.createdAt) !== dayLabel(message.createdAt)
            // Запись о звонке рвёт группу: она рисуется отдельной плашкой по центру.
            const grouped = Boolean(
              prev &&
                !showSeparator &&
                prev.type !== 'call' &&
                message.type !== 'call' &&
                prev.senderId === message.senderId &&
                message.createdAt - prev.createdAt < GROUP_WINDOW_MS,
            )
            const isOwn = message.senderId === currentUserId
            const showAvatarColumn = chat.type === 'group' && !isOwn
            const sender = showAvatarColumn ? chat.members.find((m) => m.id === message.senderId) : undefined
            const next = messages[i + 1]
            const isLastInGroup = !(
              next &&
              next.type !== 'call' &&
              dayLabel(next.createdAt) === dayLabel(message.createdAt) &&
              next.senderId === message.senderId &&
              next.createdAt - message.createdAt < GROUP_WINDOW_MS
            )
            if (message.type === 'call') {
              return (
                <div key={message.id} data-message-id={message.id}>
                  {showSeparator && <div className="date-separator">{dayLabel(message.createdAt)}</div>}
                  <CallMessage
                    message={message}
                    isOwn={isOwn}
                    onCallBack={chat.type === 'direct' ? (video) => onStartCall(video) : undefined}
                  />
                </div>
              )
            }
            return (
              <div key={message.id} data-message-id={message.id}>
                {showSeparator && <div className="date-separator">{dayLabel(message.createdAt)}</div>}
                <MessageBubble
                  message={message}
                  isOwn={isOwn}
                  grouped={grouped}
                  isLastInGroup={isLastInGroup}
                  isRead={isMessageRead(message)}
                  isPinned={chat.pinnedMessage?.id === message.id}
                  currentUserId={currentUserId}
                  showAvatarColumn={showAvatarColumn}
                  senderInfo={showAvatarColumn && !grouped && sender ? { username: sender.username, color: sender.color, avatarUrl: sender.avatarUrl } : null}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReply={setReplyingTo}
                  onForward={(selected) => setForwardingMessages([selected])}
                  onReact={onReact}
                  onTogglePin={handleTogglePin}
                  selectionMode={selectedMessages.length > 0}
                  isSelected={selectedMessageIds.has(message.id)}
                  onToggleSelected={toggleMessageSelected}
                  onSelectionDragStart={startSelectionDrag}
                  onSelectionDragEnter={continueSelectionDrag}
                  onOpenImage={(url, name) => setLightboxImage({ url, name })}
                />
              </div>
            )
          })
        )}
        <div className="message-list__anchor">
          <button
            type="button"
            className={`scroll-down-fab${showScrollDown ? ' is-visible' : ''}`}
            onClick={() => scrollToBottom(true)}
            tabIndex={showScrollDown ? 0 : -1}
            aria-hidden={!showScrollDown}
            title={unseenCount > 0 ? `Новых сообщений: ${unseenCount}` : 'К последнему сообщению'}
          >
            <ArrowDownIcon width={18} height={18} />
            {unseenCount > 0 && (
              <span className="scroll-down-fab__badge">{unseenCount > 99 ? '99+' : unseenCount}</span>
            )}
          </button>
        </div>
      </div>
      )}

      {selectionContextMenu && (
        <ContextMenu {...selectionContextMenu} onClose={closeSelectionContextMenu} />
      )}

      {replyingTo && (
        <div className="reply-preview">
          <span className="reply-preview-accent" />
          <div className="reply-preview-text">{replyingTo.text || replyingTo.attachment?.name || (replyingTo.type === 'voice' ? 'Голосовое сообщение' : replyingTo.type === 'video' ? 'Видео' : replyingTo.type === 'audio' ? 'Аудио' : replyingTo.type === 'image' ? 'Фото' : 'Файл')}</div>
          <button onClick={() => setReplyingTo(null)}>
            <CloseIcon width={15} height={15} />
          </button>
        </div>
      )}

      {uploadError && <div className="composer-error" role="alert">{uploadError}</div>}

      <form className="message-input" onSubmit={handleSubmit}>
        <input
          type="file"
          ref={fileInputRef}
          className="hidden-file-input"
          onChange={handleFilePick}
          accept="image/*,video/mp4,video/webm,video/quicktime,audio/*,.ogg,.oga,.opus,.pdf,.txt,.csv,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || isRecording}
          title="Прикрепить медиа или файл"
        >
          {uploading ? <SpinnerIcon width={18} height={18} /> : <AttachIcon width={18} height={18} />}
        </button>
        {isRecording ? (
          <>
            <div className="voice-recording" aria-live="polite">
              <div className="voice-recording__status">
                <span className="voice-recording__dot" />
                <strong>Запись</strong>
                <time>{formatDuration(recordingSeconds)}</time>
              </div>
              <div className="voice-recording__wave" aria-hidden="true">
                {Array.from({ length: 28 }, (_, index) => (
                  <span key={index} style={{ animationDelay: `${(index % 7) * -0.11}s` }} />
                ))}
              </div>
            </div>
            <button type="button" className="voice-cancel" onClick={() => finishRecording(true)} title="Удалить запись" aria-label="Удалить запись">
              <CloseIcon width={18} height={18} />
              <span>Отмена</span>
            </button>
            <button type="button" className="send-button voice-stop" onClick={() => finishRecording(false)} title="Отправить голосовое" aria-label="Отправить голосовое">
              <SendIcon width={17} height={17} />
            </button>
          </>
        ) : (
          <>
        <div className="composer-emoji-wrap" ref={emojiWrapRef}>
          <button
            type="button"
            className={`icon-btn${showComposerEmoji ? ' is-active' : ''}`}
            onClick={() => setShowComposerEmoji((v) => !v)}
            title="Эмодзи"
          >
            <SmileIcon width={18} height={18} />
          </button>
          {showComposerEmoji && (
            <div className="composer-emoji-picker">
              {COMPOSER_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    setDraft((d) => d + emoji)
                    setShowComposerEmoji(false)
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          className="text-input message-composer"
          rows={1}
          placeholder="Напишите сообщение..."
          value={draft}
          maxLength={4000}
          onChange={(e) => handleDraftChange(e.target.value)}
          onInput={(e) => {
            e.currentTarget.style.height = 'auto'
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 120)}px`
          }}
          onKeyDown={(e) => {
            const shouldSend = (enterToSend && e.key === 'Enter' && !e.shiftKey) || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
            if (!shouldSend) return
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }}
        />
        {!draft.trim() && (
          <button
            type="button"
            className="icon-btn voice-start"
            onClick={() => void startRecording()}
            disabled={uploading || connectionStatus !== 'connected'}
            title="Записать голосовое сообщение"
          >
            <MicIcon width={19} height={19} />
          </button>
        )}
        {draft.trim() && (
          <button type="submit" className="send-button" disabled={connectionStatus !== 'connected'} title={connectionStatus === 'connected' ? 'Отправить' : 'Нет соединения'}>
            <SendIcon width={17} height={17} />
          </button>
        )}
          </>
        )}
      </form>

      {forwardingMessages && (
        <ForwardModal
          chats={chats}
          currentUserId={currentUserId}
          messageCount={forwardingMessages.length}
          onPick={(targetChatId) => {
            forwardingMessages.forEach((message) => onForward(message.id, targetChatId))
            setForwardingMessages(null)
            clearSelection()
          }}
          onClose={() => setForwardingMessages(null)}
        />
      )}

      {lightboxImage && (
        <MediaLightbox url={lightboxImage.url} name={lightboxImage.name} onClose={() => setLightboxImage(null)} />
      )}

      {isDraggingFile && (
        <div className="chat-panel__drop-overlay">
          <div className="chat-panel__drop-card">
            <AttachIcon width={28} height={28} />
            <strong>Отпустите, чтобы отправить</strong>
          </div>
        </div>
      )}
    </main>
  )
}
