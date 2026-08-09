import { one, many, run } from './db.js'
import { appError } from './errors.js'

const MAX_FOLDERS = 10
const MAX_FOLDER_NAME = 32

/** «Навсегда» — это просто очень далёкая дата, отдельного флага не нужно. */
export const MUTE_FOREVER = 8640000000000000

export async function listFolders(userId) {
  const folders = await many(
    'SELECT id, name, position FROM chat_folders WHERE user_id = $1 ORDER BY position, id',
    [userId],
  )
  if (folders.length === 0) return []
  const items = await many(
    `SELECT i.folder_id, i.chat_id FROM chat_folder_items i
     JOIN chat_folders f ON f.id = i.folder_id
     WHERE f.user_id = $1`,
    [userId],
  )
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    position: f.position,
    chatIds: items.filter((i) => i.folder_id === f.id).map((i) => i.chat_id),
  }))
}

export async function createFolder(userId, name, chatIds) {
  const trimmed = String(name ?? '').trim().slice(0, MAX_FOLDER_NAME)
  if (!trimmed) throw appError('Введите название папки')

  const existing = await one('SELECT COUNT(*)::int AS count FROM chat_folders WHERE user_id = $1', [userId])
  if (existing.count >= MAX_FOLDERS) throw appError(`Не больше ${MAX_FOLDERS} папок`)

  const folder = await one(
    'INSERT INTO chat_folders (user_id, name, position, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, trimmed, existing.count, Date.now()],
  )
  await setFolderChats(userId, folder.id, chatIds)
  return folder.id
}

export async function renameFolder(userId, folderId, name) {
  const trimmed = String(name ?? '').trim().slice(0, MAX_FOLDER_NAME)
  if (!trimmed) throw appError('Введите название папки')
  const owned = await one('SELECT 1 FROM chat_folders WHERE id = $1 AND user_id = $2', [folderId, userId])
  if (!owned) throw appError('Папка не найдена')
  await run('UPDATE chat_folders SET name = $1 WHERE id = $2', [trimmed, folderId])
}

export async function deleteFolder(userId, folderId) {
  const owned = await one('SELECT 1 FROM chat_folders WHERE id = $1 AND user_id = $2', [folderId, userId])
  if (!owned) throw appError('Папка не найдена')
  await run('DELETE FROM chat_folders WHERE id = $1', [folderId])
}

/**
 * Полностью заменяет состав папки. В неё попадают только те чаты, где
 * пользователь действительно состоит — иначе через подбор id можно было бы
 * узнать о существовании чужих чатов.
 */
export async function setFolderChats(userId, folderId, chatIds) {
  const owned = await one('SELECT 1 FROM chat_folders WHERE id = $1 AND user_id = $2', [folderId, userId])
  if (!owned) throw appError('Папка не найдена')

  const ids = (Array.isArray(chatIds) ? chatIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 200)

  await run('DELETE FROM chat_folder_items WHERE folder_id = $1', [folderId])
  if (ids.length === 0) return

  const allowed = await many(
    'SELECT chat_id FROM chat_members WHERE user_id = $1 AND chat_id = ANY($2::int[])',
    [userId, ids],
  )
  for (const row of allowed) {
    await run('INSERT INTO chat_folder_items (folder_id, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      folderId,
      row.chat_id,
    ])
  }
}

export async function setArchived(chatId, userId, archived) {
  const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  if (!member) throw appError('Нет доступа к чату')
  await run('UPDATE chat_members SET archived = $1 WHERE chat_id = $2 AND user_id = $3', [
    Boolean(archived),
    chatId,
    userId,
  ])
}

export async function setMuted(chatId, userId, mutedUntil) {
  const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  if (!member) throw appError('Нет доступа к чату')
  const value = mutedUntil === null ? null : Number(mutedUntil)
  if (value !== null && (!Number.isFinite(value) || value <= Date.now())) {
    throw appError('Некорректный срок отключения уведомлений')
  }
  await run('UPDATE chat_members SET muted_until = $1 WHERE chat_id = $2 AND user_id = $3', [value, chatId, userId])
}
