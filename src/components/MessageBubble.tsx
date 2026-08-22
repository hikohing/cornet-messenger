import { memo, useRef, useState } from 'react'
import type { Message } from '../types'
import { AvatarImage } from './AvatarImage'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { useLongPress } from '../hooks/useLongPress'
import { showToast } from '../hooks/useToast'
import { renderFormattedText } from '../utils/formatting'
import { stripFormatting } from '../utils/markup'
import { VoiceMessage } from './VoiceMessage'
import {
  AlertIcon,
  CheckIcon,
  AttachIcon,
  CopyIcon,
  DoubleCheckIcon,
  EditIcon,
  ForwardIcon,
  LockIcon,
  PinIcon,
  ClockIcon,
  ReplyIcon,
  SpinnerIcon,
  TrashIcon,
} from './icons'
import { useAttachmentSource } from '../hooks/useAttachmentSource'
import { formatFileSize } from '../utils/media'
import { MessageMedia, type MediaViewerTarget } from './MessageMedia'

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
  /** Второй аргумент — расшифрованный текст: у сервера его может не быть. */
  onReport: (message: Message, text: string) => void
  onReact: (messageId: number, emoji: string) => void
  onTogglePin: (messageId: number | null) => void
  selectionMode: boolean
  isSelected: boolean
  onToggleSelected: (message: Message) => void
  onSelectionDragStart: (message: Message, selected: boolean) => void
  onSelectionDragEnter: (message: Message) => void
  onOpenMedia: (target: MediaViewerTarget) => void
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function attachmentLabel(message: Message) {
  if (message.type === 'image') return 'Фото'
  if (message.type === 'video') return 'Видео'
  if (message.type === 'voice') return 'Голосовое сообщение'
  if (message.type === 'audio') return 'Аудио'
  return message.attachment?.name || 'Файл'
}

const DECRYPTION_ERROR_LABELS: Record<NonNullable<Message['decryptionFailed']>, string> = {
  signature_invalid: 'Подпись отправителя недействительна',
  key_missing: 'Нет ключа для расшифровки',
  decrypt_failed: 'Не удалось расшифровать',
}

/**
 * Текст цитаты в ответе. Разметка тут не рендерится — показываем чистый текст,
 * иначе маркеры вроде ** торчали бы в превью.
 *
 * Отдельная ветка для зашифрованных нужна потому, что у них серверный `text`
 * пуст: без неё пустая строка проваливалась в attachmentLabel, и ответ на
 * обычное текстовое сообщение подписывался «Файл».
 */
function replyQuoteText(replyTo: Message): string {
  if (replyTo.deleted) return 'Сообщение удалено'
  if (replyTo.type === 'poll') return `📊 ${replyTo.poll?.question ?? 'Опрос'}`
  const resolved = resolveMessageText(replyTo)
  if (resolved.text) return stripFormatting(resolved.text)
  if (replyTo.encrypted) return '🔒 Зашифрованное сообщение'
  return attachmentLabel(replyTo)
}

