import type { Chat, DecryptedAttachment, Message, MessageEncryptionData } from '../types'
import { getPublicKey, loadKeyPair, type StoredPublicKey } from './keys'
import { encryptForRecipient, decryptFromSender, decryptRaw, encryptForGroup, decryptFromGroup } from './encryption'
import { groupKeyForRotation, loadGroupKey } from './groupSession'
import { decodePayload, encodePayload, type AttachmentPayload } from './payload'
import { fetchAndVerifyPublicKeys } from '../hooks/useCrypto'

/**
 * Шифруются и личные переписки, и группы. Разница в устройстве ключа: в личной
 * — одноразовый ECDH на каждое сообщение, в группе — общий симметричный ключ
 * поколения (см. groupSession.ts).
 *
 * «Избранное» не шифруется: это заметки самому себе, второй стороны нет.
 */
export function isEncryptable(chat: Chat | undefined, currentUserId: number | null): boolean {
  if (!chat || currentUserId === null) return false
  if (chat.type === 'direct') {
    const other = chat.members.find((m) => m.id !== currentUserId)
    return Boolean(other) && getPublicKey(other!.id) !== null
  }
  if (chat.type === 'group') {
    return chat.members.every((member) => getPublicKey(member.id) !== null)
  }
  // «Избранное» — заметки самому себе, но на сервере они лежали бы открытым
  // текстом наравне с перепиской. Шифруем копией, адресованной себе же.
  if (chat.type === 'saved') return getPublicKey(currentUserId) !== null
  return false
}

export async function ensureChatKeysLoaded(chat: Chat, currentUserId: number | null) {
  if (!chat || currentUserId === null) return
  if (chat.type === 'direct') {
    const other = chat.members.find((m) => m.id !== currentUserId)
    if (!other || getPublicKey(other.id)) return
    await fetchAndVerifyPublicKeys([other.id])
    return
  }
  if (chat.type !== 'group') return
  const missing = chat.members.map((member) => member.id).filter((id) => !getPublicKey(id))
  if (missing.length > 0) await fetchAndVerifyPublicKeys(missing)
  // Ключ группы подтягиваем заранее: иначе первое сообщение ждало бы и выборку
  // ключей, и, возможно, создание нового поколения.
  await loadGroupKey(chat.id).catch(() => null)
}

export async function encryptOutgoing(
  chat: Chat,
  text: string,
  senderId: number,
  file?: AttachmentPayload,
): Promise<MessageEncryptionData | null> {
  if (chat.type === 'group') return encryptOutgoingGroup(chat, text, senderId, file)
  if (chat.type !== 'direct' && chat.type !== 'saved') return null
  // В «Избранном» второй стороны нет — получателем выступаем мы сами.
  const recipient = chat.type === 'saved' ? { id: senderId } : chat.members.find((m) => m.id !== senderId)
  if (!recipient) return null
  const recipientKey = getPublicKey(recipient.id)
  if (!recipientKey) return null

  // Ключ от вложения едет внутри той же нагрузки, что и текст: значит, он
  // зашифрован для получателя и подписан отправителем ровно теми же
  // механизмами, без отдельного поля в конверте, которое пришлось бы
  // защищать заново.
  const payload = encodePayload({ text, file })
  const envelope = await encryptForRecipient(payload, recipientKey, senderId)

  // Also encrypt a copy addressed to ourselves — the recipient-targeted
  // ciphertext above can only ever be opened with the recipient's private
  // key, so without this the sender could never re-read their own sent
  // history after a reload (their public/private key state is unrelated
  // to the one-time ECDH used for the recipient copy).
  const ownKeyPair = await loadKeyPair(senderId)
  let self: MessageEncryptionData['self']
  if (ownKeyPair) {
    const ownBundle: StoredPublicKey = {
      userId: senderId,
      x25519PublicKey: ownKeyPair.x25519.publicKey,
      ed25519PublicKey: ownKeyPair.ed25519.publicKey,
      publicKeySignature: '',
      createdAt: 0,
    }
    const selfEnvelope = await encryptForRecipient(payload, ownBundle, senderId)
    self = {
      ciphertext: selfEnvelope.ciphertext,
      iv: selfEnvelope.iv,
      ephemeralPublicKey: selfEnvelope.ephemeralPublicKey,
    }
  }

  return { ...envelope, self }
}

/**
 * Групповое сообщение. Копия «самому себе» не нужна: ключ поколения общий, и
 * отправитель читает собственное сообщение тем же ключом, что и остальные.
 */
async function encryptOutgoingGroup(
  chat: Chat,
  text: string,
  senderId: number,
  file?: AttachmentPayload,
): Promise<MessageEncryptionData | null> {
  const groupKey = await loadGroupKey(chat.id)
  if (!groupKey) return null

  const payload = encodePayload({ text, file })
  const envelope = await encryptForGroup(payload, groupKey.key, senderId)
  return { ...envelope, rotation: groupKey.rotation }
}

export interface DecryptedMessagePatch {
  decryptedText?: string
  decryptedFile?: DecryptedAttachment
  decryptionFailed?: 'signature_invalid' | 'key_missing' | 'decrypt_failed'
}

/** Разбирает расшифрованную нагрузку: текст сам по себе или текст вместе с ключом от файла. */
function toPatch(plaintext: string): DecryptedMessagePatch {
  const payload = decodePayload(plaintext)
  return {
    decryptedText: payload.text,
    ...(payload.file ? { decryptedFile: payload.file as DecryptedAttachment } : {}),
  }
}

export async function decryptIncoming(message: Message, currentUserId: number | null): Promise<DecryptedMessagePatch> {
  if (!message.encrypted || !message.encryptionData) return {}

  // Групповое сообщение узнаётся по номеру поколения: у личных его нет.
  const rotation = message.encryptionData.rotation
  if (rotation) {
    const key = await groupKeyForRotation(message.chatId, rotation)
    if (!key) return { decryptionFailed: 'key_missing' }

    let sender = getPublicKey(message.senderId)
    if (!sender) {
      await fetchAndVerifyPublicKeys([message.senderId])
      sender = getPublicKey(message.senderId)
    }

    const result = await decryptFromGroup(message.encryptionData, key, sender)
    return result.success && result.plaintext !== null
      ? toPatch(result.plaintext)
      : { decryptionFailed: result.error ?? 'decrypt_failed' }
  }

  // Our own sent messages: decrypt the self-addressed copy with our own key,
  // no signature check needed since there's no third party to authenticate.
  if (currentUserId !== null && message.senderId === currentUserId) {
    const self = message.encryptionData.self
    if (!self) return { decryptionFailed: 'decrypt_failed' }
    const plaintext = await decryptRaw(self.ciphertext, self.iv, self.ephemeralPublicKey)
    return plaintext !== null ? toPatch(plaintext) : { decryptionFailed: 'decrypt_failed' }
  }

  if (!message.encryptionData.ephemeralPublicKey) return { decryptionFailed: 'decrypt_failed' }

  let sender = getPublicKey(message.senderId)
  if (!sender) {
    await fetchAndVerifyPublicKeys([message.senderId])
    sender = getPublicKey(message.senderId)
  }

  const result = await decryptFromSender(
    { ...message.encryptionData, ephemeralPublicKey: message.encryptionData.ephemeralPublicKey },
    sender
  )
  if (result.success && result.plaintext !== null) {
    return toPatch(result.plaintext)
  }
  return { decryptionFailed: result.error ?? 'decrypt_failed' }
}
