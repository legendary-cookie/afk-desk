'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { AppCore } = require('../core/app-core.cjs')
const { createFileSecretBox } = require('../core/secrets.cjs')
const { AuthManager } = require('../server/auth.cjs')
const { createRemoteServer, CSP_HEADER_VALUE } = require('../server/http-server.cjs')

class FakeBotManager {
  constructor() {}
  connect(account) { return { status: 'connecting', detail: account.host } }
  disconnect() { return { status: 'offline', detail: 'Disconnected' } }
  status() { return { status: 'offline', detail: 'Ready', logs: [] } }
  telemetry() { return {} }
  logs() { return [] }
  clearLogs() { return [] }
  sendChat() { return true }
  completeChat() { return [] }
  control() { return true }
  setControlState() { return true }
  look() { return true }
  lookDelta() { return true }
  dropStack() { return true }
  dropItems() { return true }
  depositSlot() { return true }
  setItemLock() { return { lockedInventorySlots: [] } }
  moveInventorySlot() { return true }
  equipInventoryItem() { return true }
  setAutoDeposit() { return true }
  clickWindowSlot() { return true }
  closeServerWindow() { return true }
  getWorldSnapshot() { return { blocks: [], entities: [] } }
  worldAction() { return { ok: true } }
  updateAccountConfig() {}
  getProxyHealth() { return [] }
}

async function createTestFixture(t, serverOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-http-sec-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const secretBox = createFileSecretBox({ dataDir })
  const core = new AppCore({
    userDataPath: dataDir,
    secretBox,
    BotManager: FakeBotManager,
    normalizeSkinUrl: (u) => u || '',
    platform: { getVersion: () => '0.10.0-test' }
  })
  await core.start()
  t.after(() => core.shutdown())

  const auth = new AuthManager({ dataDir, now: serverOptions.now || Date.now })
  if (serverOptions.adminPassword !== null) {
    auth.setAdminPasswordSync(serverOptions.adminPassword || 'AdminSecurityPass!2026')
  }

  const remote = createRemoteServer({
    core,
    auth,
    dataDir,
    bind: serverOptions.bind !== undefined ? serverOptions.bind : '127.0.0.1',
    port: serverOptions.port ?? 0,
    allowedHosts: serverOptions.allowedHosts || [],
    trustProxy: Boolean(serverOptions.trustProxy),
    iUnderstandPlainHttp: Boolean(serverOptions.iUnderstandPlainHttp),
    enableSetupToken: Boolean(serverOptions.enableSetupToken),
    now: serverOptions.now || Date.now,
    logger: serverOptions.logger || { log() {}, warn() {}, error() {} },
    timers: serverOptions.timers || globalThis
  })

  if (serverOptions.autoStart !== false) {
    await remote.start()
    t.after(() => remote.stop())
  }

  return { dataDir, core, auth, remote, port: remote.getPort() }
}

function rawRequest({ port, method = 'GET', path: reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null
      ? null
      : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    const finalHeaders = {
      Host: `127.0.0.1:${port}`,
      ...headers
    }
    if (payload !== null && finalHeaders['Content-Length'] === undefined) {
      finalHeaders['Content-Length'] = Buffer.byteLength(payload)
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: finalHeaders
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json
          })
        })
      }
    )
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

test('server refuses to start when no admin user exists and setup token is not enabled', async (t) => {
  const { remote } = await createTestFixture(t, { adminPassword: null, autoStart: false })
  await assert.rejects(
    () => remote.start(),
    /No admin user exists/
  )
})

test('first-run loopback one-time setup token initializes admin once and rejects reuse', async (t) => {
  const { remote, auth } = await createTestFixture(t, {
    adminPassword: null,
    enableSetupToken: true
  })
  const port = remote.getPort()
  assert.equal(auth.hasAdmin(), false)
  const setupToken = auth.setupToken.token
  assert.ok(setupToken)

  const res = await rawRequest({
    port,
    method: 'POST',
    path: '/api/setup',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`
    },
    body: {
      setupToken,
      password: 'FirstRunSetupPass!2026'
    }
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.ok(res.json.csrfToken)
  assert.equal(auth.hasAdmin(), true)

  // Second call with the same token is rejected
  const res2 = await rawRequest({
    port,
    method: 'POST',
    path: '/api/setup',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`
    },
    body: {
      setupToken,
      password: 'SecondRunSetupPass!2026'
    }
  })
  assert.equal(res2.status, 400)
  assert.equal(res2.json.error.code, 'SETUP_FAILED')
})

