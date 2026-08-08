import { useEffect, useRef, useState } from 'react'
import type { BlockedUser, User } from '../types'
import type {
  AccentPreference,
  AnimationPreference,
  AppPreferences,
  BlurPreference,
  BubblePreference,
  CallRingtonePreference,
  FontPreference,
  FontSizePreference,
  SidebarPreference,
  SoundPreference,
  ThemePreference,
  WallpaperPreference,
} from '../hooks/usePreferences'
import { getBlockedUsers, uploadFile, unblockUser as apiUnblockUser } from '../api/client'
import { AvatarImage } from './AvatarImage'
import { AvatarLightbox } from './AvatarLightbox'
import { ColorPicker } from './ColorPicker'
import { AlertIcon, CameraIcon, CheckIcon, CloseIcon, SpinnerIcon } from './icons'
import { AVATAR_DECORATIONS, BANNER_STYLES, NAMEPLATES, NAME_STYLES, PROFILE_BUNDLES, PROFILE_EFFECTS, PROFILE_FRAMES, PROFILE_THEMES, profileBannerStyle, profileCardColorStyle } from '../utils/profile'

const COLOR_PALETTE = [
  '#6e56cf', '#00b894', '#0984e3', '#e17055', '#d63031', '#00cec9', '#e84393', '#fdcb6e',
  '#22c55e', '#3b82f6', '#a855f7', '#f97316', '#14b8a6', '#f43f5e', '#84cc16', '#64748b',
]
type SettingsTab = 'profile' | 'appearance' | 'effects' | 'notifications' | 'calls' | 'chats' | 'privacy' | 'security' | 'about'
type ProfileFilter = 'all' | 'bundles' | 'theme' | 'banner' | 'avatar' | 'effects' | 'identity'

const PROFILE_FILTERS: { id: ProfileFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'bundles', label: 'Комплекты' },
  { id: 'theme', label: 'Тема' },
  { id: 'banner', label: 'Баннеры' },
  { id: 'avatar', label: 'Аватар' },
  { id: 'effects', label: 'Эффекты' },
  { id: 'identity', label: 'Имя и рамки' },
]

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Профиль' },
  { id: 'privacy', label: 'Конфиденциальность' },
  { id: 'security', label: 'Безопасность' },
  { id: 'appearance', label: 'Внешний вид' },
  { id: 'effects', label: 'Эффекты чата' },
  { id: 'notifications', label: 'Уведомления' },
  { id: 'calls', label: 'Звонки' },
  { id: 'chats', label: 'Чаты' },
  { id: 'about', label: 'О приложении' },
]

/** Разделы сгруппированы: сначала аккаунт, затем само приложение. */
const NAV_GROUPS: { title: string; items: SettingsTab[] }[] = [
  { title: 'Аккаунт', items: ['profile', 'privacy', 'security'] },
  { title: 'Приложение', items: ['appearance', 'effects', 'notifications', 'calls', 'chats'] },
  { title: 'Прочее', items: ['about'] },
]

function ColorField({ label, hint, color, onChange }: { label: string; hint?: string; color: string; onChange: (color: string) => void }) {
  return (
    <div className="color-field">
      <div className="color-field__head">
        <span className="color-field__chip" style={{ background: color }} />
        <span className="color-field__copy">
          <strong>{label}</strong>
          {hint && <small>{hint}</small>}
        </span>
      </div>
      <ColorPicker color={color} onChange={onChange} label={label} />
    </div>
  )
}

interface SettingsPanelProps {
  user: User
  preferences: AppPreferences
  onUpdatePreferences: (patch: Partial<AppPreferences>) => void
  onResetPreferences: () => void
  onUpdateProfile: (patch: {
    username?: string
    color?: string
    avatarUrl?: string | null
    bannerUrl?: string | null
    bannerStyle?: User['bannerStyle']
    avatarDecoration?: User['avatarDecoration']
    profileEffect?: User['profileEffect']
    profileTheme?: User['profileTheme']
    nameStyle?: User['nameStyle']
    profileFrame?: User['profileFrame']
    nameplateStyle?: User['nameplateStyle']
    profilePrimaryColor?: string | null
    profileSecondaryColor?: string | null
    showLastSeen?: boolean
    bio?: string
    birthDate?: string | null
    displayName?: string | null
  }) => Promise<unknown>
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<unknown>
  onRequestEmailVerification: (email: string) => Promise<unknown>
  onRemoveEmail: () => Promise<unknown>
  onClose: () => void
}

function SettingToggle({ label, description, checked, onChange, disabled = false }: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="settings-control-row">
      <span className="settings-control-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        <span className="switch-track" />
      </span>
    </label>
  )
}

