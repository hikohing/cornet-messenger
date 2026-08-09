import { request } from './client'
import type { StoredPublicKey } from '../crypto/keys'

export function uploadPublicKeys(
  x25519PublicKey: JsonWebKey,
  ed25519PublicKey: JsonWebKey,
  publicKeySignature: string
) {
  return request<{ ok: true }>('/api/crypto/keys', {
    method: 'POST',
    body: JSON.stringify({ x25519PublicKey, ed25519PublicKey, publicKeySignature }),
  })
}

export function getPublicKeys(userIds: number[]) {
  return request<{ keys: Record<number, StoredPublicKey> }>(
    `/api/crypto/keys?ids=${userIds.join(',')}`
  )
}

export function getChatKeys(chatId: number) {
  return request<{ keys: Record<number, StoredPublicKey> }>(`/api/chats/${chatId}/keys`)
}