test('bind policy: refuses public/wildcard bind without trustProxy unless iUnderstandPlainHttp is true (with hourly warning)', async (t) => {
  // 1. Public/wildcard bind without trustProxy or iUnderstandPlainHttp -> refuses start
  const { remote: pubRemote } = await createTestFixture(t, {
    bind: '0.0.0.0',
    trustProxy: false,
    iUnderstandPlainHttp: false,
    autoStart: false
  })
  await assert.rejects(
    () => pubRemote.start(),
    /Refusing to bind plain HTTP server/
  )

  const { remote: pubIpRemote } = await createTestFixture(t, {
    bind: '203.0.113.9',
    trustProxy: false,
    iUnderstandPlainHttp: false,
    autoStart: false
  })
  await assert.rejects(
    () => pubIpRemote.start(),
    /Refusing to bind plain HTTP server/
  )

  // 2. Public/wildcard bind WITH iUnderstandPlainHttp logs immediate warning and schedules hourly warning
  const warnings = []
  let intervalMs = null
  const { remote: warnRemote } = await createTestFixture(t, {
    bind: '0.0.0.0',
    trustProxy: false,
    iUnderstandPlainHttp: true,
    autoStart: false,
    logger: { log() {}, warn: (msg) => warnings.push(msg), error() {} },
    timers: {
      setInterval: (fn, ms) => {
        intervalMs = ms
        fn()
        return 123
      },
      clearInterval: () => {}
    }
  })
  // Exercise the production bind policy without exposing a wildcard listener.
  let listenOptions
  warnRemote.httpServer.listen = (port, host) => {
    listenOptions = { port, host }
    queueMicrotask(() => warnRemote.httpServer.emit('listening'))
    return warnRemote.httpServer
  }
  await warnRemote.start()
  assert.equal(listenOptions.host, '0.0.0.0')
  await warnRemote.stop()
  assert.ok(warnings.length >= 2)
  assert.match(warnings[0], /SECURITY WARNING/)
  assert.equal(intervalMs, 60 * 60 * 1000)
})

test('Host header allowlist rejects non-allowlisted hosts with 421 Misdirected Request and accepts configured AFKDESK_ALLOWED_HOSTS', async (t) => {
  const { port } = await createTestFixture(t, {
    allowedHosts: ['mybox.tailnet.ts.net']
  })

  for (const badHost of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1.evil.com', 'localhost@evil.com', 'invalid:host:99999']) {
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { Host: badHost }
    })
    assert.equal(res.status, 421, `Expected 421 for Host: ${badHost}`)
    assert.equal(res.json.error.code, 'INVALID_HOST')
  }

  for (const goodHost of [`127.0.0.1:${port}`, '127.0.0.1', `localhost:${port}`, `mybox.tailnet.ts.net:${port}`, 'mybox.tailnet.ts.net']) {
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { Host: goodHost }
    })
    assert.equal(res.status, 200, `Expected 200 for Host: ${goodHost}`)
  }
})

test('Origin header must match an allowed host on every non-GET request and server never sends CORS headers', async (t) => {
  const { port } = await createTestFixture(t)

  // Missing Origin on POST -> 403
  const missingOrigin = await rawRequest({
    port,
    method: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json' },
    body: { username: 'admin', password: 'AdminSecurityPass!2026' }
  })
  assert.equal(missingOrigin.status, 403)
  assert.equal(missingOrigin.json.error.code, 'INVALID_ORIGIN')
  assert.equal(missingOrigin.headers['access-control-allow-origin'], undefined)

  // Foreign Origin on POST -> 403
  for (const badOrigin of ['https://evil.example.com', 'http://evil.localhost:8787', 'null']) {
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        Origin: badOrigin
      },
      body: { username: 'admin', password: 'AdminSecurityPass!2026' }
    })
    assert.equal(res.status, 403, `Expected 403 for Origin: ${badOrigin}`)
    assert.equal(res.json.error.code, 'INVALID_ORIGIN')
    assert.equal(res.headers['access-control-allow-origin'], undefined)
    assert.equal(res.headers['access-control-allow-credentials'], undefined)
  }
})

test('login success, cookie flags (HttpOnly, SameSite=Strict, Path=/, Secure behind HTTPS proxy), and CSRF enforcement', async (t) => {
  const { port, core } = await createTestFixture(t, { trustProxy: true })

  // Login over simulated HTTPS proxy
  const loginRes = await rawRequest({
    port,
    method: 'POST',
    path: '/api/login',
    headers: {
      'Content-Type': 'application/json',
      Origin: `https://127.0.0.1:${port}`,
      'X-Forwarded-Proto': 'https'
    },
    body: { username: 'admin', password: 'AdminSecurityPass!2026' }
  })
  assert.equal(loginRes.status, 200)
  assert.equal(loginRes.json.ok, true)
  assert.ok(loginRes.json.csrfToken)
  const setCookie = loginRes.headers['set-cookie']?.[0] || ''
  assert.match(setCookie, /afk_session=[0-9a-f]{64}/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\//)
  assert.match(setCookie, /Secure/)

  const cookiePair = setCookie.split(';')[0]
  const csrfToken = loginRes.json.csrfToken

  // POST /api/invoke without X-AFK-CSRF -> 403 CSRF_INVALID
  const noCsrf = await rawRequest({
    port,
    method: 'POST',
    path: '/api/invoke',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookiePair
    },
    body: { channel: 'accounts:list' }
  })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.json.error.code, 'CSRF_INVALID')

  // POST /api/invoke with wrong X-AFK-CSRF -> 403 CSRF_INVALID
  const badCsrf = await rawRequest({
    port,
    method: 'POST',
    path: '/api/invoke',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookiePair,
      'X-AFK-CSRF': '0'.repeat(64)
    },
    body: { channel: 'accounts:list' }
  })
  assert.equal(badCsrf.status, 403)
  assert.equal(badCsrf.json.error.code, 'CSRF_INVALID')

  // POST /api/invoke with valid X-AFK-CSRF -> 200
  const okInvoke = await rawRequest({
    port,
    method: 'POST',
    path: '/api/invoke',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookiePair,
      'X-AFK-CSRF': csrfToken
    },
    body: { channel: 'accounts:list' }
  })
  assert.equal(okInvoke.status, 200)
  assert.equal(okInvoke.json.ok, true)
  assert.deepEqual(okInvoke.json.result, [])

  // Audit log recorded login and invoke events
  const auditLogs = core.logs.list('audit')
  assert.ok(auditLogs.some((entry) => entry.command === 'auth.login'))
  assert.ok(auditLogs.some((entry) => entry.command === 'invoke:accounts:list'))
})

