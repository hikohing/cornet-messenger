import { useEffect, useState } from 'react'
import { verifyEmail } from '../api/client'
import { AlertIcon, CheckIcon, SpinnerIcon } from './icons'

interface VerifyEmailScreenProps {
  token: string
  onDone: () => void
}

/** Открывается по ссылке из письма подтверждения почты (?verifyEmail=...). */
export function VerifyEmailScreen({ token, onDone }: VerifyEmailScreenProps) {
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    verifyEmail(token)
      .then(() => {
        if (active) setState('done')
      })
      .catch((err: Error) => {
        if (!active) return
        setMessage(err.message)
        setState('error')
      })
    return () => {
      active = false
    }
  }, [token])

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-mark">C</div>
          <div>
            <h1 className="auth-title notranslate" translate="no">CorNet</h1>
            <p className="auth-subtitle">Подтверждение почты</p>
          </div>
        </div>

        {state === 'loading' && (
          <p className="field-hint"><SpinnerIcon width={14} height={14} /> Подтверждаем…</p>
        )}

        {state === 'done' && (
          <div className="form-banner form-banner--success">
            <CheckIcon width={16} height={16} />
            Почта подтверждена и привязана к аккаунту.
          </div>
        )}

        {state === 'error' && (
          <div className="form-banner form-banner--error">
            <AlertIcon width={16} height={16} />
            {message}
          </div>
        )}

        <button
          type="button"
          className="btn-primary"
          // После успешного подтверждения перезагружаем страницу целиком, чтобы уже
          // открытая вкладка (если это она же) подхватила emailVerified без лишней логики синхронизации.
          onClick={() => (state === 'done' ? (window.location.href = window.location.pathname) : onDone())}
          disabled={state === 'loading'}
        >
          Продолжить
        </button>
      </div>
    </div>
  )
}
