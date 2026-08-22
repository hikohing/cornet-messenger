import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveUrl } from '../api/client'
import { decryptFileBytes } from '../crypto/files'
import type { AttachmentMessageType, Message } from '../types'

/**
 * Откуда браузеру брать вложение.
 *
 * У обычного файла это просто ссылка на сервер. У зашифрованного так нельзя:
 * по ссылке лежит шифротекст, ключ приходит внутри конверта сообщения, и файл
 * надо сначала скачать и расшифровать в памяти — только потом отдавать в
 * `<img>` или `<video>` как blob-ссылку.
 *
 * Картинки и голосовые расшифровываются сами: они и так показываются в ленте.
 * Видео и документы ждут нажатия — тянуть по 25 МБ на каждое открытие чата
 * было бы издевательством над мобильным трафиком.
 */
export interface AttachmentView {
  type: AttachmentMessageType | null
  name: string
  size?: number
  duration?: number
  /** Размеры кадра, если отправитель их измерил: место под медиа занимаем заранее. */
  width?: number
  height?: number
  /** Готовая ссылка для тега: обычная или blob:. Пока не готова — null. */
  src: string | null
  status: 'ready' | 'decrypting' | 'idle' | 'error' | 'locked'
  /** Есть только у тяжёлых вложений, которые ждут нажатия. */
  load?: () => void
}

const EAGER_TYPES = new Set<AttachmentMessageType>(['image', 'voice', 'audio'])

export function useAttachmentSource(message: Message): AttachmentView {
  const encrypted = Boolean(message.encrypted && message.attachmentUrl)
  const file = message.decryptedFile
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<AttachmentView['status']>('idle')
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      // Blob живёт в памяти вкладки, пока ссылку не отозвали.
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  const load = useCallback(async () => {
    if (!message.attachmentUrl || !file || objectUrlRef.current) return
    setStatus('decrypting')
    try {
      const response = await fetch(resolveUrl(message.attachmentUrl), { credentials: 'include' })
      if (!response.ok) throw new Error('not found')
      const blob = await decryptFileBytes(await response.arrayBuffer(), file, file.mimeType)
      const url = URL.createObjectURL(blob)
      objectUrlRef.current = url
      setObjectUrl(url)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [message.attachmentUrl, file])

  useEffect(() => {
    if (!encrypted || !file || objectUrlRef.current) return
    if (!EAGER_TYPES.has(file.messageType)) return
    void load()
  }, [encrypted, file, load])

  if (!message.attachmentUrl) {
    return { type: null, name: '', src: null, status: 'idle' }
  }

  if (!encrypted) {
    return {
      type: (message.type === 'text' || message.type === 'call' || message.type === 'poll' ? null : message.type),
      name: message.attachment?.name || 'Файл',
      size: message.attachment?.size,
      duration: message.attachment?.duration,
      width: message.attachment?.width,
      height: message.attachment?.height,
      src: resolveUrl(message.attachmentUrl),
      status: 'ready',
    }
  }

  // Конверт ещё не расшифрован — настоящих имени и типа мы пока не знаем.
  if (!file) {
    return {
      type: null,
      name: 'Вложение',
      size: message.attachment?.size,
      src: null,
      status: 'locked',
    }
  }

  return {
    type: file.messageType,
    name: file.name,
    size: file.size,
    duration: file.duration,
    width: file.width,
    height: file.height,
    src: objectUrl,
    status: objectUrl ? 'ready' : status,
    load: EAGER_TYPES.has(file.messageType) ? undefined : () => void load(),
  }
}
