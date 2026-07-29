const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { hashToken } = require('./access-store.cjs')

const PUBLIC_DIR = path.join(__dirname, 'public')
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
])
const VALID_PERMISSIONS = new Set(['view', 'chat', 'control', 'connect'])

class RemoteAccessServer {
  constructor({ accessStore, getAccounts, getRuntime, handleAction }) {
    this.accessStore = accessStore
    this.getAccounts = getAccounts
    this.getRuntime = getRuntime
    this.handleAction = handleAction
    this.ownerToken = crypto.randomBytes(32).toString('base64url')
    this.ownerHash = hashToken(this.ownerToken)
    this.rateLimits = new Map()
    this.staticCache = new Map()
    this.server = null
    this.port = null
  }

  async start(startPort = 37123) {
    for (let port = startPort; port < startPort + 10; port += 1) {
      try {
        await this.listen(port)
        this.port = this.server.address().port
        return this.status()
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error('Could not find an available browser-access port.')
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this.route(request, response).catch(() => this.sendError(response, 500, 'Request failed.')))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        this.server = server
        resolve()
      })
    })
  }

  stop() {
    this.server?.close()
    this.server = null
  }

  status() {
    return { running: Boolean(this.server), port: this.port, localUrl: this.port ? `http://127.0.0.1:${this.port}` : '' }
  }

  ownerUrl() {
    return `${this.status().localUrl}/session?token=${encodeURIComponent(this.ownerToken)}`
  }

  createGrant(input) {
    const accountIds = [...new Set(input.accountIds || [])].filter((id) => this.getAccounts().some((account) => account.id === id))
    const permissions = [...new Set(input.permissions || [])].filter((permission) => VALID_PERMISSIONS.has(permission))
    if (!accountIds.length) throw new Error('Select at least one account.')
    if (!permissions.includes('view')) permissions.unshift('view')
    return this.accessStore.create({
      label: String(input.label || 'Shared access').trim().slice(0, 60) || 'Shared access',
      accountIds,
      permissions
    })
  }

  async route(request, response) {
    this.setSecurityHeaders(response)
    const url = new URL(request.url, 'http://localhost')

    if (request.method === 'GET' && url.pathname === '/session') return this.createSession(request, response, url)
    const staticFile = STATIC_FILES.get(url.pathname)
    if (request.method === 'GET' && staticFile) return this.serveStatic(response, ...staticFile)

    const grant = this.authenticate(request)
    if (!grant) return this.sendError(response, 401, 'Access link required.')
    if (!this.allowRequest(request, grant.id)) return this.sendError(response, 429, 'Too many requests. Try again shortly.')

    if (request.method === 'GET' && url.pathname === '/api/state') return this.sendState(request, response, grant)
    if (request.method === 'POST' && url.pathname === '/api/action') {
      if (request.headers['x-afkdesk-request'] !== '1') return this.sendError(response, 403, 'Invalid request.')
      const input = await readJson(request)
      return this.runAction(response, grant, input)
    }
    return this.sendError(response, 404, 'Not found.')
  }

  createSession(request, response, url) {
    const token = url.searchParams.get('token') || ''
    const grant = this.findGrant(token)
    if (!grant || token.length > 128) return this.sendError(response, 401, 'This access link is invalid or revoked.')
    const secure = request.headers['x-forwarded-proto'] === 'https'
    response.writeHead(302, {
      Location: '/',
      'Set-Cookie': `afkdesk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
      'Cache-Control': 'no-store'
    })
    response.end()
  }

  authenticate(request) {
    const cookies = parseCookies(request.headers.cookie || '')
    return this.findGrant(cookies.afkdesk_session || '')
  }

  findGrant(token) {
    if (!token || token.length > 128) return null
    const candidateHash = hashToken(token)
    if (safeEqual(candidateHash, this.ownerHash)) {
      return { id: 'owner', label: 'Owner', owner: true, accountIds: ['*'], permissions: [...VALID_PERMISSIONS] }
    }
    const grant = this.accessStore.list().find((item) => !item.revokedAt && safeEqual(item.tokenHash, candidateHash))
    return grant || null
  }

  buildState(grant) {
    const accounts = this.getAccounts()
      .filter((account) => grant.owner || grant.accountIds.includes(account.id))
      .map((account) => {
        const runtime = this.getRuntime(account.id)
        return {
          id: account.id,
          label: account.label,
          minecraftName: account.minecraftName || '',
          skinUrl: account.skinUrl || '',
          server: `${account.host}:${account.port}`,
          status: runtime.status,
          detail: runtime.detail,
          telemetry: runtime.telemetry || null,
          logs: runtime.logs.slice(-100)
        }
      })
    return { viewer: { label: grant.label, permissions: grant.permissions }, accounts }
  }

  async runAction(response, grant, input) {
    const accountId = String(input?.accountId || '')
    if (!grant.owner && !grant.accountIds.includes(accountId)) return this.sendError(response, 403, 'Account access denied.')
    const permission = permissionForAction(input?.action)
    if (!permission || !grant.permissions.includes(permission)) return this.sendError(response, 403, 'Permission denied.')
    const allowedActions = new Set(['connect', 'disconnect', 'chat', 'control', 'look'])
    if (!allowedActions.has(input.action)) return this.sendError(response, 422, 'Unknown action.')
    try {
      await this.handleAction(accountId, input.action, sanitizePayload(input.action, input.payload))
      return this.sendJson(response, 200, { ok: true })
    } catch (error) {
      return this.sendError(response, 409, String(error.message || 'Action failed.').slice(0, 180))
    }
  }

  allowRequest(request, grantId) {
    const key = `${request.socket.remoteAddress}:${grantId}`
    const now = Date.now()
    const current = this.rateLimits.get(key)
    if (!current || current.resetAt < now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + 60_000 })
      return true
    }
    current.count += 1
    return current.count <= 180
  }

  serveStatic(response, filename, contentType) {
    let body = this.staticCache.get(filename)
    if (!body) {
      body = fs.readFileSync(path.join(PUBLIC_DIR, filename))
      this.staticCache.set(filename, body)
    }
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    response.end(body)
  }

  sendState(request, response, grant) {
    const body = Buffer.from(JSON.stringify(this.buildState(grant)))
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' })
      return response.end()
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ETag: etag, 'Cache-Control': 'private, no-cache' })
    response.end(body)
  }

  setSecurityHeaders(response) {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://textures.minecraft.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  }

  sendJson(response, status, value) {
    const body = Buffer.from(JSON.stringify(value))
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    response.end(body)
  }

  sendError(response, status, message) {
    if (response.headersSent) return response.end()
    return this.sendJson(response, status, { error: message })
  }
}

function permissionForAction(action) {
  return { connect: 'connect', disconnect: 'connect', chat: 'chat', control: 'control', look: 'control' }[action]
}

function sanitizePayload(action, payload) {
  if (action === 'chat') return { message: String(payload?.message || '').trim().slice(0, 256) }
  if (action === 'control') {
    const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
    const control = String(payload?.control || '')
    if (!allowed.has(control)) throw new Error('Invalid movement control.')
    return { control, duration: Math.max(100, Math.min(Number(payload?.duration) || 350, 3000)) }
  }
  if (action === 'look') {
    const direction = String(payload?.direction || '')
    if (!['left', 'right'].includes(direction)) throw new Error('Invalid look direction.')
    return { direction }
  }
  return {}
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 8192) {
        reject(new Error('Request is too large.'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('Invalid JSON.')) }
    })
    request.on('error', reject)
  })
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2))
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'hex')
  const b = Buffer.from(String(right), 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = { RemoteAccessServer, permissionForAction, sanitizePayload }
