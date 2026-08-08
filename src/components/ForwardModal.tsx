import type { Chat } from '../types'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { AvatarImage } from './AvatarImage'
import { BookmarkIcon, CloseIcon, UsersIcon } from './icons'

interface ForwardModalProps {
  chats: Chat[]
  currentUserId: number
  messageCount?: number
  onPick: (chatId: number) => void
  onClose: () => void
}

export function ForwardModal({ chats, currentUserId, messageCount = 1, onPick, onClose }: ForwardModalProps) {
  useEscapeToClose(onClose)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{messageCount > 1 ? `Переслать сообщения: ${messageCount}` : 'Переслать в...'}</h2>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon width={17} height={17} />
          </button>
        </div>
        <ul className="forward-chat-list">
          {chats.map((chat) => {
            const other = chat.members.find((m) => m.id !== currentUserId)
            return (
              <li key={chat.id}>
                <button onClick={() => onPick(chat.id)}>
                  <span
                    className="avatar avatar--sm"
                    style={{
                      background:
                        chat.type === 'saved' ? '#4a4a56' : chat.type === 'group' ? '#3a3a44' : other?.color,
                    }}
                  >
                    {chat.type === 'saved' ? (
                      <BookmarkIcon width={15} height={15} />
                    ) : chat.type === 'group' ? (
                      <UsersIcon width={15} height={15} />
                    ) : other?.avatarUrl ? (
                      <AvatarImage url={other.avatarUrl} fallback={chat.name.charAt(0).toUpperCase()} />
                    ) : (
                      chat.name.charAt(0).toUpperCase()
                    )}
                  </span>
                  {chat.name}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
