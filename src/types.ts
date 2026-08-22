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
  /**
   * Размеры кадра у фото и видео. Нужны, чтобы место под медиа было занято до
   * загрузки байтов: иначе лента дёргается, когда картинка наконец приходит.
   */
  width?: number
  height?: number
  messageType: AttachmentMessageType
  /**
   * Только на клиенте: ключ от зашифрованного файла. Не уходит на сервер как
   * поле вложения — его место внутри конверта сообщения, зашифрованного для
   * получателя.
   */
  secret?: { key: string; iv: string }
}

/** Вложение после расшифровки конверта: то, чего сервер о файле не знает. */
export interface DecryptedAttachment {
  key: string
  iv: string
  name: string
  mimeType: string
  size: number
  duration?: number
  width?: number
  height?: number
  messageType: AttachmentMessageType
}

export interface MessageEncryptionData {
  /**
   * Поколение группового ключа. Есть только у групповых сообщений — по нему
   * получатель понимает, какой из своих ключей брать: после ухода участника в
   * чате сосуществуют сообщения разных поколений.
   */
  rotation?: number
  version: 1
  ciphertext: string
  iv: string
  signature: string
  senderId: number
  ephemeralPublicKey?: JsonWebKey
  /** Same plaintext, separately encrypted to the sender's own public key so they can read it back after reload. */
  self?: {
    ciphertext: string
    iv: string
    ephemeralPublicKey: JsonWebKey
  }
}

export interface PollOption {
  id: number
  text: string
  votes: number
  /** Отдал ли текущий пользователь голос за этот вариант. */
  chosen: boolean
  /** В анонимном опросе всегда null — сервер не отдаёт список голосовавших. */
  voterIds: number[] | null
}

export interface Poll {
  messageId: number
  question: string
  anonymous: boolean
  multipleChoice: boolean
  closed: boolean
  totalVoters: number
  options: PollOption[]
}

export interface Message {
  id: number
  chatId: number
  senderId: number
  type: 'text' | AttachmentMessageType | 'call' | 'poll'
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
  /**
   * Client-only stable identity that survives the optimistic → server-confirmed
   * swap. Keying the list on the raw `id` would remount the row when the
   * negative optimistic id is replaced by the real one, replaying the entry
   * animation on every message you send.
   */
  clientKey?: number
  encrypted?: boolean
  encryptionData?: MessageEncryptionData | null
  /** Заполнен только у сообщений типа `poll`. */
  poll?: Poll | null
  /** Client-only: filled in after local decryption, never sent by the server. */
  decryptedText?: string
  /**
   * Настоящие имя, тип и ключ вложения — они лежат внутри конверта, поэтому
   * появляются только после расшифровки. Серверу видны лишь непрозрачные байты.
   */
  decryptedFile?: DecryptedAttachment
  decryptionFailed?: 'signature_invalid' | 'key_missing' | 'decrypt_failed'
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
  archived: boolean
  /** null — уведомления включены; иначе до какого момента чат беззвучный. */
  mutedUntil: number | null
  /** 0 — таймер выключен; иначе через сколько секунд сообщения исчезают. */
  autoDeleteSeconds: number
}

export interface ChatFolder {
  id: number
  name: string
  position: number
  chatIds: number[]
}
