import { one, many, run } from './db.js'
import { appError } from './errors.js'
import { isBlockedEitherWay } from './blocking.js'

function toPublicUserRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || null,
    color: row.color,
    avatarUrl: row.avatar_url,
    bannerUrl: row.banner_url,
    bannerStyle: row.banner_style ?? 'profile',
    avatarDecoration: row.avatar_decoration ?? 'none',
    profileEffect: row.profile_effect ?? 'none',
    profileTheme: row.profile_theme ?? 'default',
    nameStyle: row.name_style ?? 'plain',
    profileFrame: row.profile_frame ?? 'none',
    nameplateStyle: row.nameplate_style ?? 'none',
    profilePrimaryColor: row.profile_primary_color,
    profileSecondaryColor: row.profile_secondary_color,
    showLastSeen: row.show_last_seen,
    bio: row.bio ?? '',
    birthDate: row.birth_date,
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    createdAt: row.created_at ? Number(row.created_at) : null,
  }
}

function toPublicMessage(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    type: row.type,
    text: row.text,
    attachmentUrl: row.attachment_url,
    attachment: row.attachment_meta ?? null,
    replyToId: row.reply_to_id,
    forwarded: row.forwarded,
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    deleted: row.deleted,
    callMeta: row.call_meta ?? null,
    createdAt: Number(row.created_at),
  }
}

export async function searchUsers(query, excludeUserId) {
  query = query.trim().replace(/^@/, '')
  const rows = await many(
    `SELECT id, username, display_name, color, avatar_url FROM users
     WHERE (username ILIKE $1 OR display_name ILIKE $2) AND id != $3
     ORDER BY CASE WHEN username ILIKE $1 THEN 0 ELSE 1 END, username LIMIT 10`,
    [`${query}%`, `%${query}%`, excludeUserId],
  )
  return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || null, color: r.color, avatarUrl: r.avatar_url }))
}

export async function isMember(chatId, userId) {
  const row = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  return Boolean(row)
}

/** Собеседника в личном чате — null для групп/избранного, где блокировка не применяется. */
export async function otherDirectMemberId(chatId, userId) {
  const chat = await one('SELECT type FROM chats WHERE id = $1', [chatId])
  if (chat?.type !== 'direct') return null
  const row = await one('SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id != $2', [chatId, userId])
  return row?.user_id ?? null
}

