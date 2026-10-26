'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { WebSocket } = require('ws')
const { AppCore } = require('../core/app-core.cjs')
const { createFileSecretBox } = require('../core/secrets.cjs')
const { AuthManager } = require('../server/auth.cjs')
const { createRemoteServer, detectNetworkInterfaces } = require('../server/http-server.cjs')
const { createBrowserBridge } = require('../server/browser-bridge.js')
const { runCli } = require('../server/cli.cjs')

class FakeBotManager {
  constructor() {
    this.connectedIds = []
    this.disconnectedIds = []
    this.chats = []
  }
  connect(account) {
    this.connectedIds.push(account.id)
    return { status: 'online', detail: `Connected to ${account.host}` }
  }
  disconnect(id) {
    this.disconnectedIds.push(id)
    return { status: 'offline', detail: 'Disconnected' }
  }
  status(id) {
    return {
      status: this.connectedIds.includes(id) ? 'online' : 'offline',
      detail: 'Ready',
      logs: []
    }
  }
  telemetry() { return { health: 20, food: 20 } }
  logs() { return [] }
  clearLogs() { return [] }
  sendChat(id, message) {
    this.chats.push({ id, message })
    return { ok: true }
  }
  completeChat() { return [{ value: '/spawn', label: '/spawn' }] }
  control() { return { ok: true } }
  setControlState() { return { ok: true } }
  look() { return { ok: true } }
  lookDelta() { return { ok: true } }
  dropStack() { return { ok: true } }
  dropItems() { return { ok: true } }
  depositSlot() { return { ok: true } }
  setItemLock() { return { lockedInventorySlots: [0] } }
  moveInventorySlot() { return { ok: true } }
  equipInventoryItem() { return { ok: true } }
  setAutoDeposit() { return { ok: true } }
  clickWindowSlot() { return { ok: true } }
  closeServerWindow() { return { ok: true } }
  closeWindow() { return { ok: true } }
  getWorldSnapshot() { return { blocks: [], entities: [] } }
  worldSnapshot() { return { blocks: [], entities: [] } }
  worldAction() { return { ok: true } }
  updateAccountConfig() {}
  getProxyHealth() { return [{ id: 'p1', healthy: true }] }
  proxyHealth() { return [{ id: 'p1', healthy: true }] }
}

async function createApiFixture(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-api-ws-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const secretBox = createFileSecretBox({ dataDir })
  const core = new AppCore({
    userDataPath: dataDir,
    secretBox,
    BotManager: FakeBotManager,
    normalizeSkinUrl: (u) => u || '',
    platform: {
      getVersion: () => '0.10.0-test',
      ...(opts.platform || {})
    }
  })
  await core.start()
  t.after(() => core.shutdown())

  const auth = new AuthManager({ dataDir, now: opts.now || Date.now })
  auth.setAdminPasswordSync(opts.adminPassword || 'AdminApiPass!2026')

  const remote = createRemoteServer({
    core,
    auth,
    dataDir,
    bind: '127.0.0.1',
    port: 0,
    now: opts.now || Date.now
  })
  await remote.start()
  t.after(() => remote.stop())

  return { dataDir, core, auth, remote, port: remote.getPort() }
}

function httpJson({ port, method = 'POST', path: reqPath = '/api/invoke', token = null, cookie = null, csrf = null, origin = undefined, body = undefined }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = {
      Host: `127.0.0.1:${port}`
    }
    if (origin !== null) {
      headers.Origin = origin !== undefined ? origin : `http://127.0.0.1:${port}`
    }
    if (payload !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (cookie) headers.Cookie = cookie
    if (csrf) headers['X-AFK-CSRF'] = csrf

    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function connectWs({ port, headers = {} }) {
  return new Promise((resolve) => {
    const protocols = headers['Sec-WebSocket-Protocol'] ? [headers['Sec-WebSocket-Protocol']] : []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        ...headers
      }
    })
    const messages = []
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch {}
    })
    ws.once('open', () => resolve({ ok: true, ws, messages }))
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      try { ws.terminate() } catch {}
      resolve({ ok: false, statusCode: res.statusCode, ws })
    })
    ws.once('error', (err) => {
      resolve({ ok: false, error: err, ws })
    })
  })
}

