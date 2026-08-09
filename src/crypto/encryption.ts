import { getPublicKey, loadX25519PrivateKey, type StoredPublicKey } from './keys'
import { signBytes, verifyBytes, toBase64, fromBase64, bs, canonicalStringify } from './verification'

export interface EncryptedEnvelope {
  version: 1
  ciphertext: string
  iv: string
  ephemeralPublicKey: JsonWebKey
  signature: string
  senderId: number
}

async function importEphemeralX25519Public(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'X25519' }, true, [])
}

/** HKDF-SHA256 over the raw ECDH shared secret — never use raw ECDH output as a symmetric key directly. */
async function deriveMessageKey(sharedSecretBits: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecretBits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(salt),
      info: bs(new TextEncoder().encode('web-messenger:msg-key:v1')),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypts `plaintext` for `recipient` using a fresh ephemeral X25519 key per
 * message (one-time ECDH), so compromise of a later message's key doesn't
 * expose earlier ones. The envelope is signed with our Ed25519 key so the
 * recipient can authenticate the sender.
 */
export async function encryptForRecipient(
  plaintext: string,
  recipient: StoredPublicKey,
  senderId: number
): Promise<EncryptedEnvelope> {
  const ephemeralPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const recipientPublicKey = await importEphemeralX25519Public(recipient.x25519PublicKey)

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: recipientPublicKey },
    ephemeralPair.privateKey,
    256
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const salt = iv // 12-byte IV doubles as the HKDF salt; both are per-message-unique and public
  const messageKey = await deriveMessageKey(sharedSecretBits, salt)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    messageKey,
    bs(new TextEncoder().encode(plaintext))
  )

  const ephemeralPublicKey = (await crypto.subtle.exportKey('jwk', ephemeralPair.publicKey)) as JsonWebKey

  const signaturePayload = canonicalStringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv), ephemeralPublicKey })
  const signature = (await signBytes(new TextEncoder().encode(signaturePayload))) ?? ''

  return {
    version: 1,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    ephemeralPublicKey,
    signature,
    senderId,
  }
}

export interface DecryptResult {
  success: boolean
  plaintext: string | null
  signatureValid: boolean
  error?: 'signature_invalid' | 'key_missing' | 'decrypt_failed'
}

export async function decryptFromSender(
  envelope: EncryptedEnvelope,
  sender: StoredPublicKey | null
): Promise<DecryptResult> {
  if (!sender) {
    return { success: false, plaintext: null, signatureValid: false, error: 'key_missing' }
  }

  const signaturePayload = canonicalStringify({
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
  })
  const signatureValid = await verifyBytes(
    new TextEncoder().encode(signaturePayload),
    envelope.signature,
    sender.ed25519PublicKey
  )

  if (!signatureValid) {
    return { success: false, plaintext: null, signatureValid: false, error: 'signature_invalid' }
  }

  const myPrivateKey = await loadX25519PrivateKey()
  if (!myPrivateKey) {
    return { success: false, plaintext: null, signatureValid: true, error: 'key_missing' }
  }

  try {
    const ephemeralPublicKey = await importEphemeralX25519Public(envelope.ephemeralPublicKey)
    const sharedSecretBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ephemeralPublicKey },
      myPrivateKey,
      256
    )

    const iv = fromBase64(envelope.iv)
    const messageKey = await deriveMessageKey(sharedSecretBits, iv)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(iv) },
      messageKey,
      bs(fromBase64(envelope.ciphertext))
    )

    return {
      success: true,
      plaintext: new TextDecoder().decode(decrypted),
      signatureValid: true,
    }
  } catch {
    return { success: false, plaintext: null, signatureValid: true, error: 'decrypt_failed' }
  }
}

/**
 * Decrypts a raw ECDH-wrapped ciphertext without signature verification.
 * Used only for a sender's own self-addressed copy of a message (see
 * session.ts) — there's no third party to authenticate against, we trust
 * our own past self, so skipping the Ed25519 check is intentional here.
 */
export async function decryptRaw(ciphertext: string, iv: string, ephemeralPublicKeyJwk: JsonWebKey): Promise<string | null> {
  const myPrivateKey = await loadX25519PrivateKey()
  if (!myPrivateKey) return null

  try {
    const ephemeralPublicKey = await importEphemeralX25519Public(ephemeralPublicKeyJwk)
    const sharedSecretBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ephemeralPublicKey },
      myPrivateKey,
      256
    )
    const ivBytes = fromBase64(iv)
    const messageKey = await deriveMessageKey(sharedSecretBits, ivBytes)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(ivBytes) }, messageKey, bs(fromBase64(ciphertext)))
    return new TextDecoder().decode(decrypted)
  } catch {
    return null
  }
}

export async function encryptForUser(text: string, userId: number, senderId: number): Promise<EncryptedEnvelope | null> {
  const recipient = getPublicKey(userId)
  if (!recipient) return null
  return encryptForRecipient(text, recipient, senderId)
}

export async function decryptFromUser(envelope: EncryptedEnvelope): Promise<DecryptResult> {
  const sender = getPublicKey(envelope.senderId)
  return decryptFromSender(envelope, sender)
}

// --- Group chats: symmetric master key shared out-of-band per member (see keyAgreement.ts) ---

export interface EncryptedGroupEnvelope {
  version: 1
  ciphertext: string
  iv: string
  signature: string
  senderId: number
}

export async function encryptForGroup(
  plaintext: string,
  groupKey: CryptoKey,
  senderId: number
): Promise<EncryptedGroupEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    groupKey,
    bs(new TextEncoder().encode(plaintext))
  )

  const signaturePayload = canonicalStringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv) })
  const signature = (await signBytes(new TextEncoder().encode(signaturePayload))) ?? ''

  return {
    version: 1,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    signature,
    senderId,
  }
}

export async function decryptFromGroup(
  envelope: EncryptedGroupEnvelope,
  groupKey: CryptoKey,
  sender: StoredPublicKey | null
): Promise<DecryptResult> {
  if (!sender) {
    return { success: false, plaintext: null, signatureValid: false, error: 'key_missing' }
  }

  const signaturePayload = canonicalStringify({ ciphertext: envelope.ciphertext, iv: envelope.iv })
  const signatureValid = await verifyBytes(
    new TextEncoder().encode(signaturePayload),
    envelope.signature,
    sender.ed25519PublicKey
  )

  if (!signatureValid) {
    return { success: false, plaintext: null, signatureValid: false, error: 'signature_invalid' }
  }

  try {
    const iv = fromBase64(envelope.iv)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(iv) },
      groupKey,
      bs(fromBase64(envelope.ciphertext))
    )
    return { success: true, plaintext: new TextDecoder().decode(decrypted), signatureValid: true }
  } catch {
    return { success: false, plaintext: null, signatureValid: true, error: 'decrypt_failed' }
  }
}
