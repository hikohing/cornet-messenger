/**
 * Разбор медиафайла перед отправкой.
 *
 * Отправителю нужны две вещи, которых у самого файла в готовом виде нет:
 * размеры кадра — чтобы получатель занял место под медиа заранее и лента не
 * прыгала при догрузке, — и локальное превью для панели вложений.
 *
 * Всё считается на устройстве: у зашифрованных чатов сервер видит только
 * непрозрачные байты и подсказать размеры не может.
 */

export interface MediaProbe {
  width?: number
  height?: number
  /** Длительность видео в секундах, округлённая вниз. */
  duration?: number
}

/** Ждём метаданные не бесконечно: битый файл не должен вешать отправку. */
const PROBE_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS)
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer))
  })
}

async function probeImage(url: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('image probe failed'))
    image.src = url
  })
}

async function probeVideo(url: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
      })
    }
    video.onerror = () => reject(new Error('video probe failed'))
    video.src = url
  })
}

/**
 * Размеры и длительность файла. Ошибка разбора не считается ошибкой отправки:
 * без размеров медиа просто покажется без предварительно занятого места.
 */
export async function probeMediaFile(file: File): Promise<MediaProbe> {
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  if (!isImage && !isVideo) return {}
  const url = URL.createObjectURL(file)
  try {
    return await withTimeout(isImage ? probeImage(url) : probeVideo(url), {})
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Кадр из середины первой секунды видео — превью для панели вложений.
 * Возвращает data-URL или null, если кадр снять не удалось (кодек, CORS, iOS).
 */
export async function grabVideoFrame(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    return await withTimeout(
      new Promise<string | null>((resolve, reject) => {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        video.playsInline = true
        video.onloadeddata = () => {
          try {
            const canvas = document.createElement('canvas')
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
            const context = canvas.getContext('2d')
            if (!context || !canvas.width || !canvas.height) {
              resolve(null)
              return
            }
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            resolve(canvas.toDataURL('image/jpeg', 0.7))
          } catch {
            resolve(null)
          }
        }
        video.onseeked = video.onloadeddata
        video.onerror = () => reject(new Error('frame grab failed'))
        video.src = url
        // Первый кадр часто чёрный — отматываем чуть вперёд.
        video.currentTime = 0.1
      }),
      null,
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** «1.4 МБ» — единый формат размера файла во всём интерфейсе. */
export function formatFileSize(bytes = 0): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

/** «1:53» — единый формат для длительности медиа во всём интерфейсе. */
export function formatMediaDuration(seconds = 0): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
