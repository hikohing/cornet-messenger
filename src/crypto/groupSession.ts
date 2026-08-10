import type { Chat } from '../types'
import { getGroupKeyState, publishGroupKey } from '../api/client'
import { getPublicKey, type StoredPublicKey } from './keys'
import { generateGroupKey, unwrapGroupKey, wrapGroupKeyForMember } from './keyAgreement'
import { fetchAndVerifyPublicKeys } from '../hooks/useCrypto'

/**
 * Ключи групповых чатов.
 *
 * Ключ у группы общий и симметричный: шифровать каждое сообщение отдельно для
 * каждого участника было бы дорого и плохо масштабировалось. Сам ключ до
 * сервера не доходит — каждому участнику достаётся копия, завёрнутая его
 * публичным ключом.
 *
 * Ключ живёт поколениями. Когда кто-то уходит, сервер помечает поколение
 * устаревшим, и следующий отправитель создаёт новое: ушедший знает старый ключ,
 * но не получит нового. Старые сообщения остаются читаемыми — доли прежних
 * поколений никуда не деваются.
 */
interface CachedKey {
  rotation: number
  key: CryptoKey
}

/** Ключи по чатам и поколениям: `chatId:rotation` → развёрнутый ключ. */
const unwrapped = new Map<string, CryptoKey>()
/** Действующее поколение по чатам — им шифруются исходящие. */
const current = new Map<number, CachedKey>()
/** Незавершённые попытки создать ключ: чтобы одна вкладка не плодила поколения. */
const pending = new Map<number, Promise<CachedKey | null>>()

function cacheKey(chatId: number, rotation: number) {
  return `${chatId}:${rotation}`
}

export function forgetGroupKeys() {
  unwrapped.clear()
  current.clear()
  pending.clear()
}

/** Разворачивает все доли, которые сервер выдал нам для этого чата. */
async function absorbShares(chatId: number, shares: Awaited<ReturnType<typeof getGroupKeyState>>['shares']) {
  for (const share of shares) {
    const id = cacheKey(chatId, share.rotation)
    if (unwrapped.has(id)) continue
    try {
      const key = await unwrapGroupKey(share.wrappedKey, share.iv, share.ephemeralPublicKey)
      if (key) unwrapped.set(id, key)
    } catch {
      // Доля от чужого ключа или повреждённая — просто не будет доступна.
    }
  }
}

/** Создаёт новое поколение и раздаёт его всем участникам. */
async function createRotation(chatId: number, rotation: number, memberIds: number[]): Promise<CachedKey | null> {
  const missing = memberIds.filter((id) => !getPublicKey(id))
  if (missing.length > 0) await fetchAndVerifyPublicKeys(missing)

  const bundles: StoredPublicKey[] = []
  for (const id of memberIds) {
    const bundle = getPublicKey(id)
    // Без ключа хотя бы одного участника новое поколение создавать нельзя: он
    // остался бы с нечитаемой перепиской, и мы бы об этом даже не узнали.
    if (!bundle) return null
    bundles.push(bundle)
  }

  const { key, raw } = await generateGroupKey()
  const shares = await Promise.all(
    bundles.map(async (bundle) => ({ userId: bundle.userId, ...(await wrapGroupKeyForMember(raw, bundle)) })),
  )

  const result = await publishGroupKey(chatId, rotation, shares)
  if (!result.accepted) {
    // Кто-то опередил нас — его поколение и берём.
    return loadGroupKey(chatId, true)
  }

  unwrapped.set(cacheKey(chatId, rotation), key)
  const entry = { rotation, key }
  current.set(chatId, entry)
  return entry
}

/**
 * Действующий ключ группы: из кэша, из выданных сервером долей или, если
 * действующего поколения нет, созданием нового.
 */
export async function loadGroupKey(chatId: number, force = false): Promise<CachedKey | null> {
  if (!force) {
    const cached = current.get(chatId)
    if (cached) return cached
    const inFlight = pending.get(chatId)
    if (inFlight) return inFlight
  }

  const attempt = (async (): Promise<CachedKey | null> => {
    const state = await getGroupKeyState(chatId)
    await absorbShares(chatId, state.shares)

    if (state.rotation > 0) {
      const key = unwrapped.get(cacheKey(chatId, state.rotation))
      if (key) {
        const entry = { rotation: state.rotation, key }
        current.set(chatId, entry)
        return entry
      }
      // Поколение есть, а доли для нас нет: мы присоединились позже. Прежнюю
      // переписку прочитать не сможем, но дальше должны писать вместе со всеми.
    }

    return createRotation(chatId, state.nextRotation, state.memberIds)
  })()

  pending.set(chatId, attempt)
  try {
    return await attempt
  } finally {
    pending.delete(chatId)
  }
}

/** Ключ конкретного поколения — для расшифровки того, что пришло. */
export async function groupKeyForRotation(chatId: number, rotation: number): Promise<CryptoKey | null> {
  const cached = unwrapped.get(cacheKey(chatId, rotation))
  if (cached) return cached

  // Доля могла появиться уже после того, как мы в последний раз спрашивали.
  const state = await getGroupKeyState(chatId).catch(() => null)
  if (!state) return null
  await absorbShares(chatId, state.shares)
  return unwrapped.get(cacheKey(chatId, rotation)) ?? null
}

/** Готов ли чат к шифрованию: у всех участников есть опубликованные ключи. */
export async function groupEncryptionReady(chat: Chat, currentUserId: number | null): Promise<boolean> {
  if (chat.type !== 'group' || currentUserId === null) return false
  const memberIds = chat.members.map((member) => member.id)
  const missing = memberIds.filter((id) => !getPublicKey(id))
  if (missing.length > 0) await fetchAndVerifyPublicKeys(missing)
  return memberIds.every((id) => getPublicKey(id) !== null)
}
