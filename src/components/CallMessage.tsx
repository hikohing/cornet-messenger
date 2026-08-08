import type { Message } from '../types'
import { callMessageSummary, formatCallDuration } from '../utils/calls'
import { PhoneIcon, VideoIcon } from './icons'

interface CallMessageProps {
  message: Message
  isOwn: boolean
  onCallBack?: (video: boolean) => void
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Запись о звонке в ленте сообщений: итог, длительность и быстрый перезвон. */
export function CallMessage({ message, isOwn, onCallBack }: CallMessageProps) {
  const meta = message.callMeta ?? null
  const video = Boolean(meta?.video)
  const unanswered = meta?.outcome === 'missed' || meta?.outcome === 'cancelled' || meta?.outcome === 'failed'
  const alarming = !isOwn && meta?.outcome === 'missed'
  const summary = callMessageSummary(meta, isOwn)
  const details: string[] = []
  if (meta?.outcome === 'answered' && meta.duration > 0) details.push(formatCallDuration(meta.duration))
  if (meta?.interrupted) details.push('связь прервалась')

  return (
    <div className={`call-record${alarming ? ' call-record--missed' : ''}`}>
      <span className={`call-record__icon${unanswered ? ' is-muted' : ''}`}>
        {video ? <VideoIcon width={15} height={15} /> : <PhoneIcon width={15} height={15} />}
      </span>
      <span className="call-record__text">
        {summary}
        {details.length > 0 && <small>{details.join(' · ')}</small>}
      </span>
      <span className="call-record__time">{formatTime(message.createdAt)}</span>
      {onCallBack && (
        <button className="call-record__action" onClick={() => onCallBack(video)} title="Перезвонить">
          {video ? <VideoIcon width={15} height={15} /> : <PhoneIcon width={15} height={15} />}
        </button>
      )}
    </div>
  )
}
