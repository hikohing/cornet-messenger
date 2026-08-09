import { many, one, run } from './db.js'
import { sessionTokenHash } from './auth.js'
import { apnsConfigured, sendApns } from './apns.js'
import { sendWebPush, webPushConfigured } from './webpush.js'
import { audit } from './audit.js'

/**
 * `apns_voip` — отдельная строка, а не флаг у `apns`: PushKit выдаёт приложению
 * свой токен, не совпадающий с обычным APNs-токеном, и живёт он своей жизнью.
 */
const PROVIDERS = new Set(['apns', 'webpush', 'apns_voip'])

/**
 * ws.js сообщает сюда, жива ли ещё сессия устройства. Прямой импорт из ws.js
 * дал бы цикл (ws.js импортирует этот модуль), поэтому связь односторонняя —
 * так же, как у calls.js.
 */
let runtime = { isSessionOnline: () => false }

export function configurePushRuntime(next) {
  runtime = { ...runtime, ...next }
}

export function pushConfigured() {
  return apnsConfigured() || webPushConfigured()
}

export async function registerDevice(userId, sessionToken, input) {
  const provider = String(input?.provider ?? '')
  if (!PROVIDERS.has(provider)) return false
  const deviceToken = String(input?.token ?? '').slice(0, 1024)
  if (!deviceToken) return false

  // Для Web Push нужны ключи шифрования подписки, без них отправить нечего.
  const keys = provider === 'webpush'
    ? { p256dh: String(input?.keys?.p256dh ?? ''), auth: String(input?.keys?.auth ?? '') }
    : null
  if (keys && (!keys.p256dh || !keys.auth)) return false

  const now = Date.now()
  await run(
    `INSERT INTO push_devices (user_id, session_token, provider, device_token, keys, preview, direct_enabled, group_enabled, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (provider, device_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       session_token = EXCLUDED.session_token,
       keys = EXCLUDED.keys,
       preview = EXCLUDED.preview,
       direct_enabled = EXCLUDED.direct_enabled,
       group_enabled = EXCLUDED.group_enabled,
       last_used_at = EXCLUDED.last_used_at`,
    [
      userId,
      sessionToken ? sessionTokenHash(sessionToken) : null,
      provider,
      deviceToken,
      keys ? JSON.stringify(keys) : null,
      input?.preview !== false,
      input?.directEnabled !== false,
      input?.groupEnabled !== false,
      now,
    ],
  )
  return true
}

export async function unregisterDevice(userId, provider, deviceToken) {
  if (!PROVIDERS.has(String(provider))) return
  await run('DELETE FROM push_devices WHERE user_id = $1 AND provider = $2 AND device_token = $3', [userId, provider, deviceToken])
}

/** Разлогин и отзыв сессии должны забирать с собой и право слать пуши на это устройство. */
export async function removeDevicesForSessionHash(sessionHash) {
  if (!sessionHash) return
  await run('DELETE FROM push_devices WHERE session_token = $1', [sessionHash])
}

/** Смена и сброс пароля обнуляют все сессии пользователя — устройства уходят вместе с ними. */
export async function removeDevicesForUser(userId) {
  await run('DELETE FROM push_devices WHERE user_id = $1', [userId])
}

export async function removeDevicesForSession(sessionToken) {
  if (typeof sessionToken !== 'string' || !sessionToken) return
  await removeDevicesForSessionHash(sessionTokenHash(sessionToken))
}

/**
 * Есть ли у пользователя устройство, способное принять звонок при закрытом
 * приложении. Звонок офлайн-абоненту имеет смысл только если такое устройство
 * есть — иначе будить некого и собеседнику честнее сразу сказать «недоступен».
 */
export async function voipDeviceCount(userId) {
  if (!apnsConfigured()) return 0
  const row = await one(
    `SELECT COUNT(*)::int AS total
       FROM push_devices d
       JOIN sessions s ON s.token = d.session_token
      WHERE d.user_id = $1 AND d.provider = 'apns_voip'`,
    [userId],
  )
  return row?.total ?? 0
}

/**
 * Будит устройства собеседника VoIP-пушем. Полезная нагрузка уезжает в
 * приложение целиком: PushKit не показывает ничего сам, входящий звонок рисует
 * уже приложение через CallKit.
 *
 * @returns {Promise<number>} сколько устройств удалось разбудить
 */
export async function notifyIncomingCall({ callId, chatId, callerId, callerName, calleeId, video }) {
  if (!apnsConfigured()) return 0

  const devices = await many(
    `SELECT d.id, d.device_token
       FROM push_devices d
       JOIN sessions s ON s.token = d.session_token
      WHERE d.user_id = $1 AND d.provider = 'apns_voip'`,
    [calleeId],
  )
  if (devices.length === 0) return 0

  const results = await Promise.all(
    devices.map(async (device) => {
      const result = await sendApns(
        device.device_token,
        { callId, chatId, callerId, callerName, video: Boolean(video) },
        // Звонок протухает вместе с окном дозвона: доставлять его позже — значит
        // показать человеку входящий от того, кто уже положил трубку.
        { pushType: 'voip', priority: 10, expiration: Math.floor(Date.now() / 1000) + 40 },
      )
      if (result.expired) await run('DELETE FROM push_devices WHERE id = $1', [device.id])
      if (!result.ok) {
        audit('push.voip_failed', { userId: calleeId, status: result.status, reason: result.reason })
      }
      return result.ok
    }),
  )
  return results.filter(Boolean).length
}

