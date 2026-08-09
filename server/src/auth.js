import crypto from 'node:crypto'
import { promisify } from 'node:util'
import * as OTPAuth from 'otpauth'
import { one, run, many, withTransaction } from './db.js'
import { createSavedChat, isSafeAttachmentUrl } from './chats.js'
import { appError } from './errors.js'
import { sendPasswordResetEmail, sendVerificationEmail, sendSecurityAlert } from './mailer.js'
import { audit } from './audit.js'

const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${process.env.PORT ?? 4000}`
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000
const TOTP_ISSUER = 'CorNet'
const BACKUP_CODE_COUNT = 10

/**
 * TOTP secrets are encrypted at rest (AES-256-GCM) so a database-only leak doesn't
 * also hand over everyone's 2FA. The key must be supplied by the operator — there is
 * deliberately no built-in fallback key, since a default key shared across every
 * deployment would defeat the point of encrypting in the first place.
 */
function loadTotpEncKey() {
  const raw = process.env.TOTP_ENC_KEY
  if (!raw) return null
  try {
    const buf = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64')
    if (buf.length !== 32) throw new Error('wrong length')
    return buf
  } catch {
    console.error('TOTP_ENC_KEY задан, но не является корректным 32-байтным ключом (64 hex-символа или 44 base64-символа) — 2FA будет недоступна.')
    return null
  }
}
const TOTP_ENC_KEY = loadTotpEncKey()

function encryptTotpSecret(plaintext) {
  if (!TOTP_ENC_KEY) throw appError('2FA не настроена на сервере — обратитесь к администратору', 500)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_ENC_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
}

function decryptTotpSecret(stored) {
  if (!TOTP_ENC_KEY) throw appError('2FA не настроена на сервере — обратитесь к администратору', 500)
  const [ivHex, tagHex, dataHex] = stored.split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_ENC_KEY, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}

function backupCodeHash(code) {
  return crypto.createHash('sha256').update(code).digest('hex')
}

/** No 0/O/1/I — avoids codes that are ambiguous to read back from a saved list. */
function generateBackupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 10; i++) code += chars[crypto.randomInt(chars.length)]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

const PALETTE = ['#6c5ce7', '#00b894', '#0984e3', '#e17055', '#d63031', '#00cec9', '#e84393', '#fdcb6e']
const scrypt = promisify(crypto.scrypt)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS_PER_USER = 8
const DUMMY_PASSWORD_HASH = 'c4b3c1f67f6c9dcafdd6496c9a906cd4:2c3441150a722bf4889e1c276f06d102c9413a340b7f0f9df74ee95c298a065685602308128d5e2e643b1aec8cbf45028d23fead6e38d8e0aaf70619559b31f3'
const COMMON_PASSWORDS = new Set(['password123', 'qwerty1234', '1234567890', 'admin12345', 'letmein123', 'password1'])

/**
 * Per-account lockout, independent of the per-IP express-rate-limit on /api/auth/login.
 * Protects against distributed credential stuffing (many IPs, one username) that an
 * IP-keyed limiter can't see. Kept in-memory to match the existing single-process
 * assumption already used for WS connection state in ws.js.
 */
const LOCKOUT_THRESHOLD = 6
const LOCKOUT_STEPS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]
const loginFailures = new Map()

function lockoutKeyFor(username) {
  return username.toLowerCase()
}

function isLockedOut(username) {
  const entry = loginFailures.get(lockoutKeyFor(username))
  return Boolean(entry && entry.lockedUntil > Date.now())
}

function registerLoginFailure(username) {
  const key = lockoutKeyFor(username)
  const entry = loginFailures.get(key) ?? { count: 0, lockedUntil: 0 }
  entry.count += 1
  if (entry.count >= LOCKOUT_THRESHOLD) {
    const step = Math.min(entry.count - LOCKOUT_THRESHOLD, LOCKOUT_STEPS_MS.length - 1)
    entry.lockedUntil = Date.now() + LOCKOUT_STEPS_MS[step]
    audit('auth.account_locked', { username, lockedForMs: LOCKOUT_STEPS_MS[step] })
    void sendSecurityAlert('account_locked', 'Похоже на подбор пароля', { username, failedAttempts: entry.count })
  }
  loginFailures.set(key, entry)
}

function clearLoginFailures(username) {
  loginFailures.delete(lockoutKeyFor(username))
}

function colorForUsername(username) {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = Buffer.from(await scrypt(password, salt, 64)).toString('hex')
  return `${salt}:${hash}`
}

async function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':')
    if (!salt || !/^[0-9a-f]{128}$/i.test(hash ?? '')) return false
    const expected = Buffer.from(hash, 'hex')
    const check = Buffer.from(await scrypt(String(password), salt, expected.length))
    return expected.length === check.length && crypto.timingSafeEqual(expected, check)
  } catch {
    return false
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw appError('Пароль должен содержать от 10 до 128 символов')
  }
  const groups = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)]
  if (groups.filter(Boolean).length < 3) {
    throw appError('Добавьте в пароль строчные и заглавные буквы, цифры или специальные символы')
  }
  const normalized = password.toLowerCase()
  if (COMMON_PASSWORDS.has(normalized)) {
    throw appError('Этот пароль слишком легко угадать')
  }
}

export function sessionTokenHash(token) {
  return `v1:${crypto.createHash('sha256').update(token).digest('hex')}`
}

function toPublicUser(row) {
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
    statusText: row.status_text ?? '',
    bio: row.bio ?? '',
    birthDate: row.birth_date,
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    createdAt: row.created_at ? Number(row.created_at) : null,
    // Почта видна только самому владельцу аккаунта — эта функция используется
    // исключительно для приватного "я" (login/register/me), не для карточек в чатах.
    email: row.email ?? null,
    emailVerified: Boolean(row.email_verified),
    totpEnabled: Boolean(row.totp_enabled),
  }
}

export async function register(username, password, userAgent) {
  username = typeof username === 'string' ? username.trim() : ''
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    throw appError('Username: 3–24 латинские буквы, цифры или знак подчёркивания')
  }
  validatePassword(password)
  const existing = await one('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username])
  if (existing) throw appError('Такой пользователь уже существует', 409, 'USERNAME_TAKEN')

  const passwordHash = await hashPassword(password)
  const color = colorForUsername(username)
  const row = await one(
    'INSERT INTO users (username, password_hash, color, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [username, passwordHash, color, Date.now()],
  )
  await createSavedChat(row.id)
  return createSession(row.id, userAgent)
}

export async function login(username, password, userAgent) {
  const normalizedUsername = typeof username === 'string' ? username.trim() : ''
  const safePassword = typeof password === 'string' ? password : ''
  const locked = normalizedUsername !== '' && isLockedOut(normalizedUsername)
  const user = await one('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [normalizedUsername])
  // Always run the scrypt comparison, even when locked out, so the lockout state
  // itself can't be inferred from response timing.
  const passwordMatches = await verifyPassword(safePassword, user?.password_hash ?? DUMMY_PASSWORD_HASH)
  if (!user || !passwordMatches || locked) {
    if (user) {
      audit('auth.login_failed', { username: normalizedUsername, locked })
      if (!locked) registerLoginFailure(normalizedUsername)
    }
    throw appError('Неверное имя пользователя или пароль', 401, 'INVALID_CREDENTIALS')
  }
  clearLoginFailures(normalizedUsername)
  if (user.totp_enabled) {
    const pendingToken = crypto.randomBytes(32).toString('hex')
    await run('DELETE FROM pending_logins WHERE created_at <= $1', [Date.now() - PENDING_LOGIN_TTL_MS])
    await run('INSERT INTO pending_logins (token_hash, user_id, created_at) VALUES ($1, $2, $3)', [
      sessionTokenHash(pendingToken),
      user.id,
      Date.now(),
    ])
    return { twoFactorRequired: true, pendingToken }
  }
  return createSession(user.id, userAgent)
}

/** Completes a login that was paused for 2FA — the second half of the two-step flow above. */
export async function verifyTwoFactorLogin(pendingToken, code, userAgent) {
  if (typeof pendingToken !== 'string' || !pendingToken) throw appError('Сессия входа истекла, попробуйте снова', 400)
  const row = await one('SELECT * FROM pending_logins WHERE token_hash = $1 AND created_at > $2', [
    sessionTokenHash(pendingToken),
    Date.now() - PENDING_LOGIN_TTL_MS,
  ])
  if (!row) throw appError('Сессия входа истекла, попробуйте снова', 400, 'PENDING_LOGIN_EXPIRED')
  const ok = await verifyTotpOrBackupCode(row.user_id, code)
  if (!ok) throw appError('Неверный код', 401, 'INVALID_TOTP')
  await run('DELETE FROM pending_logins WHERE token_hash = $1', [sessionTokenHash(pendingToken)])
  return createSession(row.user_id, userAgent)
}

async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  const safeUserAgent = typeof userAgent === 'string' ? userAgent.slice(0, 300) : null
  await run('DELETE FROM sessions WHERE created_at <= $1', [now - SESSION_TTL_MS])
  await run('INSERT INTO sessions (token, user_id, created_at, user_agent, last_seen_at) VALUES ($1, $2, $3, $4, $5)', [
    sessionTokenHash(token),
    userId,
    now,
    safeUserAgent,
    now,
  ])
  await run(
    `DELETE FROM sessions WHERE token IN (
       SELECT token FROM sessions WHERE user_id = $1 ORDER BY created_at DESC OFFSET $2
     )`,
    [userId, MAX_SESSIONS_PER_USER],
  )
  const user = await one('SELECT * FROM users WHERE id = $1', [userId])
  return { token, user: toPublicUser(user) }
}

export async function userFromToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return null
  const row = await one(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token IN ($1, $2) AND sessions.created_at > $3`,
    [sessionTokenHash(token), token, Date.now() - SESSION_TTL_MS],
  )
  if (!row) return null
  return toPublicUser(row)
}

