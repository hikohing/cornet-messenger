import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachCalleeSocket,
  bufferSignal,
  configureCallRuntime,
  finishCall,
  getCall,
  isAwaitingWake,
  registerCall,
} from '../src/calls.js'
import { pool } from '../src/db.js'

// Реестр звонков — чистая память процесса, поэтому проверяем его напрямую, без
// сервера: именно здесь живёт логика ожидания устройства, разбуженного
// VoIP-пушем. Сокеты подменяем объектами — модуль только раскладывает их по
// множествам и отдаёт в runtime.sendTo.

const sent = []
configureCallRuntime({
  sendTo(sockets, payload) {
    for (const socket of sockets) sent.push({ socket, payload })
  },
  async onCallMessage() {},
})

// finishCall пишет запись в историю чата; чата с таким id нет, ошибка внутри
// проглатывается — но пул соединений остаётся открытым и держал бы процесс.
after(() => pool.end())

function fakeSocket(name) {
  return { name }
}

function newCall(callId, { calleeSockets = [], offer = null } = {}) {
  return registerCall({
    callId,
    chatId: -1,
    callerId: 1,
    calleeId: 2,
    video: false,
    callerSocket: fakeSocket('caller'),
    calleeSockets,
    offer,
  })
}

test('звонок ждёт устройство, разбуженное пушем', async (t) => {
  t.after(async () => {
    await finishCall('wake-1', null, 'hangup')
  })

  const call = newCall('wake-1', { offer: { type: 'offer', sdp: 'v=0 fake' } })

  assert.equal(isAwaitingWake(call), true, 'без сокетов собеседника звонок должен ждать пробуждения')

  // Пока устройство просыпается, ICE-кандидаты звонящего копятся на сервере.
  bufferSignal(call, { type: 'call_ice', callId: 'wake-1', candidate: { candidate: 'a' } })
  bufferSignal(call, { type: 'call_ice', callId: 'wake-1', candidate: { candidate: 'b' } })

  const socket = fakeSocket('callee-woken')
  const claimed = attachCalleeSocket('wake-1', 2, socket)

  assert.ok(claimed, 'собеседник должен суметь забрать свой звонок')
  assert.deepEqual(claimed.offer, { type: 'offer', sdp: 'v=0 fake' }, 'оффер обязан дождаться устройства')
  assert.equal(claimed.signals.length, 2, 'накопленный сигналинг уходит вместе с приглашением')
  assert.equal(isAwaitingWake(call), false, 'после подключения сокета звонок больше не ждёт')
  assert.equal(call.bufferedSignals.length, 0, 'буфер отдают ровно один раз')
})

test('чужой звонок забрать нельзя', async (t) => {
  t.after(async () => {
    await finishCall('wake-2', null, 'hangup')
  })
  newCall('wake-2')

  assert.equal(attachCalleeSocket('wake-2', 999, fakeSocket('stranger')), null)
  assert.equal(attachCalleeSocket('нет-такого', 2, fakeSocket('callee')), null)
})

test('если устройство не отозвалось, звонок закрывается как недоступный', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())

  const callerSocket = fakeSocket('caller-waiting')
  registerCall({
    callId: 'wake-3',
    chatId: -1,
    callerId: 1,
    calleeId: 2,
    video: false,
    callerSocket,
    calleeSockets: [],
    offer: { type: 'offer', sdp: 'v=0 fake' },
  })

  sent.length = 0
  // Ровно окно пробуждения: 25 секунд.
  t.mock.timers.tick(25_000)
  // finishCall асинхронный — даём микрозадачам довернуться.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(getCall('wake-3'), null, 'звонок должен быть снят с учёта')
  const notice = sent.find((item) => item.socket === callerSocket)
  assert.ok(notice, 'звонящий обязан узнать, что звонок не состоялся')
  assert.equal(notice.payload.type, 'call_end')
  assert.equal(notice.payload.reason, 'unavailable')
})

test('уже принятый звонок вторым устройством не перехватывается', async (t) => {
  t.after(async () => {
    await finishCall('wake-4', null, 'hangup')
  })

  const first = fakeSocket('phone')
  const call = newCall('wake-4', { offer: { type: 'offer', sdp: 'v=0 fake' } })
  assert.ok(attachCalleeSocket('wake-4', 2, first))

  call.answeredAt = Date.now()
  assert.equal(attachCalleeSocket('wake-4', 2, fakeSocket('tablet')), null)
})