test('scope enforcement per channel on POST /api/invoke and 501 on Electron-only channels', async (t) => {
  const { port, auth, core } = await createApiFixture(t)

  const savedAcc = core.accounts.save({
    username: 'BuilderBot',
    host: 'play.example.com',
    port: 25565,
    edition: 'java'
  })

  const readTok = auth.createTokenSync({ name: 'reader', scope: 'read' }).token
  const controlTok = auth.createTokenSync({ name: 'controller', scope: 'control' }).token
  const adminTok = auth.createTokenSync({ name: 'administrator', scope: 'admin' }).token

  // 1. Read token CAN call read channels
  for (const [channel, args] of [
    ['accounts:list', undefined],
    ['logs:list', { id: savedAcc.id }],
    ['macros:list', undefined],
    ['proxy:health', undefined],
    ['settings:get', undefined],
    ['app:version', undefined],
    ['app:supported-versions', undefined],
    ['bot:world-snapshot', { id: savedAcc.id, radius: 4 }]
  ]) {
    const res = await httpJson({ port, token: readTok, body: { channel, args } })
    assert.equal(res.status, 200, `read token should allow ${channel}`)
    assert.equal(res.json.ok, true)
  }

  // 2. Read token CANNOT call control or admin channels -> 403
  for (const [channel, args] of [
    ['bot:connect', savedAcc.id],
    ['bot:disconnect', savedAcc.id],
    ['bot:chat', { id: savedAcc.id, message: 'hi' }],
    ['bot:complete-chat', { id: savedAcc.id, text: '/' }],
    ['bot:control', { id: savedAcc.id, control: 'jump', duration: 200 }],
    ['accounts:save', { username: 'Hacker', host: 'mc.example.com', port: 25565 }],
    ['accounts:delete', savedAcc.id],
    ['settings:save', { uiScale: 110 }],
    ['notify:save', { channels: [] }]
  ]) {
    const res = await httpJson({ port, token: readTok, body: { channel, args } })
    assert.equal(res.status, 403, `read token must forbid ${channel}`)
    assert.equal(res.json.error.code, 'FORBIDDEN')
  }

  // 3. Control token CAN call bot control channels
  for (const [channel, args] of [
    ['bot:connect', savedAcc.id],
    ['bot:chat', { id: savedAcc.id, message: 'hello world' }],
    ['bot:complete-chat', { id: savedAcc.id, text: '/' }],
    ['bot:control', { id: savedAcc.id, control: 'jump', duration: 200 }],
    ['bot:disconnect', savedAcc.id]
  ]) {
    const res = await httpJson({ port, token: controlTok, body: { channel, args, confirmed: true } })
    assert.equal(res.status, 200, `control token should allow ${channel}`)
    assert.equal(res.json.ok, true)
  }

  // 4. Control token CANNOT call admin channels (accounts/settings/notify/tokens) -> 403
  for (const [channel, args] of [
    ['accounts:save', { username: 'NewAcc', host: 'mc.example.com', port: 25565 }],
    ['accounts:delete', savedAcc.id],
    ['accounts:duplicate-profile', savedAcc.id],
    ['settings:save', { uiScale: 105 }],
    ['notify:save', { channels: [] }],
    ['macros:save', { name: 'TestMacro', steps: [] }]
  ]) {
    const res = await httpJson({ port, token: controlTok, body: { channel, args } })
    assert.equal(res.status, 403, `control token must forbid ${channel}`)
    assert.equal(res.json.error.code, 'FORBIDDEN')
  }
  const controlTokensRes = await httpJson({ port, method: 'GET', path: '/api/tokens', token: controlTok })
  assert.equal(controlTokensRes.status, 403)

  // 5. Account administration requires an admin session, never an admin token.
  const adminSaveAcc = await httpJson({
    port,
    token: adminTok,
    body: {
      channel: 'accounts:save',
      args: { username: 'AdminCreated', host: 'play.example.com', port: 25565 }
    }
  })
  assert.equal(adminSaveAcc.status, 403)
  const session = auth.createSession()
  const sessionSave = await httpJson({ port, cookie: `afk_session=${session.id}`, csrf: session.csrfToken,
    body: { channel: 'accounts:save', args: { username: 'AdminCreated', host: 'play.example.com', port: 25565 } } })
  assert.equal(sessionSave.status, 200)
  assert.equal(sessionSave.json.result.name, 'play.example.com')
  assert.equal(sessionSave.json.result.username, undefined)

  // 6. Electron-only channels return 501 Not Implemented and are reported in capabilities
  for (const channel of ['auth:open-isolated', 'system:open-external', 'window:minimize', 'dialog:open-file', 'app:auto-launch']) {
    const res = await httpJson({ port, token: adminTok, body: { channel, args: {} } })
    assert.equal(res.status, 501, `Expected 501 for Electron-only channel ${channel}`)
    assert.equal(res.json.error.code, 'UNSUPPORTED')
  }

  const capsRes = await httpJson({ port, method: 'GET', path: '/api/capabilities', token: readTok })
  assert.equal(capsRes.status, 200)
  assert.equal(capsRes.json.capabilities.isolatedLoginWindow, false)
  assert.equal(capsRes.json.capabilities.openExternal, false)
  assert.equal(capsRes.json.capabilities.autoLaunch, false)
  assert.equal(capsRes.json.capabilities.fileDialogs, false)
  assert.equal(capsRes.json.capabilities.windowControls, false)
  assert.equal(capsRes.json.capabilities.deviceCodeSignIn, true)
})