/** Resolves what to show for a message body: plaintext as-is, or the decrypted/pending/failed state of an E2E-encrypted one. */
function resolveMessageText(message: Message): { text: string; pending: boolean; failed: string | null } {
  if (!message.encrypted) return { text: message.text, pending: false, failed: null }
  if (message.decryptedText !== undefined) return { text: message.decryptedText, pending: false, failed: null }
  if (message.decryptionFailed) return { text: '', pending: false, failed: DECRYPTION_ERROR_LABELS[message.decryptionFailed] }
  return { text: '', pending: true, failed: null }
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
  onReport,
  onReact,
  onTogglePin,
  selectionMode,
  isSelected,
  onToggleSelected,
  onSelectionDragStart,
  onSelectionDragEnter,
  onOpenMedia,
}: MessageBubbleProps) {
  const resolved = resolveMessageText(message)
  const emojiOnly = Boolean(resolved.text && /^(?:\p{Extended_Pictographic}|️|‍|\s){1,16}$/u.test(resolved.text))
  const [editing, setEditing] = useState(false)
  // Seeded when edit mode opens, not at mount: the text can arrive later (async
  // decryption) or change (a previous edit), and a mount-time seed would leave
  // the edit box holding stale — or, for an encrypted row, empty — text.
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const skipNextSelectionClickRef = useRef(false)
  const { menu, openFromMouseEvent, openFromTouchEvent, close: closeMenu } = useContextMenu()
  const media = useAttachmentSource(message)
  // Кадр во всю ширину пузыря: у него нет полей, а подпись и время ложатся
  // поверх или под ним — отсюда отдельные классы пузыря.
  // Видео показывается кадром даже до загрузки байтов: в зашифрованном чате их
  // тянут по нажатию, но выглядеть это должно как видео, а не как строка файла.
  const framedMedia = media.type === 'image'
    ? Boolean(media.src)
    : media.type === 'video' && Boolean(media.src || media.load)
  const caption = !editing && Boolean(resolved.text || resolved.pending || resolved.failed)
  // Время лежит поверх кадра только у медиа без подписи: с подписью оно
  // становится частью её последней строки, а в режиме правки — отдельной.
  const showTimeOnMedia = framedMedia && !caption && !editing

  const timestamp = (
    <>
      {message.editedAt && <span className="edited-label">изменено</span>}
      {formatTime(message.createdAt)}
      {isOwn && (
        // Как в Telegram: часы → галочка (сервер принял) → две галочки
        // (прочитано). Без единой надписи и без прыжка подписи — время на
        // месте с самого начала.
        <span className="read-check">
          {message.pending ? <ClockIcon width={13} height={13} /> : isRead ? <DoubleCheckIcon /> : <CheckIcon width={14} height={14} />}
        </span>
      )}
    </>
  )

  function buildMenuItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: 'Ответить', icon: <ReplyIcon width={15} height={15} />, onClick: () => onReply(message) },
    ]
    if (resolved.text) {
      items.push({
        label: 'Копировать',
        icon: <CopyIcon width={15} height={15} />,
        onClick: () => {
          navigator.clipboard.writeText(resolved.text).catch(() => {})
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
    if (isOwn && message.type === 'text' && !resolved.pending) {
      items.push({
        label: 'Изменить',
        icon: <EditIcon width={15} height={15} />,
        onClick: () => {
          setDraft(resolved.text)
          setEditing(true)
        },
      })
    }
    // Жаловаться на себя незачем — пункт есть только у чужих сообщений.
    if (!isOwn) {
      items.push({
        label: 'Пожаловаться',
        icon: <AlertIcon width={15} height={15} />,
        danger: true,
        onClick: () => onReport(message, resolved.text),
      })
    }
    items.push({ label: 'Удалить', icon: <TrashIcon width={15} height={15} />, danger: true, onClick: () => onDelete(message.id) })
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
    if (draft.trim() && draft.trim() !== resolved.text) onEdit(message.id, draft.trim())
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
          className={`message-bubble${framedMedia ? ' has-media' : ''}${framedMedia && caption ? ' has-caption' : ''}`}
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
            <div className="reply-quote">{replyQuoteText(message.replyTo)}</div>
          )}

          {/* Зашифрованное вложение: конверт ещё не открыт, поэтому неизвестны
              ни тип, ни имя — показываем нейтральную заглушку. */}
          {media.status === 'locked' && (
            <div className="message-file message-file--locked">
              <span className="message-file__icon"><LockIcon width={18} height={18} /></span>
              <span className="message-file__info">
                <strong>Зашифрованное вложение</strong>
                <small>{formatFileSize(media.size)}</small>
              </span>
            </div>
          )}

          {framedMedia && (
            <MessageMedia
              media={media}
              onOpen={onOpenMedia}
              overlay={showTimeOnMedia ? <span className="message-time message-time--on-media">{timestamp}</span> : undefined}
            />
          )}

          {(media.type === 'voice' || media.type === 'audio') && media.src && (
            <VoiceMessage
              src={media.src}
              duration={media.duration}
              messageId={message.id}
              label={media.type === 'voice' ? 'Голосовое' : media.name || 'Аудио'}
            />
          )}

          {media.type === 'file' && media.src && (
            <a className="message-file" href={media.src} target="_blank" rel="noreferrer" download={media.name}>
              <span className="message-file__icon"><AttachIcon width={20} height={20} /></span>
              <span className="message-file__info">
                <strong>{media.name}</strong>
                <small>{formatFileSize(media.size)}</small>
              </span>
            </a>
          )}

          {/* Видео и документы не тянем сами: 25 МБ на каждое открытие чата —
              слишком дорого для мобильного трафика. */}
          {media.load && !media.src && media.status !== 'error' && media.type !== 'video' && (
            <button type="button" className="message-file message-file--pending" onClick={media.load} disabled={media.status === 'decrypting'}>
              <span className="message-file__icon">
                {media.status === 'decrypting' ? <SpinnerIcon width={18} height={18} /> : <LockIcon width={18} height={18} />}
              </span>
              <span className="message-file__info">
                <strong>{media.name}</strong>
                <small>{media.status === 'decrypting' ? 'Расшифровка…' : `${formatFileSize(media.size)} · нажмите, чтобы открыть`}</small>
              </span>
            </button>
          )}

          {media.status === 'error' && (
            <div className="message-file message-file--locked">
              <span className="message-file__icon"><AlertIcon width={18} height={18} /></span>
              <span className="message-file__info">
                <strong>{media.name}</strong>
                <small>Не удалось расшифровать вложение</small>
              </span>
            </div>
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
          ) : resolved.pending ? (
            <div className="message-text muted">
              <LockIcon width={13} height={13} /> Расшифровка…
            </div>
          ) : resolved.failed ? (
            <div className="message-text muted">
              <LockIcon width={13} height={13} /> {resolved.failed}
            </div>
          ) : (
            resolved.text && (
              <div className={`message-text${emojiOnly ? ' emoji-only' : ''}`}>
                {message.encrypted && <LockIcon width={12} height={12} className="message-encrypted-icon" />}
                {renderFormattedText(resolved.text)}
                <span className="message-time message-time--float">{timestamp}</span>
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

          {!caption && !showTimeOnMedia && <div className="message-time">{timestamp}</div>}
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
