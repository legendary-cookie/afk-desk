'use strict'
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer, WebSocket } = require('ws')
const { AuthManager, scopeAllows } = require('./auth.cjs')
const { createApiRouter, sanitizeRemoteOutput, remoteEvent, recordAudit } = require('./api-routes.cjs')

const MAX_BODY_BYTES = 256 * 1024 // 256 KB
const HOURLY_WARNING_MS = 60 * 60 * 1000 // 1 hour

const CSP_HEADER_VALUE = "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
})

function normalizeIp(ip) {
  const raw = String(ip || '').trim().replace(/^\[|\]$/g, '')
  if (raw.toLowerCase().startsWith('::ffff:')) {
    const v4 = raw.slice(7)
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return v4
  }
  return raw.toLowerCase()
}

function isLoopbackIp(ip) {
  const clean = normalizeIp(ip)
  if (clean === 'localhost' || clean === '::1' || clean === '127.0.0.1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean)
  if (!m) return false
  return [m[1], m[2], m[3]].every((octet) => Number(octet) >= 0 && Number(octet) <= 255)
}

function isTailscaleIp(ip) {
  const clean = normalizeIp(ip)
  // Tailscale IPv4 CGNAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  const v4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean)
  if (v4) {
    const second = Number(v4[1])
    const third = Number(v4[2])
    const fourth = Number(v4[3])
    return second >= 64 && second <= 127 && third <= 255 && fourth <= 255
  }
  // Tailscale IPv6 ULA: fd7a:115c:a1e0::/48
  if (/^fd7a:115c:a1e0(?::|$)/i.test(clean)) return true
  return false
}

function isPrivateIp(ip) {
  const clean = normalizeIp(ip)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean)
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if ([a, b, c, d].some((x) => x < 0 || x > 255)) return false
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  // IPv6 Unique Local (fc00::/7) and Link-Local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(clean)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(clean)) return true
  return false
}

function isWildcardIp(ip) {
  const clean = normalizeIp(ip)
  return clean === '0.0.0.0' || clean === '::' || clean === '::0' || clean === '*'
}

function isPublicOrWildcardBind(ip) {
  if (isWildcardIp(ip)) return true
  return !isLoopbackIp(ip) && !isTailscaleIp(ip) && !isPrivateIp(ip)
}

function detectNetworkInterfaces(interfacesMap = os.networkInterfaces()) {
  const list = []
  for (const [name, entries] of Object.entries(interfacesMap || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const address = String(entry?.address || '').trim()
      if (!address) continue
      const family = entry.family === 6 || entry.family === 'IPv6' ? 'IPv6' : 'IPv4'
      const loopback = Boolean(entry.internal) || isLoopbackIp(address)
      const tailscale = isTailscaleIp(address)
      const priv = isPrivateIp(address)
      const pub = !loopback && !tailscale && !priv
      const tag = tailscale ? 'Tailscale' : loopback ? 'Loopback' : priv ? 'Private LAN' : 'Public'
      list.push({
        name,
        address,
        family,
        loopback,
        tailscale,
        private: priv,
        public: pub,
        label: `${address} (${tag} — ${name})`
      })
    }
  }
  return list
}

function detectTailscaleAddresses(interfacesMap = os.networkInterfaces()) {
  return detectNetworkInterfaces(interfacesMap).filter((item) => item.tailscale)
}

function parseHostHeader(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return null
  const trimmed = rawHost.trim()
  if (!trimmed || trimmed.length > 255) return null
  if (trimmed.startsWith('[')) {
    const match = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(trimmed)
    if (!match) return null
    const port = match[2] ? Number(match[2]) : null
    if (port !== null && (port < 1 || port > 65535)) return null
    return { hostname: match[1].toLowerCase(), bracketed: `[${match[1].toLowerCase()}]`, port }
  }
  const match = /^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed)
  if (!match) return null
  const port = match[2] ? Number(match[2]) : null
  if (port !== null && (port < 1 || port > 65535)) return null
  return { hostname: match[1].toLowerCase(), bracketed: match[1].toLowerCase(), port }
}

