import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'

// Как и critical-path.test.js, работает против уже запущенного сервера — по
// настоящему HTTP и WS, а не через импорт внутренностей.
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'
const PASSWORD = 'CiTest!Password123'

function randomUsername() {
  return `ci_${Math.random().toString(36).slice(2, 10)}`
}

function cookieFromResponse(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('Response did not set a session cookie')
  return setCookie.split(';')[0]
}

/** Регистрация как из нативной обёртки: сервер должен вернуть session token в теле. */
async function registerNative(username) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'native' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201)
  return res.json()
}

async function registerWeb(username) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201)
  return { cookie: cookieFromResponse(res), body: await res.json() }
}

/**
 * Подставной push-сервис. Принимает голое TCP-соединение и только считает
 * попытки: web-push всегда ходит по TLS, и без доверенного сертификата
 * рукопожатие всё равно не состоится. Проверяем то, за что отвечает наш код —
 * решение «слать или не слать» и адрес назначения; шифрование и транспорт это
 * забота самой библиотеки.
 */
function startFakePushService() {
  const attempts = []
  const server = net.createServer((socket) => {
    attempts.push(Date.now())
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, attempts, port: server.address().port }))
  })
}

/** Подписка Web Push: серверу нужны настоящие p256dh/auth, иначе шифрование не соберётся. */
function makeSubscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  }
}

function openSocket(url, protocols, options) {
  const socket = new WebSocket(url, protocols, options)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

test('нативная сессия и пуш офлайн-получателю', async (t) => {
  const config = await fetch(`${BASE_URL}/api/push/config`).catch(() => null)
  // Эндпоинт закрыт авторизацией — проверим доступность пушей уже от лица пользователя.

  const sender = await registerNative(randomUsername())
  assert.ok(sender.token, 'нативному клиенту сервер обязан вернуть session token в теле')
  assert.ok(config === null || config.status === 401, 'без авторизации конфиг пушей отдаваться не должен')

  const recipient = await registerWeb(randomUsername())

  const pushConfigRes = await fetch(`${BASE_URL}/api/push/config`, { headers: { Cookie: recipient.cookie } })
  assert.equal(pushConfigRes.status, 200)
  const pushConfig = await pushConfigRes.json()
  if (!pushConfig.vapidPublicKey) {
    t.skip('VAPID-ключи на сервере не заданы — доставку пушей проверить нечем')
    return
  }

  await t.test('bearer-токен пускает в API и в WebSocket', async () => {
    const me = await fetch(`${BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${sender.token}` } })
    assert.equal(me.status, 200)

    const socket = await openSocket(WS_URL, ['bearer', sender.token])
    assert.equal(socket.protocol, 'bearer')
    socket.close()
  })

  const fake = await startFakePushService()
  t.after(() => fake.server.close())

  await t.test('офлайн-получателю сервер отправляет пуш', async () => {
    const endpoint = `https://127.0.0.1:${fake.port}/push/test`
    const register = await fetch(`${BASE_URL}/api/push/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: recipient.cookie },
      body: JSON.stringify({
        provider: 'webpush',
        token: endpoint,
        keys: makeSubscriptionKeys(),
        preview: true,
        directEnabled: true,
        groupEnabled: true,
      }),
    })
    assert.equal(register.status, 200)

    const chatRes = await fetch(`${BASE_URL}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.token}`, 'X-Client': 'native' },
      body: JSON.stringify({ username: recipient.body.user.username }),
    })
    assert.equal(chatRes.status, 200)
    const { chat } = await chatRes.json()

    // Получатель сокет не открывал — значит, он офлайн, и пуш обязан уйти.
    const socket = await openSocket(WS_URL, ['bearer', sender.token])
    socket.send(JSON.stringify({ type: 'send', chatId: chat.id, text: 'привет из теста' }))

    const deadline = Date.now() + 8000
    while (fake.attempts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    socket.close()

    assert.equal(fake.attempts.length, 1, 'сервер должен был обратиться к push-сервису ровно один раз')
  })

  await t.test('получателю с живым сокетом пуш не дублируется', async () => {
    const before = fake.attempts.length
    const recipientSocket = await openSocket(WS_URL, undefined, { headers: { Cookie: recipient.cookie } })
    const senderSocket = await openSocket(WS_URL, ['bearer', sender.token])

    const chatRes = await fetch(`${BASE_URL}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.token}`, 'X-Client': 'native' },
      body: JSON.stringify({ username: recipient.body.user.username }),
    })
    const { chat } = await chatRes.json()

    const delivered = new Promise((resolve) => {
      recipientSocket.on('message', (raw) => {
        const event = JSON.parse(raw.toString())
        if (event.type === 'message' && event.message.text === 'второе сообщение') resolve()
      })
    })
    senderSocket.send(JSON.stringify({ type: 'send', chatId: chat.id, text: 'второе сообщение' }))
    await delivered

    // Сообщение уже доставлено по сокету; даём отправке пуша шанс произойти,
    // чтобы проверка «его не было» действительно что-то значила.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(fake.attempts.length, before, 'сессия онлайн — пуш дублировать не нужно')

    recipientSocket.close()
    senderSocket.close()
  })
})
