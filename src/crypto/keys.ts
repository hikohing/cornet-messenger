import {
  CRYPTO_KEYS_PREFIX,
  LEGACY_CRYPTO_KEYS_KEY,
  PUBLIC_KEYS_KEY,
  readSecure,
  removeSecure,
  writeSecure,
} from '../native/storage'

// Приватные ключи в нативной сборке уходят в Keychain, а не в хранилище
// WebView: iOS считает его кэшем и вправе вычистить при нехватке места, а
// вместе с ключом человек потеряет доступ ко всей переписке. В браузере
// readSecure/writeSecure — это тот же localStorage, что и раньше.

/**
 * Приватная пара — своя у каждого аккаунта. Одна ячейка на устройство означала
 * бы, что вход под вторым аккаунтом подхватит уже лежащую пару и опубликует под
 * новым userId тот же публичный ключ: два аккаунта с одинаковыми ключами
 * технически читают переписку друг друга.
 */
function keysStorageKey(userId: number): string {
  return `${CRYPTO_KEYS_PREFIX}${userId}`
}

/**
 * Чей ключ сейчас в работе. Расшифровка вызывается оттуда, где userId под рукой
 * нет (encryption.ts, keyAgreement.ts), а брать «просто ту пару, что лежит» —
 * ровно та ошибка, от которой уводит привязка к аккаунту. Пока владелец не
 * назначен, приватной пары для остального кода не существует.
 */
let activeUserId: number | null = null

/** Вызывается из useCrypto при входе, смене аккаунта и выходе. */
export function setActiveKeyOwner(userId: number | null) {
  activeUserId = userId
}

export interface UserKeyPair {
  x25519: {
    publicKey: JsonWebKey
    privateKey: JsonWebKey
  }
  ed25519: {
    publicKey: JsonWebKey
    privateKey: JsonWebKey
  }
}

export interface StoredPublicKey {
  userId: number
  x25519PublicKey: JsonWebKey
  ed25519PublicKey: JsonWebKey
  publicKeySignature: string
  createdAt: number
}

export async function generateKeyPair(): Promise<UserKeyPair> {
  const x25519Pair = await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )

  const ed25519Pair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )

  return {
    x25519: {
      publicKey: (await crypto.subtle.exportKey('jwk', x25519Pair.publicKey)) as JsonWebKey,
      privateKey: (await crypto.subtle.exportKey('jwk', x25519Pair.privateKey)) as JsonWebKey,
    },
    ed25519: {
      publicKey: (await crypto.subtle.exportKey('jwk', ed25519Pair.publicKey)) as JsonWebKey,
      privateKey: (await crypto.subtle.exportKey('jwk', ed25519Pair.privateKey)) as JsonWebKey,
    },
  }
}

export function saveKeyPair(userId: number, keys: UserKeyPair) {
  writeSecure(keysStorageKey(userId), JSON.stringify(keys))
}

function readKeyPair(userId: number): UserKeyPair | null {
  const stored = readSecure(keysStorageKey(userId))
  if (!stored) return null
  return JSON.parse(stored)
}

/**
 * Пара активного владельца. `expectedUserId` — страховка для вызовов, которые
 * знают, за кого работают: расхождение значит, что владелец ещё не переключился
 * (гонка при смене аккаунта), и молча взять чужую пару в этот момент нельзя.
 */
export async function loadKeyPair(expectedUserId?: number): Promise<UserKeyPair | null> {
  if (activeUserId === null) return null
  if (expectedUserId !== undefined && expectedUserId !== activeUserId) return null
  return readKeyPair(activeUserId)
}

/** Пара, оставшаяся от версии с одной ячейкой на устройство, ещё не отданная никому. */
export function readLegacyKeyPair(): UserKeyPair | null {
  const stored = readSecure(LEGACY_CRYPTO_KEYS_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored)
  } catch {
    // Разобрать не вышло — такой блоб всё равно нечем воспользоваться.
    return null
  }
}

/**
 * Отдаёт наследованную пару аккаунту: с этого момента она принадлежит ему одному,
 * и следующий вошедший на этом устройстве получит уже свою, новую.
 */
export function claimLegacyKeyPair(userId: number, keys: UserKeyPair) {
  saveKeyPair(userId, keys)
  removeSecure(LEGACY_CRYPTO_KEYS_KEY)
}

export async function loadSigningKey(): Promise<CryptoKey | null> {
  const keyPair = await loadKeyPair()
  if (!keyPair) return null

  return crypto.subtle.importKey(
    'jwk',
    keyPair.ed25519.privateKey,
    { name: 'Ed25519' },
    false,
    ['sign']
  )
}

export async function loadVerifyKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'Ed25519' },
    false,
    ['verify']
  )
}

export async function loadX25519PrivateKey(): Promise<CryptoKey | null> {
  const keyPair = await loadKeyPair()
  if (!keyPair) return null

  return crypto.subtle.importKey(
    'jwk',
    keyPair.x25519.privateKey,
    { name: 'X25519' },
    false,
    ['deriveBits']
  )
}

export function savePublicKey(stored: StoredPublicKey) {
  const keys = JSON.parse(readSecure(PUBLIC_KEYS_KEY) || '{}')
  keys[stored.userId] = stored
  writeSecure(PUBLIC_KEYS_KEY, JSON.stringify(keys))
}

export function getPublicKey(userId: number): StoredPublicKey | null {
  const keys = JSON.parse(readSecure(PUBLIC_KEYS_KEY) || '{}')
  return keys[userId] || null
}

export function getStoredPublicKeys(): Record<number, StoredPublicKey> {
  return JSON.parse(readSecure(PUBLIC_KEYS_KEY) || '{}')
}

/**
 * Стирает пару одного аккаунта. Пары остальных аккаунтов этого устройства и
 * ещё не разобранная наследованная ячейка остаются на месте: удаление своего
 * аккаунта не повод лишать соседа доступа к его истории. Кэш чужих публичных
 * ключей общий и восстановимый — его чистим целиком.
 */
export function clearKeysFor(userId: number) {
  removeSecure(keysStorageKey(userId))
  removeSecure(PUBLIC_KEYS_KEY)
}
