import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Внутри src импорты идут без расширения (так их резолвит Vite), а ESM-загрузчик
 * Node так не умеет — дописываем расширение сами, иначе цепочку keys.ts →
 * native/storage.ts не загрузить.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL).href
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(fileURLToPath(base + ext))) return next(base + ext, context)
      }
    }
    return next(specifier, context)
  },
})

/**
 * keys.ts ходит в хранилище через native/storage, а тот в вебе — это
 * localStorage. Подменяем его до импорта модуля: в Node глобали нет, а
 * Capacitor из этой же цепочки честно сообщает платформу 'web'.
 */
class MemoryStorage {
  #data = new Map<string, string>()
  get length() {
    return this.#data.size
  }
  key(index: number) {
    return [...this.#data.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.#data.has(key) ? this.#data.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.#data.set(String(key), String(value))
  }
  removeItem(key: string) {
    this.#data.delete(key)
  }
  clear() {
    this.#data.clear()
  }
}

const store = new MemoryStorage()
for (const [name, value] of [
  ['window', globalThis],
  ['document', { addEventListener() {}, documentElement: {} }],
  ['localStorage', store],
] as const) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const keys = await import('../src/crypto/keys.ts')
const { LEGACY_CRYPTO_KEYS_KEY, CRYPTO_KEYS_PREFIX } = await import('../src/native/storage.ts')

/** Настоящие X25519/Ed25519 тут не нужны: проверяется раскладка по ячейкам, а не криптография. */
function fakePair(tag: string) {
  return {
    x25519: { publicKey: { kty: 'OKP', x: `x-${tag}` }, privateKey: { kty: 'OKP', d: `dx-${tag}` } },
    ed25519: { publicKey: { kty: 'OKP', x: `e-${tag}` }, privateKey: { kty: 'OKP', d: `de-${tag}` } },
  } as unknown as import('../src/crypto/keys.ts').UserKeyPair
}

function reset() {
  store.clear()
  keys.setActiveKeyOwner(null)
}

test('без назначенного владельца приватной пары для кода не существует', async () => {
  reset()
  keys.saveKeyPair(1, fakePair('a'))
  assert.equal(await keys.loadKeyPair(), null)

  keys.setActiveKeyOwner(1)
  assert.equal((await keys.loadKeyPair())?.x25519.publicKey.x, 'x-a')
})

test('пары аккаунтов лежат в разных ячейках и не подменяют друг друга', async () => {
  reset()
  keys.saveKeyPair(1, fakePair('a'))
  keys.saveKeyPair(2, fakePair('b'))

  keys.setActiveKeyOwner(1)
  assert.equal((await keys.loadKeyPair())?.x25519.publicKey.x, 'x-a')
  keys.setActiveKeyOwner(2)
  assert.equal((await keys.loadKeyPair())?.x25519.publicKey.x, 'x-b')

  assert.ok(store.getItem(`${CRYPTO_KEYS_PREFIX}1`))
  assert.ok(store.getItem(`${CRYPTO_KEYS_PREFIX}2`))
})

test('вход под вторым аккаунтом не переиспользует пару первого', async () => {
  reset()
  keys.saveKeyPair(1, fakePair('a'))
  keys.setActiveKeyOwner(2)
  assert.equal(await keys.loadKeyPair(), null)
})

test('расхождение с ожидаемым владельцем не отдаёт чужую пару', async () => {
  reset()
  keys.saveKeyPair(1, fakePair('a'))
  keys.setActiveKeyOwner(1)
  assert.equal((await keys.loadKeyPair(1))?.x25519.publicKey.x, 'x-a')
  assert.equal(await keys.loadKeyPair(2), null)
})

test('наследованная пара достаётся одному аккаунту, следующий получает свою', async () => {
  reset()
  store.setItem(LEGACY_CRYPTO_KEYS_KEY, JSON.stringify(fakePair('legacy')))

  const legacy = keys.readLegacyKeyPair()
  assert.equal(legacy?.x25519.publicKey.x, 'x-legacy')

  keys.claimLegacyKeyPair(7, legacy!)
  assert.equal(store.getItem(LEGACY_CRYPTO_KEYS_KEY), null, 'ячейка освобождена')
  keys.setActiveKeyOwner(7)
  assert.equal((await keys.loadKeyPair())?.x25519.publicKey.x, 'x-legacy')

  // Второй аккаунт на том же устройстве: подхватывать больше нечего.
  assert.equal(keys.readLegacyKeyPair(), null)
  keys.setActiveKeyOwner(8)
  assert.equal(await keys.loadKeyPair(), null)
})

test('удаление аккаунта не трогает пару соседа и неразобранное наследство', () => {
  reset()
  keys.saveKeyPair(1, fakePair('a'))
  keys.saveKeyPair(2, fakePair('b'))
  store.setItem(LEGACY_CRYPTO_KEYS_KEY, JSON.stringify(fakePair('legacy')))

  keys.clearKeysFor(1)

  assert.equal(store.getItem(`${CRYPTO_KEYS_PREFIX}1`), null)
  assert.ok(store.getItem(`${CRYPTO_KEYS_PREFIX}2`))
  assert.ok(store.getItem(LEGACY_CRYPTO_KEYS_KEY))
})