test('login rate limiting and lockout over HTTP after 5 failed attempts', async (t) => {
  const { port } = await createTestFixture(t)

  for (let i = 1; i <= 5; i++) {
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`
      },
      body: { username: 'admin', password: 'WrongPassword!9999' }
    })
    assert.equal(res.status, 401)
  }

  // 6th attempt is rate-limited with 429 + Retry-After
  const lockedRes = await rawRequest({
    port,
    method: 'POST',
    path: '/api/login',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`
    },
    body: { username: 'admin', password: 'WrongPassword!9999' }
  })
  assert.equal(lockedRes.status, 429)
  assert.equal(lockedRes.json.error.code, 'RATE_LIMITED')
  assert.ok(lockedRes.headers['retry-after'])
})

test('security headers, /healthz minimal payload, 256 KB body limit (413), and JSON-only Content-Type (415)', async (t) => {
  const { port } = await createTestFixture(t)

  // /healthz unauthenticated & leaks nothing else
  const health = await rawRequest({ port, method: 'GET', path: '/healthz' })
  assert.equal(health.status, 200)
  assert.deepEqual(Object.keys(health.json).sort(), ['ok', 'version'])
  assert.equal(health.json.ok, true)
  assert.equal(health.headers['content-security-policy'], CSP_HEADER_VALUE)
  assert.equal(health.headers['x-content-type-options'], 'nosniff')
  assert.equal(health.headers['referrer-policy'], 'no-referrer')
  assert.equal(health.headers['x-powered-by'], undefined)

  // Non-JSON Content-Type -> 415
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': contentType,
        Origin: `http://127.0.0.1:${port}`
      },
      body: 'username=admin&password=foo'
    })
    assert.equal(res.status, 415, `Expected 415 for Content-Type: ${contentType}`)
    assert.equal(res.json.error.code, 'UNSUPPORTED_MEDIA_TYPE')
  }

  // Body > 256 KB -> 413
  const oversized = JSON.stringify({ padding: 'x'.repeat(270 * 1024) })
  const tooLarge = await rawRequest({
    port,
    method: 'POST',
    path: '/api/login',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`
    },
    body: oversized
  })
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.json.error.code, 'PAYLOAD_TOO_LARGE')
})

test('static files serve allowlisted desktop/src and desktop/assets and reject path traversal variants with 400/404', async (t) => {
  const { port } = await createTestFixture(t)

  // Allowed static files
  const indexRes = await rawRequest({ port, method: 'GET', path: '/' })
  assert.equal(indexRes.status, 200)
  assert.match(indexRes.headers['content-type'], /^text\/html/)
  assert.equal(indexRes.headers['content-security-policy'], CSP_HEADER_VALUE)
  assert.match(indexRes.text, /browser-bridge\.js/)

  const bridgeRes = await rawRequest({ port, method: 'GET', path: '/server/browser-bridge.js' })
  assert.equal(bridgeRes.status, 200)
  assert.match(bridgeRes.headers['content-type'], /^application\/javascript/)

  const assetRes = await rawRequest({ port, method: 'GET', path: '/assets/pov-math.js' })
  assert.equal(assetRes.status, 200)

  // Path traversal variants and forbidden files must return 400 or 404
  const traversalPaths = [
    '/../package.json',
    '/..%2fpackage.json',
    '/..%2Fpackage.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json',
    '/%252e%252e/package.json',
    '/%252e%252e%252fpackage.json',
    '/src/../package.json',
    '/src/..%2fpackage.json',
    '/src/..%5cpackage.json',
    '/assets/../package.json',
    '/assets/..%2felectron/main.cjs',
    '/..\\package.json',
    '/electron/main.cjs',
    '/core/app-core.cjs',
    '/server/auth.cjs',
    '/assets/',
    '/src/'
  ]

  for (const attackPath of traversalPaths) {
    const res = await rawRequest({ port, method: 'GET', path: attackPath })
    assert.ok(
      res.status === 400 || res.status === 404,
      `Expected 400/404 for ${attackPath}, got ${res.status}`
    )
    assert.doesNotMatch(res.text, /"afk-desk-server"/)
  }
})
