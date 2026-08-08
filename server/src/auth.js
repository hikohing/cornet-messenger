import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { one, run } from './db.js'
import { createSavedChat, isSafeAttachmentUrl } from './chats.js'
import { appError } from './errors.js'
import { sendPasswordResetEmail, sendVerificationEmail, sendSecurityAlert } from './mailer.js'
import { audit } from './audit.js'

const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${process.env.PORT ?? 4000}`
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

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

function sessionTokenHash(token) {
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
    bio: row.bio ?? '',
    birthDate: row.birth_date,
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    createdAt: row.created_at ? Number(row.created_at) : null,
    // Почта видна только самому владельцу аккаунта — эта функция используется
    // исключительно для приватного "я" (login/register/me), не для карточек в чатах.
    email: row.email ?? null,
    emailVerified: Boolean(row.email_verified),
  }
}

export async function register(username, password) {
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
  return createSession(row.id)
}

export async function login(username, password) {
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
  return createSession(user.id)
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  await run('DELETE FROM sessions WHERE created_at <= $1', [now - SESSION_TTL_MS])
  await run('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [sessionTokenHash(token), userId, now])
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

export async function deleteSession(token) {
  if (typeof token !== 'string' || !token) return
  await run('DELETE FROM sessions WHERE token IN ($1, $2)', [sessionTokenHash(token), token])
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

export async function updateProfile(userId, { color, avatarUrl, bannerUrl, bannerStyle, avatarDecoration, profileEffect, profileTheme, nameStyle, profileFrame, nameplateStyle, profilePrimaryColor, profileSecondaryColor, showLastSeen, bio, birthDate, displayName, username }) {
  const current = await one('SELECT * FROM users WHERE id = $1', [userId])
  if (bio !== undefined && bio.length > 200) throw appError('Описание не должно превышать 200 символов')
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
     nameplate_style = $15, profile_primary_color = $16, profile_secondary_color = $17 WHERE id = $18`,
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
      userId,
    ],
  )
  return toPublicUser(await one('SELECT * FROM users WHERE id = $1', [userId]))
}

export async function changePassword(userId, oldPassword, newPassword) {
  const user = await one('SELECT * FROM users WHERE id = $1', [userId])
  validatePassword(newPassword)
  if (!(await verifyPassword(oldPassword, user.password_hash))) throw appError('Неверный текущий пароль', 401, 'INVALID_PASSWORD')
  if (await verifyPassword(newPassword, user.password_hash)) throw appError('Новый пароль должен отличаться от текущего')
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), userId])
  await run('DELETE FROM sessions WHERE user_id = $1', [userId])
  clearLoginFailures(user.username)
  return createSession(userId)
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
export async function resetPasswordWithToken(token, newPassword) {
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
  return createSession(row.user_id)
}
