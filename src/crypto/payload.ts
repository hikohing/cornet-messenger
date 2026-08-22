import type { FileSecret } from './files'

/**
 * Полезная нагрузка конверта.
 *
 * Раньше внутри зашифрованного конверта лежал просто текст сообщения. Теперь
 * туда же нужно положить ключ от вложения — и сделать это так, чтобы не трогать
 * ни формат конверта, ни подпись: ключ должен ехать внутри того же шифротекста,
 * который уже подписан отправителем и зашифрован для получателя.
 *
 * Поэтому сообщения без вложения кодируются ровно как раньше — голым текстом, и
 * старые сообщения продолжают читаться. Как только появляется файл, строка
 * начинается со служебного префикса, за которым идёт JSON. Префикс начинается с
 * управляющего символа U+0001: набрать такой в поле ввода нельзя, поэтому
 * принять чужой текст за служебную нагрузку невозможно.
 */
const PREFIX = 'cornet-payload-1'

export interface AttachmentPayload extends FileSecret {
  name: string
  mimeType: string
  size: number
  /** Длительность голосового или видео в секундах. */
  duration?: number
  /** Размеры кадра: серверу их знать неоткуда, он видит только шифротекст. */
  width?: number
  height?: number
  /** Как показывать: image, video, audio, voice, file. */
  messageType: string
}

export interface MessagePayload {
  text: string
  file?: AttachmentPayload
}

export function encodePayload(payload: MessagePayload): string {
  if (!payload.file) return payload.text
  return PREFIX + JSON.stringify(payload)
}

export function decodePayload(plaintext: string): MessagePayload {
  if (!plaintext.startsWith(PREFIX)) return { text: plaintext }
  try {
    const parsed = JSON.parse(plaintext.slice(PREFIX.length)) as MessagePayload
    return { text: typeof parsed.text === 'string' ? parsed.text : '', file: parsed.file }
  } catch {
    // Испорченная нагрузка не должна выглядеть как пустое сообщение — покажем
    // хотя бы то, что пришло.
    return { text: plaintext }
  }
}
