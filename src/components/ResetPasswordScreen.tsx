import { useState } from 'react'
import { resetPassword } from '../api/client'
import { AlertIcon, SpinnerIcon } from './icons'

interface ResetPasswordScreenProps {
  token: string
  onDone: () => void
}

/** Открывается по ссылке из письма восстановления пароля (?resetToken=...). */
export function ResetPasswordScreen({ token, onDone }: ResetPasswordScreenProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const passwordGroups = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
  const strongEnough = password.length >= 10 && passwordGroups >= 3

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirmPassword) {
      setError('Пароли не совпадают')
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(token, password)
      // Полная перезагрузка — самый надёжный способ подхватить новую сессию
      // (кука уже выставлена ответом сервера) во всех местах приложения разом.
      window.location.href = '/'
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <div className="auth-mark">C</div>
          <div>
            <h1 className="auth-title notranslate" translate="no">CorNet</h1>
            <p className="auth-subtitle">Новый пароль</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="reset-password">Новый пароль</label>
          <div className="auth-password-control">
            <input
              id="reset-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
            />
            <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}>
              {showPassword ? 'Скрыть' : 'Показать'}
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="reset-password-confirm">Повторите пароль</label>
          <input
            id="reset-password-confirm"
            type={showPassword ? 'text' : 'password'}
            placeholder="••••••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
          />
        </div>

        <div className="auth-password-rules" aria-live="polite">
          <span className={password.length >= 10 ? 'met' : ''}>Не менее 10 символов</span>
          <span className={passwordGroups >= 3 ? 'met' : ''}>Три вида символов</span>
        </div>

        {error && (
          <div className="form-banner form-banner--error">
            <AlertIcon width={16} height={16} />
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={submitting || !strongEnough || password !== confirmPassword}>
          {submitting && <SpinnerIcon width={16} height={16} />}
          Сохранить и войти
        </button>
        <button type="button" className="btn-ghost" style={{ alignSelf: 'center' }} onClick={onDone}>
          Отмена
        </button>
      </form>
    </div>
  )
}
