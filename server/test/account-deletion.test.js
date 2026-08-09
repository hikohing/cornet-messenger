import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

// Работает против запущенного сервера, по настоящему HTTP и WS.
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'
const PASSWORD = 'CiTest!Password123'
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

function randomUsername() {
  return `ci_${Math.random().toString(36).slice(2, 10)}`
}

async function register() {
  const username = randomUsername()
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'native' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(res.status, 201, 'регистрация должна проходить')
  const body = await res.json()
  return { username, token: body.token, id: body.user.id }
}

function authed(token, extra = {}) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Client': 'native', ...extra }
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

test('удаление аккаунта', async (t) => {
  const leaving = await register()
  const staying = await register()

  // Личный чат с перепиской в обе стороны.
  const directRes = await fetch(`${BASE_URL}/api/chats`, {
    method: 'POST',
    headers: authed(leaving.token),
    body: JSON.stringify({ username: staying.username }),
  })
  assert.equal(directRes.status, 200)
  const { chat: direct } = await directRes.json()

  // Группа, которая должна пережить удаление одного из участников.
  const groupRes = await fetch(`${BASE_URL}/api/chats/group`, {
    method: 'POST',
    headers: authed(leaving.token),
    body: JSON.stringify({ name: 'Тестовая группа', usernames: [staying.username] }),
  })
  assert.equal(groupRes.status, 200)
  const { chat: group } = await groupRes.json()

  const leavingSocket = await openSocket(leaving.token)
  t.after(() => leavingSocket.close())
  leavingSocket.send(JSON.stringify({ type: 'send', chatId: direct.id, text: 'привет' }))
  leavingSocket.send(JSON.stringify({ type: 'send', chatId: group.id, text: 'всем привет' }))
  await new Promise((resolve) => setTimeout(resolve, 400))

  // Загруженный файл должен исчезнуть с диска вместе с аккаунтом.
  const form = new FormData()
  form.append('file', new Blob(['тестовое вложение'], { type: 'text/plain' }), 'note.txt')
  const uploadRes = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${leaving.token}`, 'X-Client': 'native' },
    body: form,
  })
  assert.equal(uploadRes.status, 200)
  const uploaded = await uploadRes.json()
  leavingSocket.send(JSON.stringify({
    type: 'send',
    chatId: direct.id,
    messageType: 'file',
    attachmentUrl: uploaded.url,
    attachment: { name: uploaded.name, mimeType: uploaded.mimeType, size: uploaded.size },
  }))
  await new Promise((resolve) => setTimeout(resolve, 400))

  const uploadedPath = path.join(UPLOADS_DIR, path.basename(uploaded.url))
  const uploadsVisible = fs.existsSync(uploadedPath)

  await t.test('без верного пароля аккаунт не удаляется', async () => {
    const res = await fetch(`${BASE_URL}/api/me`, {
      method: 'DELETE',
      headers: authed(leaving.token),
      body: JSON.stringify({ password: 'НеверныйПароль123!' }),
    })
    assert.equal(res.status, 401)
    const me = await fetch(`${BASE_URL}/api/me`, { headers: authed(leaving.token) })
    assert.equal(me.status, 200, 'аккаунт должен остаться на месте')
  })

  const stayingSocket = await openSocket(staying.token)
  t.after(() => stayingSocket.close())
  const chatGone = waitFor(stayingSocket, (event) => event.type === 'chat_left' && event.chatId === direct.id)

  await t.test('с верным паролем аккаунт удаляется', async () => {
    const res = await fetch(`${BASE_URL}/api/me`, {
      method: 'DELETE',
      headers: authed(leaving.token),
      body: JSON.stringify({ password: PASSWORD }),
    })
    assert.equal(res.status, 200)

    const me = await fetch(`${BASE_URL}/api/me`, { headers: authed(leaving.token) })
    assert.equal(me.status, 401, 'сессии удалённого аккаунта должны перестать работать')

    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: leaving.username, password: PASSWORD }),
    })
    assert.equal(login.status, 401, 'войти под удалённым аккаунтом нельзя')
  })

  await t.test('собеседник сразу узнаёт, что личный чат исчез', async () => {
    await chatGone
  })

  await t.test('личный чат удалён, группа осталась', async () => {
    const res = await fetch(`${BASE_URL}/api/chats`, { headers: authed(staying.token) })
    assert.equal(res.status, 200)
    const { chats } = await res.json()

    assert.equal(chats.some((item) => item.id === direct.id), false, 'личная переписка должна исчезнуть')

    const survivingGroup = chats.find((item) => item.id === group.id)
    assert.ok(survivingGroup, 'группа должна пережить удаление участника')
    assert.deepEqual(
      survivingGroup.members.map((member) => member.id),
      [staying.id],
      'в группе должен остаться только второй участник',
    )
  })

  await t.test('загруженные файлы удаляются с диска', async (subtest) => {
    if (!uploadsVisible) {
      subtest.skip('папка загрузок недоступна отсюда — проверять нечего')
      return
    }
    assert.equal(fs.existsSync(uploadedPath), false, 'вложение удалённого аккаунта должно исчезнуть с диска')
  })
})
