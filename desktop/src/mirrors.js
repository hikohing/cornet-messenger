'use strict'

const fs = require('node:fs')
const https = require('node:https')
const http = require('node:http')

const HEALTH_TIMEOUT_MS = 4000
const STARTUP_BUDGET_MS = 15000
const REMOTE_FETCH_TIMEOUT_MS = 5000
const MAX_MIRRORS = 20
const MAX_RESPONSE_BYTES = 100_000

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function isValidMirrorUrl(value) {
  if (typeof value !== 'string' || value.length > 200) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  } catch {
    return false
  }
}

function sanitizeMirrorList(list) {
  if (!Array.isArray(list)) return []
  const cleaned = list.map((v) => (typeof v === 'string' ? v.replace(/\/$/, '') : v)).filter(isValidMirrorUrl)
  return [...new Set(cleaned)].slice(0, MAX_MIRRORS)
}

/**
 * Local mirror list persisted per-install. Network updates only ever ADD entries
 * (union with what's already known) — a compromised or unreachable update source
 * can never leave the app with fewer working addresses than it started with.
 */
class MirrorStore {
  constructor({ defaultsPath, userDataPath }) {
    this.userDataPath = userDataPath
    const defaults = readJsonSafe(defaultsPath) ?? {}
    const stored = readJsonSafe(userDataPath) ?? {}
    const merged = sanitizeMirrorList([...(stored.mirrors ?? []), ...(defaults.mirrors ?? [])])
    this.state = {
      mirrors: merged.length > 0 ? merged : sanitizeMirrorList(defaults.mirrors ?? []),
      lastWorking: typeof stored.lastWorking === 'string' ? stored.lastWorking : null,
      remoteUpdateUrl: typeof defaults.remoteUpdateUrl === 'string' ? defaults.remoteUpdateUrl : null,
    }
  }

  save() {
    try {
      fs.writeFileSync(
        this.userDataPath,
        JSON.stringify({ mirrors: this.state.mirrors, lastWorking: this.state.lastWorking }, null, 2),
      )
    } catch (err) {
      console.error('Не удалось сохранить mirrors.json:', err)
    }
  }

  /** Last known-working mirror first, so a healthy connection is retried before the rest. */
  list() {
    const ordered = [...this.state.mirrors]
    if (this.state.lastWorking) {
      const idx = ordered.indexOf(this.state.lastWorking)
      if (idx > 0) {
        ordered.splice(idx, 1)
        ordered.unshift(this.state.lastWorking)
      }
    }
    return ordered
  }

  markWorking(mirror) {
    this.state.lastWorking = mirror
    this.save()
  }

  mergeRemote(remoteMirrors) {
    const merged = sanitizeMirrorList([...this.state.mirrors, ...remoteMirrors])
    if (merged.length === this.state.mirrors.length) return false
    this.state.mirrors = merged
    this.save()
    return true
  }
}

function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('response too large'))
          return
        }
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function checkMirrorHealth(mirror) {
  try {
    const { status } = await fetchWithTimeout(`${mirror}/api/health`, HEALTH_TIMEOUT_MS)
    if (status === 200) return true
    if (status === 404) {
      const fallback = await fetchWithTimeout(`${mirror}/`, HEALTH_TIMEOUT_MS)
      return fallback.status >= 200 && fallback.status < 400
    }
    return false
  } catch {
    return false
  }
}

/** Tries each candidate in order within a fixed overall time budget; first healthy one wins. */
async function pickWorkingMirror(store) {
  const candidates = store.list()
  const deadline = Date.now() + STARTUP_BUDGET_MS
  for (const mirror of candidates) {
    if (Date.now() > deadline) break
    if (await checkMirrorHealth(mirror)) {
      store.markWorking(mirror)
      return mirror
    }
  }
  return candidates[0] ?? null
}

/**
 * Best-effort background channel for updating the mirror list without shipping a new
 * build. The user is expected to point remoteUpdateUrl (in mirrors.default.json) at a
 * stable, low-suspicion JSON file they control (e.g. a GitHub raw URL). Failure here is
 * silent and harmless — the local list is always sufficient on its own.
 */
async function refreshRemoteMirrors(store) {
  if (!store.state.remoteUpdateUrl) return false
  try {
    const { status, body } = await fetchWithTimeout(store.state.remoteUpdateUrl, REMOTE_FETCH_TIMEOUT_MS)
    if (status !== 200) return false
    const parsed = JSON.parse(body)
    return store.mergeRemote(sanitizeMirrorList(parsed?.mirrors))
  } catch {
    return false
  }
}

module.exports = { MirrorStore, pickWorkingMirror, checkMirrorHealth, refreshRemoteMirrors, sanitizeMirrorList }
