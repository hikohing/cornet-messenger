import { useRef, useState } from 'react'
import * as api from '../api/client'
import type { RemoteCallState, SocketApi, SocketEvent } from '../api/socket'
import type { User } from '../types'
import type { AppPreferences, CallRingtonePreference } from './usePreferences'
import { showToast } from './useToast'

/** Сколько ждём ответа, прежде чем считать звонок пропущенным (сервер страхует на 60 с). */
const RING_TIMEOUT_MS = 45_000
/** Сколько терпим разрыв медиапотока, прежде чем закончить звонок. */
const RECONNECT_GIVE_UP_MS = 15_000

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

const CALL_RINGTONE_FREQUENCIES: Record<CallRingtonePreference, number> = {
  classic: 660,
  soft: 520,
  crystal: 880,
  none: 0,
}

/** Причины, о которых сообщаем тому, кто сам завершил звонок. */
const LOCAL_END_REASON_LABEL: Record<string, string> = {
  timeout: 'Нет ответа',
  unavailable: 'Собеседник не в сети',
  failed: 'Связь потеряна',
}

/** Причины, пришедшие от собеседника или сервера. */
const CALL_END_REASON_LABEL: Record<string, string> = {
  reject: 'Собеседник отклонил звонок',
  busy: 'Собеседник сейчас на другом звонке',
  already_in_call: 'У вас уже есть активный звонок',
  unavailable: 'Собеседник не в сети',
  timeout: 'Нет ответа',
  no_answer: 'Нет ответа',
  hangup: 'Звонок завершён',
  failed: 'Связь потеряна',
  not_member: 'Не удалось начать звонок: собеседник не найден в этом чате',
  invalid: 'Не удалось начать звонок',
  dnd: 'Собеседник включил режим «Не беспокоить»',
  answered_elsewhere: 'Звонок принят на другом устройстве',
}

export type CallStatus = 'outgoing' | 'ringing' | 'incoming' | 'connected'
export type CallQuality = 'good' | 'fair' | 'poor'
export type CallDeviceKind = 'audioinput' | 'videoinput' | 'audiooutput'

export interface CallStats {
  quality: CallQuality
  rttMs: number | null
  packetLoss: number
  bitrateKbps: number
}

export interface CallState {
  callId: string
  chatId: number
  otherUser: User
  /** Отправляем ли мы видео (камера или экран). */
  video: boolean
  status: CallStatus
  muted: boolean
  cameraOff: boolean
  screenSharing: boolean
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  networkState: 'stable' | 'reconnecting'
  answeredAt: number | null
  minimized: boolean
  remote: RemoteCallState
}

const IDLE_REMOTE_STATE: RemoteCallState = { muted: false, cameraOff: false, video: false, screenSharing: false }

type WakeLockLike = { release: () => Promise<void> }
type WakeLockCapableNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> } }

function describeMediaError(err: unknown, video: boolean): string {
  if (!window.isSecureContext) {
    return 'Звонки работают только по HTTPS (или на localhost). Открой сайт по защищённому адресу.'
  }
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Доступ к камере/микрофону заблокирован в браузере. Открой настройки сайта (значок замка рядом с адресом) и разреши камеру и микрофон, затем попробуй снова.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return video ? 'Не найдена камера. Проверь, что устройство подключено.' : 'Не найден микрофон. Проверь, что устройство подключено.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Камера или микрофон уже используются другим приложением.'
  }
  if (name === 'OverconstrainedError') {
    return 'Выбранное устройство недоступно. Проверь выбор микрофона и камеры в настройках звонков.'
  }
  return 'Нет доступа к камере или микрофону'
}

function playTone(frequency: number, durationMs: number, volume = 0.06) {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass || frequency <= 0 || volume <= 0) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(volume, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + durationMs / 1000)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + durationMs / 1000)
    oscillator.addEventListener('ended', () => void context.close())
  } catch {
    // Автовоспроизведение может быть запрещено до первого клика — это не ошибка звонка.
  }
}

interface UseCallSessionOptions {
  getSocket: () => SocketApi | null
  getPreferences: () => AppPreferences
  updatePreferences: (patch: Partial<AppPreferences>) => void
  resolvePeer: (chatId: number, userId: number) => Promise<User | null>
}

