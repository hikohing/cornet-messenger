import { many, one, run, withTransaction } from './db.js'
import { appError } from './errors.js'
import { isMember, membersOf } from './chats.js'

/**
 * Групповые ключи шифрования.
 *
 * Сервер никогда не видит сам ключ группы. Он хранит только его копии,
 * завёрнутые под каждого участника его же публичным ключом: развернуть такую
 * копию может лишь владелец соответствующего приватного ключа. Для сервера это
 * непрозрачные строки, которые он раздаёт по принадлежности.
 *
 * Ключ живёт «поколениями» (rotation). Когда участник уходит, поколение
 * увеличивается: старые сообщения остаются читаемыми у тех, у кого есть старая
 * доля, а к новым ушедший доступа уже не получит. Новое поколение создаёт
 * клиент — сервер не может, у него нет ключа.
 */

/** Долей больше, чем участников в самой большой мыслимой группе, быть не может. */
const MAX_SHARES = 200

function toShare(row) {
  return {
    rotation: row.rotation_number,
    wrappedKey: row.wrapped_key,
    iv: row.iv,
    ephemeralPublicKey: row.ephemeral_public_key,
  }
}

/**
 * Всё, что нужно клиенту, чтобы читать и писать в группу: текущее поколение,
 * все доступные ему доли (включая старые — ради истории) и состав участников,
 * для которых надо будет заворачивать новый ключ.
 */
export async function getGroupKeyState(chatId, userId) {
  if (!(await isMember(chatId, userId))) throw appError('Нет доступа к чату', 403)

  const current = await one('SELECT rotation_number FROM group_encryption_keys WHERE chat_id = $1', [chatId])
  const shares = await many(
    `SELECT rotation_number, wrapped_key, iv, ephemeral_public_key
       FROM group_key_shares WHERE chat_id = $1 AND user_id = $2
      ORDER BY rotation_number`,
    [chatId, userId],
  )

  const highest = await one(
    'SELECT COALESCE(MAX(rotation_number), 0) AS max FROM group_key_shares WHERE chat_id = $1',
    [chatId],
  )

  return {
    rotation: current?.rotation_number ?? 0,
    // Номер, с которого создавать следующее поколение: строго больше любого
    // выданного раньше, иначе сервер такую публикацию отклонит.
    nextRotation: Number(highest?.max ?? 0) + 1,
    shares: shares.map(toShare),
    memberIds: await membersOf(chatId),
  }
}

/**
 * Публикует новое поколение ключа: по одной обёртке на каждого участника.
 *
 * Гонка двух клиентов, одновременно решивших создать поколение, разрешается
 * тем, что номер поколения уникален: второй получит отказ и перечитает то, что
 * записал первый. Иначе половина группы шифровала бы одним ключом, половина —
 * другим.
 */
export async function publishGroupKey(chatId, userId, rotation, shares) {
  if (!(await isMember(chatId, userId))) throw appError('Нет доступа к чату', 403)
  if (!Number.isInteger(rotation) || rotation < 1) throw appError('Некорректное поколение ключа')
  if (!Array.isArray(shares) || shares.length === 0 || shares.length > MAX_SHARES) {
    throw appError('Некорректный набор ключей')
  }

  const members = new Set(await membersOf(chatId))
  const prepared = shares.map((share) => {
    const memberId = Number(share?.userId)
    if (!members.has(memberId)) throw appError('Ключ выдан не участнику чата')
    const wrappedKey = String(share?.wrappedKey ?? '')
    const iv = String(share?.iv ?? '')
    if (!wrappedKey || wrappedKey.length > 4096 || !iv || iv.length > 64) throw appError('Некорректный ключ')
    if (!share?.ephemeralPublicKey || typeof share.ephemeralPublicKey !== 'object') {
      throw appError('Некорректный ключ')
    }
    return { memberId, wrappedKey, iv, ephemeralPublicKey: share.ephemeralPublicKey }
  })

  // Каждый участник должен получить ровно одну долю — иначе кто-то останется
  // без доступа и увидит вместо переписки нечитаемые сообщения.
  if (prepared.length !== members.size) throw appError('Ключ выдан не всем участникам')

  const now = Date.now()
  return withTransaction(async (client) => {
    // Сравниваем с максимальным когда-либо выданным поколением, а не с текущим
    // указателем: после ухода участника указатель сбрасывается в ноль, и
    // сравнение с ним позволило бы переопубликовать уже существующее поколение.
    // Доли для него остались бы прежними (ON CONFLICT DO NOTHING), то есть
    // группа вернулась бы к ключу, который ушедший знает.
    // Блокируем строку чата: с агрегатной функцией FOR UPDATE не работает, а
    // без блокировки два одновременных клиента прочитали бы одинаковый максимум.
    await client.query('SELECT id FROM chats WHERE id = $1 FOR UPDATE', [chatId])
    const highest = await client.query(
      'SELECT COALESCE(MAX(rotation_number), 0) AS max FROM group_key_shares WHERE chat_id = $1',
      [chatId],
    )
    const usedRotation = Number(highest.rows[0]?.max ?? 0)
    if (rotation <= usedRotation) {
      // Кто-то успел раньше — клиент перечитает состояние и возьмёт его ключ.
      return { accepted: false, rotation: usedRotation }
    }

    await client.query(
      `INSERT INTO group_encryption_keys (chat_id, rotation_number, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET rotation_number = $2, created_at = $3`,
      [chatId, rotation, now],
    )
    for (const share of prepared) {
      await client.query(
        `INSERT INTO group_key_shares (chat_id, user_id, rotation_number, wrapped_key, iv, ephemeral_public_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (chat_id, user_id, rotation_number) DO NOTHING`,
        [chatId, share.memberId, rotation, share.wrappedKey, share.iv, JSON.stringify(share.ephemeralPublicKey), now],
      )
    }
    return { accepted: true, rotation }
  })
}

/**
 * Участник ушёл — поколение объявляется устаревшим, чтобы к новым сообщениям
 * он доступа не имел. Сами доли не удаляем: они нужны остальным, чтобы читать
 * прежнюю переписку.
 *
 * Новый ключ создаст первый, кто соберётся что-то написать: сервер этого
 * сделать не может, потому что ключа не знает.
 */
export async function invalidateGroupKey(chatId) {
  // Обнуляем указатель на действующее поколение: сами доли остаются — они нужны
  // оставшимся, чтобы читать прежнюю переписку, — но клиенты увидят, что
  // актуального ключа нет, и создадут следующее поколение.
  await run('UPDATE group_encryption_keys SET rotation_number = 0 WHERE chat_id = $1', [chatId])
}
