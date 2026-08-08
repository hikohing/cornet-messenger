import { useEffect, useState, type ReactNode } from 'react'
import { resolveUrl } from '../api/client'

interface AvatarImageProps {
  url?: string | null
  fallback: ReactNode
}

/**
 * Картинка аватара с запасным вариантом: если файл не загрузился (например,
 * ссылка осталась от удалённого файла), показываем букву или иконку вместо
 * значка битого изображения.
 */
export function AvatarImage({ url, fallback }: AvatarImageProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [url])

  if (!url || failed) return <>{fallback}</>
  return <img src={resolveUrl(url)} alt="" onError={() => setFailed(true)} />
}
