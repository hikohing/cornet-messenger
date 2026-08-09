import { useState, type ReactNode } from 'react'

/** Скрытый текст: раскрывается по клику и обратно уже не закрывается — как в Telegram. */
export function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      type="button"
      className={`message-spoiler${revealed ? ' is-revealed' : ''}`}
      aria-label={revealed ? 'Скрытый текст показан' : 'Показать скрытый текст'}
      aria-expanded={revealed}
      onClick={(event) => {
        // Пузырь сообщения слушает клики (выделение, лайтбокс) — раскрытие
        // спойлера не должно заодно срабатывать как выбор сообщения.
        event.stopPropagation()
        if (!revealed) setRevealed(true)
      }}
    >
      {children}
    </button>
  )
}
