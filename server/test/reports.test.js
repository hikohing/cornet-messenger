import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'
const PASSWORD = 'CiTest!Password123'

async function register() {
  const username = `ci_${Math.random().toString(36).slice(2, 10)}`
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'native' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  return { username, token: body.token, id: body.user.id }
}

function authed(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Client': 'native' }
}

function openSocket(token) {
  const socket = new WebSocket(WS_URL, ['bearer', token])
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function waitFor(socket, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('не дождались события в сокете')), timeoutMs)
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString())
      if (!predicate(event)) return
      clearTimeout(timer)
      resolve(event)
    })
  })
}

test('жалобы на контент', async (t) => {
  const author = await register()
  const complainer = await register()
  const stranger = await register()

  const chatRes = await fetch(`${BASE_URL}/api/chats`, {
    method: 'POST',
    headers: authed(author.token),
    body: JSON.stringify({ username: complainer.username }),
  })
  const { chat } = await chatRes.json()

  const authorSocket = await openSocket(author.token)
  const complainerSocket = await openSocket(complainer.token)
  t.after(() => {
    authorSocket.close()
    complainerSocket.close()
  })

  const delivered = waitFor(complainerSocket, (event) => event.type === 'message')
  authorSocket.send(JSON.stringify({ type: 'send', chatId: chat.id, text: 'сомнительное сообщение' }))
  const { message } = await delivered

  await t.test('список причин доступен без входа — его читает форма жалобы', async () => {
    const res = await fetch(`${BASE_URL}/api/reports/reasons`)
    assert.equal(res.status, 200)
    const { reasons } = await res.json()
    assert.ok(reasons.length > 0)
    assert.ok(reasons.every((item) => item.id && item.label))
  })

  await t.test('участник чата может пожаловаться на сообщение', async () => {
    const res = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({
        reason: 'abuse',
        messageId: message.id,
        comment: 'оскорбление',
        excerpt: 'сомнительное сообщение',
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Number.isInteger(body.id), 'жалоба должна получить номер')
  })

  await t.test('посторонний не может пожаловаться на сообщение из чужого чата', async () => {
    const res = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(stranger.token),
      body: JSON.stringify({ reason: 'spam', messageId: message.id }),
    })
    // Иначе по номеру сообщения можно было бы узнавать о чужих переписках.
    assert.equal(res.status, 403)
  })

  await t.test('жалоба на пользователя без сообщения тоже принимается', async () => {
    const res = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({ reason: 'spam', targetUserId: author.id }),
    })
    assert.equal(res.status, 200)
  })

  await t.test('без причины и без цели жалоба не принимается', async () => {
    const noReason = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({ targetUserId: author.id }),
    })
    assert.equal(noReason.status, 400)

    const badReason = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({ reason: 'что-нибудь своё', targetUserId: author.id }),
    })
    assert.equal(badReason.status, 400)

    const noTarget = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({ reason: 'spam' }),
    })
    assert.equal(noTarget.status, 400)
  })

  await t.test('на себя пожаловаться нельзя', async () => {
    const res = await fetch(`${BASE_URL}/api/reports`, {
      method: 'POST',
      headers: authed(complainer.token),
      body: JSON.stringify({ reason: 'spam', targetUserId: complainer.id }),
    })
    assert.equal(res.status, 400)
  })
})
