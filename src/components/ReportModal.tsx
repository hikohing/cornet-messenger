import { useEffect, useState } from 'react'
import { getReportReasons, submitReport, type ReportReason } from '../api/client'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { showToast } from '../hooks/useToast'
import { AlertIcon, CloseIcon, SpinnerIcon } from './icons'

/**
 * Жалоба на сообщение или на пользователя. Требование App Store к приложениям
 * с пользовательским контентом (Guideline 1.2).
 *
 * Причины берём с сервера, а не дублируем список на клиенте: их же он потом
 * и разбирает.
 */
interface ReportModalProps {
  /** Кого показываем в заголовке — имя автора сообщения или пользователя. */
  targetName: string
  /** Жалоба на конкретное сообщение; без него — жалоба на пользователя целиком. */
  messageId?: number
  targetUserId?: number
  /**
   * Расшифрованный текст сообщения, снятый здесь, на устройстве. В зашифрованных
   * чатах у сервера есть только шифротекст, и без этой копии рассматривать
   * жалобу было бы не по чему.
   */
  excerpt?: string
  onClose: () => void
}

export function ReportModal({ targetName, messageId, targetUserId, excerpt, onClose }: ReportModalProps) {
  useEscapeToClose(onClose)
  const [reasons, setReasons] = useState<ReportReason[] | null>(null)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [includeExcerpt, setIncludeExcerpt] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getReportReasons()
      .then((res) => active && setReasons(res.reasons))
      .catch(() => active && setReasons([]))
    return () => {
      active = false
    }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!reason) return
    setError(null)
    setSending(true)
    try {
      await submitReport({
        reason,
        comment: comment.trim() || undefined,
        messageId,
        targetUserId,
        excerpt: includeExcerpt ? excerpt : undefined,
      })
      showToast('Жалоба отправлена — мы её рассмотрим')
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{messageId ? 'Пожаловаться на сообщение' : 'Пожаловаться на пользователя'}</h2>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon width={17} height={17} />
          </button>
        </div>

        <form className="report-form" onSubmit={handleSubmit}>
          <p className="field-hint">
            Жалоба на <strong className="notranslate" translate="no">{targetName}</strong>. Её увидит оператор
            сервиса — автор о ней не узнает.
          </p>

          {reasons === null ? (
            <p className="field-hint"><SpinnerIcon width={13} height={13} /> Загрузка…</p>
          ) : (
            <div className="report-reasons">
              {reasons.map((item) => (
                <label key={item.id} className="report-reason">
                  <input
                    type="radio"
                    name="report-reason"
                    value={item.id}
                    checked={reason === item.id}
                    onChange={() => setReason(item.id)}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          )}

          <label htmlFor="report-comment">Что произошло (необязательно)</label>
          <textarea
            id="report-comment"
            className="text-input report-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={1000}
            rows={3}
          />

          {excerpt && (
            <label className="settings-checkbox-row">
              <input type="checkbox" checked={includeExcerpt} onChange={(event) => setIncludeExcerpt(event.target.checked)} />
              Приложить текст сообщения
            </label>
          )}
          {excerpt && includeExcerpt && (
            <blockquote className="report-excerpt">{excerpt.slice(0, 300)}</blockquote>
          )}

          {error && (
            <div className="form-banner form-banner--error">
              <AlertIcon width={15} height={15} />
              {error}
            </div>
          )}

          <div className="report-actions">
            <button type="submit" className="settings-button settings-button--danger" disabled={!reason || sending}>
              {sending && <SpinnerIcon width={15} height={15} />}
              Отправить жалобу
            </button>
            <button type="button" className="settings-button" onClick={onClose} disabled={sending}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