test('token management HTTP endpoints: create/show-once, list without secret, revoke, expiry, and /api/commands/:name', async (t) => {
  let nowMs = 1_700_000_000_000
  const { port } = await createApiFixture(t, { now: () => nowMs })

  // Login as admin session
  const loginRes = await httpJson({
    port,
    path: '/api/login',
    body: { username: 'admin', password: 'AdminApiPass!2026' }
  })
  const cookie = loginRes.headers['set-cookie'][0].split(';')[0]
  const csrf = loginRes.json.csrfToken

  // Create token via POST /api/tokens
  const createRes = await httpJson({
    port,
    path: '/api/tokens',
    cookie,
    csrf,
    body: { name: 'Phone Token', scope: 'control', expiresInDays: 1 }
  })
  assert.equal(createRes.status, 201)
  assert.match(createRes.json.token, /^afk_[0-9a-f]{16}_[0-9a-f]{48}$/)
  const rawToken = createRes.json.token
  const tokenId = createRes.json.record.id

  // GET /api/tokens lists metadata without the secret
  const listRes = await httpJson({
    port,
    method: 'GET',
    path: '/api/tokens',
    cookie
  })
  assert.equal(listRes.status, 200)
  assert.equal(listRes.json.tokens.length, 1)
  assert.equal(listRes.json.tokens[0].id, tokenId)
  assert.equal(listRes.text.includes(rawToken), false)
  assert.equal(listRes.text.includes(rawToken.split('_')[2]), false)

  // Execute command via POST /api/commands/status with Bearer token
  const cmdRes = await httpJson({
    port,
    path: '/api/commands/status',
    token: rawToken,
    body: { args: {} }
  })
  assert.equal(cmdRes.status, 200)
  assert.equal(cmdRes.json.ok, true)

  // Create another token before advancing clock, and revoke via DELETE /api/tokens/:id
  const createRes2 = await httpJson({
    port,
    path: '/api/tokens',
    cookie,
    csrf,
    body: { name: 'Revocable Token', scope: 'read' }
  })
  const token2 = createRes2.json.token
  const token2Id = createRes2.json.record.id

  const delRes = await httpJson({
    port,
    method: 'DELETE',
    path: `/api/tokens/${token2Id}`,
    cookie,
    csrf
  })
  assert.equal(delRes.status, 200)
  assert.equal(delRes.json.ok, true)

  const afterRevoke = await httpJson({
    port,
    path: '/api/invoke',
    token: token2,
    body: { channel: 'accounts:list' }
  })
  assert.equal(afterRevoke.status, 401)
  assert.equal(afterRevoke.json.error.code, 'UNAUTHORIZED')

  // Advance past 1 day expiry -> 401 UNAUTHORIZED
  nowMs += 2 * 24 * 60 * 60 * 1000
  const expiredRes = await httpJson({
    port,
    path: '/api/commands/status',
    token: rawToken,
    body: { args: {} }
  })
  assert.equal(expiredRes.status, 401)
  assert.equal(expiredRes.json.error.code, 'UNAUTHORIZED')
})

