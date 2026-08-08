import { useEffect, useState } from 'react'

export type ThemePreference = 'dark' | 'amoled' | 'light' | 'system'
export type FontSizePreference = 'small' | 'medium' | 'large'
export type AccentPreference = 'violet' | 'blue' | 'emerald' | 'rose' | 'amber' | 'custom'
export type WallpaperPreference = 'plain' | 'aurora' | 'dots' | 'grid' | 'midnight'
export type BubblePreference = 'soft' | 'compact' | 'glass' | 'outline'
export type AnimationPreference = 'fade' | 'slide' | 'pop' | 'none'
export type BlurPreference = 'off' | 'soft' | 'strong'
export type SidebarPreference = 'compact' | 'normal' | 'wide'
export type FontPreference = 'system' | 'modern' | 'rounded'
export type SoundPreference = 'soft' | 'ping' | 'crystal' | 'none'
export type CallRingtonePreference = 'classic' | 'soft' | 'crystal' | 'none'

export interface AppPreferences {
  theme: ThemePreference
  accent: AccentPreference
  customAccentColor: string
  fontSize: FontSizePreference
  fontFamily: FontPreference
  sidebarSize: SidebarPreference
  compactMode: boolean
  reducedMotion: boolean
  wallpaper: WallpaperPreference
  bubbleStyle: BubblePreference
  messageAnimation: AnimationPreference
  blurLevel: BlurPreference
  notifications: boolean
  notificationSound: boolean
  notificationSoundStyle: SoundPreference
  directNotifications: boolean
  groupNotifications: boolean
  messagePreview: boolean
  enterToSend: boolean
  sendTyping: boolean
  sendReadReceipts: boolean
  saveDrafts: boolean
  largeEmoji: boolean
  callRingVolume: number
  callRingtoneStyle: CallRingtonePreference
  startVideoCallsWithCameraOff: boolean
  doNotDisturbCalls: boolean
  /** Пустая строка — устройство по умолчанию, выбранное системой. */
  preferredMicId: string
  preferredCameraId: string
  preferredSpeakerId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** Звёзды, конфетти, дождь и другие эффекты карточки профиля будут двигаться. */
  profileEffectsAnimated: boolean
}

const STORAGE_KEY = 'connecto:preferences'

const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'dark',
  accent: 'blue',
  customAccentColor: '#3390ec',
  fontSize: 'medium',
  fontFamily: 'modern',
  sidebarSize: 'normal',
  compactMode: false,
  reducedMotion: false,
  wallpaper: 'plain',
  bubbleStyle: 'soft',
  messageAnimation: 'fade',
  blurLevel: 'soft',
  notifications: false,
  notificationSound: true,
  notificationSoundStyle: 'soft',
  directNotifications: true,
  groupNotifications: true,
  messagePreview: true,
  enterToSend: true,
  sendTyping: true,
  sendReadReceipts: true,
  saveDrafts: true,
  largeEmoji: true,
  callRingVolume: 100,
  callRingtoneStyle: 'classic',
  startVideoCallsWithCameraOff: false,
  doNotDisturbCalls: false,
  preferredMicId: '',
  preferredCameraId: '',
  preferredSpeakerId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  profileEffectsAnimated: true,
}

function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value)
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function mixWithWhite([r, g, b]: [number, number, number], amount: number): string {
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function loadPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) } : DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: light)')

    function applyTheme() {
      root.dataset.theme = preferences.theme === 'system' ? (media.matches ? 'light' : 'dark') : preferences.theme
    }

    applyTheme()
    root.dataset.fontSize = preferences.fontSize
    root.dataset.fontFamily = preferences.fontFamily
    root.dataset.accent = preferences.accent
    if (preferences.accent === 'custom' && isValidHexColor(preferences.customAccentColor)) {
      const rgb = hexToRgb(preferences.customAccentColor)
      root.style.setProperty('--accent', preferences.customAccentColor)
      root.style.setProperty('--accent-hover', mixWithWhite(rgb, 0.18))
      root.style.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, 0.18)`)
      root.style.setProperty('--accent-contrast', relativeLuminance(rgb) > 0.6 ? '#17212b' : '#ffffff')
    } else {
      root.style.removeProperty('--accent')
      root.style.removeProperty('--accent-hover')
      root.style.removeProperty('--accent-soft')
      root.style.removeProperty('--accent-contrast')
    }
    root.dataset.sidebar = preferences.sidebarSize
    root.dataset.compact = String(preferences.compactMode)
    root.dataset.reducedMotion = String(preferences.reducedMotion)
    root.dataset.wallpaper = preferences.wallpaper
    root.dataset.bubbles = preferences.bubbleStyle
    root.dataset.messageAnimation = preferences.messageAnimation
    root.dataset.blur = preferences.blurLevel
    root.dataset.largeEmoji = String(preferences.largeEmoji)
    root.dataset.profileEffectsAnimated = String(preferences.profileEffectsAnimated)
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [preferences])

  function updatePreferences(patch: Partial<AppPreferences>) {
    setPreferences((current) => ({ ...current, ...patch }))
  }

  function resetPreferences() {
    setPreferences(DEFAULT_PREFERENCES)
  }

  return { preferences, updatePreferences, resetPreferences }
}
