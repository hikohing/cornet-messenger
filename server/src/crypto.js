import { one, many, run } from './db.js'
import { appError } from './errors.js'

function toPublicKeyBundle(row) {
  return {
    userId: row.user_id,
    x25519PublicKey: row.x25519_public_key,
    ed25519PublicKey: row.ed25519_public_key,
    publicKeySignature: row.public_key_signature,
    createdAt: Number(row.created_at),
  }
}

/**
 * The server only ever stores/serves public keys — it never sees a private
 * key or plaintext message content. Clients verify publicKeySignature
 * themselves (Ed25519 self-signature over the bundle) before trusting a key
 * fetched here, so a compromised server can at most withhold or replay old
 * keys, not forge new ones undetected.
 */
export async function storePublicKeys(userId, { x25519PublicKey, ed25519PublicKey, publicKeySignature }) {
  if (!x25519PublicKey || typeof x25519PublicKey !== 'object') throw appError('Некорректный ключ X25519')
  if (!ed25519PublicKey || typeof ed25519PublicKey !== 'object') throw appError('Некорректный ключ Ed25519')
  if (typeof publicKeySignature !== 'string' || publicKeySignature.length < 1 || publicKeySignature.length > 2048) {
    throw appError('Некорректная подпись ключа')
  }
  await run(
    `INSERT INTO public_keys (user_id, x25519_public_key, ed25519_public_key, public_key_signature, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       x25519_public_key = $2, ed25519_public_key = $3, public_key_signature = $4, created_at = $5`,
    [userId, JSON.stringify(x25519PublicKey), JSON.stringify(ed25519PublicKey), publicKeySignature, Date.now()],
  )
}

export async function getPublicKeyBundle(userId) {
  const row = await one('SELECT * FROM public_keys WHERE user_id = $1', [userId])
  return row ? toPublicKeyBundle(row) : null
}

export async function getPublicKeyBundles(userIds) {
  if (userIds.length === 0) return {}
  const rows = await many('SELECT * FROM public_keys WHERE user_id = ANY($1::int[])', [userIds])
  const result = {}
  for (const row of rows) result[row.user_id] = toPublicKeyBundle(row)
  return result
}
