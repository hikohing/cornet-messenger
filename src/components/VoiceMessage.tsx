import { useEffect, useMemo, useRef, useState } from 'react'

interface VoiceMessageProps {
  /** Готовая ссылка: обычная для открытых вложений, blob: для расшифрованных. */
  src: string
  duration?: number
  messageId: number
  label?: string
}

const PLAYBACK_RATES = [1, 1.5, 2]
const WAVEFORM_BARS = 34

function formatDuration(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.8 3.8v16.4L19.7 12 6.8 3.8Z" fill="currentColor" /></svg>
}

function PauseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" fill="currentColor" /></svg>
}

export function VoiceMessage({ src, duration: suppliedDuration = 0, messageId, label = 'Голосовое' }: VoiceMessageProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(suppliedDuration)
  const [playbackRate, setPlaybackRate] = useState(1)
  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0
  const bars = useMemo(() => {
    let seed = Math.abs(messageId) || 1
    return Array.from({ length: WAVEFORM_BARS }, (_, index) => {
      seed = (seed * 9301 + 49297 + index * 31) % 233280
      return 7 + Math.round((seed / 233280) * 18)
    })
  }, [messageId])

  useEffect(() => {
    const audio = audioRef.current
    return () => {
      audio?.pause()
    }
  }, [])

  function togglePlayback() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      void audio.play().catch(() => setPlaying(false))
    } else {
      audio.pause()
    }
  }

  function seek(value: number) {
    const audio = audioRef.current
    if (!audio || !duration) return
    audio.currentTime = value
    setCurrentTime(value)
  }

  function cyclePlaybackRate() {
    const nextIndex = (PLAYBACK_RATES.indexOf(playbackRate) + 1) % PLAYBACK_RATES.length
    const nextRate = PLAYBACK_RATES[nextIndex]
    setPlaybackRate(nextRate)
    if (audioRef.current) audioRef.current.playbackRate = nextRate
  }

  return (
    <div className="voice-message">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration)
          event.currentTarget.playbackRate = playbackRate
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrentTime(0)
        }}
      />
      <button
        type="button"
        className={`voice-message__play${playing ? ' is-playing' : ''}`}
        onClick={togglePlayback}
        aria-label={playing ? `Поставить на паузу: ${label}` : `Воспроизвести: ${label}`}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="voice-message__body">
        <div className="voice-message__waveform" aria-hidden="true">
          {bars.map((height, index) => (
            <span
              key={index}
              className={index / WAVEFORM_BARS <= progress ? 'is-played' : ''}
              style={{ height }}
            />
          ))}
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Перемотка голосового сообщения"
          />
        </div>
        <div className="voice-message__meta">
          <span>{formatDuration(currentTime || duration)}</span>
        </div>
      </div>
      <button type="button" className="voice-message__speed" onClick={cyclePlaybackRate} aria-label="Изменить скорость воспроизведения">
        {playbackRate}×
      </button>
    </div>
  )
}