function buildAllowedHostsSet(bind, allowedHostsInput = []) {
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  const cleanBind = normalizeIp(bind)
  if (cleanBind && !isWildcardIp(cleanBind)) {
    set.add(cleanBind)
    if (cleanBind.includes(':')) set.add(`[${cleanBind}]`)
  }
  const extra = Array.isArray(allowedHostsInput)
    ? allowedHostsInput
    : String(allowedHostsInput || '').split(',')
  for (const item of extra) {
    const raw = String(item || '').trim().toLowerCase()
    if (!raw) continue
    const parsed = parseHostHeader(raw.includes('://') ? (() => { try { return new URL(raw).host } catch { return '' } })() : raw)
    if (parsed) {
      set.add(parsed.hostname)
      set.add(parsed.bracketed)
    } else {
      set.add(raw.replace(/^\[|\]$/g, ''))
    }
  }
  return set
}

function isHostHeaderAllowed(rawHost, allowedHostsSet) {
  const parsed = parseHostHeader(rawHost)
  if (!parsed) return false
  return allowedHostsSet.has(parsed.hostname) || allowedHostsSet.has(parsed.bracketed)
}

function buildAllowedOrigins(bind, hosts, port, trustProxy) {
  const origins = new Set()
  for (const host of buildAllowedHostsSet(bind, [])) {
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    try { origins.add(new URL(`http://${authority}:${port}`).origin) } catch {}
    if (trustProxy) { try { origins.add(new URL(`https://${authority}:${port}`).origin) } catch {} }
  }
  for (const item of Array.isArray(hosts) ? hosts : String(hosts || '').split(',')) {
    try {
      const raw = String(item).trim()
      if (raw.includes('://')) {
        const url = new URL(raw)
        if (['http:', 'https:'].includes(url.protocol) && url.href === `${url.origin}/`) origins.add(url.origin)
      } else if (raw) {
        const host = parseHostHeader(raw)
        if (!host) continue
        const authority = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname
        origins.add(new URL(`http://${authority}:${host.port || port}`).origin)
        if (trustProxy) origins.add(new URL(`https://${authority}:${host.port || 443}`).origin)
      }
    } catch {}
  }
  return origins
}

function isOriginHeaderAllowed(originHeader, allowedOrigins) {
  if (!originHeader || typeof originHeader !== 'string') return false
  try {
    const url = new URL(originHeader)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.href === `${url.origin}/` && allowedOrigins.has(url.origin)
  } catch { return false }
}

function applySecurityHeaders(res) {
  res.removeHeader('X-Powered-By')
  res.setHeader('Content-Security-Policy', CSP_HEADER_VALUE)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return
  applySecurityHeaders(res)
  const body = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLengthHeader = req.headers['content-length']
    if (contentLengthHeader !== undefined) {
      const declaredLength = Number(contentLengthHeader)
      if (!Number.isFinite(declaredLength) || declaredLength < 0) {
        return reject(Object.assign(new Error('Invalid Content-Length header.'), { statusCode: 400, code: 'BAD_REQUEST' }))
      }
      if (declaredLength > MAX_BODY_BYTES) {
        return reject(Object.assign(new Error('Payload exceeds 256 KB limit.'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }))
      }
    }

    const contentType = String(req.headers['content-type'] || '').trim()
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return reject(Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }))
    }

    const chunks = []
    let totalBytes = 0
    let done = false

    req.on('data', (chunk) => {
      if (done) return
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        done = true
        reject(Object.assign(new Error('Payload exceeds 256 KB limit.'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (done) return
      done = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('JSON body must be an object.'), { statusCode: 400, code: 'INVALID_JSON' }))
        }
        resolve(parsed)
      } catch {
        reject(Object.assign(new Error('Malformed JSON payload.'), { statusCode: 400, code: 'INVALID_JSON' }))
      }
    })

    req.on('error', (err) => {
      if (done) return
      done = true
      reject(Object.assign(err, { statusCode: 400, code: 'BAD_REQUEST' }))
    })
  })
}

