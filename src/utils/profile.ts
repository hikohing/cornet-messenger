import type { CSSProperties } from 'react'
import { resolveUrl } from '../api/client'
import type { User } from '../types'

export const BANNER_STYLES = [
  { id: 'profile', label: 'Цвет профиля' },
  { id: 'ocean', label: 'Океан' },
  { id: 'sunset', label: 'Закат' },
  { id: 'aurora', label: 'Аврора' },
  { id: 'midnight', label: 'Полночь' },
  { id: 'berry', label: 'Ягода' },
  { id: 'gold', label: 'Золото' },
  { id: 'mono', label: 'Монохром' },
] as const

export const AVATAR_DECORATIONS = [
  { id: 'none', label: 'Без рамки' },
  { id: 'ring', label: 'Орбита' },
  { id: 'neon', label: 'Неон' },
  { id: 'sparkles', label: 'Искры' },
  { id: 'double', label: 'Двойная' },
  { id: 'halo', label: 'Ореол' },
  { id: 'petals', label: 'Лепестки' },
  { id: 'flames', label: 'Пламя' },
  { id: 'bubbles', label: 'Пузыри' },
  { id: 'pixel', label: 'Пиксель' },
  { id: 'frost', label: 'Иней' },
  { id: 'vines', label: 'Лианы' },
] as const

export const PROFILE_EFFECTS = [
  { id: 'none', label: 'Обычный' },
  { id: 'glow', label: 'Свечение' },
  { id: 'aurora', label: 'Сияние' },
  { id: 'grid', label: 'Сетка' },
  { id: 'holo', label: 'Голография' },
  { id: 'stars', label: 'Звёзды' },
  { id: 'confetti', label: 'Конфетти' },
  { id: 'rain', label: 'Дождь' },
  { id: 'pulse', label: 'Импульс' },
  { id: 'scan', label: 'Сканер' },
  { id: 'sakura', label: 'Сакура' },
  { id: 'comet', label: 'Комета' },
] as const

export const PROFILE_THEMES = [
  { id: 'default', label: 'Стандарт' },
  { id: 'night', label: 'Ночь' },
  { id: 'berry', label: 'Ягода' },
  { id: 'ocean', label: 'Океан' },
  { id: 'forest', label: 'Лес' },
] as const

export const NAME_STYLES = [
  { id: 'plain', label: 'Обычный' },
  { id: 'accent', label: 'Акцент' },
  { id: 'gradient', label: 'Градиент' },
  { id: 'glow', label: 'Свечение' },
  { id: 'mono', label: 'Моно' },
] as const

export const PROFILE_FRAMES = [
  { id: 'none', label: 'Без рамки' },
  { id: 'accent', label: 'Акцент' },
  { id: 'glass', label: 'Стекло' },
  { id: 'gold', label: 'Золото' },
  { id: 'neon', label: 'Неон' },
] as const

export const NAMEPLATES = [
  { id: 'none', label: 'Без плашки' },
  { id: 'cosmic', label: 'Космос' },
  { id: 'sakura', label: 'Сакура' },
  { id: 'arcade', label: 'Аркада' },
  { id: 'forest', label: 'Лес' },
  { id: 'gold', label: 'Золото' },
] as const

export const PROFILE_BUNDLES = [
  { id: 'cosmic', label: 'Космос', caption: 'Полночь и звёзды', patch: { color: '#8b5cf6', bannerUrl: null, bannerStyle: 'midnight', avatarDecoration: 'neon', profileEffect: 'stars', profileTheme: 'night', nameStyle: 'glow', profileFrame: 'neon', nameplateStyle: 'cosmic' } },
  { id: 'sakura', label: 'Сакура', caption: 'Лепестки и нежный свет', patch: { color: '#ec4899', bannerUrl: null, bannerStyle: 'berry', avatarDecoration: 'petals', profileEffect: 'sakura', profileTheme: 'berry', nameStyle: 'gradient', profileFrame: 'glass', nameplateStyle: 'sakura' } },
  { id: 'cyber', label: 'Кибер', caption: 'Пиксели и сканер', patch: { color: '#22d3ee', bannerUrl: null, bannerStyle: 'ocean', avatarDecoration: 'pixel', profileEffect: 'scan', profileTheme: 'night', nameStyle: 'mono', profileFrame: 'neon', nameplateStyle: 'arcade' } },
  { id: 'forest', label: 'Лес', caption: 'Лианы и дождь', patch: { color: '#22c55e', bannerUrl: null, bannerStyle: 'aurora', avatarDecoration: 'vines', profileEffect: 'rain', profileTheme: 'forest', nameStyle: 'accent', profileFrame: 'accent', nameplateStyle: 'forest' } },
  { id: 'gold', label: 'Золото', caption: 'Тёплое сияние и премиальная рамка', patch: { color: '#f59e0b', bannerUrl: null, bannerStyle: 'gold', avatarDecoration: 'sparkles', profileEffect: 'confetti', profileTheme: 'night', nameStyle: 'accent', profileFrame: 'gold', nameplateStyle: 'gold' } },
] as const

const BANNERS: Record<NonNullable<User['bannerStyle']>, string> = {
  profile: '',
  ocean: 'linear-gradient(135deg, #087ea4 0%, #22d3ee 48%, #2563eb 100%)',
  sunset: 'linear-gradient(135deg, #f97316 0%, #ec4899 52%, #7c3aed 100%)',
  aurora: 'linear-gradient(135deg, #059669 0%, #14b8a6 40%, #6d28d9 100%)',
  midnight: 'linear-gradient(135deg, #111827 0%, #312e81 52%, #701a75 100%)',
  berry: 'linear-gradient(135deg, #4c0519 0%, #be185d 48%, #7e22ce 100%)',
  gold: 'linear-gradient(135deg, #713f12 0%, #f59e0b 48%, #fde68a 100%)',
  mono: 'linear-gradient(135deg, #111827 0%, #6b7280 55%, #d1d5db 100%)',
}

export function profileBannerStyle(user: User): CSSProperties {
  if (user.bannerUrl) {
    return {
      backgroundImage: `linear-gradient(180deg, transparent 38%, rgba(0, 0, 0, 0.22)), url("${resolveUrl(user.bannerUrl)}")`,
      backgroundPosition: 'center',
      backgroundSize: 'cover',
    }
  }
  if (user.profilePrimaryColor) {
    return { background: 'transparent' }
  }
  const preset = BANNERS[user.bannerStyle ?? 'profile']
  return { background: preset || `linear-gradient(135deg, ${user.color}, color-mix(in srgb, ${user.color} 34%, var(--bg-elevated)))` }
}

export function profileCardColorStyle(user: User): CSSProperties {
  if (!user.profileSecondaryColor) return {}
  return {
    '--profile-custom-top': user.profilePrimaryColor ?? user.profileSecondaryColor,
    '--profile-custom-bottom': user.profileSecondaryColor,
  } as CSSProperties
}
