import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

/**
 * Регрессии версии 2.0. Как и остальные серверные тесты, работает с уже
 * запущенным сервером по настоящему HTTP/WS — так же, как это делает браузер.
 */
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'
const PASSWORD = 'CiTest!Password123'

function cookieFromResponse(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('Ответ не выставил cookie сессии')
  return setCookie.split(';')[0]
}

async function register() {
  const username = `ci_${Math.random().toString(36).slice(2, 10)}`
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  return { username, cookie: cookieFromResponse(res), id: body.user.id }
}

function patchMe(cookie, patch) {
  return fetch(`${BASE_URL}/api/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(patch),
  })
}

async function openDirectChat(cookie, username) {
  const res = await fetch(`${BASE_URL}/api/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ username }),
  })
  assert.equal(res.status, 200)
  return (await res.json()).chat
}

test('displayName можно очистить, передав null', async () => {
  const alice = await register()

  const named = await patchMe(alice.cookie, { displayName: 'Алиса' })
  assert.equal(named.status, 200)
  assert.equal((await named.json()).user.displayName, 'Алиса')

  // Раньше null проваливался внутрь .trim() и возвращался как невнятная ошибка
  // «не удалось выполнить действие» — очистить имя было невозможно.
  const cleared = await patchMe(alice.cookie, { displayName: null })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).user.displayName, null)
})

test('выключенное «время посещения» не уезжает собеседнику', async () => {
  const alice = await register()
  const bob = await register()
  await openDirectChat(alice.cookie, bob.username)

  // Боб выходил в сеть — метка в базе появляется при обрыве сокета.
  const ws = new WebSocket(WS_URL, { headers: { Cookie: bob.cookie } })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await new Promise((resolve) => {
    ws.on('close', resolve)
    ws.close()
  })

  const hidden = await patchMe(bob.cookie, { showLastSeen: false })
  assert.equal(hidden.status, 200)

  const res = await fetch(`${BASE_URL}/api/chats`, { headers: { Cookie: alice.cookie } })
  const { chats } = await res.json()
  const bobAsSeenByAlice = chats
    .flatMap((chat) => chat.members)
    .find((member) => member.id === bob.id)
  assert.ok(bobAsSeenByAlice, 'Боб должен быть в участниках общего чата')
  assert.equal(bobAsSeenByAlice.showLastSeen, false)
  assert.equal(
    bobAsSeenByAlice.lastSeenAt,
    null,
    'при выключенном тумблере сервер не должен отдавать саму метку — соблюдать её добровольно клиент не обязан',
  )

  const shown = await patchMe(bob.cookie, { showLastSeen: true })
  assert.equal(shown.status, 200)
  const after = await fetch(`${BASE_URL}/api/chats`, { headers: { Cookie: alice.cookie } })
  const visible = (await after.json()).chats
    .flatMap((chat) => chat.members)
    .find((member) => member.id === bob.id)
  assert.ok(visible.lastSeenAt, 'с включённым тумблером метка возвращается как раньше')
})

test('присутствие рассылается только тем, с кем есть общий чат', async () => {
  const alice = await register()
  const bob = await register()
  const stranger = await register()
  await openDirectChat(alice.cookie, bob.username)

  // Алиса и посторонний слушают одновременно; в сеть заходит Боб.
  const listeners = await Promise.all(
    [alice, stranger].map(
      (who) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(WS_URL, { headers: { Cookie: who.cookie } })
          const events = []
          ws.on('message', (raw) => events.push(JSON.parse(raw.toString())))
          ws.on('open', () => resolve({ ws, events }))
          ws.on('error', reject)
        }),
    ),
  )

  const bobWs = new WebSocket(WS_URL, { headers: { Cookie: bob.cookie } })
  await new Promise((resolve, reject) => {
    bobWs.on('open', resolve)
    bobWs.on('error', reject)
  })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const presenceFor = (events) => events.filter((e) => e.type === 'presence' && e.userId === bob.id)
  assert.equal(presenceFor(listeners[0].events).length, 1, 'собеседник должен узнать, что Боб в сети')
  assert.equal(
    presenceFor(listeners[1].events).length,
    0,
    'посторонний не должен видеть, кто и когда заходит',
  )

  bobWs.close()
  for (const listener of listeners) listener.ws.close()
})

// Маршрут сброса пароля по ссылке из письма проверить здесь нечем — он требует
// подтверждённой почты и настроенного SMTP. После правки он делает ровно те же
// два шага (disconnectUser + removeDevicesForUser), что и смена пароля ниже.
test('смена пароля обрывает живой сокет прежней сессии', async () => {
  const victim = await register()

  const ws = new WebSocket(WS_URL, { headers: { Cookie: victim.cookie } })
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })

  const res = await fetch(`${BASE_URL}/api/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: victim.cookie },
    body: JSON.stringify({ oldPassword: PASSWORD, newPassword: 'Another!Password456' }),
  })
  assert.equal(res.status, 200)

  const code = await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('сокет прежней сессии не закрылся')), 5000)),
  ])
  assert.equal(code, 4001)

  const me = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: victim.cookie } })
  assert.equal(me.status, 401, 'старая кука не должна работать после смены пароля')
})
