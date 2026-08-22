import { useEffect, useRef, useState } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import type { AttachmentView } from '../hooks/useAttachmentSource'
import { formatFileSize, formatMediaDuration } from '../utils/media'
import { DownloadIcon, ExpandIcon, PlayIcon, SpinnerIcon } from './icons'

/** Во что вписывается кадр в ленте. Дальше он масштабируется под ширину пузыря. */
const MAX_WIDTH = 320
const MAX_HEIGHT = 380

export interface MediaViewerTarget {
  url: string
  name: string
  kind: 'image' | 'video'
}

interface MessageMediaProps {
  media: AttachmentView
  /** Плашка со временем и галочками — лежит поверх кадра, когда нет подписи. */
  overlay?: ReactNode
  onOpen: (target: MediaViewerTarget) => void
}

/**
 * Размер кадра в ленте.
 *
 * Считаем по размерам, присланным отправителем, а не по загруженной картинке:
 * место должно быть занято до того, как придут байты, иначе лента прыгает под
 * курсором. Маленькие картинки не растягиваем — растянутый до 320 px стикер
 * выглядит мыльным.
 */
function frameStyle(media: AttachmentView): CSSProperties {
  const { width, height } = media
  if (!width || !height) return { width: MAX_WIDTH, aspectRatio: '4 / 3' }
  const ratio = width / height
  let boxWidth = Math.min(MAX_WIDTH, width)
  if (boxWidth / ratio > MAX_HEIGHT) boxWidth = MAX_HEIGHT * ratio
  return { width: Math.round(boxWidth), aspectRatio: `${width} / ${height}` }
}

/**
 * Фото и видео в пузыре: кадр во всю его ширину, без полей и чёрных полос.
 *
 * Видео не отдаётся системному плееру сразу — сначала стоп-кадр с кнопкой
 * воспроизведения и длительностью, как в Telegram; системная панель управления
 * появляется только после нажатия.
 */
export function MessageMedia({ media, overlay, onOpen }: MessageMediaProps) {
  const [loaded, setLoaded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Нажали «играть» до того, как видео расшифровалось: как только байты придут,
  // воспроизведение начнётся само — второго нажатия человек не ждёт.
  const wantsPlaybackRef = useRef(false)
  const style = frameStyle(media)

  useEffect(() => {
    if (!media.src || !wantsPlaybackRef.current) return
    wantsPlaybackRef.current = false
    void videoRef.current?.play().catch(() => {})
  }, [media.src])

  if (media.type === 'image') {
    return (
      <div className="message-media" style={style}>
        <button
          type="button"
          className="message-media__hit"
          onClick={() => media.src && onOpen({ url: media.src, name: media.name, kind: 'image' })}
          aria-label={`Открыть фото: ${media.name}`}
        >
          {media.src && (
            <img
              className={`message-media__img${loaded ? ' is-loaded' : ''}`}
              src={media.src}
              alt={media.name}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
            />
          )}
          {!loaded && <span className="message-media__skeleton" aria-hidden="true" />}
        </button>
        {overlay && <div className="message-media__overlay">{overlay}</div>}
      </div>
    )
  }

  return (
    <div className={`message-media message-media--video${playing ? ' is-playing' : ''}`} style={style}>
      <video
        ref={videoRef}
        className="message-media__video"
        src={media.src ?? undefined}
        preload="metadata"
        playsInline
        controls={playing}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedData={() => setLoaded(true)}
      />
      {!loaded && <span className="message-media__skeleton" aria-hidden="true" />}
      {!playing && (
        <button
          type="button"
          className="message-media__play"
          onClick={() => {
            // Зашифрованное видео не качается вместе с чатом: 25 МБ на каждое
            // открытие переписки — не та цена. Первое нажатие тянет и
            // расшифровывает, воспроизведение начнётся следом.
            if (!media.src) {
              wantsPlaybackRef.current = true
              media.load?.()
              return
            }
            void videoRef.current?.play()
          }}
          disabled={media.status === 'decrypting'}
          aria-label={media.src ? 'Воспроизвести видео' : 'Загрузить и воспроизвести видео'}
        >
          <span className="message-media__play-circle">
            {media.status === 'decrypting'
              ? <SpinnerIcon width={22} height={22} />
              : media.src ? <PlayIcon width={22} height={22} /> : <DownloadIcon width={22} height={22} />}
          </span>
        </button>
      )}
      {!playing && (media.duration || media.size) ? (
        <span className="message-media__badge">
          {media.duration ? formatMediaDuration(media.duration) : formatFileSize(media.size)}
        </span>
      ) : null}
      {media.src && (
        <button
          type="button"
          className="message-media__expand"
          onClick={() => {
            videoRef.current?.pause()
            onOpen({ url: media.src!, name: media.name, kind: 'video' })
          }}
          aria-label="Открыть во весь экран"
          title="Во весь экран"
        >
          <ExpandIcon width={15} height={15} />
        </button>
      )}
      {overlay && !playing && <div className="message-media__overlay">{overlay}</div>}
    </div>
  )
}
