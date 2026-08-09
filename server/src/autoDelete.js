import { one, many, run } from './db.js'
import { appError } from './errors.js'
import { audit } from './audit.js'

/** Значения таймера, которые разрешено выставлять (в секундах). 0 — выключить. */
export const AUTO_DELETE_OPTIONS = [0, 24 * 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60]

/** Как часто подчищаем просроченные сообщения. */
const SWEEP_INTERVAL_MS = 60_000

export function isValidAutoDeleteValue(seconds) {
  return Number.isInteger(seconds) && AUTO_DELETE_OPTIONS.includes(seconds)
}

export async function getAutoDelete(chatId) {
  const row = await one('SELECT auto_delete_seconds FROM chats WHERE id = $1', [chatId])
  return row ? Number(row.auto_delete_seconds) : 0
}

export async function setAutoDelete(chatId, userId, seconds) {
  if (!isValidAutoDeleteValue(seconds)) throw appError('Недопустимое значение таймера')
  const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  if (!member) throw appError('Нет доступа к чату')
  await run('UPDATE chats SET auto_delete_seconds = $1 WHERE id = $2', [seconds, chatId])
  audit('chat.auto_delete_set', { userId, chatId, seconds })
  return seconds
}

/**
 * Полностью удаляет сообщения, чей срок вышел.
 *
 * Именно удаляет строки, а не помечает `deleted`: смысл функции в том, чтобы
 * содержимое исчезло, а «надгробие» с текстом «Сообщение удалено» оставляло бы
 * след переписки. Реакции уходят каскадом по внешнему ключу; закреплённое
 * сообщение, если оно попало под уборку, откалывается отдельно, иначе
 * chats.pinned_message_id указывал бы в пустоту.
 */
export async function sweepExpiredMessages() {
  const now = Date.now()
  const expired = await many(
    `SELECT m.id, m.chat_id
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     WHERE c.auto_delete_seconds > 0
       AND m.created_at + (c.auto_delete_seconds * 1000) <= $1
     LIMIT 500`,
    [now],
  )
  if (expired.length === 0) return []

  const ids = expired.map((r) => r.id)
  await run('UPDATE chats SET pinned_message_id = NULL WHERE pinned_message_id = ANY($1::int[])', [ids])
  await run('UPDATE messages SET reply_to_id = NULL WHERE reply_to_id = ANY($1::int[])', [ids])
  await run('DELETE FROM messages WHERE id = ANY($1::int[])', [ids])
  audit('chat.auto_delete_sweep', { count: ids.length })

  const byChat = new Map()
  for (const row of expired) {
    if (!byChat.has(row.chat_id)) byChat.set(row.chat_id, [])
    byChat.get(row.chat_id).push(row.id)
  }
  return [...byChat.entries()].map(([chatId, messageIds]) => ({ chatId, messageIds }))
}

/**
 * Запускает периодическую уборку. `onSwept` вызывается со списком
 * {chatId, messageIds}, чтобы разослать события в WebSocket.
 */
export function startAutoDeleteSweeper(onSwept) {
  let running = false
  const timer = setInterval(async () => {
    // Уборка может занять больше интервала на большой базе — не запускаем
    // вторую поверх незавершённой, иначе они будут дублировать работу.
    if (running) return
    running = true
    try {
      const swept = await sweepExpiredMessages()
      if (swept.length > 0) await onSwept(swept)
    } catch (err) {
      console.error('Ошибка при автоудалении сообщений:', err)
    } finally {
      running = false
    }
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
