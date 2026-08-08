import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  reactions?: string[]
  onReact?: (emoji: string) => void
}

export function ContextMenu({ x, y, items, reactions, onReact, onClose }: ContextMenuState & { onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y, ready: false })

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clampedX = Math.min(x, window.innerWidth - rect.width - 8)
    const clampedY = Math.min(y, window.innerHeight - rect.height - 8)
    setPosition({ x: Math.max(8, clampedX), y: Math.max(8, clampedY), ready: true })
  }, [x, y])

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    function onScroll() {
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y, visibility: position.ready ? 'visible' : 'hidden' }}
      role="menu"
    >
      {reactions && reactions.length > 0 && (
        <div className="context-menu-reactions">
          {reactions.map((emoji) => (
            <button
              key={emoji}
              className="context-menu-reaction"
              onClick={() => {
                onReact?.(emoji)
                onClose()
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {items.map((item, index) => (
        <button
          key={index}
          className={`context-menu-item${item.danger ? ' danger' : ''}`}
          role="menuitem"
          onClick={() => {
            item.onClick()
            onClose()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
