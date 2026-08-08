import { one, many, run } from './db.js'
import { appError } from './errors.js'

export async function blockUser(blockerId, blockedId) {
  if (blockerId === blockedId) throw appError('Нельзя заблокировать самого себя')
  const target = await one('SELECT id FROM users WHERE id = $1', [blockedId])
  if (!target) throw appError('Пользователь не найден')
  await run(
    'INSERT INTO blocked_users (blocker_id, blocked_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [blockerId, blockedId, Date.now()],
  )
}

export async function unblockUser(blockerId, blockedId) {
  await run('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId])
}

/** Заблокировал ли один из двух пользователей другого — направление не важно для запрета переписки. */
export async function isBlockedEitherWay(userAId, userBId) {
  const row = await one(
    'SELECT 1 FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [userAId, userBId],
  )
  return Boolean(row)
}

export async function hasBlocked(blockerId, blockedId) {
  const row = await one('SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId])
  return Boolean(row)
}

export async function listBlockedByUser(userId) {
  const rows = await many(
    `SELECT users.id, users.username, users.display_name, users.color, users.avatar_url, blocked_users.created_at
     FROM blocked_users JOIN users ON users.id = blocked_users.blocked_id
     WHERE blocked_users.blocker_id = $1 ORDER BY blocked_users.created_at DESC`,
    [userId],
  )
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name || null,
    color: row.color,
    avatarUrl: row.avatar_url,
    blockedAt: Number(row.created_at),
  }))
}
