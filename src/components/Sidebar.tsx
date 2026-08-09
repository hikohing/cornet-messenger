import { memo, useEffect, useRef, useState } from 'react'
import type { Chat, ChatFolder, User } from '../types'
import type { ConnectionStatus } from '../api/socket'
import { searchUsers } from '../api/client'
import { callMessageSummary } from '../utils/calls'
import { stripFormatting } from '../utils/markup'
import { AvatarImage } from './AvatarImage'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import type { RailView } from './LeftRail'
import {
  ArchiveIcon,
  BellIcon,
  BellOffIcon,
  BookmarkIcon,
  CloseIcon,
  FolderIcon,
  InboxIcon,
  LogoutIcon,
  PinIcon,
  SearchIcon,
  SettingsIcon,
  SpinnerIcon,
  UsersIcon,
} from './icons'

interface SidebarProps {
  chats: Chat[]
  chatsLoading: boolean
  currentUser: User
  connectionStatus: ConnectionStatus
  selectedChatId: number | null
  railView: RailView
  showNewChat: boolean
  onCloseNewChat: () => void
  onSelectChat: (chatId: number) => void
  onStartChat: (username: string) => Promise<Chat>
  onStartGroupChat: (name: string, usernames: string[]) => Promise<Chat>
  onOpenSettings: () => void
  onLogout: () => void
  onTogglePinned: (chatId: number, pinned: boolean) => void
  folders: ChatFolder[]
  onToggleArchived: (chatId: number, archived: boolean) => void
  onToggleMuted: (chatId: number, mutedUntil: number | null) => void
  onManageFolders: () => void
}

/** «Навсегда» — дата далеко в будущем, отдельного флага не заводим. */
const MUTE_FOREVER = 8640000000000000

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function otherMember(chat: Chat, currentUserId: number) {
  return chat.members.find((m) => m.id !== currentUserId)
}

function previewText(chat: Chat, currentUserId: number) {
  const last = chat.lastMessage
  if (!last) return 'Нет сообщений'
  const isOwn = last.senderId === currentUserId
  const prefix = isOwn ? 'Вы: ' : ''
  if (last.deleted) return `${prefix}Сообщение удалено`
  if (last.type === 'call') return callMessageSummary(last.callMeta, isOwn)
  if (last.type === 'image') return `${prefix}Фото`
  if (last.type === 'video') return `${prefix}Видео`
  if (last.type === 'voice') return `${prefix}Голосовое сообщение`
  if (last.type === 'audio') return `${prefix}Аудио`
  if (last.type === 'file') return `${prefix}${last.attachment?.name || 'Файл'}`
  if (last.type === 'poll') return `${prefix}📊 ${last.poll?.question ?? 'Опрос'}`
  // У зашифрованного сообщения серверный `text` пуст, поэтому берём
  // расшифрованный на клиенте. Пока расшифровка не дошла — показываем замок,
  // а не пустую строку.
  if (last.encrypted) {
    if (last.decryptedText === undefined) return `${prefix}🔒 Зашифрованное сообщение`
    return `${prefix}${stripFormatting(last.decryptedText)}`
  }
  // Маркеры разметки в превью не нужны — показываем чистый текст.
  return `${prefix}${stripFormatting(last.text)}`
}

const ChatListRow = memo(function ChatListRow({
  chat,
  currentUserId,
  isSelected,
  onSelectChat,
  onOpenMenu,
}: {
  chat: Chat
  currentUserId: number
  isSelected: boolean
  onSelectChat: (chatId: number) => void
  onOpenMenu: (event: React.MouseEvent, chat: Chat) => void
}) {
  const other = otherMember(chat, currentUserId)
  const last = chat.lastMessage
  const isSaved = chat.type === 'saved'
  const isGroup = chat.type === 'group'
  return (
    <li>
      <button
        className={`chat-list-item${isSelected ? ' active' : ''}`}
        onClick={() => onSelectChat(chat.id)}
        onContextMenu={(e) => onOpenMenu(e, chat)}
      >
        <span className="avatar-wrap">
          {isSaved ? (
            <span className="avatar avatar--md" style={{ background: '#4a4a56' }}>
              <BookmarkIcon width={20} height={20} />
            </span>
          ) : isGroup ? (
            <span className="avatar avatar--md" style={{ background: '#3a3a44' }}>
              <AvatarImage url={chat.avatarUrl} fallback={<UsersIcon width={20} height={20} />} />
            </span>
          ) : (
            <span className="avatar avatar--md" style={{ background: other?.color }}>
              <AvatarImage url={other?.avatarUrl} fallback={chat.name.charAt(0).toUpperCase()} />
            </span>
          )}
          {!isSaved && !isGroup && other?.online && <span className="online-dot" />}
        </span>
        <span className="chat-list-item-body">
          <span className="chat-list-item-top">
            <span className="chat-name">
              {chat.pinned && !isSaved && <PinIcon width={11} height={11} className="chat-pin-indicator" />}
              {chat.name}
              {chat.mutedUntil && <BellOffIcon width={11} height={11} className="chat-muted-icon" />}
            </span>
            {last && <span className="chat-time">{formatTime(last.createdAt)}</span>}
          </span>
          <span className="chat-list-item-bottom">
            <span className="chat-preview">{previewText(chat, currentUserId)}</span>
            {chat.unreadCount > 0 && <span className="unread-badge">{chat.unreadCount}</span>}
          </span>
        </span>
      </button>
    </li>
  )
})

