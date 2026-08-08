import { memo, useRef, useState } from 'react'
import type { Message } from '../types'
import { resolveUrl } from '../api/client'
import { AvatarImage } from './AvatarImage'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { useLongPress } from '../hooks/useLongPress'
import { showToast } from '../hooks/useToast'
import { VoiceMessage } from './VoiceMessage'
import {
  CheckIcon,
  AttachIcon,
  CopyIcon,
  DoubleCheckIcon,
  EditIcon,
  ForwardIcon,
  PinIcon,
  ReplyIcon,
  TrashIcon,
} from './icons'

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

interface MessageSenderInfo {
  username: string
  color: string
  avatarUrl?: string | null
}

interface MessageBubbleProps {
  message: Message
  isOwn: boolean
  grouped: boolean
  isLastInGroup: boolean
  isRead: boolean
  isPinned: boolean
  currentUserId: number
  showAvatarColumn: boolean
  senderInfo: MessageSenderInfo | null
  onEdit: (messageId: number, text: string) => void
  onDelete: (messageId: number) => void
  onReply: (message: Message) => void
  onForward: (message: Message) => void
  onReact: (messageId: number, emoji: string) => void
  onTogglePin: (messageId: number | null) => void
  selectionMode: boolean
  isSelected: boolean
  onToggleSelected: (message: Message) => void
  onSelectionDragStart: (message: Message, selected: boolean) => void
  onSelectionDragEnter: (message: Message) => void
  onOpenImage: (url: string, name: string) => void
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

function attachmentLabel(message: Message) {
  if (message.type === 'image') return 'Фото'
  if (message.type === 'video') return 'Видео'
  if (message.type === 'voice') return 'Голосовое сообщение'
  if (message.type === 'audio') return 'Аудио'
  return message.attachment?.name || 'Файл'
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isOwn,
  grouped,
  isLastInGroup,
  isRead,
  isPinned,
  currentUserId,
  showAvatarColumn,
  senderInfo,
  onEdit,
  onDelete,
  onReply,
  onForward,
  onReact,
  onTogglePin,
  selectionMode,
  isSelected,
  onToggleSelected,
  onSelectionDragStart,
  onSelectionDragEnter,
  onOpenImage,
}: MessageBubbleProps) {
  const emojiOnly = Boolean(message.text && /^(?:\p{Extended_Pictographic}|️|‍|\s){1,16}$/u.test(message.text))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const rootRef = useRef<HTMLDivElement>(null)
  const skipNextSelectionClickRef = useRef(false)
  const { menu, openFromMouseEvent, openFromTouchEvent, close: closeMenu } = useContextMenu()

  function buildMenuItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: 'Ответить', icon: <ReplyIcon width={15} height={15} />, onClick: () => onReply(message) },
    ]
    if (message.text) {
      items.push({
        label: 'Копировать',
        icon: <CopyIcon width={15} height={15} />,
        onClick: () => {
          navigator.clipboard.writeText(message.text).catch(() => {})
          showToast('Скопировано')
        },
      })
    }
    items.push({ label: 'Переслать', icon: <ForwardIcon width={15} height={15} />, onClick: () => onForward(message) })
    items.push({ label: 'Выбрать', icon: <CheckIcon width={15} height={15} />, onClick: () => onToggleSelected(message) })
    items.push({
      label: isPinned ? 'Открепить' : 'Закрепить',
      icon: <PinIcon width={15} height={15} />,
      onClick: () => onTogglePin(isPinned ? null : message.id),
    })
    if (isOwn && message.type === 'text') {
      items.push({ label: 'Изменить', icon: <EditIcon width={15} height={15} />, onClick: () => setEditing(true) })
    }
    if (isOwn) {
      items.push({ label: 'Удалить', icon: <TrashIcon width={15} height={15} />, danger: true, onClick: () => onDelete(message.id) })
    }
    return items
  }

  const longPress = useLongPress((event) => {
    if (editing || message.pending) return
    openFromTouchEvent(event, buildMenuItems())
  })

  if (message.deleted) {
    return (
      <div className={`message-row${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}${isLastInGroup ? ' last-in-group' : ''}`}>
        <div className="message-bubble deleted">
          <div className="deleted-bubble">
            <TrashIcon width={14} height={14} />
            <span className="message-text muted">Сообщение удалено</span>
          </div>
        </div>
      </div>
    )
  }

  function handleSave() {
    if (draft.trim() && draft.trim() !== message.text) onEdit(message.id, draft.trim())
    setEditing(false)
  }

  return (
    <div
      className={`message-row${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}${isLastInGroup ? ' last-in-group' : ''}${selectionMode ? ' selection-mode' : ''}${isSelected ? ' is-selected' : ''}`}
      ref={rootRef}
      onPointerDownCapture={(event) => {
        if (!selectionMode || message.pending || event.pointerType !== 'mouse' || event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        skipNextSelectionClickRef.current = true
        onSelectionDragStart(message, !isSelected)
      }}
      onPointerEnter={(event) => {
        if (!selectionMode || message.pending || event.pointerType !== 'mouse' || (event.buttons & 1) !== 1) return
        event.preventDefault()
        onSelectionDragEnter(message)
      }}
      onClickCapture={(event) => {
        if (!selectionMode || message.pending) return
        event.preventDefault()
        event.stopPropagation()
        if (skipNextSelectionClickRef.current) {
          skipNextSelectionClickRef.current = false
          return
        }
        onToggleSelected(message)
      }}
    >
      {showAvatarColumn && (
        senderInfo ? (
          <span className="message-avatar" style={{ background: senderInfo.color }}>
            <AvatarImage url={senderInfo.avatarUrl} fallback={senderInfo.username.charAt(0).toUpperCase()} />
          </span>
        ) : (
          <span className="message-avatar-spacer" />
        )
      )}
      <div className="message-bubble-column">
        {senderInfo && (
          <div className="message-sender" style={{ color: senderInfo.color }}>
            {senderInfo.username}
          </div>
        )}
        <div
          className="message-bubble"
          onContextMenu={(e) => {
            if (editing || message.pending) return
            openFromMouseEvent(e, buildMenuItems())
          }}
          {...(message.pending || editing ? {} : longPress)}
        >
          {message.forwarded && (
            <div className="forwarded-label">
              <ForwardIcon width={11} height={11} /> Переслано
            </div>
          )}

          {message.replyTo && (
            <div className="reply-quote">
              {message.replyTo.deleted ? 'Сообщение удалено' : message.replyTo.text || attachmentLabel(message.replyTo)}
            </div>
          )}

          {message.type === 'image' && message.attachmentUrl && (
            <button
              type="button"
              className="message-media-link"
              onClick={() => onOpenImage(message.attachmentUrl!, message.attachment?.name || 'Изображение')}
            >
              <img className="message-image" src={resolveUrl(message.attachmentUrl)} alt={message.attachment?.name || 'Изображение'} loading="lazy" />
            </button>
          )}

          {message.type === 'video' && message.attachmentUrl && (
            <video className="message-video" src={resolveUrl(message.attachmentUrl)} controls preload="metadata" />
          )}

          {(message.type === 'voice' || message.type === 'audio') && message.attachmentUrl && (
            <VoiceMessage
              url={message.attachmentUrl}
              duration={message.attachment?.duration}
              messageId={message.id}
              label={message.type === 'voice' ? 'Голосовое' : message.attachment?.name || 'Аудио'}
            />
          )}

          {message.type === 'file' && message.attachmentUrl && (
            <a className="message-file" href={resolveUrl(message.attachmentUrl)} target="_blank" rel="noreferrer" download={message.attachment?.name}>
              <span className="message-file__icon"><AttachIcon width={20} height={20} /></span>
              <span className="message-file__info">
                <strong>{message.attachment?.name || 'Файл'}</strong>
                <small>{formatFileSize(message.attachment?.size)}</small>
              </span>
            </a>
          )}

          {editing ? (
            <div className="message-edit-form">
              <input
                value={draft}
                maxLength={4000}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave()
                  if (e.key === 'Escape') setEditing(false)
                }}
                autoFocus
              />
              <button onClick={handleSave}>
                <CheckIcon width={16} height={16} />
              </button>
            </div>
          ) : (
            message.text && (
              <div className={`message-text${emojiOnly ? ' emoji-only' : ''}`}>
                {message.text}
                <span className="message-time message-time--float">
                  {message.editedAt && <span className="edited-label">изменено</span>}
                  {message.pending ? 'Отправка…' : formatTime(message.createdAt)}
                  {isOwn && !message.pending && (
                    <span className="read-check">{isRead ? <DoubleCheckIcon /> : <CheckIcon width={14} height={14} />}</span>
                  )}
                </span>
              </div>
            )
          )}

          {message.reactions && message.reactions.length > 0 && (
            <div className="reaction-row">
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className={`reaction-pill${r.userIds.includes(currentUserId) ? ' mine' : ''}`}
                  onClick={() => onReact(message.id, r.emoji)}
                >
                  {r.emoji} {r.userIds.length}
                </button>
              ))}
            </div>
          )}

          {(!message.text || editing) && (
            <div className="message-time">
              {message.editedAt && <span className="edited-label">изменено</span>}
              {message.pending ? 'Отправка…' : formatTime(message.createdAt)}
              {isOwn && !message.pending && (
                <span className="read-check">{isRead ? <DoubleCheckIcon /> : <CheckIcon width={14} height={14} />}</span>
              )}
            </div>
          )}
        </div>
      </div>
      {selectionMode && !message.pending && (
        <span className={`message-select-indicator${isSelected ? ' is-selected' : ''}`} aria-hidden="true">
          {isSelected && <CheckIcon width={14} height={14} />}
        </span>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          reactions={message.pending || editing ? undefined : QUICK_EMOJIS}
          onReact={(emoji) => onReact(message.id, emoji)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
})
