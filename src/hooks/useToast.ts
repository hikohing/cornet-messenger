import { useEffect, useState } from 'react'

interface ToastState {
  id: number
  message: string
}

let currentToast: ToastState | null = null
let nextId = 1
const listeners = new Set<(toast: ToastState | null) => void>()
let hideTimer: ReturnType<typeof setTimeout> | null = null

export function showToast(message: string) {
  if (hideTimer) clearTimeout(hideTimer)
  currentToast = { id: nextId++, message }
  for (const listener of listeners) listener(currentToast)
  hideTimer = setTimeout(() => {
    currentToast = null
    for (const listener of listeners) listener(null)
  }, 2600)
}

export function useToastState() {
  const [toast, setToast] = useState<ToastState | null>(currentToast)
  useEffect(() => {
    listeners.add(setToast)
    return () => {
      listeners.delete(setToast)
    }
  }, [])
  return toast
}
