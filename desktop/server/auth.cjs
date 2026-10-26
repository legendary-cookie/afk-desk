'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { SCOPES, scopeAllows } = require('../core/command-contract.cjs')

const SCRYPT_PARAMS = Object.freeze({
  N: 32768, // 2^15
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
})
const SALT_BYTES = 32
const KEY_BYTES = 64
const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 512

const SESSION_COOKIE_NAME = 'afk_session'
const CSRF_HEADER_NAME = 'x-afk-csrf'
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000 // 12 hours
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes

const LOGIN_RATE_LIMIT = 5
const LOGIN_WINDOW_MS = 60_000
const BASE_LOCKOUT_MS = 60_000
const MAX_LOCKOUT_MS = 60 * 60_000

const API_RATE_LIMIT = 120
const API_WINDOW_MS = 60_000

const MAX_TRACKERS = 10_000
const TRACKER_TTL_MS = 2 * MAX_LOCKOUT_MS
const MAX_SESSIONS = 1000
const MAX_SESSIONS_PER_USER = 10
const MAX_TOKENS = 100
let activeHashes = 0
function busyError() {
  return Object.assign(new Error('Authentication capacity exceeded.'), { statusCode: 429, code: 'RATE_LIMITED' })
}
async function limitedHash(work) {
  if (activeHashes >= 4) throw busyError()
  activeHashes++
  try { return await work() } finally { activeHashes-- }
}
function limitedHashSync(work) {
  if (activeHashes >= 4) throw busyError()
  activeHashes++
  try { return work() } finally { activeHashes-- }
}

const WS_LIMIT_PER_SESSION = 1
const WS_LIMIT_PER_TOKEN = 5

const COMMON_PASSWORDS = Object.freeze(new Set([
  'password1234',
  'password12345',
  'password123456',
  '123456789012',
  '1234567890123',
  '1234567890ab',
  'qwertyuiop12',
  'qwerty123456',
  'admin1234567',
  'admin12345678',
  'adminpassword',
  'administrator',
  'afkdesk12345',
  'afkdeskadmin',
  'minecraft123',
  'minecraft1234',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'iloveyou1234',
  'trustno11234',
  'sunshine1234',
  'princess1234',
  'football1234',
  'monkey123456',
  'shadow123456',
  'master123456',
  'dragon123456',
  'passw0rd1234',
  'aaaaaaaaaaaa',
  '111111111111',
  '000000000000',
  'abcdefghijkl'
]))

function validatePassword(password) {
  if (typeof password !== 'string') return 'Password must be a string.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`
  }
  const normalized = password.trim().toLowerCase()
  if (COMMON_PASSWORDS.has(normalized) || COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'Password is too common. Choose a stronger password.'
  }
  if (new Set(password.toLowerCase()).size < 2) {
    return 'Password is too simple. Choose a stronger password.'
  }
  return null
}

function hashSecretSync(secret, salt = crypto.randomBytes(SALT_BYTES)) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex')
  if (saltBuf.length !== SALT_BYTES) throw new Error(`Salt must be ${SALT_BYTES} bytes.`)
  const derived = crypto.scryptSync(String(secret), saltBuf, KEY_BYTES, SCRYPT_PARAMS)
  return {
    salt: saltBuf.toString('hex'),
    hash: derived.toString('hex'),
    params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }
  }
}

function hashSecret(secret, salt = crypto.randomBytes(SALT_BYTES)) {
  return new Promise((resolve, reject) => {
    const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex')
    if (saltBuf.length !== SALT_BYTES) return reject(new Error(`Salt must be ${SALT_BYTES} bytes.`))
    crypto.scrypt(String(secret), saltBuf, KEY_BYTES, SCRYPT_PARAMS, (err, derived) => {
      if (err) return reject(err)
      resolve({
        salt: saltBuf.toString('hex'),
        hash: derived.toString('hex'),
        params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }
      })
    })
  })
}

function verifySecretSync(secret, saltHex, hashHex) {
  if (typeof secret !== 'string' || !saltHex || !hashHex) return false
  try {
    const saltBuf = Buffer.from(String(saltHex), 'hex')
    const expectedBuf = Buffer.from(String(hashHex), 'hex')
    if (saltBuf.length !== SALT_BYTES || expectedBuf.length !== KEY_BYTES) return false
    const derived = crypto.scryptSync(secret, saltBuf, expectedBuf.length, SCRYPT_PARAMS)
    if (derived.length !== expectedBuf.length) return false
    return crypto.timingSafeEqual(derived, expectedBuf)
  } catch {
    return false
  }
}