function ChatListSkeleton() {
  return (
    <ul className="chat-list" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="chat-list-item-skeleton">
          <span className="skeleton skeleton-circle" />
          <span className="chat-list-item-skeleton-body">
            <span className="skeleton skeleton-line" style={{ width: '55%' }} />
            <span className="skeleton skeleton-line" style={{ width: '80%' }} />
          </span>
        </li>
      ))}
    </ul>
  )
}

const RAIL_LABELS: Record<RailView, string> = {
  all: 'Все чаты',
  direct: 'Личные сообщения',
  group: 'Группы',
  saved: 'Избранное',
  archive: 'Архив',
}

export function Sidebar({
  chats,
  chatsLoading,
  currentUser,
  connectionStatus,
  selectedChatId,
  railView,
  showNewChat,
  onCloseNewChat,
  onSelectChat,
  onStartChat,
  onStartGroupChat,
  onOpenSettings,
  onLogout,
  onTogglePinned,
  folders,
  onToggleArchived,
  onToggleMuted,
  onManageFolders,
}: SidebarProps) {
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null)
  // Папка перекрывает раздел при фильтрации, поэтому при переключении раздела
  // её надо сбросить — иначе клик по «Группы» внешне не давал бы никакого
  // эффекта, список продолжал бы показывать содержимое папки.
  useEffect(() => {
    setActiveFolderId(null)
  }, [railView])
  const [filter, setFilter] = useState('')
  const [filterUsers, setFilterUsers] = useState<User[]>([])
  const [filterSearching, setFilterSearching] = useState(false)
  const filterSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filterSearchRequestRef = useRef(0)
  const [mode, setMode] = useState<'direct' | 'group'>('direct')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<User[]>([])
  const [searching, setSearching] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMembers, setGroupMembers] = useState<User[]>([])
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef(0)
  const { menu, openFromMouseEvent, close: closeMenu } = useContextMenu()

  useEscapeToClose(() => {
    if (showNewChat) onCloseNewChat()
  })

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  useEffect(() => {
    if (filterSearchTimerRef.current) clearTimeout(filterSearchTimerRef.current)
    const trimmed = filter.trim()
    if (trimmed.length < 2) {
      filterSearchRequestRef.current += 1
      setFilterUsers([])
      setFilterSearching(false)
      return
    }
    setFilterSearching(true)
    const requestId = ++filterSearchRequestRef.current
    filterSearchTimerRef.current = setTimeout(async () => {
      try {
        const res = await searchUsers(trimmed)
        if (requestId === filterSearchRequestRef.current) setFilterUsers(res.users)
      } finally {
        if (requestId === filterSearchRequestRef.current) setFilterSearching(false)
      }
    }, 250)
    return () => {
      if (filterSearchTimerRef.current) clearTimeout(filterSearchTimerRef.current)
    }
  }, [filter])

  async function handleStartFromFilter(username: string) {
    const chat = await onStartChat(username)
    setFilter('')
    onSelectChat(chat.id)
  }

  function handleQueryChange(value: string) {
    setQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (value.trim().length < 2) {
      searchRequestRef.current += 1
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const requestId = ++searchRequestRef.current
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await searchUsers(value.trim())
        if (requestId === searchRequestRef.current) setResults(res.users)
      } finally {
        if (requestId === searchRequestRef.current) setSearching(false)
      }
    }, 220)
  }

  function resetPanel() {
    onCloseNewChat()
    setQuery('')
    setResults([])
    setGroupName('')
    setGroupMembers([])
    setMode('direct')
  }

  async function handlePickDirect(username: string) {
    const chat = await onStartChat(username)
    resetPanel()
    onSelectChat(chat.id)
  }

  function toggleGroupMember(user: User) {
    setGroupMembers((prev) =>
      prev.some((u) => u.id === user.id) ? prev.filter((u) => u.id !== user.id) : [...prev, user],
    )
  }

  async function handleCreateGroup() {
    if (!groupName.trim() || groupMembers.length === 0) return
    const chat = await onStartGroupChat(
      groupName.trim(),
      groupMembers.map((u) => u.username),
    )
    resetPanel()
    onSelectChat(chat.id)
  }

  function openChatMenu(event: React.MouseEvent, chat: Chat) {
    const items: ContextMenuItem[] = []
    if (chat.type !== 'saved') {
      items.push({
        label: chat.pinned ? 'Открепить чат' : 'Закрепить чат',
        icon: <PinIcon width={15} height={15} />,
        onClick: () => onTogglePinned(chat.id, !chat.pinned),
      })
      items.push({
        label: chat.mutedUntil ? 'Включить уведомления' : 'Отключить уведомления',
        icon: chat.mutedUntil ? <BellIcon width={15} height={15} /> : <BellOffIcon width={15} height={15} />,
        onClick: () => onToggleMuted(chat.id, chat.mutedUntil ? null : MUTE_FOREVER),
      })
      items.push({
        label: chat.archived ? 'Вернуть из архива' : 'В архив',
        icon: <ArchiveIcon width={15} height={15} />,
        onClick: () => onToggleArchived(chat.id, !chat.archived),
      })
    }
    if (items.length === 0) return
    openFromMouseEvent(event, items)
  }

  const activeFolder = folders.find((f) => f.id === activeFolderId) ?? null
  const scopedChats = chats.filter((c) => {
    // Архив — отдельный раздел: в обычных вкладках архивные чаты не показываем,
    // иначе «убрать в архив» ничего бы визуально не меняло.
    if (railView === 'archive') return c.archived
    if (c.archived) return false
    if (activeFolder) return activeFolder.chatIds.includes(c.id)
    if (railView === 'all') return true
    if (railView === 'saved') return c.type === 'saved'
    return c.type === railView
  })
  const sortedChats = [...scopedChats].sort((a, b) => {
    if (a.type === 'saved') return -1
    if (b.type === 'saved') return 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return 0
  })
  const visibleChats = filter.trim()
    ? sortedChats.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : sortedChats
  const pinnedChats = visibleChats.filter((c) => c.pinned && c.type !== 'saved')
  const restChats = visibleChats.filter((c) => !(c.pinned && c.type !== 'saved'))

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <button
          className="sidebar__avatar-btn"
          title={`${currentUser.displayName?.trim() || currentUser.username} · Настройки`}
          onClick={onOpenSettings}
        >
          <span className="avatar-wrap">
            <span className="avatar avatar--sm" style={{ background: currentUser.color }}>
              <AvatarImage
                url={currentUser.avatarUrl}
                fallback={(currentUser.displayName?.trim() || currentUser.username).charAt(0).toUpperCase()}
              />
            </span>
            <span className={`sidebar__status-dot sidebar__status-dot--${connectionStatus}`} title={connectionStatus === 'connected' ? 'В сети' : connectionStatus === 'reconnecting' ? 'Переподключение…' : connectionStatus === 'connecting' ? 'Подключение…' : 'Нет соединения'} />
          </span>
        </button>
        <div className="search-field sidebar__header-search">
          <SearchIcon width={17} height={17} />
          <input
            type="text"
            className="text-input"
            placeholder="Поиск"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button className="icon-btn" title="Настройки" onClick={onOpenSettings}>
          <SettingsIcon />
        </button>
        <button className="icon-btn" title="Выйти" onClick={onLogout}>
          <LogoutIcon />
        </button>
      </div>

      <div className="sidebar__section-label">
        {activeFolder ? activeFolder.name : RAIL_LABELS[railView]}
      </div>

      {/* Вкладки папок прячем в архиве: там свой самостоятельный список. */}
      {railView !== 'archive' && (
        <div className="folder-tabs" role="tablist" aria-label="Папки">
          <button
            type="button"
            role="tab"
            aria-selected={activeFolderId === null}
            className={`folder-tab${activeFolderId === null ? ' is-active' : ''}`}
            onClick={() => setActiveFolderId(null)}
          >
            Все
          </button>
          {folders.map((folder) => {
            const unread = chats
              .filter((c) => folder.chatIds.includes(c.id) && !c.archived && !c.mutedUntil)
              .reduce((sum, c) => sum + c.unreadCount, 0)
            return (
              <button
                key={folder.id}
                type="button"
                role="tab"
                aria-selected={activeFolderId === folder.id}
                className={`folder-tab${activeFolderId === folder.id ? ' is-active' : ''}`}
                onClick={() => setActiveFolderId(folder.id)}
              >
                {folder.name}
                {unread > 0 && <span className="folder-tab__badge">{unread}</span>}
              </button>
            )
          })}
          <button type="button" className="folder-tab folder-tab--manage" onClick={onManageFolders} title="Настроить папки">
            <FolderIcon width={13} height={13} />
          </button>
        </div>
      )}

      {showNewChat && (
        <div className="new-chat-panel">
          <div className="new-chat-panel__head">
            <div className="new-chat-tabs">
              <button className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>
                Личный чат
              </button>
              <button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
                Группа
              </button>
            </div>
            <button className="icon-btn" title="Закрыть" onClick={resetPanel}>
              <CloseIcon width={16} height={16} />
            </button>
          </div>

          {mode === 'direct' ? (
            <>
              <input
                type="text"
                className="text-input"
                placeholder="Найти пользователя..."
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                autoFocus
              />
              {searching && (
                <div className="new-chat-hint">
                  <SpinnerIcon width={13} height={13} /> Поиск...
                </div>
              )}
              {!searching && query.trim().length >= 2 && results.length === 0 && (
                <div className="new-chat-hint">Никого не найдено</div>
              )}
              <ul className="new-chat-results">
                {results.map((u) => (
                  <li key={u.id}>
                    <button onClick={() => handlePickDirect(u.username)}>
                      <span className="avatar avatar--sm" style={{ background: u.color }}>
                        {u.username.charAt(0).toUpperCase()}
                      </span>
                      {u.username}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <input
                type="text"
                className="text-input"
                placeholder="Название группы"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                autoFocus
              />
              <input
                type="text"
                className="text-input"
                placeholder="Найти участников..."
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
              />
              {groupMembers.length > 0 && (
                <div className="group-members-chips">
                  {groupMembers.map((u) => (
                    <span key={u.id} className="group-member-chip" onClick={() => toggleGroupMember(u)}>
                      {u.username} ✕
                    </span>
                  ))}
                </div>
              )}
              <ul className="new-chat-results">
                {results.map((u) => (
                  <li key={u.id}>
                    <button onClick={() => toggleGroupMember(u)}>
                      <span className="avatar avatar--sm" style={{ background: u.color }}>
                        {u.username.charAt(0).toUpperCase()}
                      </span>
                      {u.username}
                      {groupMembers.some((m) => m.id === u.id) && ' ✓'}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="create-group-button"
                disabled={!groupName.trim() || groupMembers.length === 0}
                onClick={handleCreateGroup}
              >
                Создать группу
              </button>
            </>
          )}
        </div>
      )}

      {chatsLoading ? (
        <ChatListSkeleton />
      ) : chats.length === 0 ? (
        <div className="empty-panel">
          <div className="empty-panel-icon">
            <InboxIcon width={26} height={26} />
          </div>
          <h3>Пока нет чатов</h3>
          <p>Нажмите «плюс» в узкой панели слева, чтобы найти собеседника и начать переписку.</p>
        </div>
      ) : visibleChats.length === 0 ? (
        filterSearching ? (
          <div className="empty-panel">
            <SpinnerIcon width={22} height={22} />
          </div>
        ) : filterUsers.length > 0 ? (
          <div className="filter-user-results">
            <div className="sidebar__group-label">Пользователи</div>
            <ul className="new-chat-results">
              {filterUsers.map((u) => (
                <li key={u.id}>
                  <button onClick={() => handleStartFromFilter(u.username)}>
                    <span className="avatar avatar--sm" style={{ background: u.color }}>
                      <AvatarImage url={u.avatarUrl} fallback={u.username.charAt(0).toUpperCase()} />
                    </span>
                    {u.username}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="empty-panel">
            <div className="empty-panel-icon">
              <SearchIcon width={24} height={24} />
            </div>
            <h3>Ничего не найдено</h3>
            <p>Попробуйте другой запрос.</p>
          </div>
        )
      ) : (
        <div className="chat-list-scroll">
          {pinnedChats.length > 0 && (
            <>
              <div className="sidebar__group-label">Закреплённые</div>
              <ul className="chat-list">
                {pinnedChats.map((chat) => (
                  <ChatListRow
                    key={chat.id}
                    chat={chat}
                    currentUserId={currentUser.id}
                    isSelected={chat.id === selectedChatId}
                    onSelectChat={onSelectChat}
                    onOpenMenu={openChatMenu}
                  />
                ))}
              </ul>
            </>
          )}
          {restChats.length > 0 && (
            <ul className="chat-list">
              {restChats.map((chat) => (
                <ChatListRow
                  key={chat.id}
                  chat={chat}
                  currentUserId={currentUser.id}
                  isSelected={chat.id === selectedChatId}
                  onSelectChat={onSelectChat}
                  onOpenMenu={openChatMenu}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </aside>
  )
}
