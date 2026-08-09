import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import * as api from '../api/client'
import { isNative } from './platform'

/**
 * Входящие звонки при закрытом приложении.
 *
 * Схема: сервер будит устройство VoIP-пушем (PushKit) → нативный слой сразу
 * показывает системный экран звонка (CallKit) → приложение поднимается,
 * подключает сокет и забирает у сервера отложенное приглашение с оффером
 * (`call_claim`) → человек жмёт «Принять» на системном экране, и мы запускаем
 * обычный приём звонка.
 *
 * Показывать входящий обязана именно нативная часть: JS к моменту прихода пуша
 * может ещё не существовать, а iOS требует показать звонок немедленно.
 */
export interface IncomingCallPush {
  callId: string
  chatId: number
  callerId: number
  callerName: string
  video: boolean
}

interface CornetCallKitPlugin {
  register(): Promise<{ token: string }>
  reportOutgoingCall(options: { callId: string; handle: string; video: boolean }): Promise<void>
  reportConnected(options: { callId: string }): Promise<void>
  reportCallEnded(options: { callId: string; reason: string }): Promise<void>
  endCall(options: { callId: string }): Promise<void>
  addListener(event: 'registration', handler: (data: { token: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'incomingCall', handler: (data: IncomingCallPush) => void): Promise<PluginListenerHandle>
  addListener(event: 'answerCall', handler: (data: { callId: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'endCall', handler: (data: { callId: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'muteChanged', handler: (data: { callId: string; muted: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'resetCalls', handler: () => void): Promise<PluginListenerHandle>
}

const CallKit = registerPlugin<CornetCallKitPlugin>('CornetCallKit')

export function isCallKitAvailable(): boolean {
  return isNative()
}

/** Звонки, пришедшие через системный экран: для них не надо звонить самим. */
const callKitCallIds = new Set<string>()

export function isCallKitCall(callId: string): boolean {
  return callKitCallIds.has(callId)
}

export function forgetCallKitCall(callId: string) {
  callKitCallIds.delete(callId)
}

let registeredToken: string | null = null
let registrationListenerAttached = false

async function sendTokenToServer(token: string, force = false) {
  if (!token) return
  // Токен PushKit меняется редко — заново слать его серверу есть смысл только
  // когда он действительно новый или когда сменилась сессия (после выхода
  // сервер удаляет устройства вместе с ней).
  if (!force && token === registeredToken) return
  registeredToken = token
  await api
    .registerPushDevice({ provider: 'apns_voip', token, preview: true, directEnabled: true, groupEnabled: true })
    .catch(() => {
      registeredToken = null
    })
}

/**
 * Токен PushKit не требует разрешения пользователя — он выдаётся сразу. Поэтому
 * звонки работают независимо от настроек уведомлений о сообщениях; выключает их
 * только режим «не беспокоить».
 */
export async function enableCallKit(): Promise<void> {
  if (!isNative()) return
  try {
    const { token } = await CallKit.register()
    // Токен мог прийти до подписки — тогда он вернётся прямо здесь.
    if (token) await sendTokenToServer(token, true)
    if (!registrationListenerAttached) {
      registrationListenerAttached = true
      await CallKit.addListener('registration', (data) => {
        void sendTokenToServer(data.token)
      })
    }
  } catch {
    // Плагин не собран или устройство не поддерживает VoIP-пуши — звонки
    // остаются доступны, пока приложение открыто.
  }
}

export async function disableCallKit(): Promise<void> {
  if (!isNative() || !registeredToken) return
  const token = registeredToken
  registeredToken = null
  await api.unregisterPushDevice('apns_voip', token).catch(() => undefined)
}

export interface CallKitHandlers {
  /** Пуш разбудил приложение: пора забрать у сервера отложенное приглашение. */
  onIncoming(push: IncomingCallPush): void
  onAnswer(callId: string): void
  onEnd(callId: string): void
  onMute(callId: string, muted: boolean): void
}

/** @returns функция отписки */
export function listenToCallKit(handlers: CallKitHandlers): () => void {
  if (!isNative()) return () => undefined

  const pending: Promise<PluginListenerHandle>[] = [
    CallKit.addListener('incomingCall', (push) => {
      callKitCallIds.add(push.callId)
      handlers.onIncoming(push)
    }),
    CallKit.addListener('answerCall', (data) => handlers.onAnswer(data.callId)),
    CallKit.addListener('endCall', (data) => {
      handlers.onEnd(data.callId)
      callKitCallIds.delete(data.callId)
    }),
    CallKit.addListener('muteChanged', (data) => handlers.onMute(data.callId, data.muted)),
  ]

  return () => {
    for (const handle of pending) void handle.then((h) => h.remove()).catch(() => undefined)
  }
}

export function reportOutgoingToCallKit(callId: string, handle: string, video: boolean) {
  if (!isNative()) return
  void CallKit.reportOutgoingCall({ callId, handle, video }).catch(() => undefined)
}

export function reportConnectedToCallKit(callId: string) {
  if (!isNative()) return
  void CallKit.reportConnected({ callId }).catch(() => undefined)
}

/** Звонок закончился не с системного экрана — надо погасить его вручную. */
export function reportEndedToCallKit(callId: string, reason: string) {
  if (!isNative()) return
  callKitCallIds.delete(callId)
  void CallKit.reportCallEnded({ callId, reason }).catch(() => undefined)
}
