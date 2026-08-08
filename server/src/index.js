import express from 'express'
import cors from 'cors'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { initSchema, pool } from './db.js'
import {
  register,
  login,
  authMiddleware,
  updateProfile,
  changePassword,
  deleteSession,
  requestEmailVerification,
  confirmEmailVerification,
  removeEmail,
  requestPasswordReset,
  resetPasswordWithToken,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  verifyTwoFactorLogin,
  enrollTotp,
  confirmTotp,
  disableTotp,
} from './auth.js'
import {
  getOrCreateDirectChat,
  createGroupChat,
  listChatsForUser,
  getMessages,
  searchMessages,
  isMember,
  searchUsers,
  setChatPinned,
  updateChatInfo,
  leaveGroup,
  chatIdsForUser,
} from './chats.js'
import { attachWebSocket, isOnline, notifyChatCreated, notifyChatUpdated, notifyChatLeft, disconnectSession, disconnectSessionByHash, disconnectUser } from './ws.js'
import { appError, publicErrorMessage } from './errors.js'
import { buildIceServers } from './ice.js'
import { audit } from './audit.js'
import { sendSecurityAlert } from './mailer.js'
import { blockUser, unblockUser, listBlockedByUser } from './blocking.js'

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
  void sendSecurityAlert('unhandled_rejection', 'Unhandled promise rejection', { message: err?.message ?? String(err) })
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  // Best-effort alert with a hard cap — state may be corrupted, so don't linger.
  Promise.race([
    sendSecurityAlert('uncaught_exception', 'Сервер упал (uncaughtException)', { message: err?.message ?? String(err) }),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1))
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, '..', '..', 'dist')
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(__dirname, '..', 'uploads')
const SESSION_COOKIE = 'connecto_session'
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const configuredOrigins = new Set(
  [process.env.APP_ORIGIN, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')]
    .map((origin) => origin?.trim())
    .filter(Boolean),
)
fs.mkdirSync(uploadsDir, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const extensions = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
        'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
        'audio/webm': '.webm', 'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
        'audio/wav': '.wav', 'application/pdf': '.pdf', 'text/plain': '.txt', 'application/zip': '.zip',
      }
      cb(null, `${crypto.randomUUID()}${extensions[file.mimetype] ?? ''}`)
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime',
      'audio/webm', 'audio/ogg', 'application/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
      'application/pdf', 'text/plain', 'text/csv', 'application/zip',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ])
    if (!allowed.has(file.mimetype)) return cb(appError('Этот формат файла не поддерживается'))
    cb(null, true)
  },
})

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
})

const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
})

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много регистраций. Попробуйте позже.' },
})

const sensitiveActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
})

/** Без этого лимита можно быстро забить весь том загрузок (500 МБ) — размер файла ограничен, частота нет. */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много загрузок. Попробуйте позже.' },
})

/** Создание чатов не ограничено — можно было спамить чужих пользователей уведомлениями о новых группах. */
const chatCreateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много новых чатов. Попробуйте позже.' },
})

/** Отправляет письма — жёсткий лимит, иначе можно заспамить чужой ящик или слить квоту почтового сервиса. */
const mailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
})

function cookieValue(req, name) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'
}

function setSessionCookie(req, res, token) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ]
  if (isSecureRequest(req)) attributes.push('Secure')
  res.setHeader('Set-Cookie', attributes.join('; '))
}

function clearSessionCookie(req, res) {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecureRequest(req)) attributes.push('Secure')
  res.setHeader('Set-Cookie', attributes.join('; '))
}

function isAllowedOrigin(req, origin) {
  if (!origin) return true
  if (configuredOrigins.has(origin)) return true
  try {
    const source = new URL(origin)
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
    const requestHost = forwardedHost || req.headers.host
    if (source.host === requestHost) return true
    if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(source.hostname)) return true
  } catch {
    return false
  }
  return false
}

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Origin-Agent-Cluster', '?1')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data: https:; connect-src 'self' ws: wss:",
  )
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})
app.use(cors((req, callback) => {
  const origin = req.headers.origin
  const allowed = isAllowedOrigin(req, origin)
  callback(null, {
    origin: allowed && origin ? origin : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
}))
app.use(express.json({ limit: '1mb' }))
app.use((req, _res, next) => {
  req.sessionToken = cookieValue(req, SESSION_COOKIE)
  next()
})
app.use((req, res, next) => {
  const shouldAudit = req.path.startsWith('/api/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
  if (!shouldAudit) return next()
  const startedAt = Date.now()
  res.once('finish', () => {
    const actor = req.auditUser ?? req.user
    audit('api.action', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      userId: actor?.id,
      username: actor?.username,
      durationMs: Date.now() - startedAt,
    })
  })
  next()
})
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next()
  if (!isAllowedOrigin(req, req.headers.origin)) {
    return res.status(403).json({ error: 'Запрос отклонён', code: 'ORIGIN_REJECTED' })
  }
  next()
})
app.use(['/api/auth', '/api/me'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})
app.use('/uploads', authMiddleware, express.static(uploadsDir, { fallthrough: false, maxAge: '1h' }))

