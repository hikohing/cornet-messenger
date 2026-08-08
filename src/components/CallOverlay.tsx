import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CallDeviceKind, CallState, CallStats } from '../hooks/useCallSession'
import type { AppPreferences } from '../hooks/usePreferences'
import { formatCallDuration } from '../utils/calls'
import { AvatarImage } from './AvatarImage'
import {
  ExpandIcon,
  HangupIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  PhoneIcon,
  PipIcon,
  ScreenShareIcon,
  SettingsIcon,
  SignalIcon,
  SpeakerIcon,
  VideoIcon,
  VideoOffIcon,
} from './icons'

interface CallOverlayProps {
  call: CallState
  preferences: AppPreferences
  onAccept: () => void
  onReject: () => void
  onHangUp: () => void
  onToggleMute: () => void
  onToggleCamera: () => void
  onToggleScreenShare: () => void
  onSelectDevice: (kind: CallDeviceKind, deviceId: string) => void
  onMinimize: (minimized: boolean) => void
  getStats: () => Promise<CallStats | null>
}

type MediaElementWithSink = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> }

const QUALITY_LABEL: Record<string, string> = {
  good: 'Отличная связь',
  fair: 'Связь неустойчива',
  poor: 'Плохая связь',
}

/** Секунды разговора: отсчёт идёт от момента, когда реально пошёл медиапоток. */
function useCallDuration(answeredAt: number | null) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (answeredAt === null) {
      setSeconds(0)
      return
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - answeredAt) / 1000)))
    tick()
    const interval = setInterval(tick, 500)
    return () => clearInterval(interval)
  }, [answeredAt])
  return seconds
}

/** Огрублённый уровень громкости (0–4): индикатор речи без перерисовки на каждый кадр. */
function useAudioLevel(stream: MediaStream | null, active: boolean) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!stream || !active || stream.getAudioTracks().length === 0) {
      setLevel(0)
      return
    }
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    let context: AudioContext
    try {
      context = new AudioContextClass()
    } catch {
      return
    }
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let frame = 0
    let last = 0

    const measure = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (const value of data) sum += value * value
      const rms = Math.sqrt(sum / data.length) / 255
      const next = Math.min(4, Math.round(rms * 14))
      if (next !== last) {
        last = next
        setLevel(next)
      }
      frame = requestAnimationFrame(measure)
    }
    frame = requestAnimationFrame(measure)

    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
      analyser.disconnect()
      void context.close().catch(() => {})
      setLevel(0)
    }
  }, [stream, active])
  return level
}

/** Идёт ли по дорожке реальное видео: пока собеседник не включил камеру, она muted. */
function useVideoLive(stream: MediaStream | null) {
  const [live, setLive] = useState(false)
  useEffect(() => {
    const track = stream?.getVideoTracks()[0]
    if (!track) {
      setLive(false)
      return
    }
    const update = () => setLive(!track.muted && track.readyState === 'live')
    update()
    track.addEventListener('mute', update)
    track.addEventListener('unmute', update)
    track.addEventListener('ended', update)
    return () => {
      track.removeEventListener('mute', update)
      track.removeEventListener('unmute', update)
      track.removeEventListener('ended', update)
    }
  }, [stream])
  return live
}

function useCallStats(getStats: () => Promise<CallStats | null>, active: boolean) {
  const [stats, setStats] = useState<CallStats | null>(null)
  useEffect(() => {
    if (!active) {
      setStats(null)
      return
    }
    let cancelled = false
    const poll = () => {
      void getStats().then((next) => {
        if (!cancelled) setStats(next)
      })
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return stats
}

function useMediaDevices(enabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.enumerateDevices) return
    let cancelled = false
    const refresh = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) setDevices(list)
        })
        .catch(() => {})
    }
    refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh)
    }
  }, [enabled])
  return devices
}

