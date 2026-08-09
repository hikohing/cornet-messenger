import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { isNative } from './platform'

/**
 * Секреты клиента: session token и приватные ключи E2E.
 *
 * В браузере они лежат в localStorage — как и раньше. В нативной сборке этого
 * мало: WebView-хранилище iOS считает кэшем и вправе вычистить его при нехватке
 * места, а вместе с приватным ключом пользователь потеряет доступ ко всей
 * переписке. Поэтому там всё уходит в Keychain.
 *
 * Keychain асинхронный, а чтение ключей и токена по коду синхронное, поэтому
 * при старте значения один раз поднимаются в память (`hydrateSecureStorage`), и
 * дальше `readSecure` отдаёт их без await.
 */

/**
 * Ячейка приватной пары из версии, где она была одна на устройство. Осталась
 * ради переноса на аккаунт при первом входе — см. `claimLegacyKeyPair`.
 */
export const LEGACY_CRYPTO_KEYS_KEY = 'web-messenger:crypto-keys'
/** Приватная пара каждого аккаунта хранится отдельно: `<префикс><userId>`. */
export const CRYPTO_KEYS_PREFIX = `${LEGACY_CRYPTO_KEYS_KEY}:`
export const PUBLIC_KEYS_KEY = 'web-messenger:public-keys'

export const SECURE_KEYS = [
  'web-messenger:token',
  LEGACY_CRYPTO_KEYS_KEY,
  PUBLIC_KEYS_KEY,
] as const

/**
 * Ячейки с динамическим суффиксом: сколько их и под какими userId — заранее
 * неизвестно, поэтому перед стартом их приходится перечислять в самом хранилище.
 */
const SECURE_KEY_PREFIXES = [CRYPTO_KEYS_PREFIX] as const

function hasSecurePrefix(key: string): boolean {
  return SECURE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

const cache = new Map<string, string>()

/** Фиксированные ячейки плюс найденные по префиксу — и в Keychain, и в наследии WebView. */
async function secureKeysToHydrate(): Promise<string[]> {
  const dynamic = new Set<string>()
  try {
    for (const key of await SecureStorage.keys()) {
      if (hasSecurePrefix(key)) dynamic.add(key)
    }
  } catch {
    // Как и с чтением отдельной записи: недоступный Keychain не должен ронять старт.
  }
  // Пара могла остаться в WebView-хранилище от версии до перехода на Keychain.
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key !== null && hasSecurePrefix(key)) dynamic.add(key)
  }
  return [...SECURE_KEYS, ...dynamic]
}

export async function hydrateSecureStorage(): Promise<void> {
  if (!isNative()) return
  const keys = await secureKeysToHydrate()
  await Promise.all(
    keys.map(async (key) => {
      let stored: unknown = null
      try {
        stored = await SecureStorage.get(key)
      } catch {
        // Повреждённая или недоступная запись не должна ронять запуск: хуже
        // потери ключа только приложение, которое из-за неё вообще не стартует.
      }
      if (typeof stored === 'string') {
        cache.set(key, stored)
        return
      }
      // Первый запуск после перехода на Keychain: значение могло остаться в
      // WebView-хранилище от предыдущей версии — переносим, чтобы пользователь
      // не потерял ключи и не разлогинился.
      const legacy = localStorage.getItem(key)
      if (legacy === null) return
      cache.set(key, legacy)
      try {
        await SecureStorage.set(key, legacy)
        localStorage.removeItem(key)
      } catch {
        // Останется в localStorage до следующего запуска — не фатально.
      }
    }),
  )
}

export function readSecure(key: string): string | null {
  if (!isNative()) return localStorage.getItem(key)
  return cache.get(key) ?? null
}

export function writeSecure(key: string, value: string): void {
  if (!isNative()) {
    localStorage.setItem(key, value)
    return
  }
  cache.set(key, value)
  void SecureStorage.set(key, value).catch(() => undefined)
}

export function removeSecure(key: string): void {
  if (!isNative()) {
    localStorage.removeItem(key)
    return
  }
  cache.delete(key)
  void SecureStorage.remove(key).catch(() => undefined)
}
