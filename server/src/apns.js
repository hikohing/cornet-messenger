import crypto from 'node:crypto'
import http2 from 'node:http2'

/**
 * Отправка пушей в APNs по HTTP/2 с авторизацией provider-токеном (JWT ES256).
 *
 * Отдельной библиотеки здесь нет намеренно: весь протокол — это один POST на
 * /3/device/<token> с заголовком authorization, а сложность в остальном
 * (переиспользование соединения и срок жизни JWT), и её всё равно пришлось бы
 * держать в голове.
 *
 * Нужные переменные окружения:
 *   APNS_KEY        — содержимое .p8-файла из Apple Developer (Keys → APNs)
 *   APNS_KEY_ID     — идентификатор этого ключа (10 символов)
 *   APNS_TEAM_ID    — Team ID аккаунта разработчика (10 символов)
 *   APNS_BUNDLE_ID  — bundle id приложения, он же apns-topic
 *   APNS_PRODUCTION — '1' для боевого окружения, иначе используется sandbox
 *   APNS_HOST       — переопределяет адрес (нужно тестам и прокси; в бою не задают)
 */
const HOST_PRODUCTION = 'https://api.push.apple.com'
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com'

/** Apple отклоняет provider-токен старше часа; обновляем с запасом. */
const TOKEN_TTL_MS = 50 * 60 * 1000

function config() {
  const key = process.env.APNS_KEY
  const keyId = process.env.APNS_KEY_ID
  const teamId = process.env.APNS_TEAM_ID
  const bundleId = process.env.APNS_BUNDLE_ID
  if (!key || !keyId || !teamId || !bundleId) return null
  return {
    // В переменных окружения переводы строк часто приезжают как \n — .p8 без
    // настоящих переносов Node не разберёт.
    key: key.includes('\\n') ? key.replace(/\\n/g, '\n') : key,
    keyId,
    teamId,
    bundleId,
    host: process.env.APNS_HOST || (process.env.APNS_PRODUCTION === '1' ? HOST_PRODUCTION : HOST_SANDBOX),
  }
}

export function apnsConfigured() {
  return config() !== null
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let cachedToken = null

function providerToken(settings) {
  if (cachedToken && cachedToken.issuedAt > Date.now() - TOKEN_TTL_MS) return cachedToken.value
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: settings.keyId }))
  const payload = base64url(JSON.stringify({ iss: settings.teamId, iat: Math.floor(Date.now() / 1000) }))
  const signature = crypto
    .createSign('SHA256')
    .update(`${header}.${payload}`)
    // APNs ждёт «сырую» подпись r||s, а не DER, в который Node подписывает по умолчанию.
    .sign({ key: settings.key, dsaEncoding: 'ieee-p1363' })
  const value = `${header}.${payload}.${base64url(signature)}`
  cachedToken = { value, issuedAt: Date.now() }
  return value
}

let session = null

function connection(settings) {
  if (session && !session.closed && !session.destroyed) return session
  session = http2.connect(settings.host)
  // Без обработчика ошибка соединения — неперехваченное событие, валящее процесс.
  session.on('error', () => {
    session = null
  })
  session.on('close', () => {
    session = null
  })
  return session
}

/**
 * @returns {Promise<{ ok: boolean, status: number, reason?: string, expired?: boolean }>}
 * `expired` — устройство больше не существует, строку из push_devices надо удалить.
 */
export function sendApns(deviceToken, payload, { collapseId, priority = 10, expiration = 0, pushType = 'alert' } = {}) {
  const settings = config()
  if (!settings) return Promise.resolve({ ok: false, status: 0, reason: 'NotConfigured' })

  // VoIP-пуш (PushKit) — отдельный топик с суффиксом .voip и свой тип. Он будит
  // приложение, даже когда оно выгружено, но требует, чтобы приложение сразу же
  // показало входящий звонок через CallKit: iOS убивает процесс, если этого не
  // произошло, и после нескольких нарушений перестаёт доставлять такие пуши.
  const isVoip = pushType === 'voip'

  return new Promise((resolve) => {
    let stream
    try {
      stream = connection(settings).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken(settings)}`,
        'apns-topic': isVoip ? `${settings.bundleId}.voip` : settings.bundleId,
        'apns-push-type': pushType,
        'apns-priority': String(priority),
        'apns-expiration': String(expiration),
        ...(collapseId ? { 'apns-collapse-id': collapseId.slice(0, 64) } : {}),
        'content-type': 'application/json',
      })
    } catch {
      resolve({ ok: false, status: 0, reason: 'ConnectionFailed' })
      return
    }

    let status = 0
    let body = ''
    stream.setEncoding('utf8')
    stream.on('response', (headers) => {
      status = Number(headers[':status']) || 0
    })
    stream.on('data', (chunk) => {
      body += chunk
    })
    stream.on('error', () => resolve({ ok: false, status: 0, reason: 'StreamError' }))
    stream.on('end', () => {
      if (status === 200) return resolve({ ok: true, status })
      let reason
      try {
        reason = JSON.parse(body).reason
      } catch {
        reason = undefined
      }
      // 410 — токен протух; 400 + BadDeviceToken — приложение переустановили.
      const expired = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered'
      resolve({ ok: false, status, reason, expired })
    })
    stream.end(JSON.stringify(payload))
  })
}

export function closeApns() {
  session?.close()
  session = null
}