/** Почта нужна для восстановления пароля — без неё «Забыли пароль» на экране входа бессилен. */
function EmailSettings({ user, onRequestVerification, onRemoveEmail }: {
  user: User
  onRequestVerification: (email: string) => Promise<unknown>
  onRemoveEmail: () => Promise<unknown>
}) {
  const [email, setEmail] = useState(user.email ?? '')
  const [sending, setSending] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  // Сервер сохраняет почту в user.email только ПОСЛЕ перехода по ссылке из письма,
  // поэтому «письмо отправлено на …» держим в локальном состоянии, а не в user.email.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)

  useEffect(() => {
    setEmail(user.email ?? '')
    if (user.emailVerified) setPendingEmail(null)
  }, [user.email, user.emailVerified])

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setMessage(null)
    const target = email.trim()
    try {
      await onRequestVerification(target)
      setPendingEmail(target)
      setMessage({ text: 'Письмо со ссылкой отправлено — проверьте почту', error: false })
    } catch (err) {
      setMessage({ text: (err as Error).message, error: true })
    } finally {
      setSending(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    try {
      await onRemoveEmail()
      setMessage(null)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card-title">
        <h3>Почта</h3>
        <p>Нужна для восстановления пароля, если вы его забудете</p>
      </div>
      {user.emailVerified ? (
        <div className="settings-control-row">
          <span className="settings-control-copy">
            <strong>{user.email}</strong>
            <small><CheckIcon width={12} height={12} /> Подтверждена</small>
          </span>
          <button className="settings-button settings-button--ghost" onClick={handleRemove} disabled={removing}>
            {removing && <SpinnerIcon width={14} height={14} />}
            Отвязать
          </button>
        </div>
      ) : (
        <form className="settings-email-form" onSubmit={handleSend}>
          <input
            type="email"
            className="text-input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="settings-button settings-button--primary" disabled={sending || !emailValid}>
            {sending && <SpinnerIcon width={14} height={14} />}
            {pendingEmail ? 'Отправить письмо снова' : 'Подтвердить почту'}
          </button>
        </form>
      )}
      {pendingEmail && !message && (
        <p className="field-hint">Письмо с подтверждением уже отправлено на {pendingEmail} — проверьте почту (и папку «Спам»).</p>
      )}
      {message && <div className={`form-banner ${message.error ? 'form-banner--error' : 'form-banner--success'}`}>{message.text}</div>}
    </section>
  )
}

/** Список тех, кого вы заблокировали — переписка и звонки с ними недоступны в обе стороны. */
function BlockedUsersSettings() {
  const [users, setUsers] = useState<BlockedUser[] | null>(null)
  const [unblockingId, setUnblockingId] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    getBlockedUsers()
      .then((res) => active && setUsers(res.users))
      .catch(() => active && setUsers([]))
    return () => {
      active = false
    }
  }, [])

  async function handleUnblock(id: number) {
    setUnblockingId(id)
    try {
      await apiUnblockUser(id)
      setUsers((prev) => prev?.filter((u) => u.id !== id) ?? null)
    } finally {
      setUnblockingId(null)
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card-title">
        <h3>Заблокированные</h3>
        <p>Они не могут написать вам или позвонить, а вы — им</p>
      </div>
      {users === null ? (
        <p className="field-hint"><SpinnerIcon width={13} height={13} /> Загрузка…</p>
      ) : users.length === 0 ? (
        <p className="field-hint">Никого не заблокировано</p>
      ) : (
        <div className="settings-blocked-list">
          {users.map((u) => (
            <div className="settings-control-row" key={u.id}>
              <span className="settings-control-copy">
                <strong>{u.displayName || u.username}</strong>
                <small>@{u.username}</small>
              </span>
              <button
                className="settings-button settings-button--ghost"
                onClick={() => void handleUnblock(u.id)}
                disabled={unblockingId === u.id}
              >
                {unblockingId === u.id && <SpinnerIcon width={14} height={14} />}
                Разблокировать
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Выбор устройств: названия браузер показывает только после выданного доступа к микрофону. */
function DeviceSettings({ preferences, onUpdatePreferences }: {
  preferences: AppPreferences
  onUpdatePreferences: (patch: Partial<AppPreferences>) => void
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    let cancelled = false
    const refresh = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) setDevices(list)
        })
        .catch(() => {})
    }
    refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh)
    }
  }, [])

  // До выдачи доступа браузер отдаёт устройства-заглушки с пустыми id и названием.
  const usable = devices.filter((device) => device.deviceId)
  const named = usable.some((device) => device.label)

  async function requestLabels() {
    setRequesting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      // Пользователь мог отказать — тогда останутся безымянные устройства.
    } finally {
      setRequesting(false)
    }
  }

  function renderSelect(label: string, kind: MediaDeviceKind, value: string, onChange: (deviceId: string) => void) {
    const options = usable.filter((device) => device.kind === kind)
    // Сохранённое устройство могло отключиться — не даём select молча сбросить выбор.
    const missing = value && !options.some((device) => device.deviceId === value)
    return (
      <label className="settings-select-row">
        <span>{label}</span>
        <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">По умолчанию</option>
          {options.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </option>
          ))}
          {missing && <option value={value}>Выбранное устройство недоступно</option>}
        </select>
      </label>
    )
  }

  return (
    <section className="settings-card">
      <div className="settings-card-title">
        <h3>Устройства</h3>
        <p>Используются для всех звонков; в самом звонке устройство можно переключить на лету</p>
      </div>
      <div className="settings-select-list">
        {renderSelect('Микрофон', 'audioinput', preferences.preferredMicId, (preferredMicId) => onUpdatePreferences({ preferredMicId }))}
        {renderSelect('Камера', 'videoinput', preferences.preferredCameraId, (preferredCameraId) => onUpdatePreferences({ preferredCameraId }))}
        {renderSelect('Динамики', 'audiooutput', preferences.preferredSpeakerId, (preferredSpeakerId) => onUpdatePreferences({ preferredSpeakerId }))}
      </div>
      {!named && (
        <button className="settings-button" onClick={requestLabels} disabled={requesting}>
          {requesting && <SpinnerIcon width={15} height={15} />}
          Показать названия устройств
        </button>
      )}
    </section>
  )
}