function attachmentDescription(message) {
  if (message.type === 'voice') return 'Голосовое сообщение'
  if (message.type === 'video') return 'Видео'
  if (message.type === 'audio') return 'Аудио'
  if (message.type === 'image') return 'Изображение'
  if (message.type === 'poll') return '📊 Опрос'
  if (message.type === 'file') return message.attachment?.name || 'Файл'
  return 'Новое сообщение'
}

/**
 * Текст сообщения сервер видит только у нешифрованных чатов — у E2E в базе
 * лежит один шифротекст, и подставить в пуш нечего даже при желании.
 */
function previewText(message) {
  if (message.encrypted) return '🔒 Зашифрованное сообщение'
  if (message.type === 'text') return message.text || 'Новое сообщение'
  return attachmentDescription(message)
}

async function unreadCount(userId) {
  const row = await one(
    `SELECT COUNT(*)::int AS unread
       FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
      WHERE m.id > cm.last_read_message_id AND m.sender_id <> $1 AND NOT m.deleted`,
    [userId],
  )
  return row?.unread ?? 0
}

async function deliver(device, notification) {
  if (device.provider === 'apns') {
    const result = await sendApns(device.device_token, {
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: 'default',
        badge: notification.badge,
        // Уведомления одного чата iOS сгруппирует в одну стопку.
        'thread-id': `chat-${notification.chatId}`,
      },
      chatId: notification.chatId,
      messageId: notification.messageId,
    })
    return result
  }
  return sendWebPush(
    { endpoint: device.device_token, keys: device.keys },
    {
      title: notification.title,
      body: notification.body,
      chatId: notification.chatId,
      messageId: notification.messageId,
      badge: notification.badge,
    },
  )
}

/**
 * Шлёт пуш о новом сообщении всем, кто его не увидит прямо сейчас.
 *
 * Вызывать без await: доставка ходит во внешние сервисы и не должна задерживать
 * рассылку по сокетам.
 */
export async function notifyNewMessage({ chatId, message, senderId, senderName }) {
  if (!pushConfigured()) return

  const chat = await one('SELECT type, name FROM chats WHERE id = $1', [chatId])
  if (!chat) return
  const isGroup = chat.type === 'group'

  const members = await many(
    'SELECT user_id, muted_until FROM chat_members WHERE chat_id = $1 AND user_id <> $2',
    [chatId, senderId],
  )
  const now = Date.now()
  const recipients = members.filter((member) => !(member.muted_until && Number(member.muted_until) > now))
  if (recipients.length === 0) return

  // JOIN с sessions — не оптимизация, а инвариант: устройство имеет право на
  // пуши ровно пока жива сессия, из которой его зарегистрировали. Смена пароля,
  // отзыв сессии и протухание по TTL удаляют строку в sessions, и устройство
  // перестаёт получать уведомления само, без отдельной уборки.
  const devices = await many(
    `SELECT d.id, d.user_id, d.provider, d.device_token, d.keys, d.preview, d.direct_enabled, d.group_enabled, d.session_token
       FROM push_devices d
       JOIN sessions s ON s.token = d.session_token
      WHERE d.user_id = ANY($1::int[]) AND d.provider <> 'apns_voip'`,
    [recipients.map((member) => member.user_id)],
  )

  const title = isGroup ? (chat.name || 'Группа') : senderName
  const badges = new Map()

  await Promise.all(
    devices.map(async (device) => {
      if (isGroup ? !device.group_enabled : !device.direct_enabled) return
      // Устройство прямо сейчас смотрит в чат через живой сокет — пуш был бы дублем.
      if (device.session_token && runtime.isSessionOnline(device.session_token)) return

      if (!badges.has(device.user_id)) badges.set(device.user_id, await unreadCount(device.user_id))

      const body = device.preview
        ? (isGroup ? `${senderName}: ${previewText(message)}` : previewText(message))
        : 'Новое сообщение'

      const result = await deliver(device, {
        title,
        body: body.slice(0, 300),
        chatId,
        messageId: message.id,
        badge: badges.get(device.user_id),
      })

      if (result.expired) {
        await run('DELETE FROM push_devices WHERE id = $1', [device.id])
        return
      }
      if (result.ok) {
        await run('UPDATE push_devices SET last_used_at = $1 WHERE id = $2', [Date.now(), device.id])
        return
      }
      audit('push.failed', { userId: device.user_id, provider: device.provider, status: result.status, reason: result.reason })
    }),
  )
}