function verifySecret(secret, saltHex, hashHex) {
  return new Promise((resolve) => {
    if (typeof secret !== 'string' || !saltHex || !hashHex) return resolve(false)
    let saltBuf, expectedBuf
    try {
      saltBuf = Buffer.from(String(saltHex), 'hex')
      expectedBuf = Buffer.from(String(hashHex), 'hex')
    } catch {
      return resolve(false)
    }
    if (saltBuf.length !== SALT_BYTES || expectedBuf.length !== KEY_BYTES) return resolve(false)
    crypto.scrypt(secret, saltBuf, expectedBuf.length, SCRYPT_PARAMS, (err, derived) => {
      if (err || !derived || derived.length !== expectedBuf.length) return resolve(false)
      try {
        resolve(crypto.timingSafeEqual(derived, expectedBuf))
      } catch {
        resolve(false)
      }
    })
  })
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function parseCookies(cookieHeader) {
  const out = Object.create(null)
  if (!cookieHeader || typeof cookieHeader !== 'string') return out
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

function formatSessionCookie(sessionId, { secure = false, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? '' : sessionId}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/'
  ]
  if (clear) parts.push('Max-Age=0')
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

class AuthManager {
  constructor({
    dataDir,
    now = Date.now,
    onSessionRevoked = () => {},
    onTokenRevoked = () => {}
  } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required')
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'auth.json')
    this.now = now
    this.onSessionRevoked = onSessionRevoked
    this.onTokenRevoked = onTokenRevoked

    this.sessions = new Map()
    this.loginAttemptsByIp = new Map()
    this.loginAttemptsByUser = new Map()
    this.apiCallsByActor = new Map()
    this.bearerAttemptsByIp = new Map()
    this.wsConnections = new Map()
    this.pendingTokens = 0
    this.setupToken = null

    this._dummySalt = crypto.randomBytes(SALT_BYTES).toString('hex')
    this._dummyHash = crypto.randomBytes(KEY_BYTES).toString('hex')
    this.state = this._load()
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid auth store schema')
      }
      return {
        admin: parsed.admin && typeof parsed.admin === 'object' ? parsed.admin : null,
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens.filter(t => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > this.now())).slice(0, MAX_TOKENS) : [],
        remoteConfig: parsed.remoteConfig && typeof parsed.remoteConfig === 'object' ? parsed.remoteConfig : null
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { admin: null, tokens: [], remoteConfig: null }
      }
      throw error
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600) } catch {}
    }
    fs.renameSync(tmp, this.file)
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.file, 0o600) } catch {}
    }
  }

  hasAdmin() {
    return Boolean(this.state.admin && this.state.admin.salt && this.state.admin.hash)
  }

  getAdminUsername() {
    return this.state.admin?.username || 'admin'
  }

  setAdminPasswordSync(password, username = 'admin') {
    const err = validatePassword(password)
    if (err) throw new Error(err)
    const cleanUser = String(username || this.state.admin?.username || 'admin').trim().slice(0, 64) || 'admin'
    const { salt, hash, params } = limitedHashSync(() => hashSecretSync(password))
    const timestamp = this.now()
    this.state.admin = {
      username: cleanUser,
      salt,
      hash,
      params,
      createdAt: this.state.admin?.createdAt || timestamp,
      updatedAt: timestamp
    }
    this.setupToken = null
    this._save()
    return { username: cleanUser, updatedAt: timestamp }
  }

  async setAdminPassword(password, username = 'admin', { authorize = () => true } = {}) {
    const err = validatePassword(password)
    if (err) throw new Error(err)
    const cleanUser = String(username || this.state.admin?.username || 'admin').trim().slice(0, 64) || 'admin'
    const { salt, hash, params } = await limitedHash(() => hashSecret(password))
    if (!authorize()) throw Object.assign(new Error('Session expired or credentials changed.'), { statusCode: 401, code: 'UNAUTHORIZED' })
    const timestamp = this.now()
    this.state.admin = {
      username: cleanUser,
      salt,
      hash,
      params,
      createdAt: this.state.admin?.createdAt || timestamp,
      updatedAt: timestamp
    }
    this.setupToken = null
    this._save()
    return { username: cleanUser, updatedAt: timestamp }
  }

  async verifyAdminPassword(password, username = 'admin') {
    if (!this.hasAdmin() || typeof password !== 'string') {
      await limitedHash(() => verifySecret(String(password || '').slice(0, MAX_PASSWORD_LENGTH), this._dummySalt, this._dummyHash))
      return false
    }
    const expectedUser = this.state.admin.username || 'admin'
    const suppliedUser = String(username || 'admin').trim()
    const userMatches = timingSafeEqualStrings(suppliedUser, expectedUser)
    if (password.length > MAX_PASSWORD_LENGTH) return false
    const admin = this.state.admin
    const passMatches = await limitedHash(() => verifySecret(password, admin.salt, admin.hash))
    if (this.state.admin !== admin) return false
    return userMatches && passMatches
  }

  verifyAdminPasswordSync(password, username = 'admin') {
    if (!this.hasAdmin() || typeof password !== 'string') {
      verifySecretSync(String(password || ''), this._dummySalt, this._dummyHash)
      return false
    }
    const expectedUser = this.state.admin.username || 'admin'
    const suppliedUser = String(username || 'admin').trim()
    const userMatches = timingSafeEqualStrings(suppliedUser, expectedUser)
    const passMatches = verifySecretSync(password, this.state.admin.salt, this.state.admin.hash)
    return userMatches && passMatches
  }

  issueSetupToken() {
    if (this.hasAdmin()) throw new Error('Admin user already exists.')
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = this.now() + SETUP_TOKEN_TTL_MS
    this.setupToken = { token, expiresAt }
    return { token, expiresAt }
  }

  consumeSetupToken(suppliedToken, password, username = 'admin') {
    if (this.hasAdmin()) throw new Error('Admin user already exists.')
    if (!this.setupToken) throw new Error('Setup token is not active.')
    if (this.now() >= this.setupToken.expiresAt) {
      this.setupToken = null
      throw new Error('Setup token has expired.')
    }
    if (typeof suppliedToken !== 'string' || !timingSafeEqualStrings(suppliedToken, this.setupToken.token)) {
      throw new Error('Invalid setup token.')
    }
    return this.setAdminPasswordSync(password, username)
  }

  // --- Sessions ---

  createSession({ username = 'admin', scope = 'admin', ip = '' } = {}) {
    for (const id of this.sessions.keys()) this.getSession(id, { touch: false })
    const userSessions = [...this.sessions.values()].filter(s => s.username === username)
    if (userSessions.length >= MAX_SESSIONS_PER_USER) this.revokeSession(userSessions[0].id)
    if (this.sessions.size >= MAX_SESSIONS) this.revokeSession(this.sessions.keys().next().value)
    const id = crypto.randomBytes(32).toString('hex')
    const csrfToken = crypto.randomBytes(32).toString('hex')
    const timestamp = this.now()
    const session = {
      id,
      csrfToken,
      username,
      scope,
      ip: String(ip || ''),
      createdAt: timestamp,
      lastActiveAt: timestamp
    }
    this.sessions.set(id, session)
    return session
  }

  getSession(sessionId, { touch = true } = {}) {
    if (!sessionId || typeof sessionId !== 'string') return null
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const timestamp = this.now()
    if (
      timestamp - session.lastActiveAt >= IDLE_TIMEOUT_MS ||
      timestamp - session.createdAt >= ABSOLUTE_TIMEOUT_MS
    ) {
      this.revokeSession(sessionId)
      return null
    }
    if (touch) session.lastActiveAt = timestamp
    return session
  }

  verifyCsrf(session, csrfHeader) {
    if (!session || typeof csrfHeader !== 'string' || !csrfHeader) return false
    return timingSafeEqualStrings(session.csrfToken, csrfHeader)
  }

  revokeSession(sessionId) {
    if (!sessionId) return false
    const existed = this.sessions.delete(sessionId)
    this.apiCallsByActor.delete(`session:${sessionId}`)
    this.wsConnections.delete(`session:${sessionId}`)
    try { this.onSessionRevoked(sessionId) } catch {}
    return existed
  }

  revokeAllSessions() {
    const ids = [...this.sessions.keys()]
    this.sessions.clear()
    for (const id of ids) {
      this.apiCallsByActor.delete(`session:${id}`)
      this.wsConnections.delete(`session:${id}`)
      try { this.onSessionRevoked(id) } catch {}
    }
    return ids.length
  }

  // --- API Tokens ---

  createTokenSync({ name = 'API token', scope = 'read', expiresAt = null, ttlMs = null, expiresInDays = null } = {}) {
    const prepared = this._prepareToken({ name, scope, expiresAt, ttlMs, expiresInDays })
    return this._storeToken(prepared, limitedHashSync(() => hashSecretSync(prepared.secret)))
  }

  _prepareToken({ name = 'API token', scope = 'read', expiresAt = null, ttlMs = null, expiresInDays = null } = {}) {
    if (!SCOPES.includes(scope)) {
      throw new Error(`Invalid token scope. Must be one of: ${SCOPES.join(', ')}.`)
    }
    this.state.tokens = this.state.tokens.filter(t => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > this.now()))
    if (this.state.tokens.length + this.pendingTokens >= MAX_TOKENS) throw busyError()
    const cleanName = String(name || 'API token').trim().slice(0, 80) || 'API token'
    const timestamp = this.now()
    let resolvedExpiry = null
    if (ttlMs != null && Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0) {
      resolvedExpiry = timestamp + Number(ttlMs)
    } else if (expiresInDays != null && Number.isFinite(Number(expiresInDays)) && Number(expiresInDays) > 0) {
      resolvedExpiry = timestamp + Number(expiresInDays) * 24 * 60 * 60 * 1000
    } else if (expiresAt != null && expiresAt !== '') {
      const parsed = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt))
      if (!Number.isFinite(parsed) || parsed <= timestamp) {
        throw new Error('Token expiry must be a valid future timestamp.')
      }
      resolvedExpiry = parsed
    }

    const id = crypto.randomBytes(8).toString('hex')
    const secret = crypto.randomBytes(24).toString('hex')
    return { id, secret, cleanName, scope, timestamp, resolvedExpiry }
  }

  _storeToken({ id, secret, cleanName, scope, timestamp, resolvedExpiry }, { salt, hash, params }) {
    const rawToken = `afk_${id}_${secret}`

    const entry = {
      id,
      name: cleanName,
      scope,
      salt,
      hash,
      params,
      tokenHint: `••••${secret.slice(-4)}`,
      createdAt: timestamp,
      expiresAt: resolvedExpiry,
      revokedAt: null,
      lastUsedAt: null
    }
    this.state.tokens.push(entry)
    this._save()
    return {
      token: rawToken,
      record: this._publicToken(entry)
    }
  }

  async createToken(options = {}) {
    const prepared = this._prepareToken(options)
    this.pendingTokens++
    try { return this._storeToken(prepared, await limitedHash(() => hashSecret(prepared.secret))) }
    finally { this.pendingTokens-- }
  }

  listTokens() {
    return this.state.tokens.map((t) => this._publicToken(t))
  }

  revokeToken(id) {
    const entry = this.state.tokens.find((t) => t.id === id)
    if (!entry) return false
    if (entry.revokedAt === null) {
      entry.revokedAt = this.now()
      this._save()
    }
    this.wsConnections.delete(`token:${id}`)
    try { this.onTokenRevoked(id) } catch {}
    return true
  }

  async verifyBearerToken(authHeader, ip = 'unknown') {
    if (!authHeader || typeof authHeader !== 'string') return null
    const match = /^Bearer\s+afk_([0-9a-fA-F]{8,32})_([A-Za-z0-9_-]{16,128})$/.exec(authHeader.trim())
    if (!match) return null
    const [, id, secret] = match
    if (!this.checkWindow(this.bearerAttemptsByIp, String(ip), 120).allowed) throw busyError()
    const entry = this.state.tokens.find((t) => t.id === id)
    if (!entry) {
      await limitedHash(() => verifySecret(secret, this._dummySalt, this._dummyHash))
      return null
    }
    const timestamp = this.now()
    if (entry.revokedAt !== null) return null
    if (entry.expiresAt !== null && timestamp >= entry.expiresAt) return null
    const valid = await limitedHash(() => verifySecret(secret, entry.salt, entry.hash))
    if (!valid || !this.isActorValid({ kind: 'token', id })) return null
    entry.lastUsedAt = timestamp
    return this._publicToken(entry)
  }

  verifyBearerTokenSync(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') return null
    const match = /^Bearer\s+afk_([0-9a-fA-F]{8,32})_([A-Za-z0-9_-]{16,128})$/.exec(authHeader.trim())
    if (!match) return null
    const [, id, secret] = match
    const entry = this.state.tokens.find((t) => t.id === id)
    if (!entry) {
      verifySecretSync(secret, this._dummySalt, this._dummyHash)
      return null
    }
    const timestamp = this.now()
    if (entry.revokedAt !== null) return null
    if (entry.expiresAt !== null && timestamp >= entry.expiresAt) return null
    const valid = verifySecretSync(secret, entry.salt, entry.hash)
    if (!valid) return null
    entry.lastUsedAt = timestamp
    return this._publicToken(entry)
  }

  _publicToken(entry) {
    const timestamp = this.now()
    const expired = entry.expiresAt !== null && timestamp >= entry.expiresAt
    const revoked = entry.revokedAt !== null
    return {
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      tokenHint: entry.tokenHint || '',
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      revokedAt: entry.revokedAt,
      lastUsedAt: entry.lastUsedAt,
      expired,
      active: !expired && !revoked
    }
  }

  // --- Remote Config Persistence (for Desktop Embedded Mode) ---

  getRemoteConfig() {
    const raw = this.state.remoteConfig || {}
    return {
      enabled: raw.enabled === true,
      bind: typeof raw.bind === 'string' && raw.bind.trim() ? raw.bind.trim() : '127.0.0.1',
      port: Number.isInteger(Number(raw.port)) && Number(raw.port) >= 1 && Number(raw.port) <= 65535 ? Number(raw.port) : 8787,
      allowedHosts: Array.isArray(raw.allowedHosts)
        ? raw.allowedHosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean).slice(0, 50)
        : [],
      trustProxy: raw.trustProxy === true
    }
  }

  saveRemoteConfig(input = {}) {
    const current = this.getRemoteConfig()
    const next = {
      enabled: input.enabled !== undefined ? input.enabled === true : current.enabled,
      bind: typeof input.bind === 'string' && input.bind.trim() ? input.bind.trim() : current.bind,
      port: input.port !== undefined ? Math.max(1, Math.min(65535, Number(input.port) || 8787)) : current.port,
      allowedHosts: input.allowedHosts !== undefined
        ? (Array.isArray(input.allowedHosts)
            ? input.allowedHosts
            : String(input.allowedHosts || '').split(',')
          ).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean).slice(0, 50)
        : current.allowedHosts,
      trustProxy: input.trustProxy !== undefined ? input.trustProxy === true : current.trustProxy
    }
    this.state.remoteConfig = next
    this._save()
    return next
  }

  // --- Rate Limits ---

  pruneTrackers(map, ttl = TRACKER_TTL_MS) {
    const time = this.now()
    for (const [key, value] of map) {
      const last = Array.isArray(value) ? value.at(-1) : value.updatedAt
      if (time - last >= ttl) map.delete(key)
    }
  }

  checkWindow(map, key, limit) {
    this.pruneTrackers(map, API_WINDOW_MS)
    if (!map.has(key) && map.size >= MAX_TRACKERS) return { allowed: false, retryAfterMs: API_WINDOW_MS }
    const timestamp = this.now()
    const recent = (map.get(key) || []).filter(t => timestamp - t < API_WINDOW_MS)
    if (recent.length >= limit) return { allowed: false, retryAfterMs: API_WINDOW_MS - (timestamp - recent[0]) }
    recent.push(timestamp)
    map.set(key, recent)
    return { allowed: true }
  }

  isActorValid(actor) {
    if (actor?.kind === 'session') return Boolean(this.getSession(actor.id, { touch: false }))
    if (actor?.kind !== 'token') return false
    const entry = this.state.tokens.find(t => t.id === actor.id)
    return Boolean(entry && entry.revokedAt === null && (entry.expiresAt === null || this.now() < entry.expiresAt))
  }

  reserveLoginAttempt(ip, username) {
    const rate = this.checkLoginRateLimit(ip, username)
    if (!rate.allowed) return rate
    for (const [map, key] of [[this.loginAttemptsByIp, String(ip || 'unknown')], [this.loginAttemptsByUser, String(username || 'admin').trim().toLowerCase()]]) {
      this._getLoginTracker(map, key).attempts.push(this.now())
    }
    return rate
  }

  _getLoginTracker(map, key) {
    this.pruneTrackers(map)
    if (!map.has(key) && map.size >= MAX_TRACKERS) return { attempts: [], failures: 0, lockedUntil: this.now() + LOGIN_WINDOW_MS }

    let state = map.get(key)
    if (!state) {
      state = { attempts: [], failures: 0, lockedUntil: 0 }
      map.set(key, state)
    }
    const timestamp = this.now()
    state.updatedAt = timestamp
    state.attempts = state.attempts.filter((t) => timestamp - t < LOGIN_WINDOW_MS)
    return state
  }

  checkLoginRateLimit(ip, username = 'admin') {
    const timestamp = this.now()
    const ipState = this._getLoginTracker(this.loginAttemptsByIp, String(ip || 'unknown'))
    if (ipState.lockedUntil > timestamp || ipState.attempts.length >= LOGIN_RATE_LIMIT) return { allowed: false, retryAfterMs: Math.max(LOGIN_WINDOW_MS, ipState.lockedUntil - timestamp) }
    const userState = this._getLoginTracker(this.loginAttemptsByUser, String(username || 'admin').trim().toLowerCase())

    for (const state of [ipState, userState]) {
      if (state.lockedUntil > timestamp) {
        return { allowed: false, retryAfterMs: state.lockedUntil - timestamp }
      }
      if (state.attempts.length >= LOGIN_RATE_LIMIT) {
        const exponent = Math.max(0, Math.max(state.failures, state.attempts.length) - LOGIN_RATE_LIMIT)
        const lockoutMs = Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * (2 ** exponent))
        state.lockedUntil = Math.max(state.lockedUntil, timestamp + lockoutMs)
        return { allowed: false, retryAfterMs: state.lockedUntil - timestamp }
      }
    }
    return { allowed: true, retryAfterMs: 0 }
  }

  recordLoginAttempt(ip, username = 'admin', success = false, reserved = false) {
    const timestamp = this.now()
    const ipKey = String(ip || 'unknown')
    const userKey = String(username || 'admin').trim().toLowerCase()
    const ipState = this._getLoginTracker(this.loginAttemptsByIp, ipKey)
    const userState = this._getLoginTracker(this.loginAttemptsByUser, userKey)

    if (!reserved) { ipState.attempts.push(timestamp); userState.attempts.push(timestamp) }

    if (success) {
      userState.failures = 0
      userState.lockedUntil = 0
      return
    }

    for (const state of [ipState, userState]) {
      state.failures += 1
      if (state.attempts.length >= LOGIN_RATE_LIMIT || state.failures >= LOGIN_RATE_LIMIT) {
        const exponent = Math.max(0, Math.max(state.failures, state.attempts.length) - LOGIN_RATE_LIMIT)
        const lockoutMs = Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * (2 ** exponent))
        state.lockedUntil = Math.max(state.lockedUntil, timestamp + lockoutMs)
      }
    }
  }

  checkApiRateLimit(actorKey) {
    return this.checkWindow(this.apiCallsByActor, String(actorKey || 'anonymous'), API_RATE_LIMIT)
  }

  // --- WebSocket Connection Tracking ---

  canAttachWebSocket(actor) {
    if (!actor || !actor.kind || !actor.id) return false
    // Lazy TTL cleanup bounds sockets retained for credentials that expired
    // while the server was otherwise quiet (no event deliveries).
    for (const [key, sockets] of this.wsConnections) {
      const [kind, id] = key.split(':')
      if (this.isActorValid({ kind, id })) continue
      this.wsConnections.delete(key)
      for (const ws of sockets) { try { ws.close(4401, 'Credential expired or revoked.') } catch {} }
    }
    const key = `${actor.kind}:${actor.id}`
    if (!this.wsConnections.has(key) && this.wsConnections.size >= MAX_TRACKERS) return false
    const limit = actor.kind === 'session' ? WS_LIMIT_PER_SESSION : WS_LIMIT_PER_TOKEN
    const active = this.wsConnections.get(key)
    return !active || active.size < limit
  }

  attachWebSocket(actor, ws) {
    const key = `${actor.kind}:${actor.id}`
    let set = this.wsConnections.get(key)
    if (!set) {
      set = new Set()
      this.wsConnections.set(key, set)
    }
    set.add(ws)
    return () => {
      set.delete(ws)
      if (set.size === 0) this.wsConnections.delete(key)
    }
  }
}

module.exports = {
  AuthManager,
  MAX_TRACKERS, TRACKER_TTL_MS, MAX_SESSIONS, MAX_SESSIONS_PER_USER, MAX_TOKENS,
  SCRYPT_PARAMS,
  SALT_BYTES,
  KEY_BYTES,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  IDLE_TIMEOUT_MS,
  ABSOLUTE_TIMEOUT_MS,
  SETUP_TOKEN_TTL_MS,
  LOGIN_RATE_LIMIT,
  API_RATE_LIMIT,
  WS_LIMIT_PER_SESSION,
  WS_LIMIT_PER_TOKEN,
  COMMON_PASSWORDS,
  validatePassword,
  hashSecret,
  hashSecretSync,
  verifySecret,
  verifySecretSync,
  timingSafeEqualStrings,
  parseCookies,
  formatSessionCookie,
  scopeAllows
}
