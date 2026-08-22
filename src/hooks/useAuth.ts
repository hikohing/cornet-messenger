import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { User } from '../types'

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [token, setTokenState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api
      .getMe()
      // Билет на медиа нужен до первого рендера: иначе аватары и картинки
      // успеют отрисоваться со ссылками без него и получат 401.
      .then(async (res) => {
        await api.ensureMediaTicket()
        if (!active) return
        setUser(res.user)
        setTokenState('cookie-session')
      })
      .catch(() => {
        if (!active) return
        api.clearToken()
        setTokenState(null)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  // Билет на медиа живёт полсуток, а нативное приложение с телефона неделями не
  // выгружается: без обновления в какой-то момент все картинки и аватары просто
  // перестали бы грузиться до перезапуска. Возврат из фона — самый частый и
  // самый дешёвый момент, чтобы это проверить (сам вызов ничего не делает, пока
  // до конца срока больше часа).
  useEffect(() => {
    if (!user) return
    const refresh = () => void api.ensureMediaTicket()
    const onAppState = (event: Event) => {
      if ((event as CustomEvent<{ isActive: boolean }>).detail?.isActive) refresh()
    }
    document.addEventListener('native:appstate', onAppState)
    return () => document.removeEventListener('native:appstate', onAppState)
  }, [user])

  async function login(username: string, password: string) {
    setError(null)
    try {
      const res = await api.login(username, password)
      if ('twoFactorRequired' in res) {
        setPendingTwoFactorToken(res.pendingToken)
        return
      }
      await api.ensureMediaTicket()
      setTokenState('cookie-session')
      setUser(res.user)
    } catch (err) {
      setError((err as Error).message)
      throw err
    }
  }

  async function verifyTwoFactor(code: string) {
    if (!pendingTwoFactorToken) return
    setError(null)
    try {
      const res = await api.verifyTwoFactorLogin(pendingTwoFactorToken, code)
      await api.ensureMediaTicket()
      setTokenState('cookie-session')
      setUser(res.user)
      setPendingTwoFactorToken(null)
    } catch (err) {
      setError((err as Error).message)
      throw err
    }
  }

  function cancelTwoFactor() {
    setPendingTwoFactorToken(null)
    setError(null)
  }

  async function register(username: string, password: string) {
    setError(null)
    try {
      const res = await api.register(username, password)
      await api.ensureMediaTicket()
      setTokenState('cookie-session')
      setUser(res.user)
    } catch (err) {
      setError((err as Error).message)
      throw err
    }
  }

  function logout() {
    void api.logout().catch(() => undefined)
    api.clearToken()
    api.clearMediaTicket()
    setTokenState(null)
    setUser(null)
  }

  async function updateProfile(patch: {
    username?: string
    color?: string
    avatarUrl?: string | null
    bannerUrl?: string | null
    bannerStyle?: User['bannerStyle']
    avatarDecoration?: User['avatarDecoration']
    profileEffect?: User['profileEffect']
    profileTheme?: User['profileTheme']
    nameStyle?: User['nameStyle']
    profileFrame?: User['profileFrame']
    nameplateStyle?: User['nameplateStyle']
    profilePrimaryColor?: string | null
    profileSecondaryColor?: string | null
    showLastSeen?: boolean
    bio?: string
    statusText?: string
    birthDate?: string | null
    displayName?: string | null
  }) {
    const res = await api.updateProfile(patch)
    setUser(res.user)
    return res.user
  }

  /** Подхватывает поля вроде email/emailVerified, изменённые в обход updateProfile (отвязка почты). */
  async function refreshUser() {
    const res = await api.getMe()
    setUser(res.user)
    return res.user
  }

  return {
    user,
    token,
    loading,
    error,
    login,
    register,
    logout,
    updateProfile,
    refreshUser,
    pendingTwoFactor: pendingTwoFactorToken !== null,
    verifyTwoFactor,
    cancelTwoFactor,
  }
}