function withOnline(chat) {
  return { ...chat, members: chat.members.map((m) => ({ ...m, online: isOnline(m.id) })) }
}

function asyncRoute(handler) {
  return (req, res) => handler(req, res).catch((err) => res.status(err?.status ?? 400).json({ error: publicErrorMessage(err), ...(err?.code ? { code: err.code } : {}) }))
}

app.post(
  '/api/auth/register',
  registerLimiter,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body
    const session = await register(username ?? '', password ?? '', req.headers['user-agent'])
    req.auditUser = session.user
    setSessionCookie(req, res, session.token)
    res.status(201).json({ user: session.user })
  }),
)

app.post(
  '/api/auth/login',
  loginLimiter,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body
    const session = await login(username ?? '', password ?? '', req.headers['user-agent'])
    if (session.twoFactorRequired) {
      res.json({ twoFactorRequired: true, pendingToken: session.pendingToken })
      return
    }
    req.auditUser = session.user
    setSessionCookie(req, res, session.token)
    res.json({ user: session.user })
  }),
)

app.post(
  '/api/auth/2fa/verify',
  twoFactorLimiter,
  asyncRoute(async (req, res) => {
    const { pendingToken, code } = req.body ?? {}
    const session = await verifyTwoFactorLogin(pendingToken ?? '', code ?? '', req.headers['user-agent'])
    req.auditUser = session.user
    setSessionCookie(req, res, session.token)
    res.json({ user: session.user })
  }),
)

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

app.get('/api/me', authMiddleware, (req, res) => {
  setSessionCookie(req, res, req.authToken)
  res.json({ user: req.user })
})

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const header = req.headers.authorization || ''
  const token = req.sessionToken ?? (header.startsWith('Bearer ') ? header.slice(7).trim() : null)
  disconnectSession(token)
  await deleteSession(token)
  clearSessionCookie(req, res)
  res.json({ ok: true })
}))

app.patch(
  '/api/me',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const user = await updateProfile(req.user.id, req.body ?? {})
    await Promise.all((await chatIdsForUser(req.user.id)).map((chatId) => notifyChatUpdated(chatId)))
    res.json({ user })
  }),
)

app.post(
  '/api/me/password',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {}
    const session = await changePassword(req.user.id, oldPassword ?? '', newPassword ?? '', req.headers['user-agent'])
    disconnectUser(req.user.id)
    setSessionCookie(req, res, session.token)
    res.json({ ok: true })
  }),
)

app.get(
  '/api/me/sessions',
  authMiddleware,
  asyncRoute(async (req, res) => {
    res.json({ sessions: await listSessions(req.user.id, req.authToken) })
  }),
)

app.delete(
  '/api/me/sessions/:id',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id
    const revoked = await revokeSession(req.user.id, sessionId)
    if (revoked) disconnectSessionByHash(sessionId)
    res.json({ ok: revoked })
  }),
)

app.delete(
  '/api/me/sessions',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    const revokedHashes = await revokeOtherSessions(req.user.id, req.authToken)
    for (const hash of revokedHashes) disconnectSessionByHash(hash)
    res.json({ ok: true, count: revokedHashes.length })
  }),
)

app.post(
  '/api/me/2fa/enroll',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    res.json(await enrollTotp(req.user.id))
  }),
)

app.post(
  '/api/me/2fa/confirm',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    const result = await confirmTotp(req.user.id, req.body?.code ?? '')
    await Promise.all((await chatIdsForUser(req.user.id)).map((chatId) => notifyChatUpdated(chatId)))
    res.json(result)
  }),
)

app.post(
  '/api/me/2fa/disable',
  authMiddleware,
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    await disableTotp(req.user.id, req.body?.password ?? '')
    await Promise.all((await chatIdsForUser(req.user.id)).map((chatId) => notifyChatUpdated(chatId)))
    res.json({ ok: true })
  }),
)

app.post(
  '/api/me/email',
  authMiddleware,
  mailLimiter,
  asyncRoute(async (req, res) => {
    await requestEmailVerification(req.user.id, req.body?.email ?? '')
    res.json({ ok: true })
  }),
)

app.delete(
  '/api/me/email',
  authMiddleware,
  asyncRoute(async (req, res) => {
    await removeEmail(req.user.id)
    res.json({ ok: true })
  }),
)

app.post(
  '/api/auth/verify-email',
  asyncRoute(async (req, res) => {
    const user = await confirmEmailVerification(req.body?.token ?? '')
    res.json({ user })
  }),
)

app.post(
  '/api/auth/forgot-password',
  mailLimiter,
  asyncRoute(async (req, res) => {
    await requestPasswordReset(req.body?.email ?? '')
    // Ответ одинаковый независимо от того, нашёлся ли аккаунт — иначе это способ перебором узнавать чужие адреса.
    res.json({ ok: true })
  }),
)

