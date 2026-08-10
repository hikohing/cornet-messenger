import test from 'node:test'
import assert from 'node:assert/strict'

// Групповые ключи глазами сервера: он раздаёт обёртки по принадлежности и не
// должен позволять ни выдать ключ не тому, ни воскресить поколение, из которого
// участника уже вывели.
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:4000'
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

/** Обёртка ключа для участника. Содержимое серверу непрозрачно — важна только форма. */
function share(userId, marker) {
  return {
    userId,
    wrappedKey: `wrapped-${marker}-${userId}`,
    iv: 'aXYtYmFzZTY0',
    ephemeralPublicKey: { kty: 'OKP', crv: 'X25519', x: `x-${marker}-${userId}` },
  }
}

async function keyState(token, chatId) {
  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/group-key`, { headers: authed(token) })
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}

async function publish(token, chatId, rotation, shares) {
  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/group-key`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify({ rotation, shares }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

test('групповые ключи', async (t) => {
  const owner = await register()
  const member = await register()
  const stranger = await register()

  const groupRes = await fetch(`${BASE_URL}/api/chats/group`, {
    method: 'POST',
    headers: authed(owner.token),
    body: JSON.stringify({ name: 'Ключевая группа', usernames: [member.username] }),
  })
  assert.equal(groupRes.status, 200)
  const { chat } = await groupRes.json()

  await t.test('у новой группы ключа ещё нет', async () => {
    const state = await keyState(owner.token, chat.id)
    assert.equal(state.status, 200)
    assert.equal(state.body.rotation, 0, 'действующего поколения быть не должно')
    assert.equal(state.body.nextRotation, 1)
    assert.deepEqual([...state.body.memberIds].sort(), [owner.id, member.id].sort())
  })

  await t.test('ключ раздаётся всем участникам и только им', async () => {
    const published = await publish(owner.token, chat.id, 1, [share(owner.id, 'r1'), share(member.id, 'r1')])
    assert.equal(published.status, 200)
    assert.equal(published.body.accepted, true)

    const forOwner = await keyState(owner.token, chat.id)
    const forMember = await keyState(member.token, chat.id)
    assert.equal(forOwner.body.rotation, 1)
    assert.equal(forOwner.body.shares.length, 1)
    assert.equal(forOwner.body.shares[0].wrappedKey, `wrapped-r1-${owner.id}`)
    assert.equal(forMember.body.shares[0].wrappedKey, `wrapped-r1-${member.id}`, 'каждому своя обёртка')
  })

  await t.test('посторонний не видит ключей группы', async () => {
    const state = await keyState(stranger.token, chat.id)
    assert.equal(state.status, 403)
  })

  await t.test('нельзя выдать ключ не участнику', async () => {
    const bad = await publish(owner.token, chat.id, 2, [
      share(owner.id, 'r2'),
      share(member.id, 'r2'),
      share(stranger.id, 'r2'),
    ])
    assert.equal(bad.status, 400)
  })

  await t.test('нельзя оставить участника без ключа', async () => {
    const bad = await publish(owner.token, chat.id, 2, [share(owner.id, 'r2')])
    assert.equal(bad.status, 400, 'иначе у него будет нечитаемая переписка')
  })

  await t.test('второй публикующий не перетирает чужое поколение', async () => {
    const late = await publish(member.token, chat.id, 1, [share(owner.id, 'later'), share(member.id, 'later')])
    assert.equal(late.body.accepted, false, 'поколение 1 уже занято')

    const state = await keyState(owner.token, chat.id)
    assert.equal(state.body.shares[0].wrappedKey, `wrapped-r1-${owner.id}`, 'осталась исходная обёртка')
  })

  await t.test('после ухода участника прежний ключ перестаёт быть действующим', async () => {
    const left = await fetch(`${BASE_URL}/api/chats/${chat.id}/leave`, {
      method: 'POST',
      headers: authed(member.token),
    })
    assert.equal(left.status, 200)

    const state = await keyState(owner.token, chat.id)
    assert.equal(state.body.rotation, 0, 'действующего поколения больше нет')
    assert.equal(state.body.nextRotation, 2, 'следующее поколение — строго новое')
    assert.equal(state.body.shares.length, 1, 'старая доля остаётся: прежняя переписка должна читаться')
  })

  await t.test('воскресить поколение, которое знает ушедший, нельзя', async () => {
    // Самая важная проверка: если бы сервер принял повторную публикацию первого
    // поколения, группа вернулась бы к ключу, который ушедший уже знает.
    const replay = await publish(owner.token, chat.id, 1, [share(owner.id, 'replay')])
    assert.equal(replay.body?.accepted ?? false, false)

    const state = await keyState(owner.token, chat.id)
    assert.equal(state.body.rotation, 0, 'старое поколение не должно снова стать действующим')
  })

  await t.test('новое поколение создаётся для оставшегося состава', async () => {
    const published = await publish(owner.token, chat.id, 2, [share(owner.id, 'r2')])
    assert.equal(published.body.accepted, true)

    const state = await keyState(owner.token, chat.id)
    assert.equal(state.body.rotation, 2)
    assert.equal(state.body.shares.length, 2, 'доступны и старая доля, и новая')
  })
})
