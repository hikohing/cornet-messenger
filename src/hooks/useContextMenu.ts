import { useState } from 'react'
import type { ContextMenuItem, ContextMenuState } from '../components/ContextMenu'

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  function openAt(x: number, y: number, items: ContextMenuItem[]) {
    setMenu({ x, y, items })
  }

  function openFromMouseEvent(event: React.MouseEvent, items: ContextMenuItem[]) {
    event.preventDefault()
    openAt(event.clientX, event.clientY, items)
  }

  function openFromTouchEvent(event: React.TouchEvent, items: ContextMenuItem[]) {
    const touch = event.touches[0] ?? event.changedTouches[0]
    if (navigator.vibrate) navigator.vibrate(12)
    openAt(touch?.clientX ?? 0, touch?.clientY ?? 0, items)
  }

  function close() {
    setMenu(null)
  }

  return { menu, openAt, openFromMouseEvent, openFromTouchEvent, close }
}