export async function createSavedChat(userId) {
  const chat = await one(
    "INSERT INTO chats (type, name, created_at) VALUES ('saved', 'Избранное', $1) RETURNING id",
    [Date.now()],
  )
  await run('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.id, userId])
  return chat.id
}

export async function getOrCreateDirectChat(userId, otherUsername) {
  const other = await one('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [otherUsername.trim()])
  if (!other) throw appError('Пользователь не найден')
  if (other.id === userId) throw appError('Нельзя начать чат с самим собой')

  const existing = await one(
    `SELECT chats.id as id FROM chats
     WHERE chats.type = 'direct'
       AND chats.id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)
       AND chats.id IN (SELECT chat_id FROM chat_members WHERE user_id = $2)`,
    [userId, other.id],
  )
  if (existing) return { chat: await getChatForViewer(existing.id, userId), created: false }

  if (await isBlockedEitherWay(userId, other.id)) throw appError('Нельзя начать переписку с этим пользователем')

  const chat = await one("INSERT INTO chats (type, name, created_at) VALUES ('direct', NULL, $1) RETURNING id", [
    Date.now(),
  ])
  await run('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)', [chat.id, userId, other.id])
  return { chat: await getChatForViewer(chat.id, userId), created: true }
}

export async function createGroupChat(creatorId, name, usernames) {
  const trimmedName = name.trim()
  if (trimmedName.length < 1) throw appError('Введите название группы')
  const memberIds = new Set([creatorId])
  for (const username of usernames) {
    const user = await one('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()])
    if (!user) throw appError(`Пользователь "${username}" не найден`)
    memberIds.add(user.id)
  }
  if (memberIds.size < 2) throw appError('Добавьте хотя бы одного участника')

  const chat = await one("INSERT INTO chats (type, name, created_at) VALUES ('group', $1, $2) RETURNING id", [
    trimmedName,
    Date.now(),
  ])
  for (const id of memberIds) {
    await run('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)', [chat.id, id])
  }
  return { chat: await getChatForViewer(chat.id, creatorId), created: true }
}

export async function hydrateChat(chatId, viewerId) {
  const chatRow = await one('SELECT id, type, name, description, avatar_url, pinned_message_id FROM chats WHERE id = $1', [chatId])
  const memberRows = await many(
    `SELECT users.id, users.username, users.display_name, users.color, users.avatar_url, users.banner_url, users.banner_style, users.avatar_decoration, users.profile_effect, users.profile_theme, users.name_style, users.profile_frame, users.nameplate_style, users.profile_primary_color, users.profile_secondary_color, users.show_last_seen, users.bio, users.birth_date, users.last_seen_at, users.created_at
     FROM chat_members JOIN users ON users.id = chat_members.user_id WHERE chat_members.chat_id = $1`,
    [chatId],
  )
  const members = memberRows.map(toPublicUserRow)
  const readState = await many(
    'SELECT user_id as "userId", last_read_message_id as "lastReadMessageId" FROM chat_members WHERE chat_id = $1',
    [chatId],
  )
  const viewerRow = await one('SELECT pinned FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, viewerId])
  const pinned = Boolean(viewerRow?.pinned)
  const unread = await one(
    `SELECT COUNT(*)::int as count FROM messages
     WHERE chat_id = $1 AND sender_id != $2 AND deleted = false
       AND id > COALESCE((SELECT last_read_message_id FROM chat_members WHERE chat_id = $1 AND user_id = $2), 0)`,
    [chatId, viewerId],
  )

  let name = chatRow.name
  if (chatRow.type === 'direct') {
    const other = members.find((m) => m.id !== viewerId)
    name = other ? other.displayName || other.username : 'Чат'
  }

  let pinnedMessage = null
  if (chatRow.pinned_message_id) {
    const row = await one('SELECT * FROM messages WHERE id = $1', [chatRow.pinned_message_id])
    if (row) pinnedMessage = toPublicMessage(row)
  }

  return {
    id: chatId,
    type: chatRow.type,
    name,
    description: chatRow.description ?? '',
    avatarUrl: chatRow.avatar_url,
    members,
    readState,
    unreadCount: unread.count,
    pinnedMessage,
    pinned,
  }
}

export async function updateChatInfo(chatId, userId, { name, description, avatarUrl }) {
  if (!(await isMember(chatId, userId))) throw appError('Нет доступа к чату')
  const chatRow = await one('SELECT type, name, description, avatar_url FROM chats WHERE id = $1', [chatId])
  if (chatRow.type !== 'group') throw appError('Информацию можно менять только у групп')
  const trimmedName = name !== undefined ? name.trim() : chatRow.name
  if (name !== undefined && trimmedName.length < 1) throw appError('Введите название группы')
  if (description !== undefined && description.length > 300) throw appError('Описание не должно превышать 300 символов')
  await run('UPDATE chats SET name = $1, description = $2, avatar_url = $3 WHERE id = $4', [
    trimmedName,
    description !== undefined ? description : chatRow.description,
    avatarUrl !== undefined ? avatarUrl : chatRow.avatar_url,
    chatId,
  ])
  return getChatForViewer(chatId, userId)
}

export async function getLastMessage(chatId) {
  const last = await one(
    'SELECT * FROM messages WHERE chat_id = $1 AND deleted = false ORDER BY created_at DESC LIMIT 1',
    [chatId],
  )
  return last ? toPublicMessage(last) : null
}

/** Full chat payload for one viewer, including its latest visible message. */
export async function getChatForViewer(chatId, viewerId) {
  const hydrated = await hydrateChat(chatId, viewerId)
  return { ...hydrated, lastMessage: await getLastMessage(chatId) }
}

/** Saved chat first, then pinned chats, then most recently active chats. */
export function sortChats(chats) {
  return [...chats].sort((a, b) => {
    if (a.type === 'saved') return -1
    if (b.type === 'saved') return 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0)
  })
}

export async function listChatsForUser(userId) {
  const rows = await many('SELECT chat_id FROM chat_members WHERE user_id = $1', [userId])
  const chats = []
  for (const row of rows) {
    chats.push(await getChatForViewer(row.chat_id, userId))
  }
  return sortChats(chats)
}

async function attachExtras(messages) {
  if (messages.length === 0) return []
  const ids = messages.map((m) => m.id)
  const reactionRows = await many(
    `SELECT message_id as "messageId", emoji, array_agg(user_id) as "userIds"
     FROM reactions WHERE message_id = ANY($1::int[]) GROUP BY message_id, emoji`,
    [ids],
  )
  const replyIds = [...new Set(messages.map((m) => m.replyToId).filter(Boolean))]
  const replyRows = replyIds.length
    ? await many('SELECT * FROM messages WHERE id = ANY($1::int[])', [replyIds])
    : []
  const replyById = new Map(replyRows.map((r) => [r.id, toPublicMessage(r)]))

  return messages.map((m) => ({
    ...m,
    reactions: reactionRows
      .filter((r) => r.messageId === m.id)
      .map((r) => ({ emoji: r.emoji, userIds: r.userIds })),
    replyTo: m.replyToId ? replyById.get(m.replyToId) ?? null : null,
  }))
}

export async function getMessages(chatId) {
  const rows = await many('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC', [chatId])
  return attachExtras(rows.map(toPublicMessage))
}

export async function searchMessages(chatId, query) {
  const rows = await many(
    "SELECT * FROM messages WHERE chat_id = $1 AND deleted = false AND type <> 'call' AND text ILIKE $2 ORDER BY created_at DESC LIMIT 30",
    [chatId, `%${query}%`],
  )
  return attachExtras(rows.map(toPublicMessage))
}

/** Attachments may only reference files this server stored under /uploads. */
export function isSafeAttachmentUrl(url) {
  return typeof url === 'string' && /^\/uploads\/[A-Za-z0-9._-]{1,120}$/.test(url) && !url.includes('..')
}

export async function addMessage(chatId, senderId, { type = 'text', text = '', attachmentUrl = null, attachment = null, replyToId = null, forwarded = false, callMeta = null }) {
  if (attachmentUrl !== null && !isSafeAttachmentUrl(attachmentUrl)) {
    throw appError('Недопустимое вложение')
  }
  if (replyToId !== null) {
    // A quote may only point at a live message inside the very same chat.
    const target = await one('SELECT id FROM messages WHERE id = $1 AND chat_id = $2 AND deleted = false', [
      replyToId,
      chatId,
    ])
    if (!target) replyToId = null
  }
  const createdAt = Date.now()
  const row = await one(
    `INSERT INTO messages (chat_id, sender_id, type, text, attachment_url, attachment_meta, reply_to_id, forwarded, call_meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [chatId, senderId, type, text, attachmentUrl, attachment ? JSON.stringify(attachment) : null, replyToId, forwarded, callMeta ? JSON.stringify(callMeta) : null, createdAt],
  )
  const [withExtras] = await attachExtras([toPublicMessage(row)])
  return withExtras
}

export async function editMessage(messageId, userId, text) {
  const message = await one('SELECT * FROM messages WHERE id = $1', [messageId])
  if (!message || message.sender_id !== userId || message.deleted) return null
  if (message.type !== 'text') return null
  if (!(await isMember(message.chat_id, userId))) return null
  const editedAt = Date.now()
  await run('UPDATE messages SET text = $1, edited_at = $2 WHERE id = $3', [text, editedAt, messageId])
  const [withExtras] = await attachExtras([toPublicMessage({ ...message, text, edited_at: editedAt })])
  return withExtras
}

export async function deleteMessage(messageId, userId) {
  const message = await one('SELECT * FROM messages WHERE id = $1', [messageId])
  if (!message || message.deleted) return null
  if (!(await isMember(message.chat_id, userId))) return null
  await run("UPDATE messages SET deleted = true, text = '', attachment_url = NULL, attachment_meta = NULL WHERE id = $1", [messageId])
  // Callers rebroadcast the surviving last message so chat previews stay accurate.
  return { chatId: message.chat_id, messageId, lastMessage: await getLastMessage(message.chat_id) }
}

export async function toggleReaction(messageId, userId, emoji) {
  const message = await one('SELECT chat_id, deleted FROM messages WHERE id = $1', [messageId])
  if (!message || message.deleted) return null
  if (!(await isMember(message.chat_id, userId))) return null
  const existing = await one('SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
    messageId,
    userId,
    emoji,
  ])
  if (existing) {
    await run('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
      messageId,
      userId,
      emoji,
    ])
  } else {
    await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, userId, emoji])
  }
  const reactionRows = await many(
    'SELECT emoji, array_agg(user_id) as "userIds" FROM reactions WHERE message_id = $1 GROUP BY emoji',
    [messageId],
  )
  return { chatId: message.chat_id, messageId, reactions: reactionRows }
}

export async function forwardMessage(userId, sourceMessageId, targetChatId) {
  if (!(await isMember(targetChatId, userId))) throw appError('Нет доступа к целевому чату')
  const source = await one('SELECT * FROM messages WHERE id = $1', [sourceMessageId])
  if (!source || source.deleted) throw appError('Сообщение не найдено')
  if (source.type === 'call') throw appError('Запись о звонке нельзя переслать')
  if (!(await isMember(source.chat_id, userId))) throw appError('Нет доступа к исходному чату')
  return addMessage(targetChatId, userId, {
    type: source.type,
    text: source.text,
    attachmentUrl: source.attachment_url,
    attachment: source.attachment_meta,
    forwarded: true,
  })
}

export async function pinMessage(chatId, userId, messageId) {
  if (!(await isMember(chatId, userId))) throw appError('Нет доступа к чату')
  if (messageId) {
    const message = await one('SELECT id FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId])
    if (!message) throw appError('Сообщение не найдено')
  }
  await run('UPDATE chats SET pinned_message_id = $1 WHERE id = $2', [messageId, chatId])
}

export async function setChatPinned(chatId, userId, pinned) {
  if (!(await isMember(chatId, userId))) throw appError('Нет доступа к чату')
  await run('UPDATE chat_members SET pinned = $1 WHERE chat_id = $2 AND user_id = $3', [
    Boolean(pinned),
    chatId,
    userId,
  ])
  return getChatForViewer(chatId, userId)
}

export async function markRead(chatId, userId, messageId) {
  await run(
    'UPDATE chat_members SET last_read_message_id = $1 WHERE chat_id = $2 AND user_id = $3 AND last_read_message_id < $1',
    [messageId, chatId, userId],
  )
}

export async function membersOf(chatId) {
  const rows = await many('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId])
  return rows.map((r) => r.user_id)
}

export async function chatIdsForUser(userId) {
  const rows = await many('SELECT chat_id FROM chat_members WHERE user_id = $1', [userId])
  return rows.map((row) => row.chat_id)
}

export async function leaveGroup(chatId, userId) {
  const chatRow = await one('SELECT type FROM chats WHERE id = $1', [chatId])
  if (!chatRow || chatRow.type !== 'group') throw appError('Покинуть можно только группу')
  if (!(await isMember(chatId, userId))) throw appError('Вы не состоите в этой группе')
  await run('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  const remaining = await one('SELECT COUNT(*)::int as count FROM chat_members WHERE chat_id = $1', [chatId])
  if (remaining.count === 0) await run('DELETE FROM chats WHERE id = $1', [chatId])
}
