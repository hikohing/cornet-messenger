import { fromBase64, toBase64, bs } from './verification'

/**
 * Шифрование вложений.
 *
 * Текст сообщения защищён сквозным шифрованием, а файлы до этого уходили на
 * сервер как есть — то есть обещание «переписку не прочитать» на картинки и
 * документы не распространялось. Здесь это чинится: файл шифруется на
 * устройстве отдельным одноразовым ключом, на сервер уезжают непрозрачные
 * байты, а сам ключ едет внутри конверта сообщения — то есть уже зашифрованным
 * для получателя и подписанным отправителем.
 *
 * Ключ на файл, а не общий: пересылка файла в другой чат сможет переиспользовать
 * уже загруженные байты, не открывая доступ ко всей переписке.
 */
export interface FileSecret {
  /** AES-256-GCM ключ в base64. Существует только внутри конверта сообщения. */
  key: string
  iv: string
}

export interface EncryptedFile {
  blob: Blob
  secret: FileSecret
}

/** Имя, под которым шифротекст уходит на сервер: настоящее хранится в конверте. */
export const ENCRYPTED_UPLOAD_NAME = 'attachment.bin'
export const ENCRYPTED_UPLOAD_MIME = 'application/octet-stream'

export async function encryptFile(file: Blob): Promise<EncryptedFile> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, await file.arrayBuffer())
  const rawKey = await crypto.subtle.exportKey('raw', key)

  return {
    // Тип намеренно обезличенный: по Content-Type загрузки не должно быть видно,
    // картинка это или документ.
    blob: new Blob([ciphertext], { type: ENCRYPTED_UPLOAD_MIME }),
    secret: { key: toBase64(rawKey), iv: toBase64(iv) },
  }
}

export async function decryptFileBytes(ciphertext: ArrayBuffer, secret: FileSecret, mimeType: string): Promise<Blob> {
  const key = await crypto.subtle.importKey('raw', bs(fromBase64(secret.key)), { name: 'AES-GCM' }, false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(fromBase64(secret.iv)) },
    key,
    ciphertext,
  )
  return new Blob([plaintext], { type: mimeType })
}
