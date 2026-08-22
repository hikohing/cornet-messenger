import type { BlockedUser, Chat, ChatFolder, Message, MessageAttachment, User } from '../types'
import { isNative } from '../native/platform'
import { readSecure, removeSecure, writeSecure } from '../native/storage'

const API_URL = import.meta.env.VITE_API_URL ?? ''

const TOKEN_KEY = 'web-messenger:token'

export function getToken(): string | null {
  return readSecure(TOKEN_KEY)
}

export function setToken(token: string) {
  writeSecure(TOKEN_KEY, token)
}

export function clearToken() {
  removeSecure(TOKEN_KEY)
}

/**
 * Сервер выдаёт session token в теле ответа только нативному клиенту — по этому
 * заголовку он его и узнаёт. В браузере заголовка нет, сессия остаётся в
 * HttpOnly-куке, недоступной для XSS.
 */
function clientHeaders(): Record<string, string> {
  return isNative() ? { 'X-Client': 'native' } : {}
}

/**
 * Забирает выданный сервером токен. В вебе его в ответе нет — там сессия
 * приходит кукой, а любой оставшийся с прошлых версий токен надо стереть.
 */
function adoptSession<T extends { token?: string }>(response: T): T {
  if (response.token) setToken(response.token)
  else clearToken()
  return response
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...clientHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch {
    throw new Error('Нет соединения с сервером. Обновите страницу и попробуйте снова.')
  }
  let data: { error?: string } = {}
  try {
    data = await res.json()
  } catch {
    if (!res.ok) throw new Error('Сервер недоступен. Попробуйте позже.')
  }
  if (!res.ok) throw new Error(data.error ?? 'Ошибка запроса')
  return data as T
}

export function register(username: string, password: string) {
  return request<{ user: User; token?: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }).then(adoptSession)
}

export function login(username: string, password: string) {
  return request<{ user: User; token?: string } | { twoFactorRequired: true; pendingToken: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }).then((res) => ('twoFactorRequired' in res ? res : adoptSession(res)))
}

export function verifyTwoFactorLogin(pendingToken: string, code: string) {
  return request<{ user: User; token?: string }>('/api/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ pendingToken, code }),
  }).then(adoptSession)
}

export function enrollTotp() {
  return request<{ secret: string; otpauthUrl: string }>('/api/me/2fa/enroll', { method: 'POST' })
}

