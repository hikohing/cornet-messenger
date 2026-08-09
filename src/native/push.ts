import { PushNotifications } from '@capacitor/push-notifications'
import * as api from '../api/client'
import { isNative } from './platform'

/**
 * Регистрация устройства для пушей.
 *
 * Два транспорта под одним интерфейсом: нативная сборка получает device token от
 * APNs, браузер — подписку Web Push (она же работает в PWA, установленной на
 * домашний экран iOS 16.4+). Сервер про разницу знает только по полю provider.
 *
 * Пуши нужны потому, что уведомления через `new Notification()` живут ровно
 * столько, сколько открыта вкладка: закрытое приложение так уведомить нельзя.
 */
export interface PushPreferences {
  preview: boolean
  directEnabled: boolean
  groupEnabled: boolean
}

export type PushResult = 'granted' | 'denied' | 'unsupported' | 'unconfigured'

/** Токен последней подписки — нужен, чтобы отписаться и чтобы досылать смену настроек. */
const DEVICE_KEY = 'connecto:push-device'

interface StoredDevice {
  provider: 'apns' | 'webpush'
  token: string
  keys?: { p256dh: string; auth: string }
}

function loadDevice(): StoredDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY)
    return raw ? (JSON.parse(raw) as StoredDevice) : null
  } catch {
    return null
  }
}

function saveDevice(device: StoredDevice | null) {
  if (device) localStorage.setItem(DEVICE_KEY, JSON.stringify(device))
  else localStorage.removeItem(DEVICE_KEY)
}

/** VAPID-ключ приходит base64url, а subscribe() ждёт сырые байты. */
function decodeVapidKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Тап по уведомлению должен открывать нужный чат — App слушает это событие. */
function requestOpenChat(chatId: unknown) {
  const id = Number(chatId)
  if (!Number.isInteger(id) || id <= 0) return
  document.dispatchEvent(new CustomEvent('push:open-chat', { detail: { chatId: id } }))
}

/** Слушатель 'registration' переживает смену настроек, поэтому свежие берёт отсюда. */
let preferencesSnapshot: PushPreferences = { preview: true, directEnabled: true, groupEnabled: true }

let nativeListenersAttached = false

async function enableNativePush(preferences: PushPreferences): Promise<PushResult> {
  const current = await PushNotifications.checkPermissions()
  const status = current.receive === 'granted'
    ? 'granted'
    : (await PushNotifications.requestPermissions()).receive
  if (status !== 'granted') return 'denied'

  if (!nativeListenersAttached) {
    nativeListenersAttached = true
    // APNs выдаёт токен асинхронно после register() — и может прислать новый в
    // любой момент жизни приложения, поэтому слушатель ставится один раз и живёт
    // до конца сессии.
    await PushNotifications.addListener('registration', (token) => {
      const device: StoredDevice = { provider: 'apns', token: token.value }
      saveDevice(device)
      void api.registerPushDevice({ ...device, ...preferencesSnapshot }).catch(() => undefined)
    })
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      requestOpenChat(action.notification.data?.chatId)
    })
  }

  preferencesSnapshot = preferences
  await PushNotifications.register()
  return 'granted'
}

async function enableWebPush(preferences: PushPreferences): Promise<PushResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'

  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return 'denied'

  const config = await api.getPushConfig()
  if (!config.vapidPublicKey) return 'unconfigured'

  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  // Уже существующая подписка могла быть выпущена под другой VAPID-ключ —
  // тогда subscribe() бросит ошибку, и переподписаться можно только после отписки.
  let subscription = await registration.pushManager.getSubscription()
  const applicationServerKey = decodeVapidKey(config.vapidPublicKey)
  if (subscription) {
    const existing = new Uint8Array(subscription.options.applicationServerKey ?? new ArrayBuffer(0))
    const same = existing.length === applicationServerKey.length && existing.every((byte, i) => byte === applicationServerKey[i])
    if (!same) {
      await subscription.unsubscribe()
      subscription = null
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  }

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
  if (!json.endpoint || !json.keys) return 'unsupported'

  const device: StoredDevice = { provider: 'webpush', token: json.endpoint, keys: json.keys }
  saveDevice(device)
  await api.registerPushDevice({ ...device, ...preferences })
  return 'granted'
}

export async function enablePush(preferences: PushPreferences): Promise<PushResult> {
  preferencesSnapshot = preferences
  try {
    return isNative() ? await enableNativePush(preferences) : await enableWebPush(preferences)
  } catch {
    return 'unsupported'
  }
}

export async function disablePush(): Promise<void> {
  const device = loadDevice()
  saveDevice(null)
  if (!device) return
  await api.unregisterPushDevice(device.provider, device.token).catch(() => undefined)
  if (device.provider === 'webpush' && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe().catch(() => undefined)
  }
}

/** Переключатели «превью», «личные», «группы» живут на клиенте — серверу их надо досылать. */
export async function syncPushPreferences(preferences: PushPreferences): Promise<void> {
  preferencesSnapshot = preferences
  const device = loadDevice()
  if (!device) return
  await api.registerPushDevice({ ...device, ...preferences }).catch(() => undefined)
}

/** Веб-версия: клик по уведомлению обрабатывает service worker и присылает сюда chatId. */
export function listenForPushOpens(): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'push:open-chat') requestOpenChat(event.data.chatId)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}
