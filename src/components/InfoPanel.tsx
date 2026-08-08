import { useRef, useState } from 'react'
import type { Chat, User } from '../types'
import { uploadFile } from '../api/client'
import { AvatarImage } from './AvatarImage'
import { AvatarLightbox } from './AvatarLightbox'
import { BackIcon, BlockIcon, BookmarkIcon, CakeIcon, CameraIcon, CalendarIcon, CloseIcon, LogoutIcon, MessageIcon, PinIcon, UsersIcon } from './icons'
import { showToast } from '../hooks/useToast'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { profileBannerStyle, profileCardColorStyle } from '../utils/profile'

interface InfoPanelProps {
  chat: Chat
  currentUserId: number
  blockedUserIds: Set<number>
  onClose: () => void
  onScrollToPinned: () => void
  onTogglePin: (messageId: number | null) => void
  onUpdateChatInfo: (patch: { name?: string; description?: string; avatarUrl?: string | null }) => Promise<void>
  onMessageUser: (username: string) => void
  onLeaveGroup: () => Promise<void>
  onBlockUser: (userId: number) => Promise<void>
  onUnblockUser: (userId: number) => Promise<void>
}

function formatLastSeen(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatBirthDate(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatMemberSince(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

function ProfileCard({ user, onOpenAvatar, blocked, onToggleBlock }: {
  user: User
  onOpenAvatar: () => void
  blocked: boolean
  onToggleBlock: () => void
}) {
  const presence = user.online
    ? 'в сети'
    : user.showLastSeen && user.lastSeenAt
      ? `был(а) в сети ${formatLastSeen(user.lastSeenAt)}`
      : 'не в сети'
  const displayName = user.displayName?.trim() || user.username

  return (
    <div className={`profile-card profile-card--${user.profileEffect ?? 'none'} profile-card--theme-${user.profileTheme ?? 'default'} profile-card--frame-${user.profileFrame ?? 'none'}${user.profileSecondaryColor ? ' profile-card--custom-colors' : ''}`} style={profileCardColorStyle(user)}>
      <div className="profile-card__banner" style={profileBannerStyle(user)} />
      <div className="profile-card__avatar-row">
        <div className="profile-card__avatar-slot">
          <button
            className="profile-card__avatar"
            style={{ background: user.color }}
            onClick={onOpenAvatar}
            disabled={!user.avatarUrl}
            aria-label={user.avatarUrl ? 'Открыть фотографию профиля' : 'Фотография профиля не загружена'}
          >
            <AvatarImage url={user.avatarUrl} fallback={displayName.charAt(0).toUpperCase()} />
          </button>
          <span className={`profile-card__deco profile-card__deco--${user.avatarDecoration ?? 'none'}`} aria-hidden="true" />
          {user.online && <span className="profile-card__status-dot" title="в сети" />}
        </div>
      </div>
      <div className={`profile-card__identity profile-nameplate--${user.nameplateStyle ?? 'none'}`}>
        <h4 className={`profile-name--${user.nameStyle ?? 'plain'}`}>{displayName}</h4>
        <p className="profile-card__handle">@{user.username}</p>
        <span className={`profile-card__presence-pill${user.online ? ' is-online' : ''}`}>{presence}</span>
      </div>

      <div className="profile-card__panel">
        <section className="profile-card__section">
          <h5>О себе</h5>
          <p className="info-panel__bio">{user.bio?.trim() ? user.bio : 'Пользователь ничего о себе не рассказал.'}</p>
        </section>

        {user.birthDate && (
          <section className="profile-card__section">
            <h5>Дата рождения</h5>
            <p className="info-panel__hint">
              <CakeIcon width={14} height={14} /> {formatBirthDate(user.birthDate)}
            </p>
          </section>
        )}

        {user.createdAt && (
          <section className="profile-card__section">
            <h5>Участник CorNet с</h5>
            <p className="info-panel__hint">
              <CalendarIcon width={14} height={14} /> {formatMemberSince(user.createdAt)}
            </p>
          </section>
        )}

        <section className="profile-card__section">
          <button className={`profile-card__block-button${blocked ? ' is-blocked' : ''}`} onClick={onToggleBlock}>
            <BlockIcon width={14} height={14} />
            {blocked ? 'Разблокировать' : 'Заблокировать'}
          </button>
        </section>
      </div>
    </div>
  )
}

function ProfileView({ user, onBack, onMessage, onOpenAvatar, blocked, onToggleBlock }: {
  user: User
  onBack: () => void
  onMessage: () => void
  onOpenAvatar: () => void
  blocked: boolean
  onToggleBlock: () => void
}) {
  return (
    <>
      <header className="info-panel__header">
        <button className="icon-btn" onClick={onBack} aria-label="Назад">
          <BackIcon width={18} height={18} />
        </button>
        <h3>Профиль</h3>
        <span />
      </header>
      <div className="info-panel__body info-panel__body--profile">
        <ProfileCard user={user} onOpenAvatar={onOpenAvatar} blocked={blocked} onToggleBlock={onToggleBlock} />
        {!blocked && (
          <button className="info-panel__message-button" onClick={onMessage}>
            <MessageIcon width={16} height={16} /> Написать сообщение
          </button>
        )}
      </div>
    </>
  )
}

export function InfoPanel({ chat, currentUserId, blockedUserIds, onClose, onScrollToPinned, onTogglePin, onUpdateChatInfo, onMessageUser, onLeaveGroup, onBlockUser, onUnblockUser }: InfoPanelProps) {
  const [viewingMember, setViewingMember] = useState<User | null>(null)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState(chat.description ?? '')
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [avatarPreviewUser, setAvatarPreviewUser] = useState<User | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const other = chat.members.find((m) => m.id !== currentUserId)
  const headerColor = chat.type === 'group' ? '#3a3a44' : chat.type === 'saved' ? '#4a4a56' : other?.color
  useEscapeToClose(() => avatarPreviewUser ? setAvatarPreviewUser(null) : onClose())

  function toggleBlock(userId: number) {
    void (blockedUserIds.has(userId) ? onUnblockUser(userId) : onBlockUser(userId)).catch((err) => showToast((err as Error).message))
  }

  if (viewingMember) {
    return (
      <aside className="info-panel">
        <ProfileView
          user={viewingMember}
          onBack={() => setViewingMember(null)}
          onMessage={() => onMessageUser(viewingMember.username)}
          onOpenAvatar={() => setAvatarPreviewUser(viewingMember)}
          blocked={blockedUserIds.has(viewingMember.id)}
          onToggleBlock={() => toggleBlock(viewingMember.id)}
        />
        {avatarPreviewUser?.avatarUrl && <AvatarLightbox url={avatarPreviewUser.avatarUrl} name={avatarPreviewUser.displayName || avatarPreviewUser.username} onClose={() => setAvatarPreviewUser(null)} />}
      </aside>
    )
  }

  async function handleAvatarPick(file: File | undefined) {
    if (!file) return
    setUploadingAvatar(true)
    try {
      const res = await uploadFile(file)
      await onUpdateChatInfo({ avatarUrl: res.url })
    } catch (err) {
      showToast((err as Error).message)
    } finally {
      setUploadingAvatar(false)
      if (avatarInputRef.current) avatarInputRef.current.value = ''
    }
  }

  async function handleLeave() {
    setLeaving(true)
    try {
      await onLeaveGroup()
    } catch (err) {
      showToast((err as Error).message)
      setLeaving(false)
      setConfirmingLeave(false)
    }
  }

  async function saveDescription() {
    setEditingDescription(false)
    if (descriptionDraft === chat.description) return
    try {
      await onUpdateChatInfo({ description: descriptionDraft })
    } catch (err) {
      showToast((err as Error).message)
      setDescriptionDraft(chat.description ?? '')
    }
  }

  return (
    <aside className="info-panel">
      <header className="info-panel__header">
        <h3>{chat.type === 'group' ? 'Информация о группе' : 'Информация о чате'}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть панель">
          <CloseIcon width={17} height={17} />
        </button>
      </header>

      <div className={`info-panel__body${chat.type === 'direct' && other ? ' info-panel__body--profile' : ''}`}>
        {chat.type === 'direct' && other ? (
          <ProfileCard
            user={other}
            onOpenAvatar={() => setAvatarPreviewUser(other)}
            blocked={blockedUserIds.has(other.id)}
            onToggleBlock={() => toggleBlock(other.id)}
          />
        ) : (
          <div className="info-panel__profile">
            <div className="info-panel__avatar" style={{ background: headerColor }}>
              {chat.type === 'group' && chat.avatarUrl ? (
                <AvatarImage url={chat.avatarUrl} fallback={<UsersIcon width={30} height={30} />} />
              ) : chat.type === 'saved' ? (
                '★'
              ) : chat.type === 'group' ? (
                <UsersIcon width={30} height={30} />
              ) : (
                chat.name.charAt(0).toUpperCase()
              )}
              {chat.type === 'group' && (
                <>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    hidden
                    onChange={(e) => void handleAvatarPick(e.target.files?.[0])}
                  />
                  <button
                    className="info-panel__avatar-edit"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={uploadingAvatar}
                    title="Изменить фото группы"
                  >
                    <CameraIcon width={14} height={14} />
                  </button>
                </>
              )}
            </div>
            <h4>{chat.name}</h4>
            {chat.type === 'group' && <p className="info-panel__status">{chat.members.length} участников</p>}
            {chat.type === 'saved' && <p className="info-panel__status">Личные заметки</p>}
          </div>
        )}

        {chat.type === 'group' && (
          <section className="info-panel__section">
            <h5>Описание</h5>
            {editingDescription ? (
              <div className="info-panel__description-edit">
                <textarea
                  className="text-input"
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  maxLength={300}
                  rows={3}
                  autoFocus
                />
                <div className="info-panel__description-actions">
                  <button className="settings-button" onClick={() => { setEditingDescription(false); setDescriptionDraft(chat.description ?? '') }}>
                    Отмена
                  </button>
                  <button className="settings-button settings-button--primary" onClick={() => void saveDescription()}>
                    Сохранить
                  </button>
                </div>
              </div>
            ) : (
              <button className="info-panel__description" onClick={() => setEditingDescription(true)}>
                {chat.description?.trim() ? chat.description : 'Добавьте описание группы'}
              </button>
            )}
          </section>
        )}

        {chat.pinnedMessage && (
          <section className="info-panel__section">
            <h5>Закреплённое сообщение</h5>
            <button className="info-panel__pinned-message" onClick={onScrollToPinned}>
              <PinIcon width={14} height={14} />
              <span>{chat.pinnedMessage.text || chat.pinnedMessage.attachment?.name || (chat.pinnedMessage.type === 'voice' ? 'Голосовое сообщение' : chat.pinnedMessage.type === 'video' ? 'Видео' : chat.pinnedMessage.type === 'audio' ? 'Аудио' : chat.pinnedMessage.type === 'image' ? 'Фото' : 'Файл')}</span>
            </button>
            <button className="info-panel__unpin" onClick={() => onTogglePin(null)}>
              Открепить сообщение
            </button>
          </section>
        )}

        {chat.type === 'group' && (
          <section className="info-panel__section">
            <h5>Участники — {chat.members.length}</h5>
            <ul className="info-panel__members">
              {chat.members.map((member) => (
                <li key={member.id}>
                  <button
                    className="info-panel__member"
                    onClick={() => member.id !== currentUserId && setViewingMember(member)}
                  >
                    <span className="avatar-wrap">
                      <span className="avatar avatar--sm" style={{ background: member.color }}>
                        <AvatarImage
                          url={member.avatarUrl}
                          fallback={(member.displayName?.trim() || member.username).charAt(0).toUpperCase()}
                        />
                      </span>
                      {member.online && <span className="online-dot" />}
                    </span>
                    <span className="info-panel__member-name">
                      {member.id === currentUserId ? `${member.displayName?.trim() || member.username} (вы)` : member.displayName?.trim() || member.username}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {chat.type === 'group' && (
          <section className="info-panel__section">
            {confirmingLeave ? (
              <div className="info-panel__leave-confirm">
                <p>Точно покинуть группу «{chat.name}»? История переписки будет удалена для вас.</p>
                <div className="info-panel__description-actions">
                  <button className="settings-button" onClick={() => setConfirmingLeave(false)} disabled={leaving}>
                    Отмена
                  </button>
                  <button className="settings-button settings-button--danger" onClick={() => void handleLeave()} disabled={leaving}>
                    {leaving ? 'Выход…' : 'Покинуть группу'}
                  </button>
                </div>
              </div>
            ) : (
              <button className="info-panel__leave-button" onClick={() => setConfirmingLeave(true)}>
                <LogoutIcon width={15} height={15} /> Покинуть группу
              </button>
            )}
          </section>
        )}

        {chat.type === 'saved' && (
          <section className="info-panel__section">
            <p className="info-panel__hint">
              <BookmarkIcon width={14} height={14} /> Сообщения здесь видны только вам.
            </p>
          </section>
        )}
        {avatarPreviewUser?.avatarUrl && <AvatarLightbox url={avatarPreviewUser.avatarUrl} name={avatarPreviewUser.displayName || avatarPreviewUser.username} onClose={() => setAvatarPreviewUser(null)} />}
      </div>
    </aside>
  )
}
