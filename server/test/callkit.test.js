import test from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import { WebSocket } from 'ws'

/**
 * Полный путь звонка на закрытое приложение: приглашение задерживается на
 * сервере, уходит VoIP-пуш, разбуженное устройство забирает оффер вместе с
 * накопленным сигналингом.
 *
 * Работает против запущенного сервера. Чтобы APNs указывал сюда, а не в Apple,
 * сервер должен быть запущен с APNS_HOST=http://127.0.0.1:<MOCK_APNS_PORT> и
 * заполненными APNS_* — см. README и .github/workflows/ci.yml. Без этого тест
 * пропускается.
 */
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'
const MOCK_APNS_PORT = Number(process.env.MOCK_APNS_PORT ?? 4455)
const PASSWORD = 'CiTest!Password123'

function randomUsername() {
  return `ci_${Math.random().toString(36).slice(2, 10)}`
}

async function registerNative(username) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'native' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201, 'регистрация должна проходить')
  return res.json()
}

/** Подставной APNs. Открытый HTTP/2 (h2c) — TLS здесь только мешал бы. */
function startMockApns() {
  const received = []
  const server = http2.createServer()
  server.on('stream', (stream, headers) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        body = {}
      }
      received.push({ headers, body })
      stream.respond({ ':status': 200 })
      stream.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(MOCK_APNS_PORT, '127.0.0.1', () => resolve({ server, received }))
  })
}

function openSocket(protocols) {
  const socket = new WebSocket(WS_URL, protocols)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function waitFor(socket, predicate, timeoutMs = 8000) {
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

test('звонок будит закрытое приложение и доносит до него оффер', async (t) => {
  const caller = await registerNative(randomUsername())
  const callee = await registerNative(randomUsername())

  const config = await (await fetch(`${BASE_URL}/api/push/config`, {
    headers: { Authorization: `Bearer ${callee.token}` },
  })).json()
  if (!config.apnsEnabled) {
    t.skip('APNs на сервере не настроен — VoIP-пуши проверить нечем')
    return
  }

  const mock = await startMockApns()
  t.after(() => mock.server.close())

  // Собеседник регистрирует токен PushKit и уходит в офлайн — сокета у него нет.
  const registered = await fetch(`${BASE_URL}/api/push/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callee.token}` },
    body: JSON.stringify({
      provider: 'apns_voip',
      token: 'a'.repeat(64),
      preview: true,
      directEnabled: true,
      groupEnabled: true,
    }),
  })
  assert.equal(registered.status, 200)

  const chatRes = await fetch(`${BASE_URL}/api/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${caller.token}`, 'X-Client': 'native' },
    body: JSON.stringify({ username: callee.user.username }),
  })
  assert.equal(chatRes.status, 200)
  const { chat } = await chatRes.json()

  const callerSocket = await openSocket(['bearer', caller.token])
  t.after(() => callerSocket.close())

  const callId = crypto.randomUUID()
  const offer = { type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' }
  callerSocket.send(JSON.stringify({
    type: 'call_invite',
    callId,
    chatId: chat.id,
    targetUserId: callee.user.id,
    video: false,
    sdp: offer,
  }))

  await t.test('уходит VoIP-пуш с данными звонка', async () => {
    const deadline = Date.now() + 8000
    while (mock.received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(mock.received.length, 1, 'ожидался ровно один VoIP-пуш')
    const [push] = mock.received
    assert.equal(push.headers['apns-push-type'], 'voip')
    assert.match(push.headers['apns-topic'], /\.voip$/, 'топик VoIP-пуша обязан оканчиваться на .voip')
    assert.equal(push.body.callId, callId)
    assert.equal(push.body.chatId, chat.id)
    assert.equal(push.body.callerId, caller.user.id)
    assert.ok(push.body.callerName, 'в пуше должно быть имя звонящего — его покажет CallKit')
  })

  await t.test('разбуженное устройство забирает оффер и накопленный сигналинг', async () => {
    // Пока устройство «просыпается», звонящий уже шлёт ICE-кандидатов.
    callerSocket.send(JSON.stringify({
      type: 'call_ice',
      callId,
      candidate: { candidate: 'candidate:1 udp', sdpMLineIndex: 0 },
    }))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const calleeSocket = await openSocket(['bearer', callee.token])
    t.after(() => calleeSocket.close())

    const invitePromise = waitFor(calleeSocket, (event) => event.type === 'call_invite')
    const icePromise = waitFor(calleeSocket, (event) => event.type === 'call_ice')
    calleeSocket.send(JSON.stringify({ type: 'call_claim', callId }))

    const invite = await invitePromise
    assert.equal(invite.callId, callId)
    assert.equal(invite.fromUserId, caller.user.id)
    assert.deepEqual(invite.sdp, offer, 'оффер обязан дождаться разбуженного устройства')

    const ice = await icePromise
    assert.equal(ice.candidate.candidate, 'candidate:1 udp', 'кандидаты времени пробуждения не должны теряться')
  })
})