test('secrets never appear in any API response or WebSocket message (proxy password, webhook URL, bot token, MSAL token)', async (t) => {
  const { port, core, auth } = await createApiFixture(t)
  const adminTok = auth.createTokenSync({ name: 'admin-tok', scope: 'admin' }).token
  const session = auth.createSession()

  const FAKE_PROXY_PASS = 'FAKE_PROXY_PASSWORD_SECRET_9999'
  const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/123456789/FAKE_DISCORD_WEBHOOK_SECRET_8888'
  const FAKE_BOT_TOKEN = '123456:FAKE_TELEGRAM_BOT_TOKEN_SECRET_7777'
  const FAKE_REFRESH_TOKEN = 'FAKE_MSAL_REFRESH_TOKEN_SECRET_6666'

  const account = core.accounts.save({
    username: 'secret@example.com',
    host: 'play.example.com',
    port: 25565,
    proxy: {
      enabled: true,
      type: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      username: 'proxyuser',
      password: FAKE_PROXY_PASS
    }
  })

  core.notify.save({
    type: 'discord',
    name: 'Discord Alerts',
    enabled: true,
    events: ['kicked'],
    webhookUrl: FAKE_WEBHOOK
  })
  core.notify.save({
    type: 'telegram',
    name: 'Telegram Alerts',
    enabled: true,
    events: ['kicked'],
    botToken: FAKE_BOT_TOKEN,
    chatId: '12345'
  })
  core._appendAudit({ actor: { kind: 'session', id: session.id, scope: 'admin' },
    accountId: account.id, command: 'account.connect', result: 'allowed' })
  core._appendAudit({ actor: { kind: 'token', id: adminTok.split('_')[1], scope: 'admin' },
    accountId: account.id, command: 'status', result: 'allowed' })
  const echoedSecrets = `hello secret@example.com ${FAKE_PROXY_PASS} ${FAKE_WEBHOOK} ${FAKE_BOT_TOKEN} prefix${session.id}suffix ${adminTok}`
  core.eventStore.append(account.id, { type: 'log', kind: 'chat', message: echoedSecrets,
    password: FAKE_PROXY_PASS, webhookUrl: FAKE_WEBHOOK, botToken: FAKE_BOT_TOKEN, refreshToken: FAKE_REFRESH_TOKEN })
  assert.ok(core.logs.list('audit').length >= 2)
  assert.ok(core.logs.list(account.id).some(e => e.type === 'audit'))

  const wsConn = await connectWs({
    port,
    headers: { Authorization: `Bearer ${adminTok}` }
  })
  assert.equal(wsConn.ok, true)
  t.after(() => wsConn.ws.close())

  // Emit a bot event containing secret-named fields
  core.emitBotEvent('status', 'acc-1', {
    status: 'online',
    detail: echoedSecrets,
    password: FAKE_PROXY_PASS,
    refreshToken: FAKE_REFRESH_TOKEN,
    webhookUrl: FAKE_WEBHOOK,
    botToken: FAKE_BOT_TOKEN
  })

  await new Promise((r) => setTimeout(r, 50))

  const responsesToInspect = []
  for (const [channel, args] of [
    ['accounts:list', undefined],
    ['notify:list', undefined],
    ['settings:get', undefined],
    ['logs:list', { id: 'audit' }],
    ['logs:list', { id: account.id }],
    ['proxy:health', undefined]
  ]) {
    const res = await httpJson({ port, cookie: `afk_session=${session.id}`, csrf: session.csrfToken, body: { channel, args } })
    assert.equal(res.status, 200)
    responsesToInspect.push(res.text)
  }

  const cmdStatus = await httpJson({
    port,
    path: '/api/commands/status',
    token: adminTok,
    body: { args: {} }
  })
  responsesToInspect.push(cmdStatus.text)
  responsesToInspect.push(JSON.stringify(wsConn.messages))

  const combined = responsesToInspect.join('\n')
  for (const secret of [FAKE_PROXY_PASS, FAKE_WEBHOOK, FAKE_BOT_TOKEN, FAKE_REFRESH_TOKEN, '@example.com', session.id, adminTok, adminTok.split('_')[2]]) {
    assert.equal(combined.includes(secret), false, `Secret "${secret}" must never appear in API/WS output`)
  }
})

