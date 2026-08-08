import { createPortal } from 'react-dom'
import { resolveUrl } from '../api/client'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { CloseIcon, DownloadIcon } from './icons'

interface MediaLightboxProps {
  url: string
  name: string
  onClose: () => void
}

/** Полноэкранный просмотр фото из переписки: открытие в новой вкладке заменено на нормальный вьюер. */
export function MediaLightbox({ url, name, onClose }: MediaLightboxProps) {
  useEscapeToClose(onClose)
  const resolved = resolveUrl(url)

  return createPortal(
    <div className="avatar-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <div className="avatar-lightbox__toolbar">
        <div>
          <strong>{name}</strong>
          <span>Фото</span>
        </div>
        <div className="avatar-lightbox__actions">
          <a
            className="avatar-lightbox__close"
            href={resolved}
            download={name}
            onClick={(event) => event.stopPropagation()}
            aria-label="Скачать"
            title="Скачать"
          >
            <DownloadIcon width={19} height={19} />
          </a>
          <button className="avatar-lightbox__close" onClick={onClose} aria-label="Закрыть">
            <CloseIcon width={22} height={22} />
          </button>
        </div>
      </div>
      <img className="avatar-lightbox__image" src={resolved} alt={name} onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  )
}