function isSuspiciousStaticPath(rawUrl) {
  const pathPart = String(rawUrl || '').split('?')[0].split('#')[0]
  if (!pathPart.startsWith('/')) return true
  if (pathPart.includes('\0') || pathPart.includes('\\')) return true
  if (/(?:^|\/)\.\.(?:\/|$)/.test(pathPart)) return true
  // Reject URL-encoded traversal characters (%2e, %2f, %5c, %00) and double-encoded variants (%252e, etc.)
  if (/%2e|%2f|%5c|%00|%25(?:2e|2f|5c|00)/i.test(pathPart)) return true
  let decoded
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return true
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('..')) return true
  const segments = decoded.split('/')
  if (segments.some((seg) => seg === '.' || seg === '..')) return true
  return false
}

function resolveStaticFile(rawUrl, { srcDir, assetsDir, bridgeFile }) {
  if (isSuspiciousStaticPath(rawUrl)) return null
  const cleanPath = decodeURIComponent(String(rawUrl || '/').split('?')[0].split('#')[0])

  if (cleanPath === '/' || cleanPath === '/index.html' || cleanPath === '/src/index.html') {
    return { filePath: path.join(srcDir, 'index.html'), isIndexHtml: true }
  }
  if (
    cleanPath === '/browser-bridge.js' ||
    cleanPath === '/server/browser-bridge.js' ||
    cleanPath === '/src/browser-bridge.js'
  ) {
    return { filePath: bridgeFile, isIndexHtml: false }
  }

  let baseDir = srcDir
  let relPath = cleanPath.slice(1)
  if (cleanPath.startsWith('/assets/')) {
    baseDir = assetsDir
    relPath = cleanPath.slice('/assets/'.length)
  } else if (cleanPath.startsWith('/src/')) {
    baseDir = srcDir
    relPath = cleanPath.slice('/src/'.length)
  }

  if (!relPath || relPath.includes('/') && !cleanPath.startsWith('/assets/') && !cleanPath.startsWith('/src/')) {
    // Only single-level files in src/ or assets/, no arbitrary subdirectories
  }

  const candidate = path.resolve(baseDir, relPath)
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`
  if (!candidate.startsWith(baseWithSep)) return null

  const ext = path.extname(candidate).toLowerCase()
  if (!Object.hasOwn(MIME_TYPES, ext)) return null

  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return null
    const realCandidate = fs.realpathSync(candidate)
    const realBase = fs.realpathSync(baseDir)
    const realBaseWithSep = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`
    if (!realCandidate.startsWith(realBaseWithSep)) return null
    return { filePath: realCandidate, isIndexHtml: candidate.endsWith(`${path.sep}index.html`) }
  } catch {
    return null
  }
}

