import { audit } from './audit.js'

/**
 * Без RESEND_API_KEY письма не отправляются — вместо этого содержимое (включая
 * ссылку) уходит в лог сервера, чтобы восстановление пароля и подтверждение
 * почты можно было проверять локально без настоящего почтового сервиса.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY
const MAIL_FROM = process.env.MAIL_FROM || 'CorNet <onboarding@resend.dev>'
const ALERT_EMAIL = process.env.ALERT_EMAIL
const ALERT_COOLDOWN_MS = 10 * 60 * 1000
const lastAlertAt = new Map()

export function mailerConfigured() {
  return Boolean(RESEND_API_KEY)
}

export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log(
      `[DEV MAIL] to=${to} subject="${subject}"\n${text}\n(Письмо не отправлено: RESEND_API_KEY не задан — см. README.)`,
    )
    return { delivered: false }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }),
    })
    if (!res.ok) {
      audit('mail.failed', { to, subject, status: res.status })
      return { delivered: false }
    }
    return { delivered: true }
  } catch (err) {
    audit('mail.failed', { to, subject, message: err?.message })
    return { delivered: false }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

export function sendPasswordResetEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Восстановление пароля в CorNet',
    text: `Чтобы задать новый пароль, перейдите по ссылке (действует 1 час): ${link}\n\nЕсли вы не запрашивали сброс пароля, просто проигнорируйте это письмо.`,
    html: `<p>Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>`,
  })
}

export function sendVerificationEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Подтверждение почты в CorNet',
    text: `Чтобы привязать эту почту к аккаунту, перейдите по ссылке (действует 24 часа): ${link}`,
    html: `<p>Чтобы привязать эту почту к аккаунту, перейдите по ссылке (действует 24 часа):</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  })
}

/**
 * Operator-facing alert (server crashes, account lockouts) — separate audience and
 * purpose from the user-facing emails above. Deliberately best-effort: missing
 * ALERT_EMAIL or a failed send never throws, since alerting must not be able to take
 * the server down. Cooldown is per `kind` so one attack/incident sends one email, not
 * a flood — see auth.js's account lockout and index.js's crash handlers for callers.
 */
export async function sendSecurityAlert(kind, subject, details) {
  if (!ALERT_EMAIL) return { delivered: false }
  const now = Date.now()
  const last = lastAlertAt.get(kind) ?? 0
  if (now - last < ALERT_COOLDOWN_MS) return { delivered: false }
  lastAlertAt.set(kind, now)
  const detailsText = Object.entries(details ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  try {
    return await sendEmail({
      to: ALERT_EMAIL,
      subject: `[CorNet alert] ${subject}`,
      text: `${subject}\n\n${detailsText}\n\ntime: ${new Date().toISOString()}`,
      html: `<p><strong>${escapeHtml(subject)}</strong></p><pre>${escapeHtml(detailsText)}</pre><p>${escapeHtml(new Date().toISOString())}</p>`,
    })
  } catch {
    return { delivered: false }
  }
}
