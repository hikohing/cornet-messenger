import { loadX25519PrivateKey, type StoredPublicKey } from './keys'
import { toBase64, fromBase64, bs } from './verification'

/**
 * Wraps a random group master key so each member can unwrap it with their
 * own X25519 private key — an ephemeral ECDH per recipient, same construction
 * as encryptForRecipient but for a raw symmetric key instead of message text.
 */
export async function wrapGroupKeyForMember(
  groupKeyRaw: ArrayBuffer,
  member: StoredPublicKey
): Promise<{ wrappedKey: string; iv: string; ephemeralPublicKey: JsonWebKey }> {
  const ephemeralPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const memberPublicKey = await crypto.subtle.importKey('jwk', member.x25519PublicKey, { name: 'X25519' }, true, [])

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: memberPublicKey },
    ephemeralPair.privateKey,
    256
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapKey = await deriveWrapKey(sharedSecretBits, iv)

  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, wrapKey, groupKeyRaw)
  const ephemeralPublicKey = (await crypto.subtle.exportKey('jwk', ephemeralPair.publicKey)) as JsonWebKey

  return { wrappedKey: toBase64(wrapped), iv: toBase64(iv), ephemeralPublicKey }
}

export async function unwrapGroupKey(
  wrappedKey: string,
  iv: string,
  ephemeralPublicKeyJwk: JsonWebKey
): Promise<CryptoKey | null> {
  const myPrivateKey = await loadX25519PrivateKey()
  if (!myPrivateKey) return null

  const ephemeralPublicKey = await crypto.subtle.importKey('jwk', ephemeralPublicKeyJwk, { name: 'X25519' }, true, [])
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: ephemeralPublicKey },
    myPrivateKey,
    256
  )

  const ivBytes = fromBase64(iv)
  const wrapKey = await deriveWrapKey(sharedSecretBits, ivBytes)

  const groupKeyRaw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(ivBytes) }, wrapKey, bs(fromBase64(wrappedKey)))

  return crypto.subtle.importKey('raw', groupKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function deriveWrapKey(sharedSecretBits: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecretBits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(salt),
      info: bs(new TextEncoder().encode('web-messenger:group-key-wrap:v1')),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function generateGroupKey(): Promise<{ key: CryptoKey; raw: ArrayBuffer }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = await crypto.subtle.exportKey('raw', key)
  return { key, raw }
}
