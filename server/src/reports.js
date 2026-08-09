import { many, one } from './db.js'
import { appError } from './errors.js'
import { audit } from './audit.js'
import { mailerConfigured, sendEmail } from './mailer.js'
import { isMember } from './chats.js'

/**
 * Жалобы на контент и на пользователей.
 *
 * Требование App Store к приложениям с пользовательским контентом
 * (Guideline 1.2): пожаловаться должно быть можно, и жалоба должна куда-то
 * приходить. Поэтому жалоба всегда сохраняется в базу, а оператору уходит
 * письмо — доставка письма при этом никогда не влияет на сам приём жалобы.
 */
const REASONS = new Set(['spam', 'abuse', 'sexual', 'violence', 'illegal', 'other'])

const REASON_LABELS = {
  spam: 'Спам',
  abuse: 'Оскорбления или травля',
  sexual: 'Сексуализированный контент',
  violence: 'Насилие или угрозы',
  illegal: 'Противозаконный контент',
  other: 'Другое',
}

const MAX_COMMENT = 1000
const MAX_EXCERPT = 2000
/** Письма не должны превращаться в собственный DoS: жалобы всё равно все в базе. */
const ALERT_INTERVAL_MS = 60 * 1000
let lastAlertAt = 0

export function reportReasons() {
  return [...REASONS].map((id) => ({ id, label: REASON_LABELS[id] }))
}

async function notifyOperator(report, reporterName, targetName) {
  // Почта может быть не настроена — жалобы тогда просто копятся в таблице
  // reports, и это ровно то, что видно в `npm run reports`.
  if (!process.env.ALERT_EMAIL || !mailerConfigured()) return
  const now = Date.now()
  if (now - lastAlertAt < ALERT_INTERVAL_MS) return
  lastAlertAt = now

  const pending = await one("SELECT COUNT(*)::int AS total FROM reports WHERE status = 'open'", [])
  const lines = [
    `Причина: ${REASON_LABELS[report.reason] ?? report.reason}`,
    `На кого: ${targetName ?? '—'}`,
    `От кого: ${reporterName ?? '—'}`,
    report.chat_id ? `Чат: ${report.chat_id}` : null,
    report.message_id ? `Сообщение: ${report.message_id}` : null,
    report.comment ? `Комментарий: ${report.comment}` : null,
    report.excerpt ? `Текст (снят на устройстве жалующегося): ${report.excerpt}` : null,
    `Всего нерассмотренных жалоб: ${pending?.total ?? '?'}`,
  ].filter(Boolean)

  try {
    await sendEmail({
      to: process.env.ALERT_EMAIL,
      subject: `[CorNet] Жалоба #${report.id}`,
      text: lines.join('\n'),
      html: `<p><strong>Жалоба #${report.id}</strong></p><pre>${lines
        .join('\n')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`,
    })
  } catch {
    // Письмо не ушло — жалоба уже в базе, потерять её это не может.
  }
}

export async function createReport(reporterId, input) {
  const reason = String(input?.reason ?? '')
  if (!REASONS.has(reason)) throw appError('Выберите причину жалобы')

  const comment = String(input?.comment ?? '').trim().slice(0, MAX_COMMENT)
  const excerpt = String(input?.excerpt ?? '').trim().slice(0, MAX_EXCERPT)
  const messageId = input?.messageId ? Number(input.messageId) : null
  let targetUserId = input?.targetUserId ? Number(input.targetUserId) : null
  let chatId = null

  if (messageId) {
    const message = await one('SELECT id, chat_id, sender_id FROM messages WHERE id = $1', [messageId])
    if (!message) throw appError('Сообщение не найдено', 404)
    // Пожаловаться можно только на то, что человек и так видит: иначе по номеру
    // сообщения можно было бы узнавать о чужих переписках.
    if (!(await isMember(message.chat_id, reporterId))) throw appError('Нет доступа к чату', 403)
    chatId = message.chat_id
    targetUserId = message.sender_id
  } else if (targetUserId) {
    const target = await one('SELECT id FROM users WHERE id = $1', [targetUserId])
    if (!target) throw appError('Пользователь не найден', 404)
  } else {
    throw appError('Не указано, на что жалоба')
  }

  if (targetUserId === reporterId) throw appError('Нельзя пожаловаться на самого себя')

  const report = await one(
    `INSERT INTO reports (reporter_id, target_user_id, message_id, chat_id, reason, comment, excerpt, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [reporterId, targetUserId, messageId, chatId, reason, comment, excerpt, Date.now()],
  )

  audit('report.created', { reportId: report.id, userId: reporterId, targetUserId, messageId, chatId, reason })

  const names = await many('SELECT id, username FROM users WHERE id = ANY($1::int[])', [
    [reporterId, targetUserId].filter(Boolean),
  ])
  const nameOf = (id) => names.find((row) => row.id === id)?.username
  // Без await: доставка письма не должна задерживать ответ жалующемуся.
  void notifyOperator(report, nameOf(reporterId), nameOf(targetUserId))

  return { id: report.id }
}
