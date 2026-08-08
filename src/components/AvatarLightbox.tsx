import { createPortal } from 'react-dom'
import { resolveUrl } from '../api/client'
import { CloseIcon } from './icons'

interface AvatarLightboxProps {
  url: string
  name: string
  onClose: () => void
}

export function AvatarLightbox({ url, name, onClose }: AvatarLightboxProps) {
  return createPortal(
    <div className="avatar-lightbox" role="dialog" aria-modal="true" aria-label={`Фотография профиля ${name}`} onClick={onClose}>
      <div className="avatar-lightbox__toolbar">
        <div>
          <strong>{name}</strong>
          <span>Фотография профиля</span>
        </div>
        <button className="avatar-lightbox__close" onClick={onClose} aria-label="Закрыть фотографию">
          <CloseIcon width={22} height={22} />
        </button>
      </div>
      <img className="avatar-lightbox__image" src={resolveUrl(url)} alt={`Аватар ${name}`} onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  )
}
