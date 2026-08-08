import { useToastState } from '../hooks/useToast'

export function ToastHost() {
  const toast = useToastState()
  if (!toast) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      <div key={toast.id} className="toast">
        {toast.message}
      </div>
    </div>
  )
}
