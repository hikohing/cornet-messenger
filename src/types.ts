export interface User {
  id: number
  username: string
  displayName?: string | null
  color: string
  avatarUrl?: string | null
  bannerUrl?: string | null
  bannerStyle?: 'profile' | 'ocean' | 'sunset' | 'aurora' | 'midnight' | 'berry' | 'gold' | 'mono' | 'coral' | 'mint' | 'lavender' | 'crimson' | 'emerald' | 'graphite' | 'peach' | 'indigo'
  avatarDecoration?: 'none' | 'ring' | 'neon' | 'sparkles' | 'double' | 'halo' | 'petals' | 'flames' | 'bubbles' | 'pixel' | 'frost' | 'vines' | 'comet' | 'aurora' | 'gold' | 'shadow'
  profileEffect?: 'none' | 'glow' | 'aurora' | 'grid' | 'holo' | 'stars' | 'confetti' | 'rain' | 'pulse' | 'scan' | 'sakura' | 'comet' | 'snow' | 'embers' | 'matrix' | 'ripple'
  profileTheme?: 'default' | 'night' | 'berry' | 'ocean' | 'forest' | 'sunset' | 'crimson' | 'emerald' | 'graphite' | 'rose'
  nameStyle?: 'plain' | 'accent' | 'gradient' | 'glow' | 'mono' | 'shadow' | 'outline' | 'neon'
  profileFrame?: 'none' | 'accent' | 'glass' | 'gold' | 'neon' | 'ice' | 'fire' | 'shadow' | 'emerald' | 'rose'
  nameplateStyle?: 'none' | 'cosmic' | 'sakura' | 'arcade' | 'forest' | 'gold' | 'ocean' | 'crimson' | 'midnight' | 'royal'
  profilePrimaryColor?: string | null
  profileSecondaryColor?: string | null
  showLastSeen?: boolean
  statusText?: string
  bio?: string
  birthDate?: string | null
  lastSeenAt?: number | null
  createdAt?: number | null
  online?: boolean
  /** Присутствуют только в приватном объекте текущего пользователя (не в чужих профилях). */
  email?: string | null
  emailVerified?: boolean
  totpEnabled?: boolean
}

export interface BlockedUser {
  id: number
  username: string
  displayName?: string | null
  color: string
  avatarUrl?: string | null
  blockedAt: number
}

export interface Reaction {
  emoji: string
  userIds: number[]
}

export type CallOutcome = 'answered' | 'missed' | 'declined' | 'cancelled' | 'failed'

/** Итог звонка, который сервер записывает в историю чата. */
export interface CallMeta {
  video: boolean
  outcome: CallOutcome
  duration: number
  interrupted?: boolean
}

export type AttachmentMessageType = 'image' | 'video' | 'audio' | 'voice' | 'file'

export interface MessageAttachment {
  url: string
  name: string
  mimeType: string
  size: number
  duration?: number
  messageType: AttachmentMessageType
}

export interface Message {
  id: number
  chatId: number
  senderId: number
  type: 'text' | AttachmentMessageType | 'call'
  text: string
  callMeta?: CallMeta | null
  attachmentUrl?: string | null
  attachment?: Omit<MessageAttachment, 'url' | 'messageType'> | null
  replyToId?: number | null
  replyTo?: Message | null
  forwarded?: boolean
  editedAt?: number | null
  deleted: number | boolean
  createdAt: number
  reactions?: Reaction[]
  pending?: boolean
}

export type ChatType = 'direct' | 'group' | 'saved'

export interface ReadStateEntry {
  userId: number
  lastReadMessageId: number
}

export interface Chat {
  id: number
  type: ChatType
  name: string
  description?: string
  avatarUrl?: string | null
  members: User[]
  lastMessage: Message | null
  readState: ReadStateEntry[]
  unreadCount: number
  pinnedMessage: Message | null
  pinned: boolean
}
