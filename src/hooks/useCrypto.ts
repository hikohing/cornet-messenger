import { useEffect, useRef, useState } from 'react'
import {
  generateKeyPair,
  saveKeyPair,
  loadKeyPair,
  readLegacyKeyPair,
  claimLegacyKeyPair,
  clearKeysFor,
  setActiveKeyOwner,
  savePublicKey,
  type StoredPublicKey,
  type UserKeyPair,
} from '../crypto/keys'
import { signPublicKeyBundle, verifyPublicKeyBundle } from '../crypto/verification'
import { uploadPublicKeys, getPublicKeys } from '../api/crypto-client'

/** Та ли это пара, что уже опубликована под аккаунтом: у OKP-ключей `x` и есть сам материал ключа. */
function matchesPublished(pair: UserKeyPair, published: StoredPublicKey | undefined): boolean {
  return (
    published?.x25519PublicKey?.x === pair.x25519.publicKey.x &&
    published?.ed25519PublicKey?.x === pair.ed25519.publicKey.x
  )
}

export function useCrypto(userId: number | null) {
  const [keyPair, setKeyPair] = useState<UserKeyPair | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const uploadedFor = useRef<number | null>(null)

  useEffect(() => {
    // Владельца назначаем синхронно, до первого await: эффекты useChats идут
    // следом за этим и уже дёргают расшифровку — застать чужого владельца или
    // владельца от прошлого аккаунта они не должны.
    setActiveKeyOwner(userId)
    if (!userId) {
      setKeyPair(null)
      setIsLoading(false)
      return
    }

    // Смена аккаунта в пределах сессии: пара в состоянии — от предыдущего.
    setKeyPair(null)
    setIsLoading(true)
    setError(null)

    const owner = userId
    let cancelled = false

    async function initKeys() {
      try {
        let pair = await loadKeyPair(owner)
        let published: StoredPublicKey | undefined
        let publishedFetched = false

        if (!pair) {
          const legacy = readLegacyKeyPair()
          if (legacy) {
            // Наследованная пара лежала одна на устройство, поэтому правило
            // «первый вошедший её и забирает» повторило бы исходную ошибку: под
            // чужим аккаунтом она открыла бы чужую историю. Забираем только ту,
            // публичная половина которой уже опубликована под этим userId.
            //
            // Сеть здесь нельзя обработать как «ну сгенерируем новую»: это
            // затёрло бы единственную пару законного владельца и он потерял бы
            // всю переписку. Пусть лучше упадёт в error и повторится при
            // следующем запуске — ячейка останется нетронутой.
            published = (await getPublicKeys([owner])).keys[owner]
            publishedFetched = true
            if (matchesPublished(legacy, published)) {
              claimLegacyKeyPair(owner, legacy)
              pair = legacy
            }
          }
        }

        if (!pair) {
          pair = await generateKeyPair()
          saveKeyPair(owner, pair)
        }
        if (cancelled) return
        setKeyPair(pair)

        if (uploadedFor.current !== owner) {
          uploadedFor.current = owner
          // Re-uploading an unchanged key on every reload burns the endpoint's
          // hourly quota (it shares the strict "sensitive action" limiter), so
          // a few refreshes would start failing with 429 and leave the key
          // stale for anyone who rotated it. Upload only when it differs.
          if (!publishedFetched) {
            published = (await getPublicKeys([owner])).keys[owner]
            // За время запроса аккаунт мог смениться, а подписывать бандл будет
            // уже ключ нового владельца — выгружать такое незачем.
            if (cancelled) return
          }
          if (!matchesPublished(pair, published)) {
            const signature = await signPublicKeyBundle(pair.x25519.publicKey, pair.ed25519.publicKey)
            if (signature) {
              await uploadPublicKeys(pair.x25519.publicKey, pair.ed25519.publicKey, signature)
            }
          }
        }
      } catch (err) {
        if (cancelled) return
        // Выгрузку имеет смысл повторить: до неё могло и не дойти.
        uploadedFor.current = null
        setError(err instanceof Error ? err.message : 'Failed to initialize encryption keys')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void initKeys()
    return () => {
      cancelled = true
    }
  }, [userId])

  return {
    keyPair,
    isLoading,
    error,
    reset: () => {
      if (userId !== null) clearKeysFor(userId)
      setKeyPair(null)
      uploadedFor.current = null
    },
  }
}

/** Fetches and caches (with signature verification) the public key bundles for a set of users. */
export async function fetchAndVerifyPublicKeys(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return
  const { keys } = await getPublicKeys(userIds)

  for (const [userIdStr, bundle] of Object.entries(keys)) {
    const isValid = await verifyPublicKeyBundle(bundle)
    if (!isValid) {
      console.warn(`Signature verification failed for public key bundle of user ${userIdStr} — possible key tampering, discarding`)
      continue
    }
    savePublicKey(bundle)
  }
}
