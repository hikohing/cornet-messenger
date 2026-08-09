import { loadSigningKey, loadVerifyKey, type StoredPublicKey } from './keys'

/**
 * TS's DOM lib types Web Crypto inputs as BufferSource = ArrayBufferView<ArrayBuffer>,
 * but Uint8Array.buffer is typed ArrayBufferLike (it could back onto a
 * SharedArrayBuffer). Our arrays are always plain heap buffers from
 * TextEncoder/getRandomValues/etc, so this cast just documents that — no
 * runtime behavior changes.
 */
function bs(data: Uint8Array): BufferSource {
  return data as unknown as BufferSource
}

/**
 * Postgres JSONB re-serializes objects with keys in its own canonical order
 * (not insertion order), so a plain JSON.stringify() of a value that has
 * round-tripped through the DB (e.g. a JWK nested in an envelope) won't
 * match the bytes that were originally signed on the sending client. Sorting
 * keys recursively before stringifying makes signing/verification agree
 * regardless of how the object got there.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function signBytes(data: Uint8Array): Promise<string | null> {
  const signingKey = await loadSigningKey()
  if (!signingKey) return null
  const signature = await crypto.subtle.sign('Ed25519', signingKey, bs(data))
  return toBase64(signature)
}

export async function verifyBytes(
  data: Uint8Array,
  signatureB64: string,
  publicKeyJwk: JsonWebKey
): Promise<boolean> {
  try {
    const verifyKey = await loadVerifyKey(publicKeyJwk)
    const signature = fromBase64(signatureB64)
    return await crypto.subtle.verify('Ed25519', verifyKey, bs(signature), bs(data))
  } catch {
    return false
  }
}

export async function signMessage(message: string): Promise<string | null> {
  return signBytes(new TextEncoder().encode(message))
}

export async function verifyMessage(
  message: string,
  signatureB64: string,
  senderPublicKey: JsonWebKey
): Promise<boolean> {
  return verifyBytes(new TextEncoder().encode(message), signatureB64, senderPublicKey)
}

/**
 * Public-key bundles are self-signed with the Ed25519 key to bind the
 * X25519 key to it — without this, a malicious server could swap either
 * half of the bundle without detection.
 */
export async function signPublicKeyBundle(
  x25519PublicKey: JsonWebKey,
  ed25519PublicKey: JsonWebKey
): Promise<string | null> {
  const combined = canonicalStringify({ x25519PublicKey, ed25519PublicKey })
  return signBytes(new TextEncoder().encode(combined))
}

export async function verifyPublicKeyBundle(bundle: StoredPublicKey): Promise<boolean> {
  const combined = canonicalStringify({
    x25519PublicKey: bundle.x25519PublicKey,
    ed25519PublicKey: bundle.ed25519PublicKey,
  })
  return verifyBytes(
    new TextEncoder().encode(combined),
    bundle.publicKeySignature,
    bundle.ed25519PublicKey
  )
}

export async function generateHash(data: string): Promise<string> {
  const buffer = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return toBase64(hash)
}

/** Short human-comparable fingerprint (first 16 hex chars of the SHA-256 of both public keys). */
export async function fingerprintOf(bundle: Pick<StoredPublicKey, 'x25519PublicKey' | 'ed25519PublicKey'>): Promise<string> {
  const combined = canonicalStringify({
    x: bundle.x25519PublicKey,
    e: bundle.ed25519PublicKey,
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined))
  const bytes = new Uint8Array(hash)
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export { toBase64, fromBase64, bs }