export function confirmTotp(code: string) {
  return request<{ backupCodes: string[] }>('/api/me/2fa/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function disableTotp(password: string) {
  return request<{ ok: true }>('/api/me/2fa/disable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function getMe() {
  return request<{ user: User }>('/api/me')
}

export function logout() {
  return request<{ ok: true }>('/api/auth/logout', { method: 'POST' })
}

export function getChats() {
  return request<{ chats: Chat[] }>('/api/chats')
}

export function createChat(username: string) {
  return request<{ chat: Chat }>('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ username }),
  })
}

export function getMessages(chatId: number) {
  return request<{ messages: Message[] }>(`/api/chats/${chatId}/messages`)
}

export function searchUsers(query: string) {
  return request<{ users: User[] }>(`/api/users?query=${encodeURIComponent(query)}`)
}

export function createGroupChat(name: string, usernames: string[]) {
  return request<{ chat: Chat }>('/api/chats/group', {
    method: 'POST',
    body: JSON.stringify({ name, usernames }),
  })
}

export function updateProfile(patch: {
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
  statusText?: string
  birthDate?: string | null
  displayName?: string | null
}) {
  return request<{ user: User }>('/api/me', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function updateChatInfo(chatId: number, patch: { name?: string; description?: string; avatarUrl?: string | null }) {
  return request<{ chat: Chat }>(`/api/chats/${chatId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function leaveGroup(chatId: number) {
  return request<{ ok: true }>(`/api/chats/${chatId}/leave`, { method: 'POST' })
}

export function getFolders() {
  return request<{ folders: ChatFolder[] }>('/api/folders')
}

export function createFolder(name: string, chatIds: number[]) {
  return request<{ id: number; folders: ChatFolder[] }>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name, chatIds }),
  })
}

export function updateFolder(folderId: number, patch: { name?: string; chatIds?: number[] }) {
  return request<{ folders: ChatFolder[] }>(`/api/folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteFolder(folderId: number) {
  return request<{ folders: ChatFolder[] }>(`/api/folders/${folderId}`, { method: 'DELETE' })
}

export function archiveChat(chatId: number, archived: boolean) {
  return request<{ chat: Chat }>(`/api/chats/${chatId}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  })
}

/** `mutedUntil: null` включает уведомления обратно. */
export function muteChat(chatId: number, mutedUntil: number | null) {
  return request<{ chat: Chat }>(`/api/chats/${chatId}/mute`, {
    method: 'PATCH',
    body: JSON.stringify({ mutedUntil }),
  })
}

/** Варианты таймера исчезающих сообщений; 0 выключает. */
export const AUTO_DELETE_OPTIONS = [0, 24 * 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60] as const

export function setAutoDelete(chatId: number, seconds: number) {
  return request<{ ok: true; seconds: number }>(`/api/chats/${chatId}/auto-delete`, {
    method: 'PATCH',
    body: JSON.stringify({ seconds }),
  })
}

export function changePassword(oldPassword: string, newPassword: string) {
  // Смена пароля выпускает новую сессию — старый токен сразу перестаёт работать.
  return request<{ ok: true; token?: string }>('/api/me/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  }).then(adoptSession)
}

export interface SessionInfo {
  id: string
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
  isCurrent: boolean
}

export function getSessions() {
  return request<{ sessions: SessionInfo[] }>('/api/me/sessions')
}

export function revokeSession(sessionId: string) {
  return request<{ ok: boolean }>(`/api/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export function revokeOtherSessions() {
  return request<{ ok: true; count: number }>('/api/me/sessions', { method: 'DELETE' })
}

export function requestEmailVerification(email: string) {
  return request<{ ok: true }>('/api/me/email', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export function removeEmail() {
  return request<{ ok: true }>('/api/me/email', { method: 'DELETE' })
}

export function verifyEmail(token: string) {
  return request<{ user: User }>('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export function forgotPassword(email: string) {
  return request<{ ok: true }>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/** Необратимо: удаляет аккаунт, личные чаты и всё загруженное. */
export function deleteAccount(password: string, code?: string) {
  return request<{ ok: true }>('/api/me', {
    method: 'DELETE',
    body: JSON.stringify({ password, code }),
  })
}

export function resetPassword(token: string, newPassword: string) {
  return request<{ user: User; token?: string }>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  }).then(adoptSession)
}

export function blockUser(userId: number) {
  return request<{ ok: true }>(`/api/users/${userId}/block`, { method: 'POST' })
}

export function unblockUser(userId: number) {
  return request<{ ok: true }>(`/api/users/${userId}/unblock`, { method: 'POST' })
}

export interface ReportReason {
  id: string
  label: string
}

export function getReportReasons() {
  return request<{ reasons: ReportReason[] }>('/api/reports/reasons')
}

export function submitReport(input: {
  reason: string
  comment?: string
  messageId?: number
  targetUserId?: number
  /** Текст, снятый на устройстве: в зашифрованных чатах сервер видит только шифротекст. */
  excerpt?: string
}) {
  return request<{ id: number }>('/api/reports', { method: 'POST', body: JSON.stringify(input) })
}

export function getBlockedUsers() {
  return request<{ users: BlockedUser[] }>('/api/users/blocked')
}

/**
 * @param name имя, под которым файл уедет на сервер. У зашифрованных вложений
 *   оно намеренно обезличено — настоящее хранится внутри конверта сообщения.
 */
export interface UploadOptions {
  /** Доля отправленных байтов, 0…1. Вызывается по мере отправки тела запроса. */
  onProgress?: (fraction: number) => void
  /** Отмена: пользователь убрал вложение из панели, пока оно грузилось. */
  signal?: AbortSignal
}

/** Отменённая пользователем загрузка — не ошибка, её не показывают в интерфейсе. */
export class UploadAbortedError extends Error {
  constructor() {
    super('Загрузка отменена')
    this.name = 'UploadAbortedError'
  }
}

/**
 * XMLHttpRequest, а не fetch: только он даёт прогресс отправки тела. Без него
 * загрузка 25 МБ выглядит как зависшая кнопка, и человек жмёт её повторно.
 */
export function uploadFile(
  file: Blob,
  name?: string,
  options: UploadOptions = {},
): Promise<Omit<MessageAttachment, 'messageType'>> {
  const token = getToken()
  const form = new FormData()
  form.append('file', file, name ?? (file instanceof File ? file.name : 'file'))

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadAbortedError())
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_URL}/api/upload`)
    xhr.withCredentials = true
    for (const [header, value] of Object.entries(clientHeaders())) xhr.setRequestHeader(header, value)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    const onAbort = () => xhr.abort()
    options.signal?.addEventListener('abort', onAbort)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () => {
      options.signal?.removeEventListener('abort', onAbort)
      let data: { error?: string } & Record<string, unknown>
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        reject(new Error('Ошибка загрузки'))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error ?? 'Ошибка загрузки'))
        return
      }
      options.onProgress?.(1)
      resolve(data as unknown as Omit<MessageAttachment, 'messageType'>)
    }
    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new Error('Нет соединения с сервером. Обновите страницу и попробуйте снова.'))
    }
    xhr.onabort = () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new UploadAbortedError())
    }
    xhr.send(form)
  })
}

export function pinChat(chatId: number, pinned: boolean) {
  return request<{ chat: Chat }>(`/api/chats/${chatId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  })
}

export function searchMessages(chatId: number, query: string) {
  return request<{ messages: Message[] }>(`/api/chats/${chatId}/search?query=${encodeURIComponent(query)}`)
}

export interface GroupKeyShare {
  rotation: number
  wrappedKey: string
  iv: string
  ephemeralPublicKey: JsonWebKey
}

export function getGroupKeyState(chatId: number) {
  return request<{ rotation: number; nextRotation: number; shares: GroupKeyShare[]; memberIds: number[] }>(
    `/api/chats/${chatId}/group-key`,
  )
}

export function publishGroupKey(
  chatId: number,
  rotation: number,
  shares: Array<{ userId: number; wrappedKey: string; iv: string; ephemeralPublicKey: JsonWebKey }>,
) {
  return request<{ accepted: boolean; rotation: number }>(`/api/chats/${chatId}/group-key`, {
    method: 'POST',
    body: JSON.stringify({ rotation, shares }),
  })
}

export interface PushDeviceRegistration {
  /** `apns_voip` — токен PushKit для звонков; он не совпадает с обычным APNs-токеном. */
  provider: 'apns' | 'webpush' | 'apns_voip'
  token: string
  keys?: { p256dh: string; auth: string }
  preview: boolean
  directEnabled: boolean
  groupEnabled: boolean
}

export function getPushConfig() {
  return request<{ vapidPublicKey: string | null; apnsEnabled: boolean }>('/api/push/config')
}

export function registerPushDevice(device: PushDeviceRegistration) {
  return request<{ ok: true }>('/api/push/devices', { method: 'POST', body: JSON.stringify(device) })
}

export function unregisterPushDevice(provider: 'apns' | 'webpush' | 'apns_voip', token: string) {
  return request<{ ok: true }>('/api/push/devices', { method: 'DELETE', body: JSON.stringify({ provider, token }) })
}

export function getIceServers() {
  return request<{ iceServers: RTCIceServer[] }>('/api/ice-servers')
}

export function apiUrl() {
  return API_URL
}

/**
 * Билет на чтение /uploads для нативной сборки: `<img src>` не умеет слать
 * Authorization, а куки домена API из WebView со схемы capacitor:// не уходят.
 * В браузере не используется — там загрузки авторизуются кукой как обычно.
 */
let mediaTicket: { value: string; expiresAt: number } | null = null

export async function ensureMediaTicket(): Promise<void> {
  if (!isNative()) return
  // Обновляем заранее: билет живёт полсуток, и менять его чаще нет смысла —
  // новый билет меняет URL и обнуляет кэш всех уже загруженных картинок.
  if (mediaTicket && mediaTicket.expiresAt - Date.now() > 60 * 60 * 1000) return
  try {
    const res = await request<{ ticket: string; expiresAt: number }>('/api/media-ticket')
    mediaTicket = { value: res.ticket, expiresAt: res.expiresAt }
  } catch {
    // Останемся без билета — картинки не откроются, но всё остальное работает.
  }
}

export function clearMediaTicket() {
  mediaTicket = null
}

export function resolveUrl(url: string) {
  // Расшифрованное вложение приходит сюда как blob:-ссылка — к ней ничего
  // приписывать нельзя, иначе получится битый адрес.
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  const absolute = url.startsWith('http') ? url : `${API_URL}${url}`
  if (!mediaTicket || !absolute.includes('/uploads/')) return absolute
  return `${absolute}${absolute.includes('?') ? '&' : '?'}t=${encodeURIComponent(mediaTicket.value)}`
}
