import { one, many, run, pool } from './db.js'
import { appError } from './errors.js'

export const MAX_POLL_OPTIONS = 10
export const MIN_POLL_OPTIONS = 2
const MAX_QUESTION_LENGTH = 255
const MAX_OPTION_LENGTH = 100

/**
 * Опрос — единственный тип сообщения, который сервер обязан читать: он считает
 * голоса. Поэтому опросы разрешены только в группах, где переписка и так не
 * зашифрована сквозным шифрованием. В личных чатах это молча ломало бы
 * обещание E2E, поэтому там опрос создать нельзя.
 */
export async function assertPollAllowed(chatId, userId) {
  const chat = await one('SELECT type FROM chats WHERE id = $1', [chatId])
  if (!chat) throw appError('Чат не найден')
  if (chat.type !== 'group') throw appError('Опросы доступны только в группах')
  const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  if (!member) throw appError('Нет доступа к чату')
}

export function normalizePollInput(raw) {
  const question = String(raw?.question ?? '').trim().slice(0, MAX_QUESTION_LENGTH)
  if (!question) throw appError('Введите вопрос')

  const options = (Array.isArray(raw?.options) ? raw.options : [])
    .map((o) => String(o ?? '').trim().slice(0, MAX_OPTION_LENGTH))
    .filter(Boolean)
  if (options.length < MIN_POLL_OPTIONS) throw appError('Нужно минимум два варианта')
  if (options.length > MAX_POLL_OPTIONS) throw appError(`Не больше ${MAX_POLL_OPTIONS} вариантов`)
  if (new Set(options).size !== options.length) throw appError('Варианты не должны повторяться')

  return {
    question,
    options,
    anonymous: raw?.anonymous !== false,
    multipleChoice: Boolean(raw?.multipleChoice),
  }
}

/** Создаёт опрос и привязанное к нему сообщение одной транзакцией. */
export async function createPoll(chatId, senderId, input) {
  const { question, options, anonymous, multipleChoice } = normalizePollInput(input)
  const createdAt = Date.now()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const messageRes = await client.query(
      `INSERT INTO messages (chat_id, sender_id, type, text, created_at)
       VALUES ($1, $2, 'poll', '', $3) RETURNING id`,
      [chatId, senderId, createdAt],
    )
    const messageId = messageRes.rows[0].id

    await client.query(
      `INSERT INTO polls (message_id, chat_id, question, anonymous, multiple_choice, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, chatId, question, anonymous, multipleChoice, createdAt],
    )
    for (const [index, text] of options.entries()) {
      await client.query('INSERT INTO poll_options (message_id, position, text) VALUES ($1, $2, $3)', [
        messageId,
        index,
        text,
      ])
    }
    await client.query('COMMIT')
    return messageId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Голосует за вариант. Повторный клик по уже выбранному варианту снимает голос.
 * В опросе с одним вариантом ответа прежний голос заменяется новым.
 */
export async function votePoll(messageId, userId, optionId) {
  const poll = await one('SELECT * FROM polls WHERE message_id = $1', [messageId])
  if (!poll) throw appError('Опрос не найден')
  if (poll.closed) throw appError('Опрос завершён')

  const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [poll.chat_id, userId])
  if (!member) throw appError('Нет доступа к чату')

  const option = await one('SELECT id FROM poll_options WHERE id = $1 AND message_id = $2', [optionId, messageId])
  if (!option) throw appError('Вариант не найден')

  const existing = await one('SELECT 1 FROM poll_votes WHERE message_id = $1 AND option_id = $2 AND user_id = $3', [
    messageId,
    optionId,
    userId,
  ])

  if (existing) {
    await run('DELETE FROM poll_votes WHERE message_id = $1 AND option_id = $2 AND user_id = $3', [
      messageId,
      optionId,
      userId,
    ])
  } else {
    if (!poll.multiple_choice) {
      await run('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2', [messageId, userId])
    }
    await run('INSERT INTO poll_votes (message_id, option_id, user_id, created_at) VALUES ($1, $2, $3, $4)', [
      messageId,
      optionId,
      userId,
      Date.now(),
    ])
  }

  return poll.chat_id
}

export async function closePoll(messageId, userId) {
  const poll = await one('SELECT p.*, m.sender_id FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = $1', [messageId])
  if (!poll) throw appError('Опрос не найден')
  if (poll.sender_id !== userId) throw appError('Завершить опрос может только автор')
  await run('UPDATE polls SET closed = true WHERE message_id = $1', [messageId])
  return poll.chat_id
}

/**
 * Собирает опрос для показа. `viewerId` нужен, чтобы отметить собственные
 * голоса; в анонимном опросе список проголосовавших не отдаётся вообще —
 * иначе анонимность была бы только на словах.
 */
export async function getPoll(messageId, viewerId) {
  const poll = await one('SELECT * FROM polls WHERE message_id = $1', [messageId])
  if (!poll) return null

  const options = await many('SELECT id, position, text FROM poll_options WHERE message_id = $1 ORDER BY position', [messageId])
  const votes = await many('SELECT option_id, user_id FROM poll_votes WHERE message_id = $1', [messageId])

  const totalVoters = new Set(votes.map((v) => v.user_id)).size

  return {
    messageId,
    question: poll.question,
    anonymous: poll.anonymous,
    multipleChoice: poll.multiple_choice,
    closed: poll.closed,
    totalVoters,
    options: options.map((o) => {
      const optionVotes = votes.filter((v) => v.option_id === o.id)
      return {
        id: o.id,
        text: o.text,
        votes: optionVotes.length,
        chosen: optionVotes.some((v) => v.user_id === viewerId),
        voterIds: poll.anonymous ? null : optionVotes.map((v) => v.user_id),
      }
    }),
  }
}

/** Массово подтягивает опросы к списку сообщений (для истории чата). */
export async function attachPolls(messages, viewerId) {
  const pollMessages = messages.filter((m) => m.type === 'poll')
  if (pollMessages.length === 0) return messages
  const polls = await Promise.all(pollMessages.map((m) => getPoll(m.id, viewerId)))
  const byId = new Map(polls.filter(Boolean).map((p) => [p.messageId, p]))
  return messages.map((m) => (m.type === 'poll' ? { ...m, poll: byId.get(m.id) ?? null } : m))
}
