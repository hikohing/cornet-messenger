import webpush from 'web-push'

/**
 * Web Push (VAPID) — уведомления для браузеров и для PWA, установленной на
 * домашний экран iOS. Нативное приложение ходит через APNs (см. apns.js).
 *
 * Переменные окружения:
 *   VAPID_PUBLIC_KEY  — публичный ключ, его же отдаём клиенту для подписки
 *   VAPID_PRIVATE_KEY — приватный ключ
 *   VAPID_SUBJECT     — mailto:… или https://… контакт оператора (требование спеки)
 *
 * Пару ключей достаточно сгенерировать один раз:
 *   node -e "console.log(require('web-push').generateVAPIDKeys())"
 */
const publicKey = process.env.VAPID_PUBLIC_KEY
const privateKey = process.env.VAPID_PRIVATE_KEY
const subject = process.env.VAPID_SUBJECT || process.env.APP_ORIGIN || 'mailto:admin@example.com'

let configured = false
if (publicKey && privateKey) {
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    configured = true
  } catch (err) {
    console.error('VAPID-ключи заданы, но webpush их не принял — веб-пуши отключены:', err?.message)
  }
}

export function webPushConfigured() {
  return configured
}

export function vapidPublicKey() {
  return configured ? publicKey : null
}

/**
 * @returns {Promise<{ ok: boolean, status: number, expired?: boolean }>}
 * `expired` — подписка отозвана браузером, строку из push_devices надо удалить.
 */
export async function sendWebPush(subscription, payload) {
  if (!configured) return { ok: false, status: 0 }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 })
    return { ok: true, status: 201 }
  } catch (err) {
    const status = Number(err?.statusCode) || 0
    // 404/410 от push-сервиса означают, что такой подписки больше нет.
    return { ok: false, status, expired: status === 404 || status === 410 }
  }
}
