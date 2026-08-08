import { useRef } from 'react'

const LONG_PRESS_MS = 450
const MOVE_TOLERANCE_PX = 10

/** Fires `onLongPress` after a sustained touch hold; cancels if the finger moves or lifts early. */
export function useLongPress(onLongPress: (event: React.TouchEvent) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  function clear() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }

  function onTouchStart(event: React.TouchEvent) {
    const touch = event.touches[0]
    if (!touch) return
    startRef.current = { x: touch.clientX, y: touch.clientY }
    const syntheticEvent = event
    timerRef.current = setTimeout(() => {
      onLongPress(syntheticEvent)
      startRef.current = null
    }, LONG_PRESS_MS)
  }

  function onTouchMove(event: React.TouchEvent) {
    const touch = event.touches[0]
    if (!touch || !startRef.current) return
    const dx = touch.clientX - startRef.current.x
    const dy = touch.clientY - startRef.current.y
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) clear()
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd: clear,
    onTouchCancel: clear,
  }
}
