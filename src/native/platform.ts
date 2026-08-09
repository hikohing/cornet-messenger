import { Capacitor } from '@capacitor/core'

export type NativePlatform = 'ios' | 'android' | 'web'

/**
 * В браузере Capacitor тоже подгружается (это обычный npm-пакет), но сообщает
 * платформу 'web' и все нативные вызовы уходят в веб-заглушки. Поэтому весь
 * остальной код может импортировать этот модуль без оглядки на сборку.
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export function platform(): NativePlatform {
  const value = Capacitor.getPlatform()
  return value === 'ios' || value === 'android' ? value : 'web'
}

export function isIOS(): boolean {
  return platform() === 'ios'
}