function createRemoteServer({
  core,
  auth: injectedAuth,
  dataDir,
  bind: bindOption,
  port: portOption,
  allowedHosts: allowedHostsOption,
  trustProxy: trustProxyOption,
  iUnderstandPlainHttp = false,
  enableSetupToken = false,
  now = Date.now,
  timers = globalThis,
  logger = console,
  interfacesMap,
  desktopEmbedded = false,
  getRemoteAccessStatus = null,
  saveRemoteAccessSettings = null
} = {}) {
  if (!core) throw new TypeError('core (AppCore) is required')
  const resolvedDataDir = dataDir || core.userDataPath
  const explicitBind = bindOption !== undefined || Boolean(process.env.AFKDESK_BIND)
  const bind = String(bindOption ?? process.env.AFKDESK_BIND ?? '127.0.0.1').trim()
  const port = portOption !== undefined
    ? Number(portOption)
    : (process.env.AFKDESK_PORT !== undefined ? Number(process.env.AFKDESK_PORT) : 8787)
  const trustProxy = trustProxyOption !== undefined
    ? Boolean(trustProxyOption)
    : /^(?:1|true|yes)$/i.test(String(process.env.AFKDESK_TRUST_PROXY || ''))
  const allowedHostsInput = allowedHostsOption !== undefined
    ? allowedHostsOption
    : (process.env.AFKDESK_ALLOWED_HOSTS || '')

  const wsBySession = new Map()
  const wsByToken = new Map()
  const allWsClients = new Set()

  const closeActorSockets = (map, id, reason) => {
    const set = map.get(id)
    if (!set) return
    map.delete(id)
    for (const ws of set) {
      allWsClients.delete(ws)
      try { ws.close(4401, reason) } catch {}
    }
  }

  const auth = injectedAuth || new AuthManager({
    dataDir: resolvedDataDir,
    now,
    onSessionRevoked: (sessionId) => closeActorSockets(wsBySession, sessionId, 'Session revoked'),
    onTokenRevoked: (tokenId) => closeActorSockets(wsByToken, tokenId, 'Token revoked')
  })

  if (injectedAuth) {
    const prevSessionRevoked = auth.onSessionRevoked
    const prevTokenRevoked = auth.onTokenRevoked
    auth.onSessionRevoked = (sessionId) => {
      try { prevSessionRevoked?.(sessionId) } catch {}
      closeActorSockets(wsBySession, sessionId, 'Session revoked')
    }
    auth.onTokenRevoked = (tokenId) => {
      try { prevTokenRevoked?.(tokenId) } catch {}
      closeActorSockets(wsByToken, tokenId, 'Token revoked')
    }
  }

  let allowedHostsSet = buildAllowedHostsSet(bind, allowedHostsInput)
  let allowedOrigins = buildAllowedOrigins(bind, allowedHostsInput, port, trustProxy)
  let pkgVersion = '0.10.0-beta.9'
  try {
    pkgVersion = require('../package.json').version || pkgVersion
  } catch {}

  const srcDir = path.resolve(__dirname, '..', 'src')
  const assetsDir = path.resolve(__dirname, '..', 'assets')
  const bridgeFile = path.resolve(__dirname, 'browser-bridge.js')

  function getClientIp(req) {
    if (trustProxy) {
      // Use the RIGHT-most entry: it is appended by our own trusted proxy. Earlier
      // entries are client-controlled (e.g. a spoofed "127.0.0.1" would otherwise
      // grant the loopback lockout exemption and allow unlimited password guessing).
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean).pop() || ''
      if (forwarded) return normalizeIp(forwarded)
    }
    return normalizeIp(req.socket?.remoteAddress || '127.0.0.1')
  }

  function isSecureRequest(req) {
    if (req.socket?.encrypted) return true
    if (trustProxy) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
      if (proto === 'https') return true
    }
    return false
  }

  function getCapabilities() {
    return {
      mode: desktopEmbedded ? 'desktop-remote' : 'server',
      headless: !desktopEmbedded,
      isolatedLoginWindow: false,
      openExternal: false,
      autoLaunch: false,
      fileDialogs: false,
      windowControls: false,
      deviceCodeSignIn: true,
      bedrock: Boolean(core.botManager?.bedrock || core.bots?.bedrock)
    }
  }

  const apiRouter = createApiRouter({
    core,
    auth,
    now,
    pkgVersion,
    isLoopbackIp,
    isSecureRequest,
    getCapabilities,
    getRemoteAccessStatus,
    saveRemoteAccessSettings
  })

  const httpServer = http.createServer(async (req, res) => {
    applySecurityHeaders(res)
    const clientIp = getClientIp(req)
    const method = String(req.method || 'GET').toUpperCase()
    const rawUrl = String(req.url || '/')

    // Rule 3: Host header allowlist (DNS-rebinding defence) -> 421 Misdirected Request
    if (!isHostHeaderAllowed(req.headers.host, allowedHostsSet)) {
      return sendJson(res, 421, {
        ok: false,
        error: { code: 'INVALID_HOST', message: 'Host header is not allowlisted.' }
      })
    }

    // Rule 4: Origin header check on every non-GET/HEAD request -> 403 Forbidden
    if (method !== 'GET' && method !== 'HEAD') {
      if (!isOriginHeaderAllowed(req.headers.origin, allowedOrigins)) {
        recordAudit(core, now, {
          actor: { kind: 'anonymous', id: 'origin-check', scope: 'none', ip: clientIp },
          command: `${method} ${rawUrl.split('?')[0]}`,
          result: 'forbidden',
          code: 'INVALID_ORIGIN',
          ip: clientIp
        })
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'INVALID_ORIGIN', message: 'Origin header is missing or not allowlisted.' }
        })
      }
    }

    const pathname = rawUrl.split('?')[0].split('#')[0]

    // API and healthz routes
    if (pathname === '/healthz' || pathname === '/api' || pathname.startsWith('/api/')) {
      let body = {}
      if (method !== 'GET' && method !== 'HEAD') {
        const hasBody =
          method === 'POST' ||
          method === 'PUT' ||
          method === 'PATCH' ||
          req.headers['content-length'] !== undefined ||
          req.headers['transfer-encoding'] !== undefined
        if (hasBody) {
          try {
            body = await readJsonBody(req)
          } catch (err) {
            const status = err.statusCode || 400
            return sendJson(res, status, {
              ok: false,
              error: { code: err.code || 'BAD_REQUEST', message: err.message }
            })
          }
        }
      }
      try {
        await apiRouter.handleApi(req, res, { pathname, method, body, clientIp, sendJson })
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' }
        })
      }
      return
    }

    // Static file serving (GET / HEAD only)
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' }
      })
    }

    if (isSuspiciousStaticPath(rawUrl)) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: 'INVALID_PATH', message: 'Invalid path.' }
      })
    }

    const resolvedStatic = resolveStaticFile(rawUrl, { srcDir, assetsDir, bridgeFile })
    if (!resolvedStatic) {
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'File not found.' }
      })
    }

    try {
      const ext = path.extname(resolvedStatic.filePath).toLowerCase()
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      let content = fs.readFileSync(resolvedStatic.filePath)
      if (resolvedStatic.isIndexHtml) {
        // Align the embedded meta CSP with the HTTP CSP so browser fetch(/api/*) and WS(/ws) work
        const htmlText = content.toString('utf8').replace(
          /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
          `<meta http-equiv="Content-Security-Policy" content="${CSP_HEADER_VALUE}" />`
        )
        content = Buffer.from(htmlText, 'utf8')
      }
      res.statusCode = 200
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Length', content.length)
      if (method === 'HEAD') return res.end()
      res.end(content)
    } catch {
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'File not found.' }
      })
    }
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })

  function rejectUpgrade(socket, statusCode, statusText, message) {
    try {
      const body = JSON.stringify({ ok: false, error: { code: statusText.toUpperCase().replace(/\s+/g, '_'), message } })
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n` +
        `Content-Security-Policy: ${CSP_HEADER_VALUE}\r\n` +
        `X-Content-Type-Options: nosniff\r\n` +
        `Referrer-Policy: no-referrer\r\n` +
        `Connection: close\r\n` +
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n` +
        body
      )
    } catch {}
    try { socket.destroy() } catch {}
  }

  httpServer.on('upgrade', async (req, socket, head) => {
    const clientIp = getClientIp(req)
    const rawUrl = String(req.url || '/')
    const pathname = rawUrl.split('?')[0].split('#')[0]

    // 1. Host header check on WS upgrade
    if (!isHostHeaderAllowed(req.headers.host, allowedHostsSet)) {
      return rejectUpgrade(socket, 421, 'Misdirected Request', 'Host header is not allowlisted.')
    }

    // 2. Origin header check on WS upgrade
    if (!isOriginHeaderAllowed(req.headers.origin, allowedOrigins)) {
      recordAudit(core, now, {
        actor: { kind: 'anonymous', id: 'ws-origin', scope: 'none', ip: clientIp },
        command: 'ws.connect',
        result: 'forbidden',
        code: 'INVALID_ORIGIN',
        ip: clientIp
      })
      return rejectUpgrade(socket, 403, 'Forbidden', 'Origin header is missing or not allowlisted.')
    }

    // 3. Only /ws path is supported
    if (pathname !== '/ws') {
      return rejectUpgrade(socket, 404, 'Not Found', 'WebSocket endpoint not found.')
    }

    // 4. Authenticate session or Bearer token
    let authentication
    try { authentication = await apiRouter.authenticateRequest(req, clientIp) } catch { return rejectUpgrade(socket, 429, 'Too Many Requests', 'Authentication capacity exceeded.') }
    const { actor, session, error: authErr } = authentication
    if (!actor) {
      recordAudit(core, now, {
        actor: { kind: 'anonymous', id: 'ws-anon', scope: 'none', ip: clientIp },
        command: 'ws.connect',
        result: 'unauthorized',
        code: 'UNAUTHORIZED',
        ip: clientIp
      })
      return rejectUpgrade(socket, 401, 'Unauthorized', authErr || 'Authentication required.')
    }

    if (session) {
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(p => p.trim())
      const proof = protocols.find(p => p.startsWith('afk-csrf.'))?.slice(9) || new URL(rawUrl, 'http://localhost').searchParams.get('csrf')
      if (!auth.verifyCsrf(session, proof)) return rejectUpgrade(socket, 403, 'Forbidden', 'Invalid WebSocket CSRF token.')
    }
    // 5. Connection limit check: 1 per session, 5 per token
    if (!auth.canAttachWebSocket(actor)) {
      recordAudit(core, now, {
        actor,
        command: 'ws.connect',
        result: 'rate_limited',
        code: 'WS_LIMIT_EXCEEDED',
        ip: clientIp
      })
      return rejectUpgrade(socket, 429, 'Too Many Requests', 'WebSocket connection limit exceeded.')
    }

    if (!auth.isActorValid(actor)) return rejectUpgrade(socket, 401, 'Unauthorized', 'Credential expired or revoked.')
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!auth.isActorValid(actor)) { ws.close(4401, 'Credential expired or revoked.'); return }
      const detach = auth.attachWebSocket(actor, ws)
      ws.actor = actor
      allWsClients.add(ws)
      const trackerMap = actor.kind === 'session' ? wsBySession : wsByToken
      let actorSet = trackerMap.get(actor.id)
      if (!actorSet) {
        actorSet = new Set()
        trackerMap.set(actor.id, actorSet)
      }
      actorSet.add(ws)

      recordAudit(core, now, {
        actor,
        command: 'ws.connect',
        result: 'allowed',
        ip: clientIp
      })

      let messageTimes = []
      ws.on('message', () => {
        if (ws.readyState !== WebSocket.OPEN) return
        const time = now()
        messageTimes = messageTimes.filter(t => time - t < 10_000)
        messageTimes.push(time)
        if (messageTimes.length > 10) ws.close(1008, 'Message rate exceeded')
      })
      ws.on('close', () => {
        detach()
        allWsClients.delete(ws)
        actorSet.delete(ws)
        if (actorSet.size === 0) trackerMap.delete(actor.id)
      })

      ws.on('error', () => {
        detach()
        allWsClients.delete(ws)
        actorSet.delete(ws)
        if (actorSet.size === 0) trackerMap.delete(actor.id)
      })

      // Push initial runtime states for accounts if available
      try {
        const accounts = core.accounts?.list?.() || []
        for (const acc of accounts) {
          const st = core.status?.(acc.id)
          if (st) {
            if (st.status) {
              sendWsEvent(ws, 'bot:event', { type: 'status', id: acc.id, payload: { status: st.status, detail: st.detail } })
            }
            if (st.telemetry) {
              sendWsEvent(ws, 'bot:event', { type: 'telemetry', id: acc.id, payload: st.telemetry })
            }
          }
        }
      } catch {}
    })
  })

  function sendWsEvent(ws, channel, payload) {
    if (ws.readyState !== WebSocket.OPEN) return
    const actor = ws.actor
    if (!actor || !scopeAllows(actor.scope, 'read')) return

    if (!auth.isActorValid(actor)) { ws.close(4401, 'Credential expired or revoked.'); return }
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return }
    const projected = remoteEvent(channel, payload, actor)
    if (projected === null) return
    try {
      const safePayload = sanitizeRemoteOutput(core, projected)
      ws.send(JSON.stringify({ channel, payload: safePayload }))
      if (ws.bufferedAmount > 1024 * 1024) ws.terminate()
    } catch {}
  }

  function broadcast(channel, payload) {
    for (const ws of allWsClients) {
      sendWsEvent(ws, channel, payload)
    }
  }

  // Wire into core.emitToUi while preserving any existing emitToUi callback
  const previousEmitToUi = core.emitToUi
  core.emitToUi = (channel, payload) => {
    try { previousEmitToUi?.(channel, payload) } catch {}
    broadcast(channel, payload)
  }

  let hourlyWarningTimer = null
  let listening = false

  async function start() {
    if (listening) return address()

    // Rule 1: Refuse to start without an admin user (unless one-time loopback setup token is enabled)
    if (!auth.hasAdmin()) {
      if (enableSetupToken && isLoopbackIp(bind)) {
        const { token } = auth.issueSetupToken()
        logger.log?.(`[AFK Desk Server] One-time loopback setup token (valid 15m): ${token}`)
      } else {
        throw new Error('No admin user exists. Run "afk-desk-server init" to create an admin user before starting.')
      }
    }

    // Rule 2: Non-loopback bind requires explicit config
    if (!isLoopbackIp(bind) && !explicitBind) {
      throw new Error('Binding to a non-loopback address requires an explicit bind configuration.')
    }

    // Rule 2 & 10: Refuse public non-private/non-tailnet bind without trustProxy HTTPS unless --i-understand-plain-http
    if (isPublicOrWildcardBind(bind) && !trustProxy) {
      if (!iUnderstandPlainHttp) {
        throw new Error(
          `Refusing to bind plain HTTP server to public/wildcard address "${bind}" without trustProxy HTTPS. ` +
          `Bind to 127.0.0.1, a Tailscale address (100.64.0.0/10), or pass --i-understand-plain-http.`
        )
      }
      const warnMsg = `[SECURITY WARNING] AFK Desk server is bound to "${bind}" over plain HTTP without a trusted HTTPS proxy!`
      logger.warn?.(warnMsg)
      hourlyWarningTimer = timers.setInterval?.(() => {
        logger.warn?.(warnMsg)
      }, HOURLY_WARNING_MS)
      hourlyWarningTimer?.unref?.()
    }

    // Detect and print Tailscale addresses
    const tailscaleAddrs = detectTailscaleAddresses(interfacesMap)
    if (tailscaleAddrs.length > 0) {
      logger.log?.(`[AFK Desk Server] Detected Tailscale address(es): ${tailscaleAddrs.map((a) => a.address).join(', ')}`)
    }

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        httpServer.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        httpServer.removeListener('error', onError)
        listening = true
        const actualAddr = httpServer.address()
        if (actualAddr && typeof actualAddr === 'object' && actualAddr.address) {
          allowedHostsSet = buildAllowedHostsSet(bind, allowedHostsInput)
          allowedOrigins = buildAllowedOrigins(bind, allowedHostsInput, actualAddr.port, trustProxy)
        }
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(port, bind)
    })

    return address()
  }

  async function stop() {
    if (hourlyWarningTimer) {
      timers.clearInterval?.(hourlyWarningTimer)
      hourlyWarningTimer = null
    }
    for (const ws of allWsClients) {
      try { ws.close(1001, 'Server shutting down') } catch {}
      try { ws.terminate?.() } catch {}
    }
    allWsClients.clear()
    wsBySession.clear()
    wsByToken.clear()

    if (!listening) return
    listening = false
    await new Promise((resolve) => {
      httpServer.close(() => resolve())
      try { httpServer.closeAllConnections?.() } catch {}
    })
  }

  function address() {
    const addr = httpServer.address()
    if (!addr || typeof addr === 'string') return { address: bind, port }
    return { address: bind, port: addr.port, family: addr.family }
  }

  function isListening() {
    return listening
  }

  function getPort() {
    return address().port
  }

  function updateAllowedHosts(nextAllowedHosts) {
    allowedHostsSet = buildAllowedHostsSet(bind, nextAllowedHosts)
    allowedOrigins = buildAllowedOrigins(bind, nextAllowedHosts, getPort(), trustProxy)
  }

  return {
    httpServer,
    wss,
    auth,
    start,
    stop,
    address,
    getPort,
    isListening,
    isRunning: isListening,
    broadcast,
    updateAllowedHosts,
    getCapabilities
  }
}

module.exports = {
  createRemoteServer,
  CSP_HEADER_VALUE,
  MAX_BODY_BYTES,
  HOURLY_WARNING_MS,
  normalizeIp,
  isLoopbackIp,
  isTailscaleIp,
  isPrivateIp,
  isWildcardIp,
  isPublicOrWildcardBind,
  detectNetworkInterfaces,
  detectTailscaleAddresses,
  parseHostHeader,
  buildAllowedHostsSet,
  isHostHeaderAllowed,
  isOriginHeaderAllowed,
  buildAllowedOrigins
}
