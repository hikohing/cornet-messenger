import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

// Assumes the server is already running (see .github/workflows/ci.yml and
// package.json's "test" script) — this suite talks to it over real HTTP/WS,
// the same way a browser client does, rather than importing app internals.
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws'

function cookieFromResponse(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('Response did not set a session cookie')
  return setCookie.split(';')[0]
}

test('register → login → send a message end to end', async (t) => {
  // Must fit the server's 3-24 char username validation (see auth.js).
  const username = `ci_${Math.random().toString(36).slice(2, 10)}`
  const password = 'CiTest!Password123'

  let cookie
  await t.test('register', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.user.username, username)
    cookie = cookieFromResponse(res)
  })

  await t.test('login with the same credentials works', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 200)
    cookie = cookieFromResponse(res)
  })

  let savedChatId
  await t.test('registration auto-creates the Saved Messages chat', async () => {
    const res = await fetch(`${BASE_URL}/api/chats`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const { chats } = await res.json()
    const saved = chats.find((chat) => chat.type === 'saved')
    assert.ok(saved, 'expected a chat with type "saved"')
    savedChatId = saved.id
  })

  await t.test('sending a message over the websocket delivers and persists it', async () => {
    const text = `ci smoke test ${Date.now()}`
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } })

    const delivered = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for message echo')), 10_000)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'send', chatId: savedChatId, text })))
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString())
        if (event.type === 'message' && event.message?.text === text) {
          clearTimeout(timer)
          resolve(event.message)
        }
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    ws.close()

    assert.equal(delivered.chatId, savedChatId)
    assert.equal(delivered.text, text)

    const res = await fetch(`${BASE_URL}/api/chats/${savedChatId}/messages`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const { messages } = await res.json()
    assert.ok(messages.some((m) => m.text === text), 'sent message should be persisted')
  })
})