export function useCallSession({ getSocket, getPreferences, updatePreferences, resolvePeer }: UseCallSessionOptions) {
  const [call, setCall] = useState<CallState | null>(null)
  const callRef = useRef<CallState | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const remoteDescSetRef = useRef(false)
  const incomingOfferRef = useRef<RTCSessionDescriptionInit | null>(null)
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ringLoopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleFlashRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const originalTitleRef = useRef<string>(document.title)
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS)
  const wakeLockRef = useRef<WakeLockLike | null>(null)
  const politeRef = useRef(false)
  const makingOfferRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const negotiationReadyRef = useRef(false)
  const statsPrevRef = useRef<{ bytes: number; at: number } | null>(null)

  callRef.current = call

  function applyCall(next: CallState | null) {
    callRef.current = next
    setCall(next)
  }

  function patchCall(callId: string, patch: Partial<CallState> | ((prev: CallState) => Partial<CallState>)) {
    setCall((prev) => {
      if (!prev || prev.callId !== callId) return prev
      const resolved = typeof patch === 'function' ? patch(prev) : patch
      if (Object.keys(resolved).length === 0) return prev
      const next = { ...prev, ...resolved }
      callRef.current = next
      return next
    })
  }

  /* ---------------------------------------------------------------- звуки */

  function stopRingLoop() {
    if (ringLoopRef.current) {
      clearInterval(ringLoopRef.current)
      ringLoopRef.current = null
    }
  }

  function ringVolume() {
    return Math.max(0, Math.min(100, getPreferences().callRingVolume)) / 100
  }

  function startRingLoop(kind: 'incoming' | 'outgoing') {
    stopRingLoop()
    const volume = ringVolume()
    if (volume === 0) return
    if (kind === 'incoming') {
      const style = getPreferences().callRingtoneStyle
      if (style === 'none') return
      const tone = () => playTone(CALL_RINGTONE_FREQUENCIES[style], 260, 0.07 * volume)
      tone()
      ringLoopRef.current = setInterval(tone, 1600)
    } else {
      const tone = () => playTone(420, 700, 0.05 * volume)
      tone()
      ringLoopRef.current = setInterval(tone, 2200)
    }
  }

  function playConnectedTone() {
    const volume = ringVolume()
    if (volume === 0) return
    playTone(680, 120, 0.05 * volume)
    setTimeout(() => playTone(880, 160, 0.05 * volume), 130)
  }

  function playEndedTone() {
    const volume = ringVolume()
    if (volume === 0) return
    playTone(420, 220, 0.045 * volume)
  }

  /* ------------------------------------------------- фон: заголовок, экран */

  function startTitleFlash(text: string) {
    if (titleFlashRef.current) return
    originalTitleRef.current = document.title
    let toggled = false
    titleFlashRef.current = setInterval(() => {
      toggled = !toggled
      document.title = toggled ? text : originalTitleRef.current
    }, 900)
  }

  function stopTitleFlash() {
    if (!titleFlashRef.current) return
    clearInterval(titleFlashRef.current)
    titleFlashRef.current = null
    document.title = originalTitleRef.current
  }

  async function acquireWakeLock() {
    const nav = navigator as WakeLockCapableNavigator
    if (!nav.wakeLock || wakeLockRef.current) return
    try {
      wakeLockRef.current = await nav.wakeLock.request('screen')
    } catch {
      // Wake Lock недоступен (фоновая вкладка, политика браузера) — звонок это не ломает.
    }
  }

  function releaseWakeLock() {
    void wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
  }

  function notifyIncoming(otherUser: User, video: boolean) {
    const name = otherUser.displayName?.trim() || otherUser.username
    startTitleFlash(video ? '📹 Входящий видеозвонок' : '📞 Входящий звонок')
    if (!document.hidden) return
    const preferences = getPreferences()
    if (!preferences.notifications || !('Notification' in window) || Notification.permission !== 'granted') return
    try {
      const notification = new Notification(video ? 'Входящий видеозвонок' : 'Входящий звонок', {
        body: name,
        tag: 'connecto-call',
        requireInteraction: true,
      })
      notification.addEventListener('click', () => {
        window.focus()
        notification.close()
      })
    } catch {
      // Уведомления могут быть заблокированы системой.
    }
  }

  /* ------------------------------------------------------ медиа и трансивер */

  function audioConstraints(): MediaTrackConstraints {
    const preferences = getPreferences()
    return {
      deviceId: preferences.preferredMicId ? { exact: preferences.preferredMicId } : undefined,
      echoCancellation: preferences.echoCancellation,
      noiseSuppression: preferences.noiseSuppression,
      autoGainControl: preferences.autoGainControl,
    }
  }

  function videoConstraints(): MediaTrackConstraints {
    const preferences = getPreferences()
    return {
      deviceId: preferences.preferredCameraId ? { exact: preferences.preferredCameraId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    }
  }

  async function requestMedia(video: boolean): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: video ? videoConstraints() : false })
    } catch (err) {
      // Сохранённое устройство могло исчезнуть — пробуем ещё раз с устройствами по умолчанию.
      if (err instanceof DOMException && err.name === 'OverconstrainedError') {
        return navigator.mediaDevices.getUserMedia({ audio: true, video })
      }
      throw err
    }
  }

  function videoTransceiver(): RTCRtpTransceiver | null {
    const pc = pcRef.current
    if (!pc) return null
    return pc.getTransceivers().find((t) => (t.sender.track?.kind ?? t.receiver.track?.kind) === 'video') ?? null
  }

  function sendLocalState(state?: Partial<RemoteCallState>) {
    const current = callRef.current
    if (!current) return
    getSocket()?.callState(current.callId, {
      muted: current.muted,
      cameraOff: current.cameraOff,
      video: current.video,
      screenSharing: current.screenSharing,
      ...state,
    })
  }

  /* --------------------------------------------------------- жизненный цикл */

  function teardownCall() {
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    cameraTrackRef.current = null
    remoteStreamRef.current = null
    pendingIceRef.current = []
    remoteDescSetRef.current = false
    incomingOfferRef.current = null
    negotiationReadyRef.current = false
    makingOfferRef.current = false
    ignoreOfferRef.current = false
    politeRef.current = false
    statsPrevRef.current = null
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current)
      ringTimeoutRef.current = null
    }
    if (reconnectWatchdogRef.current) {
      clearTimeout(reconnectWatchdogRef.current)
      reconnectWatchdogRef.current = null
    }
    stopRingLoop()
    stopTitleFlash()
    releaseWakeLock()
  }

  function endCall(reason: string, notifyRemote: boolean) {
    const current = callRef.current
    if (!current) return
    if (notifyRemote) getSocket()?.callEnd(current.callId, reason)
    const wasConnected = current.status === 'connected'
    teardownCall()
    applyCall(null)
    if (wasConnected) playEndedTone()
    if (LOCAL_END_REASON_LABEL[reason]) showToast(LOCAL_END_REASON_LABEL[reason])
  }

  function createPeerConnection(callId: string, polite: boolean) {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
    politeRef.current = polite
    remoteStreamRef.current = null

    pc.onicecandidate = (e) => {
      if (e.candidate) getSocket()?.callIce(callId, e.candidate.toJSON())
    }
    pc.ontrack = (e) => {
      // Каждую дорожку кладём в НОВЫЙ MediaStream: браузер не начинает
      // воспроизводить дорожку, добавленную в поток, который уже висит в srcObject.
      const known = remoteStreamRef.current?.getTracks() ?? []
      if (known.includes(e.track)) return
      const next = new MediaStream([...known, e.track])
      remoteStreamRef.current = next
      patchCall(callId, { remoteStream: next })
      e.track.addEventListener('ended', () => {
        const live = remoteStreamRef.current?.getTracks().filter((track) => track !== e.track) ?? []
        const updated = new MediaStream(live)
        remoteStreamRef.current = updated
        patchCall(callId, { remoteStream: updated })
      })
    }
    pc.onnegotiationneeded = async () => {
      if (!negotiationReadyRef.current || callRef.current?.callId !== callId) return
      try {
        makingOfferRef.current = true
        await pc.setLocalDescription()
        if (pc.localDescription) {
          getSocket()?.callNegotiate(callId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp })
        }
      } catch {
        // Повторные переговоры не критичны: текущие дорожки продолжают идти.
      } finally {
        makingOfferRef.current = false
      }
    }
    pc.onconnectionstatechange = () => {
      if (callRef.current?.callId !== callId) return
      const state = pc.connectionState
      if (state === 'connected') {
        handleConnectionRecovered(callId)
      } else if (state === 'disconnected' || state === 'failed') {
        handleConnectionTrouble(pc, callId)
      }
    }
    return pc
  }

  /** Медиапоток пошёл: отсюда начинается отсчёт разговора. */
  function handleConnectionRecovered(callId: string) {
    if (reconnectWatchdogRef.current) {
      clearTimeout(reconnectWatchdogRef.current)
      reconnectWatchdogRef.current = null
    }
    if (callRef.current?.callId === callId && callRef.current.answeredAt === null) playConnectedTone()
    patchCall(callId, (prev) => ({
      ...(prev.networkState === 'stable' ? {} : { networkState: 'stable' as const }),
      ...(prev.answeredAt === null ? { answeredAt: Date.now() } : {}),
    }))
  }

  function handleConnectionTrouble(pc: RTCPeerConnection, callId: string) {
    patchCall(callId, (prev) => (prev.networkState === 'reconnecting' ? {} : { networkState: 'reconnecting' }))
    // Перезапуск ICE инициирует только звонящий, иначе оба уйдут в гонку офферов.
    if (!politeRef.current && pc.connectionState === 'failed') {
      try {
        pc.restartIce()
      } catch {
        // Старые браузеры без restartIce просто дождутся вердикта watchdog.
      }
    }
    if (!reconnectWatchdogRef.current) {
      reconnectWatchdogRef.current = setTimeout(() => {
        reconnectWatchdogRef.current = null
        if (callRef.current?.callId === callId && pc.connectionState !== 'connected') endCall('failed', true)
      }, RECONNECT_GIVE_UP_MS)
    }
  }

  async function flushPendingIce() {
    const pc = pcRef.current
    if (!pc) return
    const pending = pendingIceRef.current
    pendingIceRef.current = []
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        // Поздние или уже неактуальные кандидаты можно игнорировать.
      }
    }
  }

  function markConnected(callId: string) {
    stopRingLoop()
    stopTitleFlash()
    void acquireWakeLock()
    patchCall(callId, (prev) => (prev.status === 'connected' ? {} : { status: 'connected' }))
    sendLocalState()
  }

  /* --------------------------------------------------------------- действия */

  async function loadIceServers() {
    try {
      const res = await api.getIceServers()
      if (Array.isArray(res.iceServers) && res.iceServers.length > 0) iceServersRef.current = res.iceServers
    } catch {
      // Останутся публичные STUN-серверы по умолчанию.
    }
  }

  async function startCall(chatId: number, otherUser: User, video: boolean) {
    if (callRef.current) {
      showToast('У вас уже есть активный звонок')
      return
    }
    let stream: MediaStream
    try {
      stream = await requestMedia(video)
    } catch (err) {
      showToast(describeMediaError(err, video))
      return
    }
    const cameraOff = video && getPreferences().startVideoCallsWithCameraOff
    const videoTrack = stream.getVideoTracks()[0] ?? null
    if (videoTrack) {
      cameraTrackRef.current = videoTrack
      videoTrack.enabled = !cameraOff
    }

    const callId = crypto.randomUUID()
    const pc = createPeerConnection(callId, false)
    pcRef.current = pc
    localStreamRef.current = stream
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream))
    // Видео-трансивер создаём всегда: тогда камеру и экран можно включить
    // прямо в аудиозвонке без повторных переговоров.
    const transceiver = pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] })
    if (videoTrack) await transceiver.sender.replaceTrack(videoTrack)

    applyCall({
      callId,
      chatId,
      otherUser,
      video,
      status: 'outgoing',
      muted: false,
      cameraOff,
      screenSharing: false,
      localStream: stream,
      remoteStream: null,
      networkState: 'stable',
      answeredAt: null,
      minimized: false,
      remote: IDLE_REMOTE_STATE,
    })
    startRingLoop('outgoing')

    try {
      await pc.setLocalDescription(await pc.createOffer())
      const sent = getSocket()?.callInvite(otherUser.id, chatId, callId, video, {
        type: pc.localDescription!.type,
        sdp: pc.localDescription!.sdp,
      })
      if (!sent) {
        endCall('invalid', false)
        showToast('Нет связи с сервером')
        return
      }
    } catch {
      endCall('failed', false)
      return
    }

    ringTimeoutRef.current = setTimeout(() => {
      if (callRef.current?.callId === callId && callRef.current.status !== 'connected') endCall('timeout', true)
    }, RING_TIMEOUT_MS)
  }

  async function handleIncomingInvite(event: Extract<SocketEvent, { type: 'call_invite' }>) {
    if (callRef.current) {
      getSocket()?.callEnd(event.callId, 'busy')
      return
    }
    if (getPreferences().doNotDisturbCalls) {
      getSocket()?.callEnd(event.callId, 'dnd')
      return
    }
    const otherUser = await resolvePeer(event.chatId, event.fromUserId)
    if (!otherUser) {
      getSocket()?.callEnd(event.callId, 'invalid')
      return
    }
    if (callRef.current) {
      getSocket()?.callEnd(event.callId, 'busy')
      return
    }

    incomingOfferRef.current = event.sdp
    applyCall({
      callId: event.callId,
      chatId: event.chatId,
      otherUser,
      video: event.video,
      status: 'incoming',
      muted: false,
      cameraOff: false,
      screenSharing: false,
      localStream: null,
      remoteStream: null,
      networkState: 'stable',
      answeredAt: null,
      minimized: false,
      remote: { ...IDLE_REMOTE_STATE, video: event.video },
    })

    // Соединение готовим заранее — к моменту «Принять» кандидаты уже собраны.
    try {
      const pc = createPeerConnection(event.callId, true)
      pcRef.current = pc
      await pc.setRemoteDescription(event.sdp)
      remoteDescSetRef.current = true
      await flushPendingIce()
    } catch {
      endCall('failed', true)
      return
    }

    startRingLoop('incoming')
    notifyIncoming(otherUser, event.video)
    getSocket()?.callRinging(event.callId)
  }

  async function acceptCall() {
    const current = callRef.current
    const pc = pcRef.current
    if (!current || current.status !== 'incoming' || !pc) return

    let stream: MediaStream
    try {
      stream = await requestMedia(current.video)
    } catch (err) {
      showToast(describeMediaError(err, current.video))
      endCall('failed', true)
      return
    }
    if (callRef.current?.callId !== current.callId) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    const cameraOff = current.video && getPreferences().startVideoCallsWithCameraOff
    const videoTrack = stream.getVideoTracks()[0] ?? null
    if (videoTrack) {
      cameraTrackRef.current = videoTrack
      videoTrack.enabled = !cameraOff
    }
    localStreamRef.current = stream
    stopRingLoop()
    stopTitleFlash()

    try {
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream))
      const transceiver = videoTransceiver()
      if (videoTrack && transceiver) {
        await transceiver.sender.replaceTrack(videoTrack)
        transceiver.direction = 'sendrecv'
      } else if (videoTrack) {
        pc.addTrack(videoTrack, stream)
      }
      await pc.setLocalDescription(await pc.createAnswer())
      getSocket()?.callAnswer(current.callId, { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp })
    } catch {
      showToast('Не удалось установить соединение')
      endCall('failed', true)
      return
    }

    negotiationReadyRef.current = true
    patchCall(current.callId, { localStream: stream, cameraOff, status: 'connected' })
    void acquireWakeLock()
    sendLocalState({ cameraOff, video: current.video })
  }

  function rejectCall() {
    endCall('reject', true)
  }

  function hangUp() {
    endCall('hangup', true)
  }

  function toggleMute() {
    const current = callRef.current
    if (!current) return
    const muted = !current.muted
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
    patchCall(current.callId, { muted })
    sendLocalState({ muted })
  }

  /** Включает камеру в аудиозвонке или переключает её состояние в видеозвонке. */
  async function toggleCamera() {
    const current = callRef.current
    const pc = pcRef.current
    if (!current || !pc || current.status !== 'connected') return
    if (current.screenSharing) {
      showToast('Сначала остановите демонстрацию экрана')
      return
    }

    if (!current.video) {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() })
      } catch (err) {
        showToast(describeMediaError(err, true))
        return
      }
      const track = stream.getVideoTracks()[0]
      if (!track || callRef.current?.callId !== current.callId) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      cameraTrackRef.current = track
      localStreamRef.current?.addTrack(track)
      const transceiver = videoTransceiver()
      if (transceiver) {
        await transceiver.sender.replaceTrack(track)
        transceiver.direction = 'sendrecv'
      } else if (localStreamRef.current) {
        pc.addTrack(track, localStreamRef.current)
      }
      patchCall(current.callId, { video: true, cameraOff: false, localStream: localStreamRef.current })
      sendLocalState({ video: true, cameraOff: false })
      return
    }

    const cameraOff = !current.cameraOff
    const track = cameraTrackRef.current
    if (track) track.enabled = !cameraOff
    patchCall(current.callId, { cameraOff })
    sendLocalState({ cameraOff })
  }

  function stopScreenShare() {
    const current = callRef.current
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    if (!current) return
    const transceiver = videoTransceiver()
    const camera = cameraTrackRef.current
    if (transceiver) {
      void transceiver.sender.replaceTrack(camera && camera.readyState === 'live' ? camera : null).catch(() => {})
      if (!camera || camera.readyState !== 'live') transceiver.direction = 'recvonly'
    }
    const stillVideo = Boolean(camera && camera.readyState === 'live')
    patchCall(current.callId, { screenSharing: false, video: stillVideo })
    sendLocalState({ screenSharing: false, video: stillVideo })
  }

  async function toggleScreenShare() {
    const current = callRef.current
    if (!current || current.status !== 'connected') return
    if (current.screenSharing) {
      stopScreenShare()
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('Демонстрация экрана не поддерживается этим браузером')
      return
    }
    let screenStream: MediaStream
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    } catch {
      return
    }
    const screenTrack = screenStream.getVideoTracks()[0]
    const transceiver = videoTransceiver()
    if (!screenTrack || !transceiver || callRef.current?.callId !== current.callId) {
      screenStream.getTracks().forEach((track) => track.stop())
      return
    }
    try {
      await transceiver.sender.replaceTrack(screenTrack)
      transceiver.direction = 'sendrecv'
    } catch {
      screenStream.getTracks().forEach((track) => track.stop())
      showToast('Не удалось начать демонстрацию экрана')
      return
    }
    screenStreamRef.current = screenStream
    screenTrack.addEventListener('ended', () => {
      if (callRef.current?.callId === current.callId && callRef.current.screenSharing) stopScreenShare()
    })
    patchCall(current.callId, { screenSharing: true, video: true })
    sendLocalState({ screenSharing: true, video: true })
  }

  /** Смена микрофона/камеры на лету: дорожка подменяется без разрыва соединения. */
  async function switchDevice(kind: CallDeviceKind, deviceId: string) {
    if (kind === 'audiooutput') {
      updatePreferences({ preferredSpeakerId: deviceId })
      return
    }
    const current = callRef.current
    if (kind === 'audioinput') {
      updatePreferences({ preferredMicId: deviceId })
      if (!current) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...audioConstraints(), deviceId: deviceId ? { exact: deviceId } : undefined },
        })
        const track = stream.getAudioTracks()[0]
        if (!track) return
        track.enabled = !current.muted
        const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'audio')
        await sender?.replaceTrack(track)
        localStreamRef.current?.getAudioTracks().forEach((old) => {
          localStreamRef.current?.removeTrack(old)
          old.stop()
        })
        localStreamRef.current?.addTrack(track)
        patchCall(current.callId, { localStream: localStreamRef.current })
      } catch (err) {
        showToast(describeMediaError(err, false))
      }
      return
    }

    updatePreferences({ preferredCameraId: deviceId })
    if (!current || !current.video || current.screenSharing) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...videoConstraints(), deviceId: deviceId ? { exact: deviceId } : undefined },
      })
      const track = stream.getVideoTracks()[0]
      if (!track) return
      track.enabled = !current.cameraOff
      const transceiver = videoTransceiver()
      await transceiver?.sender.replaceTrack(track)
      localStreamRef.current?.getVideoTracks().forEach((old) => {
        localStreamRef.current?.removeTrack(old)
        old.stop()
      })
      localStreamRef.current?.addTrack(track)
      cameraTrackRef.current = track
      patchCall(current.callId, { localStream: localStreamRef.current })
    } catch (err) {
      showToast(describeMediaError(err, true))
    }
  }

  function setMinimized(minimized: boolean) {
    const current = callRef.current
    if (!current) return
    patchCall(current.callId, { minimized })
  }

  /** Свежая статистика соединения для индикатора качества. */
  async function getCallStats(): Promise<CallStats | null> {
    const pc = pcRef.current
    if (!pc || callRef.current?.status !== 'connected') return null
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      return null
    }
    let rtt: number | null = null
    let lost = 0
    let received = 0
    let bytes = 0
    report.forEach((entry) => {
      const stat = entry as Record<string, number | string | boolean>
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && typeof stat.currentRoundTripTime === 'number') {
        rtt = rtt === null ? stat.currentRoundTripTime : Math.min(rtt, stat.currentRoundTripTime)
      }
      if (stat.type === 'inbound-rtp') {
        lost += typeof stat.packetsLost === 'number' ? stat.packetsLost : 0
        received += typeof stat.packetsReceived === 'number' ? stat.packetsReceived : 0
        bytes += typeof stat.bytesReceived === 'number' ? stat.bytesReceived : 0
      }
    })

    const now = Date.now()
    const prev = statsPrevRef.current
    statsPrevRef.current = { bytes, at: now }
    const bitrateKbps = prev && now > prev.at ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.at))) : 0
    const packetLoss = received + lost > 0 ? lost / (received + lost) : 0
    const rttMs = rtt === null ? null : Math.round(rtt * 1000)
    const quality: CallQuality =
      packetLoss > 0.08 || (rttMs !== null && rttMs > 500)
        ? 'poor'
        : packetLoss > 0.03 || (rttMs !== null && rttMs > 250)
          ? 'fair'
          : 'good'
    return { quality, rttMs, packetLoss, bitrateKbps }
  }

  /* ----------------------------------------------------------- события сети */

  async function handleEvent(event: SocketEvent) {
    const current = callRef.current
    switch (event.type) {
      case 'call_invite':
        await handleIncomingInvite(event)
        return

      case 'call_ringing':
        if (current?.callId === event.callId && current.status === 'outgoing') {
          patchCall(event.callId, { status: 'ringing' })
        }
        return

      case 'call_answer': {
        const pc = pcRef.current
        if (!pc || current?.callId !== event.callId) return
        try {
          await pc.setRemoteDescription(event.sdp)
          remoteDescSetRef.current = true
          negotiationReadyRef.current = true
          await flushPendingIce()
          markConnected(event.callId)
        } catch {
          endCall('failed', true)
        }
        return
      }

      case 'call_negotiate': {
        const pc = pcRef.current
        if (!pc || current?.callId !== event.callId) return
        const collision = event.sdp.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable')
        ignoreOfferRef.current = !politeRef.current && collision
        if (ignoreOfferRef.current) return
        try {
          await pc.setRemoteDescription(event.sdp)
          if (event.sdp.type === 'offer') {
            await pc.setLocalDescription()
            if (pc.localDescription) {
              getSocket()?.callNegotiate(event.callId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp })
            }
          }
        } catch {
          // Провалившиеся переговоры не рвут звонок: остаются прежние дорожки.
        }
        return
      }

      case 'call_ice':
        if (current?.callId !== event.callId) return
        if (remoteDescSetRef.current && pcRef.current) {
          // Кандидаты отвергнутого оффера ожидаемо не применяются — это не ошибка.
          pcRef.current.addIceCandidate(event.candidate).catch(() => {})
        } else {
          pendingIceRef.current.push(event.candidate)
        }
        return

      case 'call_state':
        if (current?.callId !== event.callId) return
        patchCall(event.callId, { remote: event.state })
        return

      case 'call_end': {
        if (current?.callId !== event.callId) return
        const wasConnected = current.status === 'connected'
        teardownCall()
        applyCall(null)
        if (wasConnected) playEndedTone()
        showToast(CALL_END_REASON_LABEL[event.reason] ?? 'Звонок завершён')
        return
      }

      default:
        return
    }
  }

  /** Собеседник ушёл из сети — держать звонок дальше нечего. */
  function handlePeerOffline(userId: number) {
    if (callRef.current?.otherUser.id === userId) endCall('unavailable', false)
  }

  /** Полный сброс при разлогине или пересоздании сокета. */
  function reset() {
    if (!callRef.current) return
    teardownCall()
    applyCall(null)
  }

  return {
    call,
    loadIceServers,
    handleEvent,
    handlePeerOffline,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    switchDevice,
    setMinimized,
    getCallStats,
    reset,
  }
}