export function CallOverlay({
  call,
  preferences,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onSelectDevice,
  onMinimize,
  getStats,
}: CallOverlayProps) {
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const localStreamRef = useRef<MediaStream | null>(call.localStream)
  const speakerIdRef = useRef(preferences.preferredSpeakerId)
  const [needsSoundGesture, setNeedsSoundGesture] = useState(false)
  const [devicesOpen, setDevicesOpen] = useState(false)

  localStreamRef.current = call.localStream
  speakerIdRef.current = preferences.preferredSpeakerId

  // Звук и картинка идут в разные элементы: тогда воспроизведение голоса
  // не зависит ни от видео, ни от того, свёрнут звонок или развёрнут.
  const audioTrackIds = call.remoteStream?.getAudioTracks().map((t) => t.id).join(',') ?? ''
  const videoTrackIds = call.remoteStream?.getVideoTracks().map((t) => t.id).join(',') ?? ''
  const remoteStream = call.remoteStream
  const remoteAudioStream = useMemo(
    () => (audioTrackIds && remoteStream ? new MediaStream(remoteStream.getAudioTracks()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioTrackIds],
  )
  const remoteVideoStream = useMemo(
    () => (videoTrackIds && remoteStream ? new MediaStream(remoteStream.getVideoTracks()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoTrackIds],
  )
  const remoteAudioStreamRef = useRef<MediaStream | null>(remoteAudioStream)
  const remoteVideoStreamRef = useRef<MediaStream | null>(remoteVideoStream)
  remoteAudioStreamRef.current = remoteAudioStream
  remoteVideoStreamRef.current = remoteVideoStream

  const connected = call.status === 'connected'
  const minimized = call.minimized && call.status !== 'incoming'
  const seconds = useCallDuration(call.answeredAt)
  const stats = useCallStats(getStats, connected)
  const devices = useMediaDevices(devicesOpen)
  const remoteLevel = useAudioLevel(remoteAudioStream, connected && !call.remote.muted)
  const localLevel = useAudioLevel(call.localStream, connected && !call.muted)
  const remoteVideoLive = useVideoLive(remoteVideoStream)

  // Картинку показываем, когда кадры реально идут: не полагаемся на единственное
  // сообщение о состоянии собеседника, которое могло потеряться.
  const remoteHasVideo = remoteVideoLive && !call.remote.cameraOff
  const localHasVideo = call.video && !call.cameraOff
  const name = call.otherUser.displayName?.trim() || call.otherUser.username

  const playAudio = useCallback((el: HTMLAudioElement) => {
    el.play()
      .then(() => setNeedsSoundGesture(false))
      .catch(() => setNeedsSoundGesture(true))
  }, [])

  const applySink = useCallback((el: HTMLMediaElement) => {
    const sinkCapable = el as MediaElementWithSink
    if (sinkCapable.setSinkId && speakerIdRef.current) sinkCapable.setSinkId(speakerIdRef.current).catch(() => {})
  }, [])

  /** Ref-колбэки, а не эффекты: элементы переезжают между свёрнутым и полным видом. */
  const attachRemoteAudio = useCallback(
    (el: HTMLAudioElement | null) => {
      remoteAudioRef.current = el
      if (!el) return
      if (el.srcObject !== remoteAudioStreamRef.current) el.srcObject = remoteAudioStreamRef.current
      applySink(el)
      if (remoteAudioStreamRef.current) playAudio(el)
    },
    [applySink, playAudio],
  )

  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el
    if (!el) return
    if (el.srcObject !== remoteVideoStreamRef.current) el.srcObject = remoteVideoStreamRef.current
    el.play().catch(() => {})
  }, [])

  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el
    if (el && el.srcObject !== localStreamRef.current) el.srcObject = localStreamRef.current
  }, [])

  useEffect(() => {
    const el = remoteAudioRef.current
    if (!el || el.srcObject === remoteAudioStream) return
    el.srcObject = remoteAudioStream
    applySink(el)
    if (remoteAudioStream) playAudio(el)
  }, [remoteAudioStream, applySink, playAudio])

  // Дорожку выдают ещё до того, как по ней пошёл звук: когда пошёл — запускаем воспроизведение ещё раз.
  useEffect(() => {
    const track = remoteAudioStream?.getAudioTracks()[0]
    if (!track) return
    const retry = () => {
      const el = remoteAudioRef.current
      if (el) playAudio(el)
    }
    if (!track.muted) retry()
    track.addEventListener('unmute', retry)
    return () => track.removeEventListener('unmute', retry)
  }, [remoteAudioStream, playAudio])

  useEffect(() => {
    const el = remoteVideoRef.current
    if (!el || el.srcObject === remoteVideoStream) return
    el.srcObject = remoteVideoStream
    if (remoteVideoStream) el.play().catch(() => {})
  }, [remoteVideoStream])

  useEffect(() => {
    const el = localVideoRef.current
    if (el && el.srcObject !== call.localStream) el.srcObject = call.localStream
  }, [call.localStream])

  // Выбранный динамик применяется там, где браузер поддерживает setSinkId.
  useEffect(() => {
    const el = remoteAudioRef.current as MediaElementWithSink | null
    if (!el?.setSinkId) return
    el.setSinkId(preferences.preferredSpeakerId || '').catch(() => {})
  }, [preferences.preferredSpeakerId])

  useEffect(() => {
    if (call.status === 'incoming') return
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'm' || key === 'ь') {
        e.preventDefault()
        onToggleMute()
      } else if (key === 'v' || key === 'м') {
        e.preventDefault()
        void onToggleCamera()
      } else if (key === 'escape') {
        e.preventDefault()
        onMinimize(!minimized)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [call.status, minimized, onMinimize, onToggleCamera, onToggleMute])

  const reconnecting = connected && call.networkState === 'reconnecting'
  const statusLabel =
    call.status === 'incoming'
      ? call.video
        ? 'Входящий видеозвонок'
        : 'Входящий звонок'
      : call.status === 'outgoing'
        ? 'Соединение…'
        : call.status === 'ringing'
          ? 'Звоним…'
          : reconnecting
            ? 'Восстановление соединения…'
            : call.answeredAt === null
              ? 'Соединение…'
              : formatCallDuration(seconds)

  const remoteNotes: string[] = []
  if (connected) {
    if (call.remote.screenSharing) remoteNotes.push('Показывает экран')
    else if (call.remote.video && call.remote.cameraOff) remoteNotes.push('Камера выключена')
    if (call.remote.muted) remoteNotes.push('Микрофон выключен')
  }

  async function togglePictureInPicture() {
    const el = remoteVideoRef.current
    if (!el) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await el.requestPictureInPicture()
    } catch {
      // Браузер может запретить PiP — интерфейс просто останется как есть.
    }
  }

  function renderDeviceGroup(label: string, kind: CallDeviceKind, deviceKind: MediaDeviceKind, selected: string) {
    // Устройства с пустым id — заглушки браузера, выбрать их нельзя.
    const options = devices.filter((d) => d.kind === deviceKind && d.deviceId)
    return (
      <div className="call-devices__group">
        <span className="call-devices__label">{label}</span>
        {options.length === 0 ? (
          <span className="call-devices__empty">Устройства не найдены</span>
        ) : (
          options.map((device) => (
            <button
              key={device.deviceId}
              className={`call-devices__item${selected === device.deviceId || (!selected && device.deviceId === 'default') ? ' is-active' : ''}`}
              onClick={() => {
                onSelectDevice(kind, device.deviceId)
                setDevicesOpen(false)
              }}
            >
              {device.label || 'Устройство без названия'}
            </button>
          ))
        )}
      </div>
    )
  }

  const avatar = (
    <span className="call-surface__avatar" style={{ background: call.otherUser.color }}>
      <AvatarImage url={call.otherUser.avatarUrl} fallback={name.charAt(0).toUpperCase()} />
    </span>
  )

  return (
    <div
      className={[
        'call-surface',
        minimized ? 'call-surface--mini' : 'call-surface--full',
        remoteHasVideo ? 'has-remote-video' : '',
        reconnecting ? 'is-reconnecting' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Голос собеседника: отдельный элемент, смонтирован всегда и в обоих режимах. */}
      <audio ref={attachRemoteAudio} autoPlay />
      <video ref={attachRemoteVideo} className="call-surface__remote-video" autoPlay playsInline muted />
      <video ref={attachLocal} className={`call-surface__local-video${localHasVideo ? '' : ' is-hidden'}`} autoPlay playsInline muted />

      {/* Браузер мог заблокировать автозапуск звука — даём явную кнопку в обоих режимах. */}
      {needsSoundGesture && (
        <button
          className="call-overlay__sound-unlock"
          onClick={() => remoteAudioRef.current && playAudio(remoteAudioRef.current)}
        >
          <SpeakerIcon width={16} height={16} /> Включить звук
        </button>
      )}

      {minimized ? (
        <>
          <button className="call-mini__body" onClick={() => onMinimize(false)} title="Развернуть звонок">
            {!remoteHasVideo && <span className={`call-mini__avatar${remoteLevel > 1 ? ' is-speaking' : ''}`}>{avatar}</span>}
            <span className="call-mini__text">
              <strong>{name}</strong>
              <small>{statusLabel}</small>
            </span>
          </button>
          <div className="call-mini__actions">
            <button
              className={`call-mini__btn${call.muted ? ' is-off' : ''}`}
              onClick={onToggleMute}
              title={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}
            >
              {call.muted ? <MicOffIcon width={16} height={16} /> : <MicIcon width={16} height={16} />}
            </button>
            <button className="call-mini__btn" onClick={() => onMinimize(false)} title="Развернуть звонок">
              <ExpandIcon width={16} height={16} />
            </button>
            <button className="call-mini__btn call-mini__btn--hangup" onClick={onHangUp} title="Завершить звонок">
              <HangupIcon width={16} height={16} />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="call-overlay__top">
            <div className="call-overlay__top-info">
              <strong>{name}</strong>
              <span className={reconnecting ? 'call-overlay__status--reconnecting' : undefined}>{statusLabel}</span>
            </div>
            <div className="call-overlay__top-actions">
              {connected && stats && (
                <span
                  className={`call-quality call-quality--${stats.quality}`}
                  title={`${QUALITY_LABEL[stats.quality]}${stats.rttMs !== null ? ` · задержка ${stats.rttMs} мс` : ''} · потери ${(stats.packetLoss * 100).toFixed(1)}% · ${stats.bitrateKbps} кбит/с`}
                >
                  <SignalIcon width={15} height={15} />
                </span>
              )}
              {call.status !== 'incoming' && (
                <button className="call-overlay__chip" onClick={() => onMinimize(true)} title="Свернуть звонок (Esc)">
                  <MinimizeIcon width={16} height={16} />
                </button>
              )}
            </div>
          </div>

          {!remoteHasVideo && (
            <div className="call-overlay__identity">
              <div
                className={[
                  'call-overlay__avatar-ring',
                  call.status === 'incoming' || call.status === 'ringing' ? 'is-ringing' : '',
                  remoteLevel > 1 ? 'is-speaking' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {avatar}
              </div>
              <h2>{name}</h2>
              <p className={reconnecting ? 'call-overlay__status--reconnecting' : undefined}>{statusLabel}</p>
            </div>
          )}

          {remoteNotes.length > 0 && (
            <div className="call-overlay__remote-notes">
              {remoteNotes.map((note) => (
                <span key={note}>{note}</span>
              ))}
            </div>
          )}

          {devicesOpen && (
            <div className="call-devices">
              {renderDeviceGroup('Микрофон', 'audioinput', 'audioinput', preferences.preferredMicId)}
              {renderDeviceGroup('Камера', 'videoinput', 'videoinput', preferences.preferredCameraId)}
              {renderDeviceGroup('Динамики', 'audiooutput', 'audiooutput', preferences.preferredSpeakerId)}
            </div>
          )}

          <div className="call-overlay__controls">
            {call.status === 'incoming' ? (
              <>
                <button className="call-overlay__btn call-overlay__btn--reject" onClick={onReject} title="Отклонить">
                  <HangupIcon width={24} height={24} />
                </button>
                <button className="call-overlay__btn call-overlay__btn--accept" onClick={onAccept} title="Принять">
                  <PhoneIcon width={22} height={22} />
                </button>
              </>
            ) : (
              <>
                <button
                  className={`call-overlay__btn call-overlay__btn--toggle${call.muted ? ' is-off' : ''}${localLevel > 1 ? ' is-speaking' : ''}`}
                  onClick={onToggleMute}
                  title={call.muted ? 'Включить микрофон (M)' : 'Выключить микрофон (M)'}
                >
                  {call.muted ? <MicOffIcon width={20} height={20} /> : <MicIcon width={20} height={20} />}
                </button>
                <button
                  className={`call-overlay__btn call-overlay__btn--toggle${call.video && call.cameraOff ? ' is-off' : ''}`}
                  onClick={onToggleCamera}
                  title={call.video && !call.cameraOff ? 'Выключить камеру (V)' : 'Включить камеру (V)'}
                  disabled={!connected || call.screenSharing}
                >
                  {call.video && !call.cameraOff ? <VideoIcon width={20} height={20} /> : <VideoOffIcon width={20} height={20} />}
                </button>
                <button
                  className={`call-overlay__btn call-overlay__btn--toggle${call.screenSharing ? ' is-active' : ''}`}
                  onClick={onToggleScreenShare}
                  title={call.screenSharing ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
                  disabled={!connected}
                >
                  <ScreenShareIcon width={20} height={20} />
                </button>
                {remoteHasVideo && document.pictureInPictureEnabled && (
                  <button className="call-overlay__btn call-overlay__btn--toggle" onClick={togglePictureInPicture} title="Картинка в картинке">
                    <PipIcon width={20} height={20} />
                  </button>
                )}
                <button
                  className={`call-overlay__btn call-overlay__btn--toggle${devicesOpen ? ' is-active' : ''}`}
                  onClick={() => setDevicesOpen((v) => !v)}
                  title="Микрофон, камера, динамики"
                >
                  <SettingsIcon width={20} height={20} />
                </button>
                <button className="call-overlay__btn call-overlay__btn--reject" onClick={onHangUp} title="Завершить звонок">
                  <HangupIcon width={24} height={24} />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