test('WebSocket /ws enforces auth, Origin, Host, concurrency caps, scope-filtered events, and closes on revocation', async (t) => {
  const { port, auth, core } = await createApiFixture(t)

  // 1. WS without session or token -> rejected (401)
  const unauthWs = await connectWs({ port })
  assert.equal(unauthWs.ok, false)
  assert.equal(unauthWs.statusCode, 401)

  // 2. WS with bad Origin -> rejected (403)
  const readTok = auth.createTokenSync({ name: 'ws-read', scope: 'read' }).token
  const badOriginWs = await connectWs({
    port,
    headers: {
      Authorization: `Bearer ${readTok}`,
      Origin: 'https://evil.example.com'
    }
  })
  assert.equal(badOriginWs.ok, false)
  assert.equal(badOriginWs.statusCode, 403)

  // 3. WS with bad Host -> rejected (421)
  const badHostWs = await connectWs({
    port,
    headers: {
      Authorization: `Bearer ${readTok}`,
      Host: 'evil.example.com'
    }
  })
  assert.equal(badHostWs.ok, false)
  assert.equal(badHostWs.statusCode, 421)

  // 4. WS concurrency limit: 1 per session
  const loginRes = await httpJson({
    port,
    path: '/api/login',
    body: { username: 'admin', password: 'AdminApiPass!2026' }
  })
  const cookie = loginRes.headers['set-cookie'][0].split(';')[0]
  const csrf = loginRes.json.csrfToken

  const sessionWs1 = await connectWs({ port, headers: { Cookie: cookie, 'Sec-WebSocket-Protocol': `afk-csrf.${csrf}` } })
  assert.equal(sessionWs1.ok, true)
  t.after(() => sessionWs1.ws.close())

  const sessionWs2 = await connectWs({ port, headers: { Cookie: cookie, 'Sec-WebSocket-Protocol': `afk-csrf.${csrf}` } })
  assert.equal(sessionWs2.ok, false)
  assert.equal(sessionWs2.statusCode, 429)

  // 5. WS scope filtering: read token gets status/telemetry/logs, but NOT login-code; admin session gets login-code
  const readWs = await connectWs({ port, headers: { Authorization: `Bearer ${readTok}` } })
  assert.equal(readWs.ok, true)
  t.after(() => readWs.ws.close())

  core.emitBotEvent('status', 'acc-1', { status: 'online', detail: 'Spawned' })
  core.emitBotEvent('login-code', 'acc-1', { userCode: 'ABCD-1234', verificationUri: 'https://microsoft.com/link' })

  await new Promise((r) => setTimeout(r, 60))

  // Admin session received both status and login-code (headless device-code sign-in)
  assert.ok(sessionWs1.messages.some((m) => m.channel === 'bot:event' && m.payload.type === 'status'))
  assert.ok(sessionWs1.messages.some((m) => m.channel === 'bot:event' && m.payload.type === 'login-code' && m.payload.payload.userCode === 'ABCD-1234'))

  // Read token received status, but NOT login-code
  assert.ok(readWs.messages.some((m) => m.channel === 'bot:event' && m.payload.type === 'status'))
  assert.equal(readWs.messages.some((m) => m.channel === 'bot:event' && m.payload.type === 'login-code'), false)

  // 6. Logging out session immediately closes sessionWs1
  const closedPromise = new Promise((resolve) => sessionWs1.ws.once('close', (code) => resolve(code)))
  await httpJson({
    port,
    path: '/api/logout',
    cookie,
    csrf,
    body: {}
  })
  const closeCode = await closedPromise
  assert.equal(closeCode, 4401)
})