export async function touchSessionSeen(token) {
  if (typeof token !== 'string' || !token) return
  await run('UPDATE sessions SET last_seen_at = $1 WHERE token = $2', [Date.now(), sessionTokenHash(token)])
}

export async function deleteSession(token) {
  if (typeof token !== 'string' || !token) return
  await run('DELETE FROM sessions WHERE token IN ($1, $2)', [sessionTokenHash(token), token])
}

/** Session "id" exposed to the client is the hashed token — safe to show (one-way), never the bearer value. */
export async function listSessions(userId, currentToken) {
  const currentHash = typeof currentToken === 'string' ? sessionTokenHash(currentToken) : null
  const rows = await many(
    'SELECT token, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = $1 ORDER BY COALESCE(last_seen_at, created_at) DESC',
    [userId],
  )
  return rows.map((row) => ({
    id: row.token,
    userAgent: row.user_agent,
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : Number(row.created_at),
    isCurrent: row.token === currentHash,
  }))
}

/** Revokes one session by its hashed id — only if it belongs to userId. Returns true if a row was removed. */
export async function revokeSession(userId, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const result = await run('DELETE FROM sessions WHERE token = $1 AND user_id = $2', [sessionId, userId])
  return result.rowCount > 0
}

/** Revokes every session for a user except the one currently making the request. */
export async function revokeOtherSessions(userId, currentToken) {
  const currentHash = typeof currentToken === 'string' ? sessionTokenHash(currentToken) : null
  const rows = await many('SELECT token FROM sessions WHERE user_id = $1 AND token != $2', [userId, currentHash ?? '']);
  await run('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [userId, currentHash ?? ''])
  return rows.map((row) => row.token)
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || ''
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  const token = req.sessionToken ?? bearerToken
  const user = await userFromToken(token)
  if (!user) return res.status(401).json({ error: 'Требуется авторизация', code: 'UNAUTHORIZED' })
  req.user = user
  req.authToken = token
  next()
}

export async function updateProfile(userId, { color, avatarUrl, bannerUrl, bannerStyle, avatarDecoration, profileEffect, profileTheme, nameStyle, profileFrame, nameplateStyle, profilePrimaryColor, profileSecondaryColor, showLastSeen, bio, statusText, birthDate, displayName, username }) {
  const current = await one('SELECT * FROM users WHERE id = $1', [userId])
  if (bio !== undefined && bio.length > 200) throw appError('Описание не должно превышать 200 символов')
  if (statusText !== undefined && statusText.length > 60) throw appError('Статус не должен превышать 60 символов')
  if (birthDate !== undefined && birthDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    throw appError('Некорректная дата рождения')
  }
  if (displayName !== undefined && displayName !== null && displayName.length > 32) {
    throw appError('Отображаемое имя не должно превышать 32 символа')
  }
  if (avatarUrl !== undefined && avatarUrl !== null && !isSafeAttachmentUrl(avatarUrl)) {
    throw appError('Недопустимая ссылка на аватар')
  }
  if (bannerUrl !== undefined && bannerUrl !== null && !isSafeAttachmentUrl(bannerUrl)) {
    throw appError('Недопустимая ссылка на обложку')
  }
  let nextUsername = current.username
  if (username !== undefined) {
    nextUsername = String(username).trim()
    if (!/^[A-Za-z0-9_]{3,24}$/.test(nextUsername)) {
      throw appError('Username: 3–24 латинские буквы, цифры или знак подчёркивания')
    }
    const occupied = await one('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [nextUsername, userId])
    if (occupied) throw appError('Этот username уже занят')
  }
  const bannerStyles = new Set(['profile', 'ocean', 'sunset', 'aurora', 'midnight', 'berry', 'gold', 'mono', 'coral', 'mint', 'lavender', 'crimson', 'emerald', 'graphite', 'peach', 'indigo'])
  const avatarDecorations = new Set(['none', 'ring', 'neon', 'sparkles', 'double', 'halo', 'petals', 'flames', 'bubbles', 'pixel', 'frost', 'vines', 'comet', 'aurora', 'gold', 'shadow'])
  const profileEffects = new Set(['none', 'glow', 'aurora', 'grid', 'holo', 'stars', 'confetti', 'rain', 'pulse', 'scan', 'sakura', 'comet', 'snow', 'embers', 'matrix', 'ripple'])
  const profileThemes = new Set(['default', 'night', 'berry', 'ocean', 'forest', 'sunset', 'crimson', 'emerald', 'graphite', 'rose'])
  const nameStyles = new Set(['plain', 'accent', 'gradient', 'glow', 'mono', 'shadow', 'outline', 'neon'])
  const profileFrames = new Set(['none', 'accent', 'glass', 'gold', 'neon', 'ice', 'fire', 'shadow', 'emerald', 'rose'])
  const nameplateStyles = new Set(['none', 'cosmic', 'sakura', 'arcade', 'forest', 'gold', 'ocean', 'crimson', 'midnight', 'royal'])
  if (bannerStyle !== undefined && !bannerStyles.has(bannerStyle)) throw appError('Неизвестный стиль обложки')
  if (avatarDecoration !== undefined && !avatarDecorations.has(avatarDecoration)) throw appError('Неизвестное украшение аватара')
  if (profileEffect !== undefined && !profileEffects.has(profileEffect)) throw appError('Неизвестный эффект профиля')
  if (profileTheme !== undefined && !profileThemes.has(profileTheme)) throw appError('Неизвестная тема профиля')
  if (nameStyle !== undefined && !nameStyles.has(nameStyle)) throw appError('Неизвестный стиль имени')
  if (profileFrame !== undefined && !profileFrames.has(profileFrame)) throw appError('Неизвестная рамка профиля')
  if (nameplateStyle !== undefined && !nameplateStyles.has(nameplateStyle)) throw appError('Неизвестная плашка имени')
  for (const profileColor of [profilePrimaryColor, profileSecondaryColor]) {
    if (profileColor !== undefined && profileColor !== null && !/^#[0-9a-fA-F]{6}$/.test(profileColor)) {
      throw appError('Цвет профиля должен быть указан в формате #RRGGBB')
    }
  }
  await run(
    `UPDATE users SET color = $1, avatar_url = $2, show_last_seen = $3, bio = $4, birth_date = $5,
     display_name = $6, username = $7, banner_url = $8, banner_style = $9, avatar_decoration = $10,
     profile_effect = $11, profile_theme = $12, name_style = $13, profile_frame = $14,
     nameplate_style = $15, profile_primary_color = $16, profile_secondary_color = $17, status_text = $18 WHERE id = $19`,
    [
      color ?? current.color,
      avatarUrl !== undefined ? avatarUrl : current.avatar_url,
      showLastSeen !== undefined ? Boolean(showLastSeen) : current.show_last_seen,
      bio !== undefined ? bio : current.bio,
      birthDate !== undefined ? birthDate : current.birth_date,
      displayName !== undefined ? (displayName.trim() || null) : current.display_name,
      nextUsername,
      bannerUrl !== undefined ? bannerUrl : current.banner_url,
      bannerStyle !== undefined ? bannerStyle : current.banner_style,
      avatarDecoration !== undefined ? avatarDecoration : current.avatar_decoration,
      profileEffect !== undefined ? profileEffect : current.profile_effect,
      profileTheme !== undefined ? profileTheme : current.profile_theme,
      nameStyle !== undefined ? nameStyle : current.name_style,
      profileFrame !== undefined ? profileFrame : current.profile_frame,
      nameplateStyle !== undefined ? nameplateStyle : current.nameplate_style,
      profilePrimaryColor !== undefined ? profilePrimaryColor : current.profile_primary_color,
      profileSecondaryColor !== undefined ? profileSecondaryColor : current.profile_secondary_color,
      statusText !== undefined ? statusText.trim() : current.status_text,
      userId,
    ],
  )
  return toPublicUser(await one('SELECT * FROM users WHERE id = $1', [userId]))
}

export async function changePassword(userId, oldPassword, newPassword, userAgent) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId])
  validatePassword(newPassword)
  if (!(await verifyPassword(oldPassword, user.password_hash))) throw appError('Неверный текущий пароль', 401, 'INVALID_PASSWORD')
  if (await verifyPassword(newPassword, user.password_hash)) throw appError('Новый пароль должен отличаться от текущего')
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), userId])
  await run('DELETE FROM sessions WHERE user_id = $1', [userId])
  clearLoginFailures(user.username)
  return createSession(userId, userAgent)
}

