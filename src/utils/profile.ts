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
  { id: 'coral', label: 'Коралл' },
  { id: 'mint', label: 'Мята' },
  { id: 'lavender', label: 'Лаванда' },
  { id: 'crimson', label: 'Багрянец' },
  { id: 'emerald', label: 'Изумруд' },
  { id: 'graphite', label: 'Графит' },
  { id: 'peach', label: 'Персик' },
  { id: 'indigo', label: 'Индиго' },
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
  { id: 'comet', label: 'Комета' },
  { id: 'aurora', label: 'Аврора' },
  { id: 'gold', label: 'Золото' },
  { id: 'shadow', label: 'Тень' },
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
  { id: 'snow', label: 'Снег' },
  { id: 'embers', label: 'Угли' },
  { id: 'matrix', label: 'Матрица' },
  { id: 'ripple', label: 'Рябь' },
] as const

export const PROFILE_THEMES = [
  { id: 'default', label: 'Стандарт' },
  { id: 'night', label: 'Ночь' },
  { id: 'berry', label: 'Ягода' },
  { id: 'ocean', label: 'Океан' },
  { id: 'forest', label: 'Лес' },
  { id: 'sunset', label: 'Закат' },
  { id: 'crimson', label: 'Багрянец' },
  { id: 'emerald', label: 'Изумруд' },
  { id: 'graphite', label: 'Графит' },
  { id: 'rose', label: 'Роза' },
] as const

export const NAME_STYLES = [
  { id: 'plain', label: 'Обычный' },
  { id: 'accent', label: 'Акцент' },
  { id: 'gradient', label: 'Градиент' },
  { id: 'glow', label: 'Свечение' },
  { id: 'mono', label: 'Моно' },
  { id: 'shadow', label: 'Тень' },
  { id: 'outline', label: 'Контур' },
  { id: 'neon', label: 'Неон' },
] as const

export const PROFILE_FRAMES = [
  { id: 'none', label: 'Без рамки' },
  { id: 'accent', label: 'Акцент' },
  { id: 'glass', label: 'Стекло' },
  { id: 'gold', label: 'Золото' },
  { id: 'neon', label: 'Неон' },
  { id: 'ice', label: 'Лёд' },
  { id: 'fire', label: 'Огонь' },
  { id: 'shadow', label: 'Тень' },
  { id: 'emerald', label: 'Изумруд' },
  { id: 'rose', label: 'Роза' },
] as const

export const NAMEPLATES = [
  { id: 'none', label: 'Без плашки' },
  { id: 'cosmic', label: 'Космос' },
  { id: 'sakura', label: 'Сакура' },
  { id: 'arcade', label: 'Аркада' },
  { id: 'forest', label: 'Лес' },
  { id: 'gold', label: 'Золото' },
  { id: 'ocean', label: 'Океан' },
  { id: 'crimson', label: 'Багрянец' },
  { id: 'midnight', label: 'Полночь' },
  { id: 'royal', label: 'Роял' },
] as const

export const PROFILE_BUNDLES = [
  { id: 'cosmic', label: 'Космос', caption: 'Полночь и звёзды', patch: { color: '#8b5cf6', bannerUrl: null, bannerStyle: 'midnight', avatarDecoration: 'neon', profileEffect: 'stars', profileTheme: 'night', nameStyle: 'glow', profileFrame: 'neon', nameplateStyle: 'cosmic' } },
  { id: 'sakura', label: 'Сакура', caption: 'Лепестки и нежный свет', patch: { color: '#ec4899', bannerUrl: null, bannerStyle: 'berry', avatarDecoration: 'petals', profileEffect: 'sakura', profileTheme: 'berry', nameStyle: 'gradient', profileFrame: 'glass', nameplateStyle: 'sakura' } },
  { id: 'cyber', label: 'Кибер', caption: 'Пиксели и сканер', patch: { color: '#22d3ee', bannerUrl: null, bannerStyle: 'ocean', avatarDecoration: 'pixel', profileEffect: 'scan', profileTheme: 'night', nameStyle: 'mono', profileFrame: 'neon', nameplateStyle: 'arcade' } },
  { id: 'forest', label: 'Лес', caption: 'Лианы и дождь', patch: { color: '#22c55e', bannerUrl: null, bannerStyle: 'aurora', avatarDecoration: 'vines', profileEffect: 'rain', profileTheme: 'forest', nameStyle: 'accent', profileFrame: 'accent', nameplateStyle: 'forest' } },
  { id: 'gold', label: 'Золото', caption: 'Тёплое сияние и премиальная рамка', patch: { color: '#f59e0b', bannerUrl: null, bannerStyle: 'gold', avatarDecoration: 'sparkles', profileEffect: 'confetti', profileTheme: 'night', nameStyle: 'accent', profileFrame: 'gold', nameplateStyle: 'gold' } },
  { id: 'abyss', label: 'Бездна', caption: 'Глубина и прохлада', patch: { color: '#38bdf8', bannerUrl: null, bannerStyle: 'indigo', avatarDecoration: 'aurora', profileEffect: 'ripple', profileTheme: 'ocean', nameStyle: 'neon', profileFrame: 'ice', nameplateStyle: 'ocean' } },
  { id: 'midnight', label: 'Полночь', caption: 'Тень и звёздное небо', patch: { color: '#818cf8', bannerUrl: null, bannerStyle: 'midnight', avatarDecoration: 'shadow', profileEffect: 'stars', profileTheme: 'graphite', nameStyle: 'shadow', profileFrame: 'shadow', nameplateStyle: 'midnight' } },
  { id: 'ember', label: 'Пламя', caption: 'Угли и жар заката', patch: { color: '#fb923c', bannerUrl: null, bannerStyle: 'coral', avatarDecoration: 'gold', profileEffect: 'embers', profileTheme: 'sunset', nameStyle: 'outline', profileFrame: 'fire', nameplateStyle: 'crimson' } },
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
  coral: 'linear-gradient(135deg, #7c2d12 0%, #f97316 48%, #fca5a5 100%)',
  mint: 'linear-gradient(135deg, #064e3b 0%, #10b981 48%, #a7f3d0 100%)',
  lavender: 'linear-gradient(135deg, #3b0764 0%, #a855f7 48%, #e9d5ff 100%)',
  crimson: 'linear-gradient(135deg, #450a0a 0%, #dc2626 48%, #fca5a5 100%)',
  emerald: 'linear-gradient(135deg, #022c22 0%, #059669 48%, #6ee7b7 100%)',
  graphite: 'linear-gradient(135deg, #030712 0%, #374151 55%, #9ca3af 100%)',
  peach: 'linear-gradient(135deg, #7c2d12 0%, #fb923c 48%, #fed7aa 100%)',
  indigo: 'linear-gradient(135deg, #1e1b4b 0%, #4f46e5 48%, #a5b4fc 100%)',
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