app.post(
  '/api/auth/reset-password',
  sensitiveActionLimiter,
  asyncRoute(async (req, res) => {
    const session = await resetPasswordWithToken(req.body?.token ?? '', req.body?.newPassword ?? '', req.headers['user-agent'])
    setSessionCookie(req, res, session.token)
    res.json({ user: session.user })
  }),
)

app.post(
  '/api/users/:id/block',
  authMiddleware,
  asyncRoute(async (req, res) => {
    await blockUser(req.user.id, Number(req.params.id))
    res.json({ ok: true })
  }),
)

app.post(
  '/api/users/:id/unblock',
  authMiddleware,
  asyncRoute(async (req, res) => {
    await unblockUser(req.user.id, Number(req.params.id))
    res.json({ ok: true })
  }),
)

app.get(
  '/api/users/blocked',
  authMiddleware,
  asyncRoute(async (req, res) => {
    res.json({ users: await listBlockedByUser(req.user.id) })
  }),
)

app.get(
  '/api/users',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const query = String(req.query.query || '')
    if (query.length < 1) return res.json({ users: [] })
    res.json({ users: await searchUsers(query, req.user.id) })
  }),
)

app.get(
  '/api/chats',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chats = (await listChatsForUser(req.user.id)).map(withOnline)
    res.json({ chats })
  }),
)

app.post(
  '/api/chats',
  authMiddleware,
  chatCreateLimiter,
  asyncRoute(async (req, res) => {
    const { chat, created } = await getOrCreateDirectChat(req.user.id, req.body.username ?? '')
    if (created) await notifyChatCreated(chat.id)
    res.json({ chat: withOnline(chat) })
  }),
)

app.post(
  '/api/chats/group',
  authMiddleware,
  chatCreateLimiter,
  asyncRoute(async (req, res) => {
    const { name, usernames } = req.body ?? {}
    const { chat } = await createGroupChat(req.user.id, name ?? '', Array.isArray(usernames) ? usernames : [])
    await notifyChatCreated(chat.id)
    res.json({ chat: withOnline(chat) })
  }),
)

app.get(
  '/api/chats/:id/messages',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chatId = Number(req.params.id)
    if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' })
    res.json({ messages: await getMessages(chatId) })
  }),
)

app.post(
  '/api/chats/:id/leave',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chatId = Number(req.params.id)
    await leaveGroup(chatId, req.user.id)
    await notifyChatUpdated(chatId)
    notifyChatLeft(req.user.id, chatId)
    res.json({ ok: true })
  }),
)

app.patch(
  '/api/chats/:id/pin',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chatId = Number(req.params.id)
    const chat = await setChatPinned(chatId, req.user.id, Boolean(req.body?.pinned))
    res.json({ chat: withOnline(chat) })
  }),
)

app.patch(
  '/api/chats/:id',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chatId = Number(req.params.id)
    const { name, description, avatarUrl } = req.body ?? {}
    const chat = await updateChatInfo(chatId, req.user.id, { name, description, avatarUrl })
    await notifyChatUpdated(chatId)
    res.json({ chat: withOnline(chat) })
  }),
)

app.get(
  '/api/chats/:id/search',
  authMiddleware,
  asyncRoute(async (req, res) => {
    const chatId = Number(req.params.id)
    if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' })
    const query = String(req.query.query || '')
    if (query.trim().length < 1) return res.json({ messages: [] })
    res.json({ messages: await searchMessages(chatId, query.trim()) })
  }),
)

app.get('/api/ice-servers', authMiddleware, (req, res) => {
  res.json({ iceServers: buildIceServers() })
})

app.post('/api/upload', authMiddleware, uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' })
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  })
})

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 25 МБ)' : 'Не удалось загрузить файл'
    return res.status(400).json({ error: message })
  }
  res.status(err?.status ?? 400).json({ error: publicErrorMessage(err, 'Не удалось обработать запрос'), ...(err?.code ? { code: err.code } : {}) })
})

app.use(express.static(clientDist))
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

const PORT = process.env.PORT ?? 4000

async function start() {
  await initSchema()
  const server = http.createServer(app)
  const wss = attachWebSocket(server)

  let shuttingDown = false
  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Получен ${signal}, останавливаю сервер...`)
    const forceExitTimer = setTimeout(() => {
      console.error('Не удалось корректно завершиться за отведённое время, выхожу принудительно')
      process.exit(1)
    }, 10_000)
    forceExitTimer.unref()

    server.close()
    for (const client of wss.clients) {
      client.close(1012, 'Server restarting')
    }
    try {
      await pool.end()
    } catch (err) {
      console.error('Ошибка при закрытии пула БД:', err)
    }
    clearTimeout(forceExitTimer)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`)
  })
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err)
  process.exit(1)
})
