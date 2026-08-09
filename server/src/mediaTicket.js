import crypto from 'node:crypto'
import { one } from './db.js'
import { sessionTokenHash } from './auth.js'

/**
 * Нативный клиент (Capacitor) не может авторизовать загрузку картинок обычным
 * способом: `<img src>` не умеет слать заголовок Authorization, а куки домена
 * API в WKWebView со схемы capacitor:// не отправляются. Поэтому такой клиент
 * один раз берёт короткоживущий «билет» и подставляет его в query к /uploads.
 *
 * Билет намеренно не является полноценной сессией: он живёт минуты, привязан к
 * конкретной сессии (отзыв сессии обрывает и его) и даёт только чтение
 * загруженных файлов — то есть ровно тот доступ, который у этой сессии и так
 * есть.
 */
/**
 * Полсуток, а не минуты: билет попадает прямо в `src` картинок, и его смена
 * меняет URL — то есть сбрасывает весь кэш медиа в WebView. Отзыв сессии всё
 * равно убивает билет сразу, независимо от срока.
 */
const TICKET_TTL_MS = 12 * 60 * 60 * 1000

function loadTicketKey() {
  const raw = process.env.MEDIA_TICKET_KEY
  if (raw) {
    try {
      const buf = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64')
      if (buf.length === 32) return buf
      console.error('MEDIA_TICKET_KEY задан, но не является 32-байтным ключом — использую случайный ключ на время работы процесса.')
    } catch {
      console.error('MEDIA_TICKET_KEY не удалось разобрать — использую случайный ключ на время работы процесса.')
    }
  }
  // Без явного ключа билеты просто перестают действовать при рестарте: клиент
  // получит 401 и возьмёт новый. Это заметно лучше, чем общий дефолтный ключ.
  return crypto.randomBytes(32)
}

const TICKET_KEY = loadTicketKey()

function sign(sessionHash, expiresAt) {
  return crypto.createHmac('sha256', TICKET_KEY).update(`${sessionHash}.${expiresAt}`).digest('hex')
}

export async function issueMediaTicket(sessionToken) {
  // Ищем сессию так же, как userFromToken: в старых строках токен мог лежать в
  // сыром виде, и билет должен ссылаться ровно на то значение, что в таблице —
  // иначе проверка потом его не найдёт.
  const row = await one('SELECT token FROM sessions WHERE token IN ($1, $2)', [sessionTokenHash(sessionToken), sessionToken])
  if (!row) return null
  const expiresAt = Date.now() + TICKET_TTL_MS
  return { ticket: `${row.token}.${expiresAt}.${sign(row.token, expiresAt)}`, expiresAt }
}

export async function verifyMediaTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 200) return false
  const [sessionHash, expiresRaw, signature] = ticket.split('.')
  if (!sessionHash || !expiresRaw || !signature) return false
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false

  const expected = sign(sessionHash, expiresAt)
  const given = Buffer.from(signature, 'hex')
  const want = Buffer.from(expected, 'hex')
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false

  // Подпись подтверждает только то, что билет выдали мы. Сессию за это время
  // могли отозвать — тогда билет должен умереть вместе с ней.
  const session = await one('SELECT user_id FROM sessions WHERE token = $1', [sessionHash])
  return Boolean(session)
}