export function SettingsPanel({
  user,
  preferences,
  onUpdatePreferences,
  onResetPreferences,
  onUpdateProfile,
  onChangePassword,
  onRequestEmailVerification,
  onRemoveEmail,
  onClose,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [profileMessage, setProfileMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [profileMessageClosing, setProfileMessageClosing] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [displayNameDraft, setDisplayNameDraft] = useState(user.displayName ?? '')
  const [usernameDraft, setUsernameDraft] = useState(user.username)
  const [bioDraft, setBioDraft] = useState(user.bio ?? '')
  const [birthDateDraft, setBirthDateDraft] = useState(user.birthDate ?? '')
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false)
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('all')
  const [profileSearch, setProfileSearch] = useState('')
  const [primaryColorDraft, setPrimaryColorDraft] = useState(user.profilePrimaryColor ?? user.color)
  const [secondaryColorDraft, setSecondaryColorDraft] = useState(user.profileSecondaryColor ?? '#0b1118')
  const [customColorsEnabled, setCustomColorsEnabled] = useState(Boolean(user.profilePrimaryColor || user.profileSecondaryColor))
  const quickAvatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const settingsContentRef = useRef<HTMLElement>(null)
  const profileSectionRefs = useRef<Partial<Record<ProfileFilter, HTMLElement | null>>>({})

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (avatarPreviewOpen) setAvatarPreviewOpen(false)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [avatarPreviewOpen, onClose])

  useEffect(() => {
    setProfileMessageClosing(false)
    if (!profileMessage || profileMessage.error) return
    const timer = window.setTimeout(() => setProfileMessageClosing(true), 2000)
    return () => window.clearTimeout(timer)
  }, [profileMessage])

  useEffect(() => {
    if (!profileMessageClosing) return
    const timer = window.setTimeout(() => {
      setProfileMessage(null)
      setProfileMessageClosing(false)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [profileMessageClosing])

  function renderProfileMessage(extraClass = '') {
    if (!profileMessage) return null
    return (
      <button
        type="button"
        className={`form-banner form-banner--dismissible ${extraClass} ${profileMessage.error ? 'form-banner--error' : 'form-banner--success'}${profileMessageClosing ? ' is-closing' : ''}`}
        onClick={() => setProfileMessageClosing(true)}
        role="status"
        aria-label={`${profileMessage.text}. Нажмите, чтобы скрыть`}
      >
        {profileMessage.error && <AlertIcon width={15} height={15} />}
        {profileMessage.text}
      </button>
    )
  }

  async function updateProfile(patch: { username?: string; color?: string; avatarUrl?: string | null; bannerUrl?: string | null; bannerStyle?: User['bannerStyle']; avatarDecoration?: User['avatarDecoration']; profileEffect?: User['profileEffect']; profileTheme?: User['profileTheme']; nameStyle?: User['nameStyle']; profileFrame?: User['profileFrame']; nameplateStyle?: User['nameplateStyle']; profilePrimaryColor?: string | null; profileSecondaryColor?: string | null; showLastSeen?: boolean; bio?: string; birthDate?: string | null; displayName?: string | null }) {
    setSavingProfile(true)
    setProfileMessage(null)
    try {
      await onUpdateProfile(patch)
      setProfileMessage({ text: 'Изменения сохранены', error: false })
    } catch (err) {
      setProfileMessage({ text: (err as Error).message, error: true })
    } finally {
      setSavingProfile(false)
    }
  }

  async function savePreviewProfile() {
    const username = usernameDraft.trim().replace(/^@/, '')
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      setProfileMessage({ text: 'Username: 3–24 латинские буквы, цифры или _', error: true })
      return
    }
    await updateProfile({
      username,
      displayName: displayNameDraft.trim() || null,
      bio: bioDraft.trim(),
    })
    setUsernameDraft(username)
  }

  async function handleAvatar(file: File | undefined) {
    if (!file) return
    setUploadingAvatar(true)
    setProfileMessage(null)
    try {
      const result = await uploadFile(file)
      await updateProfile({ avatarUrl: result.url })
    } catch (err) {
      setProfileMessage({ text: (err as Error).message, error: true })
    } finally {
      setUploadingAvatar(false)
      if (quickAvatarInputRef.current) quickAvatarInputRef.current.value = ''
    }
  }

  async function handleBanner(file: File | undefined) {
    if (!file) return
    setUploadingAvatar(true)
    setProfileMessage(null)
    try {
      const result = await uploadFile(file)
      await updateProfile({ bannerUrl: result.url })
    } catch (err) {
      setProfileMessage({ text: (err as Error).message, error: true })
    } finally {
      setUploadingAvatar(false)
      if (bannerInputRef.current) bannerInputRef.current.value = ''
    }
  }

  async function handleNotifications(enabled: boolean) {
    setProfileMessage(null)
    if (!enabled) {
      onUpdatePreferences({ notifications: false })
      return
    }
    if (!('Notification' in window)) {
      setProfileMessage({ text: 'Этот браузер не поддерживает системные уведомления', error: true })
      return
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    onUpdatePreferences({ notifications: permission === 'granted' })
    if (permission !== 'granted') setProfileMessage({ text: 'Разрешите уведомления в настройках браузера', error: true })
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPasswordMessage(null)
    if (newPassword.length < 10) {
      setPasswordMessage({ text: 'Минимальная длина пароля — 10 символов', error: true })
      return
    }
    const passwordGroups = [/[a-z]/.test(newPassword), /[A-Z]/.test(newPassword), /\d/.test(newPassword), /[^A-Za-z0-9]/.test(newPassword)].filter(Boolean).length
    if (passwordGroups < 3) {
      setPasswordMessage({ text: 'Добавьте заглавные и строчные буквы, цифры или специальные символы', error: true })
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ text: 'Новые пароли не совпадают', error: true })
      return
    }
    setSavingPassword(true)
    try {
      await onChangePassword(oldPassword, newPassword)
      setPasswordMessage({ text: 'Пароль успешно обновлён', error: false })
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPasswordMessage({ text: (err as Error).message, error: true })
    } finally {
      setSavingPassword(false)
    }
  }

  const avatar = <AvatarImage url={user.avatarUrl} fallback={user.username.charAt(0).toUpperCase()} />
  const previewUser: User = {
    ...user,
    profilePrimaryColor: customColorsEnabled ? primaryColorDraft : null,
    profileSecondaryColor: customColorsEnabled ? secondaryColorDraft : null,
  }
  const normalizedProfileSearch = profileSearch.trim().toLocaleLowerCase()
  const matchesProfileSearch = (text: string) => !normalizedProfileSearch || text.toLocaleLowerCase().includes(normalizedProfileSearch)
  function navigateToProfileSection(section: ProfileFilter) {
    setProfileFilter(section)
    setProfileSearch('')
    window.requestAnimationFrame(() => {
      if (section === 'all') {
        settingsContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      profileSectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  const isProfileBundleActive = (bundle: (typeof PROFILE_BUNDLES)[number]) => {
    if (user.profilePrimaryColor || user.profileSecondaryColor) return false
    return (Object.entries(bundle.patch) as Array<[keyof User, unknown]>).every(([key, value]) => (user[key] ?? null) === value)
  }

  return (
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div className="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-user">
            <span className="avatar avatar--sm" style={{ background: user.color }}>{avatar}</span>
            <span><strong>{user.displayName || user.username}</strong><small>@{user.username}</small></span>
          </div>
          <nav className="settings-nav-list" aria-label="Разделы настроек">
            {NAV_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <span className="settings-nav-group__title">{group.title}</span>
                {group.items.map((id) => (
                  <div className="settings-nav-item-wrap" key={id}>
                    <button
                      className={`settings-nav-item${activeTab === id ? ' active' : ''}`}
                      onClick={() => setActiveTab(id)}
                      aria-current={activeTab === id ? 'page' : undefined}
                    >
                      {TABS.find((tab) => tab.id === id)?.label}
                    </button>
                    {id === 'profile' && activeTab === 'profile' && (
                      <div className="settings-nav-subitems">
                        {PROFILE_FILTERS.map((filter) => (
                          <button
                            key={filter.id}
                            className={`settings-nav-subitem${profileFilter === filter.id ? ' active' : ''}`}
                            onClick={() => navigateToProfileSection(filter.id)}
                            aria-current={profileFilter === filter.id ? 'true' : undefined}
                          >
                            {filter.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main className="settings-content" ref={settingsContentRef}>
          <header className="settings-content-header">
            <h2 id="settings-title">{TABS.find((tab) => tab.id === activeTab)?.label}</h2>
            <button className="settings-close" onClick={onClose} aria-label="Закрыть настройки">
              <span className="settings-close__ring"><CloseIcon width={17} height={17} /></span>
              <span className="settings-close__hint">ESC</span>
            </button>
          </header>

          <div className={`settings-page${activeTab === 'profile' ? ' settings-page--wide' : ''}`}>
            {activeTab === 'profile' && (
              <>
                <div className="profile-studio">
                  <div className="profile-studio__preview">
                    <section className="settings-card settings-live-preview-card">
                  <div className="settings-card-title">
                    <h3>Предпросмотр профиля</h3>
                    <p>Так вашу карточку увидят другие пользователи</p>
                  </div>
                  <div className="settings-live-preview-stage">
                    <div className={`profile-card settings-live-profile profile-card--${user.profileEffect ?? 'none'} profile-card--theme-${user.profileTheme ?? 'default'} profile-card--frame-${user.profileFrame ?? 'none'}${previewUser.profileSecondaryColor ? ' profile-card--custom-colors' : ''}`} style={profileCardColorStyle(previewUser)}>
                      <div className="profile-card__banner" style={profileBannerStyle(previewUser)} />
                      <div className="profile-card__avatar-row">
                        <div className="settings-live-avatar-wrap profile-card__avatar-slot">
                          <button
                            className="profile-card__avatar"
                            style={{ background: user.color }}
                            onClick={() => user.avatarUrl && setAvatarPreviewOpen(true)}
                            disabled={!user.avatarUrl}
                            aria-label={user.avatarUrl ? 'Открыть фотографию профиля' : 'Фотография профиля не загружена'}
                          >
                            {avatar}
                          </button>
                          <span className={`profile-card__deco profile-card__deco--${user.avatarDecoration ?? 'none'}`} aria-hidden="true" />
                          <input ref={quickAvatarInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => void handleAvatar(e.target.files?.[0])} />
                          <button className="settings-live-avatar-edit" onClick={() => quickAvatarInputRef.current?.click()} disabled={uploadingAvatar} aria-label="Изменить аватар">
                            <CameraIcon width={15} height={15} />
                          </button>
                        </div>
                      </div>
                      <div className={`profile-card__identity profile-nameplate--${user.nameplateStyle ?? 'none'}`}>
                        <input
                          className={`settings-live-inline-name profile-name--${user.nameStyle ?? 'plain'}`}
                          value={displayNameDraft}
                          onChange={(e) => setDisplayNameDraft(e.target.value)}
                          maxLength={32}
                          placeholder={user.username}
                          aria-label="Отображаемое имя"
                        />
                        <label className="settings-live-inline-username">
                          <span>@</span>
                          <input
                            value={usernameDraft}
                            onChange={(e) => setUsernameDraft(e.target.value.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, ''))}
                            maxLength={24}
                            autoCapitalize="none"
                            spellCheck={false}
                            aria-label="Username"
                          />
                        </label>
                        <span className="profile-card__presence-pill is-online">в сети</span>
                      </div>
                      <div className="profile-card__panel">
                        <section className="profile-card__section">
                          <h5>О себе</h5>
                          <textarea
                            className="settings-live-inline-bio"
                            value={bioDraft}
                            onChange={(e) => setBioDraft(e.target.value)}
                            maxLength={200}
                            rows={2}
                            placeholder="Расскажите немного о себе…"
                            aria-label="О себе"
                          />
                        </section>
                      </div>
                      <button className="settings-live-card-save" onClick={() => void savePreviewProfile()} disabled={savingProfile || (usernameDraft === user.username && displayNameDraft === (user.displayName ?? '') && bioDraft === (user.bio ?? ''))}>
                        {savingProfile ? 'Сохранение…' : 'Сохранить'}
                      </button>
                    </div>
                    {renderProfileMessage('settings-live-profile-message')}
                  </div>
                    </section>
                  </div>
                  <div className="profile-studio__controls">
                <div className="profile-shop-search"><span>⌕</span><input value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} placeholder="Найти оформление…" aria-label="Поиск оформления" />{profileSearch && <button onClick={() => setProfileSearch('')} aria-label="Очистить поиск">×</button>}</div>
                <section ref={(node) => { profileSectionRefs.current.bundles = node }} className="settings-card profile-bundles-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Готовые комплекты</h3><p>Сочетают обложку, украшение, эффект, имя и рамку в одной коллекции</p></div>
                  <div className="profile-bundle-options">
                    {PROFILE_BUNDLES.filter((bundle) => matchesProfileSearch(`${bundle.label} ${bundle.caption}`)).map((bundle) => {
                      const active = isProfileBundleActive(bundle)
                      return (
                        <button
                          key={bundle.id}
                          className={`profile-bundle-option profile-bundle-option--${bundle.id}${active ? ' selected' : ''}`}
                          onClick={() => { setCustomColorsEnabled(false); void updateProfile({ ...bundle.patch, profilePrimaryColor: null, profileSecondaryColor: null }) }}
                          disabled={savingProfile}
                          aria-pressed={active}
                        >
                          <span className="profile-bundle-option__art">
                            <span className="profile-bundle-option__orb" />
                            <span className="profile-bundle-option__avatar">{avatar}</span>
                            <span className="profile-bundle-option__identity"><b>{user.displayName || user.username}</b><i>@{user.username}</i></span>
                            <span className="profile-bundle-option__badge">COLLECTION</span>
                          </span>
                          <span className="profile-bundle-option__footer">
                            <span><strong>{bundle.label}</strong><small>{bundle.caption}</small></span>
                            <em>{active ? 'Выбрано' : 'Применить'} <b aria-hidden="true">→</b></em>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
                <section ref={(node) => { profileSectionRefs.current.theme = node }} className="settings-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Тема профиля</h3><p>Основная атмосфера и оттенок всей карточки</p></div>
                  <div className="profile-theme-options">
                    {PROFILE_THEMES.filter((option) => matchesProfileSearch(option.label)).map((option) => <button key={option.id} className={`profile-theme-option profile-theme-option--${option.id}${(user.profileTheme ?? 'default') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ profileTheme: option.id })} aria-pressed={(user.profileTheme ?? 'default') === option.id} disabled={savingProfile}><span /><small>{option.label}</small></button>)}
                  </div>
                </section>
                <section className="settings-card"><div className="settings-card-title"><h3>Цвет акцента</h3><p>Используется для аватара, кнопок и свечения</p></div><div className="color-picker color-picker--large">{COLOR_PALETTE.map((color) => <button key={color} className={`color-swatch${color === user.color ? ' selected' : ''}`} style={{ background: color }} onClick={() => void updateProfile({ color })} aria-label={`Выбрать цвет ${color}`} aria-pressed={color === user.color} disabled={savingProfile} />)}</div></section>
                <section className="settings-card profile-dual-color-card">
                  <div className="settings-card-title"><h3>Двухцветная RGB-тема</h3><p>Первый цвет меняет верх профиля, второй — мягкий фон нижней части</p></div>
                  <div
                    className="profile-dual-color-preview"
                    style={{ background: `linear-gradient(180deg, ${primaryColorDraft} 0%, color-mix(in srgb, ${primaryColorDraft} 58%, ${secondaryColorDraft}) 44%, ${secondaryColorDraft} 100%)` }}
                    aria-label="Предпросмотр плавного перехода двух цветов"
                  />
                  <div className="profile-rgb-grid">
                    <ColorField
                      label="Верх профиля"
                      hint="Обложка и заливка сверху"
                      color={primaryColorDraft}
                      onChange={(color) => { setPrimaryColorDraft(color); setCustomColorsEnabled(true) }}
                    />
                    <ColorField
                      label="Низ профиля"
                      hint="Фон карточки под аватаром"
                      color={secondaryColorDraft}
                      onChange={(color) => { setSecondaryColorDraft(color); setCustomColorsEnabled(true) }}
                    />
                  </div>
                  <div className="profile-color-actions"><button className="settings-button settings-button--primary" onClick={() => void updateProfile({ profilePrimaryColor: primaryColorDraft, profileSecondaryColor: secondaryColorDraft, bannerUrl: null })} disabled={savingProfile}>{savingProfile ? 'Сохранение…' : 'Применить RGB'}</button><button className="settings-button settings-button--ghost" onClick={() => { setCustomColorsEnabled(false); void updateProfile({ profilePrimaryColor: null, profileSecondaryColor: null }) }}>Сбросить</button></div>
                </section>
                <section ref={(node) => { profileSectionRefs.current.banner = node }} className="settings-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Обложка профиля</h3><p>Цветной фон сверху карточки — выберите стиль или загрузите своё изображение</p></div>
                  <div className="profile-customization-grid profile-customization-grid--banners">
                    {BANNER_STYLES.filter((option) => matchesProfileSearch(option.label)).map((option) => (
                      <button
                        key={option.id}
                        className={`profile-banner-option profile-banner-option--${option.id}${!user.bannerUrl && (user.bannerStyle ?? 'profile') === option.id ? ' selected' : ''}`}
                        onClick={() => { setCustomColorsEnabled(false); void updateProfile({ bannerStyle: option.id, bannerUrl: null, profilePrimaryColor: null, profileSecondaryColor: null }) }}
                        aria-pressed={!user.bannerUrl && (user.bannerStyle ?? 'profile') === option.id}
                        disabled={savingProfile}
                      >
                        <span style={option.id === 'profile' ? { background: user.color } : undefined} />
                        <small>{option.label}</small>
                      </button>
                    ))}
                  </div>
                  <div className="profile-upload-actions">
                    <input ref={bannerInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => void handleBanner(e.target.files?.[0])} />
                    <button className="settings-button" onClick={() => bannerInputRef.current?.click()} disabled={uploadingAvatar}>{uploadingAvatar ? 'Загрузка…' : 'Загрузить свою обложку'}</button>
                    {user.bannerUrl && <button className="settings-button settings-button--ghost" onClick={() => void updateProfile({ bannerUrl: null })}>Удалить обложку</button>}
                  </div>
                </section>
                <section ref={(node) => { profileSectionRefs.current.avatar = node }} className="settings-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Украшение аватара</h3><p>Декоративная рамка отображается вокруг вашей фотографии в профиле</p></div>
                  <div className="profile-customization-grid">
                    {AVATAR_DECORATIONS.filter((option) => matchesProfileSearch(option.label)).map((option) => (
                      <button key={option.id} className={`profile-decoration-option${(user.avatarDecoration ?? 'none') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ avatarDecoration: option.id })} aria-pressed={(user.avatarDecoration ?? 'none') === option.id} disabled={savingProfile}>
                        <span className="profile-decoration-option__preview">
                          <span className="profile-card__avatar" style={{ background: user.color }}>
                            {avatar}
                          </span>
                          <span className={`profile-card__deco profile-card__deco--${option.id}`} aria-hidden="true" />
                        </span>
                        <small>{option.label}</small>
                      </button>
                    ))}
                  </div>
                </section>
                <section ref={(node) => { profileSectionRefs.current.effects = node }} className="settings-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Эффект карточки</h3><p>Лёгкое оформление фона, которое увидят посетители профиля</p></div>
                  <div className="profile-effect-options">
                    {PROFILE_EFFECTS.filter((option) => matchesProfileSearch(option.label)).map((option) => <button key={option.id} className={`profile-effect-option profile-effect-option--${option.id}${(user.profileEffect ?? 'none') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ profileEffect: option.id })} aria-pressed={(user.profileEffect ?? 'none') === option.id} disabled={savingProfile}><span />{option.label}</button>)}
                  </div>
                  <SettingToggle
                    label="Анимировать эффекты"
                    description="Звёзды мерцают, конфетти и лепестки плавно падают, комета пролетает по карточке"
                    checked={preferences.profileEffectsAnimated}
                    onChange={(profileEffectsAnimated) => onUpdatePreferences({ profileEffectsAnimated })}
                  />
                </section>
                <section ref={(node) => { profileSectionRefs.current.identity = node }} className="settings-card profile-navigation-target">
                  <div className="settings-card-title"><h3>Стиль имени</h3><p>Отдельное оформление отображаемого имени в карточке</p></div>
                  <div className="profile-name-options">
                    {NAME_STYLES.filter((option) => matchesProfileSearch(option.label)).map((option) => <button key={option.id} className={`profile-name-option profile-name-option--${option.id}${(user.nameStyle ?? 'plain') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ nameStyle: option.id })} aria-pressed={(user.nameStyle ?? 'plain') === option.id} disabled={savingProfile}><span className={`profile-name--${option.id}`}>{user.displayName || user.username}</span><small>{option.label}</small></button>)}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-title"><h3>Рамка профиля</h3><p>Контур вокруг всей карточки пользователя</p></div>
                  <div className="profile-frame-options">
                    {PROFILE_FRAMES.filter((option) => matchesProfileSearch(option.label)).map((option) => <button key={option.id} className={`profile-frame-option profile-frame-option--${option.id}${(user.profileFrame ?? 'none') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ profileFrame: option.id })} aria-pressed={(user.profileFrame ?? 'none') === option.id} disabled={savingProfile}><span /><small>{option.label}</small></button>)}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-title"><h3>Плашка имени</h3><p>Декоративный фон под именем и username, как nameplates в магазине</p></div>
                  <div className="profile-nameplate-options">
                    {NAMEPLATES.filter((option) => matchesProfileSearch(option.label)).map((option) => <button key={option.id} className={`profile-nameplate-option profile-nameplate-option--${option.id}${(user.nameplateStyle ?? 'none') === option.id ? ' selected' : ''}`} onClick={() => void updateProfile({ nameplateStyle: option.id })} aria-pressed={(user.nameplateStyle ?? 'none') === option.id} disabled={savingProfile}><span><b>{user.displayName || user.username}</b><i>@{user.username}</i></span><small>{option.label}</small></button>)}
                  </div>
                </section>
                <section className={`settings-card${normalizedProfileSearch ? ' profile-studio-card--hidden' : ''}`}>
                  <div className="settings-card-title"><h3>Дополнительно</h3><p>Необязательная информация профиля</p></div>
                  <label className="settings-field-label" htmlFor="birth-date">Дата рождения</label>
                  <input
                    id="birth-date"
                    type="date"
                    className="text-input"
                    value={birthDateDraft}
                    onChange={(e) => setBirthDateDraft(e.target.value)}
                    onBlur={() => birthDateDraft !== (user.birthDate ?? '') && void updateProfile({ birthDate: birthDateDraft || null })}
                  />
                </section>
                  </div>
                </div>
                {avatarPreviewOpen && user.avatarUrl && <AvatarLightbox url={user.avatarUrl} name={user.displayName || user.username} onClose={() => setAvatarPreviewOpen(false)} />}
              </>
            )}

            {activeTab === 'appearance' && (
              <>
                <section className="settings-card"><div className="settings-card-title"><h3>Тема оформления</h3><p>AMOLED использует настоящий чёрный и экономит заряд на OLED-экранах</p></div><div className="settings-segments settings-segments--themes settings-segments--four">{(['dark', 'amoled', 'light', 'system'] as ThemePreference[]).map((theme) => <button key={theme} className={preferences.theme === theme ? 'active' : ''} onClick={() => onUpdatePreferences({ theme })}><span className={`theme-preview theme-preview--${theme}`} />{theme === 'dark' ? 'Тёмная' : theme === 'amoled' ? 'AMOLED' : theme === 'light' ? 'Светлая' : 'Системная'}</button>)}</div></section>
                <section className="settings-card">
                  <div className="settings-card-title"><h3>Акцент приложения</h3><p>Кнопки, активные чаты, ссылки и ваши сообщения</p></div>
                  <div className="accent-options">
                    {(['violet', 'blue', 'emerald', 'rose', 'amber'] as AccentPreference[]).map((accent) => (
                      <button key={accent} className={`accent-option accent-option--${accent}${preferences.accent === accent ? ' active' : ''}`} onClick={() => onUpdatePreferences({ accent })} aria-label={accent}>
                        <span />{accent === 'violet' ? 'Фиолетовый' : accent === 'blue' ? 'Синий' : accent === 'emerald' ? 'Изумрудный' : accent === 'rose' ? 'Розовый' : 'Янтарный'}
                      </button>
                    ))}
                    <button
                      className={`accent-option accent-option--custom${preferences.accent === 'custom' ? ' active' : ''}`}
                      onClick={() => onUpdatePreferences({ accent: 'custom' })}
                      aria-pressed={preferences.accent === 'custom'}
                    >
                      <span style={{ background: preferences.customAccentColor }} />Свой цвет
                    </button>
                  </div>
                  {preferences.accent === 'custom' && (
                    <div className="settings-inline-picker">
                      <ColorPicker
                        color={preferences.customAccentColor}
                        onChange={(customAccentColor) => onUpdatePreferences({ accent: 'custom', customAccentColor })}
                        label="Акцент приложения"
                      />
                    </div>
                  )}
                </section>
                <section className="settings-card"><div className="settings-card-title"><h3>Размер текста</h3><p>Настройте читаемость сообщений и элементов интерфейса</p></div><div className="settings-segments">{(['small', 'medium', 'large'] as FontSizePreference[]).map((size) => <button key={size} className={preferences.fontSize === size ? 'active' : ''} onClick={() => onUpdatePreferences({ fontSize: size })}>{size === 'small' ? 'Мелкий' : size === 'medium' ? 'Обычный' : 'Крупный'}</button>)}</div></section>
                <section className="settings-card"><div className="settings-card-title"><h3>Шрифт</h3><p>Меняет характер всего интерфейса</p></div><div className="settings-segments">{(['system', 'modern', 'rounded'] as FontPreference[]).map((fontFamily) => <button key={fontFamily} className={`font-option font-option--${fontFamily}${preferences.fontFamily === fontFamily ? ' active' : ''}`} onClick={() => onUpdatePreferences({ fontFamily })}>{fontFamily === 'system' ? 'Системный' : fontFamily === 'modern' ? 'Современный' : 'Скруглённый'}</button>)}</div></section>
                <section className="settings-card"><div className="settings-card-title"><h3>Ширина списка чатов</h3><p>Полезно для маленьких ноутбуков и широких мониторов</p></div><div className="settings-segments">{(['compact', 'normal', 'wide'] as SidebarPreference[]).map((sidebarSize) => <button key={sidebarSize} className={preferences.sidebarSize === sidebarSize ? 'active' : ''} onClick={() => onUpdatePreferences({ sidebarSize })}>{sidebarSize === 'compact' ? 'Узкая' : sidebarSize === 'normal' ? 'Обычная' : 'Широкая'}</button>)}</div></section>
                <section className="settings-card settings-card--rows"><SettingToggle label="Компактный режим" description="Уменьшает отступы и помещает больше информации" checked={preferences.compactMode} onChange={(compactMode) => onUpdatePreferences({ compactMode })} /><SettingToggle label="Уменьшить анимации" description="Отключает лишние движения и плавные переходы" checked={preferences.reducedMotion} onChange={(reducedMotion) => onUpdatePreferences({ reducedMotion })} /></section>
              </>
            )}

            {activeTab === 'effects' && (
              <>
                <section className="settings-card"><div className="settings-card-title"><h3>Фон переписки</h3><p>Выберите атмосферу для области сообщений</p></div><div className="wallpaper-options">{(['plain', 'aurora', 'dots', 'grid', 'midnight'] as WallpaperPreference[]).map((wallpaper) => <button key={wallpaper} className={preferences.wallpaper === wallpaper ? 'active' : ''} onClick={() => onUpdatePreferences({ wallpaper })}><span className={`wallpaper-preview wallpaper-preview--${wallpaper}`} /><strong>{wallpaper === 'plain' ? 'Чистый' : wallpaper === 'aurora' ? 'Аврора' : wallpaper === 'dots' ? 'Точки' : wallpaper === 'grid' ? 'Сетка' : 'Полночь'}</strong></button>)}</div></section>
                <section className="settings-card"><div className="settings-card-title"><h3>Стиль сообщений</h3><p>Форма и материал пузырей сообщений</p></div><div className="bubble-options">{(['soft', 'compact', 'glass', 'outline'] as BubblePreference[]).map((bubbleStyle) => <button key={bubbleStyle} className={preferences.bubbleStyle === bubbleStyle ? 'active' : ''} onClick={() => onUpdatePreferences({ bubbleStyle })}><span className={`bubble-preview bubble-preview--${bubbleStyle}`}><i>Привет!</i><i>Как дела?</i></span><strong>{bubbleStyle === 'soft' ? 'Мягкий' : bubbleStyle === 'compact' ? 'Компактный' : bubbleStyle === 'glass' ? 'Стекло' : 'Контур'}</strong></button>)}</div></section>
                <section className="settings-card"><div className="settings-card-title"><h3>Появление сообщений</h3><p>Анимация новых сообщений в открытом чате</p></div><div className="settings-segments">{(['fade', 'slide', 'pop', 'none'] as AnimationPreference[]).map((messageAnimation) => <button key={messageAnimation} className={preferences.messageAnimation === messageAnimation ? 'active' : ''} onClick={() => onUpdatePreferences({ messageAnimation })}>{messageAnimation === 'fade' ? 'Плавно' : messageAnimation === 'slide' ? 'Сдвиг' : messageAnimation === 'pop' ? 'Пружина' : 'Без анимации'}</button>)}</div></section>
                <section className="settings-card"><div className="settings-card-title"><h3>Размытие и прозрачность</h3><p>Эффект стекла для панелей и всплывающих элементов</p></div><div className="settings-segments">{(['off', 'soft', 'strong'] as BlurPreference[]).map((blurLevel) => <button key={blurLevel} className={preferences.blurLevel === blurLevel ? 'active' : ''} onClick={() => onUpdatePreferences({ blurLevel })}>{blurLevel === 'off' ? 'Выключено' : blurLevel === 'soft' ? 'Мягкое' : 'Сильное'}</button>)}</div></section>
              </>
            )}

            {activeTab === 'notifications' && (
              <><section className="settings-card settings-card--rows"><SettingToggle label="Системные уведомления" description="Показывать сообщения, когда вкладка свёрнута" checked={preferences.notifications} onChange={(value) => void handleNotifications(value)} /><SettingToggle label="Личные чаты" description="Уведомлять о сообщениях от собеседников" checked={preferences.directNotifications} onChange={(directNotifications) => onUpdatePreferences({ directNotifications })} disabled={!preferences.notifications} /><SettingToggle label="Групповые чаты" description="Уведомлять о новых сообщениях в группах" checked={preferences.groupNotifications} onChange={(groupNotifications) => onUpdatePreferences({ groupNotifications })} disabled={!preferences.notifications} /><SettingToggle label="Предпросмотр текста" description="Показывать текст сообщения в уведомлении" checked={preferences.messagePreview} onChange={(messagePreview) => onUpdatePreferences({ messagePreview })} disabled={!preferences.notifications} /></section><section className="settings-card"><div className="settings-card-title"><h3>Звук уведомления</h3><p>Выберите характер сигнала или полностью отключите его</p></div><div className="settings-segments">{(['soft', 'ping', 'crystal', 'none'] as SoundPreference[]).map((notificationSoundStyle) => <button key={notificationSoundStyle} className={preferences.notificationSoundStyle === notificationSoundStyle ? 'active' : ''} onClick={() => onUpdatePreferences({ notificationSoundStyle, notificationSound: notificationSoundStyle !== 'none' })}>{notificationSoundStyle === 'soft' ? 'Мягкий' : notificationSoundStyle === 'ping' ? 'Ping' : notificationSoundStyle === 'crystal' ? 'Кристалл' : 'Без звука'}</button>)}</div></section>{renderProfileMessage()}</>
            )}

            {activeTab === 'calls' && (
              <>
                <section className="settings-card settings-card--rows">
                  <div className="settings-control-row">
                    <span className="settings-control-copy"><strong>Громкость звонка</strong><small>Громкость входящего и исходящего сигнала звонка</small></span>
                    <span className="settings-slider">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={preferences.callRingVolume}
                        onChange={(e) => onUpdatePreferences({ callRingVolume: Number(e.target.value) })}
                        aria-label="Громкость звонка"
                      />
                      <small>{preferences.callRingVolume}%</small>
                    </span>
                  </div>
                </section>
                <section className="settings-card">
                  <div className="settings-card-title"><h3>Мелодия звонка</h3><p>Сигнал, который вы услышите при входящем звонке</p></div>
                  <div className="settings-segments">
                    {(['classic', 'soft', 'crystal', 'none'] as CallRingtonePreference[]).map((callRingtoneStyle) => (
                      <button
                        key={callRingtoneStyle}
                        className={preferences.callRingtoneStyle === callRingtoneStyle ? 'active' : ''}
                        onClick={() => onUpdatePreferences({ callRingtoneStyle })}
                      >
                        {callRingtoneStyle === 'classic' ? 'Классика' : callRingtoneStyle === 'soft' ? 'Мягкая' : callRingtoneStyle === 'crystal' ? 'Кристалл' : 'Без звука'}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="settings-card settings-card--rows">
                  <SettingToggle
                    label="Начинать видеозвонки с выключенной камерой"
                    description="Камеру можно будет включить вручную в любой момент звонка"
                    checked={preferences.startVideoCallsWithCameraOff}
                    onChange={(startVideoCallsWithCameraOff) => onUpdatePreferences({ startVideoCallsWithCameraOff })}
                  />
                  <SettingToggle
                    label="Не беспокоить"
                    description="Автоматически отклонять все входящие звонки"
                    checked={preferences.doNotDisturbCalls}
                    onChange={(doNotDisturbCalls) => onUpdatePreferences({ doNotDisturbCalls })}
                  />
                </section>
                <DeviceSettings preferences={preferences} onUpdatePreferences={onUpdatePreferences} />
                <section className="settings-card settings-card--rows">
                  <SettingToggle
                    label="Подавление эха"
                    description="Убирает эхо от динамиков; отключайте только при работе через гарнитуру или микшер"
                    checked={preferences.echoCancellation}
                    onChange={(echoCancellation) => onUpdatePreferences({ echoCancellation })}
                  />
                  <SettingToggle
                    label="Шумоподавление"
                    description="Отсекает постоянный фоновый шум — вентилятор, клавиатуру, улицу"
                    checked={preferences.noiseSuppression}
                    onChange={(noiseSuppression) => onUpdatePreferences({ noiseSuppression })}
                  />
                  <SettingToggle
                    label="Автоусиление громкости"
                    description="Выравнивает громкость голоса, если микрофон слышно слишком тихо"
                    checked={preferences.autoGainControl}
                    onChange={(autoGainControl) => onUpdatePreferences({ autoGainControl })}
                  />
                </section>
                <section className="settings-card settings-tip"><strong>Надёжность соединения</strong><p>Звонки используют STUN, а также TURN-сервер, если он настроен на сервере — это помогает установить соединение, даже если оба собеседника за строгим NAT. При кратковременных сбоях сети звонок пытается восстановиться автоматически, не завершаясь сразу.</p></section>
              </>
            )}

            {activeTab === 'chats' && (
              <><section className="settings-card settings-card--rows"><SettingToggle label="Enter отправляет сообщение" description="Shift + Enter добавляет новую строку; Ctrl + Enter отправляет всегда" checked={preferences.enterToSend} onChange={(enterToSend) => onUpdatePreferences({ enterToSend })} /><SettingToggle label="Сохранять черновики" description="Запоминать недописанный текст отдельно для каждого чата" checked={preferences.saveDrafts} onChange={(saveDrafts) => onUpdatePreferences({ saveDrafts })} /><SettingToggle label="Крупные одиночные эмодзи" description="Сообщения только из эмодзи отображаются заметнее" checked={preferences.largeEmoji} onChange={(largeEmoji) => onUpdatePreferences({ largeEmoji })} /></section><section className="settings-card settings-tip"><strong>Управление вводом</strong><p>Поле сообщения растёт вместе с текстом и поддерживает многострочные сообщения до пяти строк.</p></section></>
            )}

            {activeTab === 'privacy' && (
              <><section className="settings-card settings-card--rows"><SettingToggle label="Показывать время посещения" description="Собеседники смогут увидеть, когда вы были в сети" checked={user.showLastSeen ?? true} onChange={(showLastSeen) => void updateProfile({ showLastSeen })} disabled={savingProfile} /><SettingToggle label="Показывать, что я печатаю" description="Отправлять собеседникам индикатор набора текста" checked={preferences.sendTyping} onChange={(sendTyping) => onUpdatePreferences({ sendTyping })} /><SettingToggle label="Отправлять отметки о прочтении" description="Собеседники увидят, какие сообщения вы прочитали" checked={preferences.sendReadReceipts} onChange={(sendReadReceipts) => onUpdatePreferences({ sendReadReceipts })} /></section><section className="settings-card settings-tip"><strong>Приватность</strong><p>Эти параметры действуют сразу на текущем устройстве. Настройка времени посещения сохраняется в аккаунте.</p></section>{renderProfileMessage()}<BlockedUsersSettings /></>
            )}

            {activeTab === 'security' && (
              <>
                <EmailSettings user={user} onRequestVerification={onRequestEmailVerification} onRemoveEmail={onRemoveEmail} />
                <section className="settings-card"><div className="settings-card-title"><h3>Смена пароля</h3><p>Не менее 10 символов и минимум три разных вида символов</p></div><form className="settings-password-form" onSubmit={handlePasswordSubmit}><label htmlFor="old-password">Текущий пароль</label><input id="old-password" type={showPasswords ? 'text' : 'password'} className="text-input" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" /><label htmlFor="new-password">Новый пароль</label><input id="new-password" type={showPasswords ? 'text' : 'password'} className="text-input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} /><label htmlFor="confirm-password">Повторите новый пароль</label><input id="confirm-password" type={showPasswords ? 'text' : 'password'} className="text-input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} /><label className="settings-checkbox-row"><input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />Показать пароли</label>{passwordMessage && <div className={`form-banner ${passwordMessage.error ? 'form-banner--error' : 'form-banner--success'}`}>{passwordMessage.error && <AlertIcon width={15} height={15} />}{passwordMessage.text}</div>}<button type="submit" className="settings-button settings-button--primary" disabled={savingPassword || !oldPassword || !newPassword || !confirmPassword}>{savingPassword && <SpinnerIcon width={15} height={15} />}Сохранить пароль</button></form></section>
              </>
            )}

            {activeTab === 'about' && (
              <><section className="settings-card settings-about"><span className="settings-about-logo">C</span><h3 className="notranslate" translate="no">CorNet</h3><p>Современный мессенджер с личными и групповыми чатами.</p><span className="settings-version">Версия 0.2 Beta</span></section><section className="settings-card settings-card--rows"><div className="settings-control-row"><span className="settings-control-copy"><strong>Сбросить настройки интерфейса</strong><small>Вернуть тему, размер текста и поведение чатов по умолчанию</small></span><button className="settings-button settings-button--ghost" onClick={onResetPreferences}>Сбросить</button></div></section></>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