test('browser-bridge.js no-ops when window.afkDesk exists and implements full preload API over fetch + WebSocket', async (t) => {
  const existing = Object.freeze({ existingPreload: true })
  const window = { afkDesk: existing }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/browser-bridge.js'), 'utf8'), {
    window, globalThis: window,
    fetch: () => assert.fail('existing preload must not fetch'),
    WebSocket: class { constructor() { assert.fail('existing preload must not connect') } }
  })
  assert.equal(window.afkDesk, existing)
  const { port } = await createApiFixture(t)

  let sessionCookie = ''
  const bridge = createBrowserBridge({
    fetchImpl: async (urlPath, init = {}) => {
      const headers = { ...(init.headers || {}) }
      if (sessionCookie) headers.Cookie = sessionCookie
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { ...init, headers })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) sessionCookie = setCookie.split(';')[0]
      return res
    },
    WebSocketImpl: class extends WebSocket {
      constructor(url, protocols) {
        assert.match(protocols[0], /^afk-csrf\.[a-f0-9]{64}$/)
        super(url, protocols, {
          headers: {
            Origin: `http://127.0.0.1:${port}`,
            ...(sessionCookie ? { Cookie: sessionCookie } : {})
          }
        })
      }
    },
    locationObj: {
      protocol: 'http:',
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`
    }
  })
  t.after(() => bridge._close())

  const loginInfo = await bridge.login('AdminApiPass!2026', 'admin')
  assert.equal(loginInfo.ok, true)
  assert.ok(bridge._getCsrfToken())

  const version = await bridge.getAppVersion()
  assert.equal(version, '0.10.0-test')

  const accounts = await bridge.listAccounts()
  assert.deepEqual(accounts, [])

  const saved = await bridge.saveAccount({
    username: 'BridgePlayer',
    host: 'mc.example.com',
    port: 25565
  })
  assert.equal(saved.name, 'mc.example.com')
  assert.equal(saved.username, undefined)

  await assert.rejects(
    () => bridge.openExternal('https://example.com'),
    (err) => err.status === 501 && err.code === 'UNSUPPORTED'
  )
})

test('CLI init --password-stdin creates admin and SIGTERM shutdown calls core.shutdown()', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-cli-test-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

  let stdoutText = ''
  const stdin = Readable.from(['CliStrongAdminPass!2026\n'])
  const stdout = { write: (chunk) => { stdoutText += String(chunk) } }
  const stderr = { write: () => {} }

  const initRes = await runCli(['init', '--data', dataDir, '--password-stdin'], {
    stdin,
    stdout,
    stderr,
    env: {}
  })
  assert.equal(initRes.exitCode, 0)
  assert.match(stdoutText, /Admin user "admin" initialized/)

  // Verify auth.json has admin configured
  const auth = new AuthManager({ dataDir })
  assert.equal(auth.hasAdmin(), true)

  // Verify SIGTERM on started server calls core.shutdown() and exits cleanly
  const fakeProcListeners = new Map()
  let exitCode = null
  const fakeProcess = {
    on: (sig, fn) => fakeProcListeners.set(sig, fn),
    removeListener: (sig) => fakeProcListeners.delete(sig),
    exit: (code) => { exitCode = code }
  }

  const startRes = await runCli(['start', '--data', dataDir, '--bind', '127.0.0.1', '--port', '0'], {
    stdout,
    stderr,
    env: {},
    processObj: fakeProcess
  })
  assert.equal(startRes.exitCode, 0)
  const started = startRes.instance
  assert.equal(started.remoteServer.isRunning(), true)

  let coreShutDown = false
  const origShutdown = started.core.shutdown.bind(started.core)
  started.core.shutdown = async () => {
    coreShutDown = true
    return origShutdown()
  }

  await fakeProcListeners.get('SIGTERM')()
  assert.equal(coreShutDown, true)
  assert.equal(started.remoteServer.isRunning(), false)
  assert.equal(exitCode, 0)
})

test('R2-11: main.cjs embedded lifecycle is off by default, requires password, and starts/stops through trusted settings IPC', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-main-embedded-'))
  const handlers = new Map(), windows = [], errors = [], servers = []
  const app = new EventEmitter()
  Object.assign(app, {
    whenReady: () => Promise.resolve(), getPath: () => dataDir, getVersion: () => 'test',
    quit: () => app.emit('before-quit'), getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {}
  })
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, { mainFrame: { url: '' }, send() {}, setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } })
      windows.push(this)
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
  }
  const electron = { app, BrowserWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showErrorBox: (...args) => errors.push(args) }, Notification: { isSupported: () => false } }
  const filename = path.join(__dirname, '../electron/main.cjs'), realRequire = createRequire(filename)
  const sandbox = { __dirname: path.dirname(filename), process, console, Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return electron
      if (name === './bot-manager.cjs') return { BotManager: FakeBotManager, normalizeSkinUrl: () => '' }
      if (name === '../server/http-server.cjs') return { detectNetworkInterfaces, createRemoteServer(options) {
        // Real HTTP lifecycle and production hooks, with only the OS listener replaced.
        const remote = createRemoteServer(options)
        remote.httpServer.listen = () => { queueMicrotask(() => remote.httpServer.emit('listening')); return remote.httpServer }
        servers.push(remote)
        return remote
      } }
      return realRequire(name)
    }
  }
  t.after(async () => {
    app.emit('before-quit')
    await new Promise(resolve => setImmediate(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [])
  const window = windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const settings = () => handlers.get('settings:get')(event)
  const save = remoteAccess => handlers.get('settings:save')(event, { remoteAccess })
  assert.equal(settings().remoteAccess.enabled, false)
  assert.equal(servers.length, 0)
  assert.throws(() => save({ _update: true, enabled: true }), /Set an admin password/)
  assert.equal(servers.length, 0)
  save({ _update: true, enabled: true, adminPassword: 'EmbeddedAdminPass!2026', bind: '127.0.0.1', port: 8787 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(servers.length, 1)
  assert.equal(servers[0].isRunning(), true)
  assert.equal(settings().remoteAccess.running, true)
  save({ _update: true, enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(servers[0].isRunning(), false)
  assert.equal(settings().remoteAccess.running, false)
  save({ _update: true, enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(servers[1].isRunning(), true)
  app.emit('before-quit')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(servers[1].isRunning(), false)
})
