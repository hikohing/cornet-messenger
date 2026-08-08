import type { BlockedUser, Chat, Message, MessageAttachment, User } from '../types'

const API_URL = import.meta.env.VITE_API_URL ?? ''

const TOKEN_KEY = 'web-messenger:token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
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
  return request<{ user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function login(username: string, password: string) {
  return request<{ user: User } | { twoFactorRequired: true; pendingToken: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function verifyTwoFactorLogin(pendingToken: string, code: string) {
  return request<{ user: User }>('/api/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ pendingToken, code }),
  })
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

export function changePassword(oldPassword: string, newPassword: string) {
  return request<{ ok: true }>('/api/me/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  })
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

export function resetPassword(token: string, newPassword: string) {
  return request<{ user: User }>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
}

export function blockUser(userId: number) {
  return request<{ ok: true }>(`/api/users/${userId}/block`, { method: 'POST' })
}

export function unblockUser(userId: number) {
  return request<{ ok: true }>(`/api/users/${userId}/unblock`, { method: 'POST' })
}

export function getBlockedUsers() {
  return request<{ users: BlockedUser[] }>('/api/users/blocked')
}

export async function uploadFile(file: File): Promise<Omit<MessageAttachment, 'messageType'>> {
  const token = getToken()
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    })
  } catch {
    throw new Error('Нет соединения с сервером. Обновите страницу и попробуйте снова.')
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Ошибка загрузки')
  return data
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

export function getIceServers() {
  return request<{ iceServers: RTCIceServer[] }>('/api/ice-servers')
}

export function apiUrl() {
  return API_URL
}

export function resolveUrl(url: string) {
  return url.startsWith('http') ? url : `${API_URL}${url}`
}
