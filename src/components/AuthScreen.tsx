import { useState } from 'react'
import { forgotPassword } from '../api/client'
import { AlertIcon, SpinnerIcon } from './icons'

interface AuthScreenProps {
  error: string | null
  onLogin: (username: string, password: string) => Promise<void>
  onRegister: (username: string, password: string) => Promise<void>
  pendingTwoFactor: boolean
  onVerifyTwoFactor: (code: string) => Promise<void>
  onCancelTwoFactor: () => void
}

function TwoFactorForm({ error, onVerify, onCancel }: {
  error: string | null
  onVerify: (code: string) => Promise<void>
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await onVerify(code.trim())
    } catch {
      // error surfaced via `error` prop
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <div className="auth-brand">
        <div className="auth-mark">C</div>
        <div>
          <h1 className="auth-title notranslate" translate="no">CorNet</h1>
          <p className="auth-subtitle">Код из приложения-аутентификатора</p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="auth-2fa-code">Код или резервный код</label>
        <input
          id="auth-2fa-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="one-time-code"
          inputMode="text"
          placeholder="123456"
          maxLength={11}
        />
        <small className="field-hint">6-значный код из приложения — либо один из сохранённых резервных кодов</small>
      </div>
      {error && (
        <div className="form-banner form-banner--error">
          <AlertIcon width={16} height={16} />
          {error}
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={submitting || !code.trim()}>
        {submitting && <SpinnerIcon width={16} height={16} />}
        Подтвердить
      </button>
      <button type="button" className="btn-ghost" style={{ alignSelf: 'center' }} onClick={onCancel}>
        Назад ко входу
      </button>
    </form>
  )
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await forgotPassword(email.trim())
      setSent(true)
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-mark">C</div>
          <div>
            <h1 className="auth-title notranslate" translate="no">CorNet</h1>
            <p className="auth-subtitle">Проверьте почту</p>
          </div>
        </div>
        <p className="field-hint">
          Если на аккаунте есть подтверждённая почта {email.trim()}, мы отправили на неё ссылку для сброса пароля.
          Ссылка действует час.
        </p>
        <button type="button" className="btn-ghost" style={{ alignSelf: 'center' }} onClick={onBack}>
          Назад ко входу
        </button>
      </div>
    )
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <div className="auth-brand">
        <div className="auth-mark">C</div>
        <div>
          <h1 className="auth-title notranslate" translate="no">CorNet</h1>
          <p className="auth-subtitle">Восстановление пароля</p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="forgot-email">Почта, привязанная к аккаунту</label>
        <input
          id="forgot-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="email"
          required
        />
      </div>
      <button type="submit" className="btn-primary" disabled={submitting || !email.trim()}>
        {submitting && <SpinnerIcon width={16} height={16} />}
        Отправить ссылку
      </button>
      <button type="button" className="btn-ghost" style={{ alignSelf: 'center' }} onClick={onBack}>
        Назад ко входу
      </button>
    </form>
  )
}

export function AuthScreen({ error, onLogin, onRegister, pendingTwoFactor, onVerifyTwoFactor, onCancelTwoFactor }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const normalizedUsername = username.trim().replace(/^@/, '')
  const usernameValid = /^[A-Za-z0-9_]{3,24}$/.test(normalizedUsername)
  const passwordGroups = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
  const passwordStrongEnough = password.length >= 10 && passwordGroups >= 3 && usernameValid

  function switchMode(nextMode: 'login' | 'register' | 'forgot') {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setLocalError(null)
  }

  if (pendingTwoFactor) {
    return (
      <div className="auth-shell">
        <TwoFactorForm error={error} onVerify={onVerifyTwoFactor} onCancel={onCancelTwoFactor} />
      </div>
    )
  }

  if (mode === 'forgot') {
    return (
      <div className="auth-shell">
        <ForgotPasswordForm onBack={() => switchMode('login')} />
      </div>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError(null)
    if (mode === 'register' && password !== confirmPassword) {
      setLocalError('Пароли не совпадают')
      return
    }
    setSubmitting(true)
    try {
      if (mode === 'login') await onLogin(normalizedUsername, password)
      else await onRegister(normalizedUsername, password)
    } catch {
      // error surfaced via `error` prop
    } finally {
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
            <p className="auth-subtitle">
              {mode === 'login' ? 'С возвращением' : 'Создайте новый аккаунт'}
            </p>
          </div>
        </div>

        <div className="auth-mode-tabs" role="tablist" aria-label="Режим авторизации">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Вход</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>Регистрация</button>
        </div>

        <div className="field">
          <label htmlFor="auth-username">Username</label>
          <div className="auth-username-control">
            <span aria-hidden="true">@</span>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24))}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              minLength={3}
              maxLength={24}
            />
          </div>
          {mode === 'register' && <small className="field-hint">Уникальный username · 3–24 латинские буквы, цифры или _</small>}
        </div>

        <div className="field">
          <div className="field-label-row">
            <label htmlFor="auth-password">Пароль</label>
            {mode === 'login' && (
              <button type="button" className="auth-link-button" onClick={() => switchMode('forgot')}>
                Забыли пароль?
              </button>
            )}
          </div>
          <div className="auth-password-control">
            <input
              id="auth-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 10 : undefined}
              maxLength={128}
            />
            <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}>{showPassword ? 'Скрыть' : 'Показать'}</button>
          </div>
        </div>

        {mode === 'register' && (
          <>
            <div className="field">
              <label htmlFor="auth-password-confirm">Повторите пароль</label>
              <input id="auth-password-confirm" type={showPassword ? 'text' : 'password'} placeholder="••••••••••" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} />
            </div>
            <div className="auth-password-rules" aria-live="polite">
              <span className={password.length >= 10 ? 'met' : ''}>Не менее 10 символов</span>
              <span className={passwordGroups >= 3 ? 'met' : ''}>Три вида символов</span>
            </div>
          </>
        )}

        {(localError || error) && (
          <div className="form-banner form-banner--error">
            <AlertIcon width={16} height={16} />
            {localError || error}
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={submitting || !usernameValid || !password || (mode === 'register' && (!passwordStrongEnough || password !== confirmPassword))}>
          {submitting && <SpinnerIcon width={16} height={16} />}
          {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
        </button>

        <button
          type="button"
          className="btn-ghost"
          style={{ alignSelf: 'center' }}
          onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти'}
        </button>
      </form>
    </div>
  )
}