/**
 * Полное удаление аккаунта — требование App Store (5.1.1v) и просто честное
 * поведение: «удалить» должно означать удалить, а не отключить.
 *
 * Что происходит:
 *  - строка пользователя удаляется, и по внешним ключам с ней уходят сессии,
 *    сообщения, реакции, голоса в опросах, ключи шифрования, папки, блокировки
 *    и зарегистрированные устройства для пушей;
 *  - личные чаты удаляются целиком: переписка один на один без одной стороны
 *    нерабочая — писать в неё некому, а сообщения ушедшего и так исчезли;
 *  - группы остаются жить, но если участников не осталось — удаляются;
 *  - закреплённые сообщения, указывавшие на удалённые, отцепляются.
 *
 * Всё одной транзакцией: аккаунт, удалённый наполовину, хуже неудалённого.
 *
 * @returns {Promise<{ files: string[], removedChats: Array<{ chatId: number, memberIds: number[] }>, groupChatIds: number[] }>}
 *   files — что убрать с диска; removedChats и groupChatIds — кому разослать
 *   обновления, чтобы у собеседников не осталось чата-призрака до перезагрузки.
 */
export async function deleteAccount(userId, password, totpCode) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId])
  if (!user) throw appError('Аккаунт не найден', 404)
  if (!(await verifyPassword(typeof password === 'string' ? password : '', user.password_hash))) {
    throw appError('Неверный пароль', 401, 'INVALID_PASSWORD')
  }
  // Пароль мог утечь — если человек включил второй фактор, для необратимого
  // действия он тем более обязателен.
  if (user.totp_enabled && !(await verifyTotpOrBackupCode(userId, totpCode))) {
    throw appError('Неверный код', 401, 'INVALID_TOTP')
  }

  const files = await many(
    `SELECT attachment_url AS url FROM messages WHERE sender_id = $1 AND attachment_url IS NOT NULL
     UNION
     SELECT avatar_url FROM users WHERE id = $1 AND avatar_url IS NOT NULL
     UNION
     SELECT banner_url FROM users WHERE id = $1 AND banner_url IS NOT NULL`,
    [userId],
  )

  // Собираем до удаления: после транзакции этих чатов уже не существует, а
  // собеседникам надо сказать, что чат пропал.
  const removedChatRows = await many(
    `SELECT c.id AS chat_id,
            ARRAY(SELECT user_id FROM chat_members WHERE chat_id = c.id AND user_id <> $1) AS member_ids
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
      WHERE c.type <> 'group'`,
    [userId],
  )
  const groupChatRows = await many(
    `SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 WHERE c.type = 'group'`,
    [userId],
  )

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM chats WHERE type <> 'group' AND id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)`,
      [userId],
    )
    await client.query('DELETE FROM users WHERE id = $1', [userId])
    // Группа, из которой ушёл последний участник, никому уже не принадлежит.
    await client.query('DELETE FROM chats WHERE NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_members.chat_id = chats.id)')
    // pinned_message_id — обычная колонка без внешнего ключа, поэтому после
    // каскадного удаления сообщений она могла остаться висеть в пустоту.
    await client.query(
      `UPDATE chats SET pinned_message_id = NULL
        WHERE pinned_message_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = chats.pinned_message_id)`,
    )
  })

  audit('account.deleted', { userId, username: user.username })
  return {
    files: files.map((row) => row.url).filter((url) => isSafeAttachmentUrl(url)),
    removedChats: removedChatRows.map((row) => ({ chatId: row.chat_id, memberIds: row.member_ids ?? [] })),
    groupChatIds: groupChatRows.map((row) => row.id),
  }
}

export async function touchLastSeen(userId) {
  await run('UPDATE users SET last_seen_at = $1 WHERE id = $2', [Date.now(), userId])
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function newOpaqueToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Отправляет письмо для привязки почты к аккаунту; сама почта сохранится только после подтверждения. */
export async function requestEmailVerification(userId, email) {
  const trimmed = typeof email === 'string' ? email.trim() : ''
  if (!isValidEmail(trimmed)) throw appError('Введите корректный email')
  const occupied = await one('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND email_verified = true AND id != $2', [trimmed, userId])
  if (occupied) throw appError('Эта почта уже привязана к другому аккаунту')

  const token = newOpaqueToken()
  await run('DELETE FROM email_verifications WHERE user_id = $1', [userId])
  await run('INSERT INTO email_verifications (token_hash, user_id, email, created_at) VALUES ($1, $2, $3, $4)', [
    sessionTokenHash(token),
    userId,
    trimmed,
    Date.now(),
  ])
  await sendVerificationEmail(trimmed, `${APP_ORIGIN}/?verifyEmail=${token}`)
}

/** Подтверждает почту по токену из письма и привязывает её к аккаунту. */
export async function confirmEmailVerification(token) {
  if (typeof token !== 'string' || !token) throw appError('Ссылка недействительна')
  const row = await one(
    'SELECT * FROM email_verifications WHERE token_hash = $1 AND created_at > $2',
    [sessionTokenHash(token), Date.now() - EMAIL_VERIFICATION_TTL_MS],
  )
  if (!row) throw appError('Ссылка недействительна или устарела')
  const occupied = await one('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND email_verified = true AND id != $2', [row.email, row.user_id])
  if (occupied) throw appError('Эта почта уже привязана к другому аккаунту')
  await run('UPDATE users SET email = $1, email_verified = true WHERE id = $2', [row.email, row.user_id])
  await run('DELETE FROM email_verifications WHERE user_id = $1', [row.user_id])
  return toPublicUser(await one('SELECT * FROM users WHERE id = $1', [row.user_id]))
}

export async function removeEmail(userId) {
  await run('UPDATE users SET email = NULL, email_verified = false WHERE id = $1', [userId])
  await run('DELETE FROM email_verifications WHERE user_id = $1', [userId])
}

/**
 * Всегда завершается «успешно» с точки зрения вызывающего — сообщать, найден ли
 * аккаунт по указанной почте, значит позволять перебором узнавать чужие адреса.
 */
export async function requestPasswordReset(email) {
  const trimmed = typeof email === 'string' ? email.trim() : ''
  if (!isValidEmail(trimmed)) return
  const user = await one('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1) AND email_verified = true', [trimmed])
  if (!user) return

  const token = newOpaqueToken()
  await run('DELETE FROM password_resets WHERE user_id = $1', [user.id])
  await run('INSERT INTO password_resets (token_hash, user_id, created_at) VALUES ($1, $2, $3)', [
    sessionTokenHash(token),
    user.id,
    Date.now(),
  ])
  await sendPasswordResetEmail(user.email, `${APP_ORIGIN}/?resetToken=${token}`)
}

/** Сбрасывает пароль по токену из письма, гасит все сессии и сразу выдаёт новую. */
export async function resetPasswordWithToken(token, newPassword, userAgent) {
  if (typeof token !== 'string' || !token) throw appError('Ссылка недействительна')
  validatePassword(newPassword)
  const row = await one(
    'SELECT * FROM password_resets WHERE token_hash = $1 AND used = false AND created_at > $2',
    [sessionTokenHash(token), Date.now() - PASSWORD_RESET_TTL_MS],
  )
  if (!row) throw appError('Ссылка недействительна или устарела', 400, 'RESET_TOKEN_INVALID')
  await run('UPDATE password_resets SET used = true WHERE token_hash = $1', [sessionTokenHash(token)])
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), row.user_id])
  await run('DELETE FROM sessions WHERE user_id = $1', [row.user_id])
  return createSession(row.user_id, userAgent)
}

export function totpConfigured() {
  return Boolean(TOTP_ENC_KEY)
}

/** Starts enrollment: generates and stores a secret, but leaves 2FA off until confirmTotp succeeds. */
export async function enrollTotp(userId) {
  const user = await one('SELECT username FROM users WHERE id = $1', [userId])
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({ issuer: TOTP_ISSUER, label: user.username, secret })
  await run('UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2', [encryptTotpSecret(secret.base32), userId])
  await run('DELETE FROM totp_backup_codes WHERE user_id = $1', [userId])
  return { secret: secret.base32, otpauthUrl: totp.toString() }
}

/** Confirms enrollment with a live code, flips 2FA on, and mints a fresh set of backup codes
 *  (returned in plaintext exactly once — only their hashes are ever persisted). */
export async function confirmTotp(userId, code) {
  const user = await one('SELECT totp_secret FROM users WHERE id = $1', [userId])
  if (!user?.totp_secret) throw appError('Сначала подключите 2FA — запросите QR-код заново')
  const secret = OTPAuth.Secret.fromBase32(decryptTotpSecret(user.totp_secret))
  const delta = OTPAuth.TOTP.validate({ secret, token: String(code || '').trim(), window: 1 })
  if (delta === null) throw appError('Неверный код', 401, 'INVALID_TOTP')
  await run('UPDATE users SET totp_enabled = true WHERE id = $1', [userId])
  await run('DELETE FROM totp_backup_codes WHERE user_id = $1', [userId])
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode)
  const now = Date.now()
  for (const code of codes) {
    await run('INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES ($1, $2, $3)', [userId, backupCodeHash(code), now])
  }
  audit('auth.2fa_enabled', { userId })
  return { backupCodes: codes }
}

export async function disableTotp(userId, password) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId])
  if (!(await verifyPassword(password ?? '', user.password_hash))) throw appError('Неверный пароль', 401, 'INVALID_PASSWORD')
  await run('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [userId])
  await run('DELETE FROM totp_backup_codes WHERE user_id = $1', [userId])
  audit('auth.2fa_disabled', { userId })
}

/** Accepts either a live 6-digit TOTP code or a one-time backup code (case-insensitive). */
async function verifyTotpOrBackupCode(userId, code) {
  const trimmed = String(code || '').trim()
  if (!trimmed) return false
  const user = await one('SELECT totp_secret FROM users WHERE id = $1', [userId])
  if (!user?.totp_secret) return false
  if (/^\d{6}$/.test(trimmed)) {
    const secret = OTPAuth.Secret.fromBase32(decryptTotpSecret(user.totp_secret))
    return OTPAuth.TOTP.validate({ secret, token: trimmed, window: 1 }) !== null
  }
  const hash = backupCodeHash(trimmed.toUpperCase())
  const row = await one('SELECT id FROM totp_backup_codes WHERE user_id = $1 AND code_hash = $2 AND used = false', [userId, hash])
  if (!row) return false
  await run('UPDATE totp_backup_codes SET used = true WHERE id = $1', [row.id])
  return true
}
