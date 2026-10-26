'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { AuthManager, IDLE_TIMEOUT_MS, ABSOLUTE_TIMEOUT_MS, MAX_TRACKERS, TRACKER_TTL_MS, MAX_SESSIONS, MAX_SESSIONS_PER_USER, MAX_TOKENS } = require('../server/auth.cjs')
const { createApiRouter, recordAudit } = require('../server/api-routes.cjs')
const { createRemoteServer, buildAllowedOrigins, isOriginHeaderAllowed } = require('../server/http-server.cjs')
const { createCommandLayer } = require('../core/commands.cjs')
const { AppCore } = require('../core/app-core.cjs')
const { CHANNEL_SPECS } = require('../server/api-routes.cjs')
const { validateInvoke } = require('../server/remote-policy.cjs')
const { createBrowserBridge } = require('../server/browser-bridge.js')
class MemoryAuth extends AuthManager {
  _load() { return { admin: null, tokens: [], remoteConfig: null } }
  _save() {}
}
const PASSWORD = 'StrongOriginal!2026'
function fixture(t, { now = Date.now } = {}) {
  const auth = new MemoryAuth({ dataDir: '.', now })
  const buckets = new Map(), calls = []
  const accounts = [{ id: 'a1', username: 'secret@example.com', email: 'secret@example.com', profileName: 'Builder', host: 'mc.test', edition: 'java', proxy: { password: 'fake-proxy-password' } }]
  const core = {
    userDataPath: '.', emitToUi() {},
    store: { list: () => accounts },
    notifySettings: { getDecrypted: () => [{ webhookUrl: 'https://discord.com/api/webhooks/123/fake-secret', botToken: '123456789:FAKE_TOKEN_12345678901234567890' }] },
    eventStore: { append(id, entry) { buckets.set(id, [...(buckets.get(id) || []), entry]) } },
    _appendAudit: AppCore.prototype._appendAudit,
    accounts: { list: () => accounts, save: x => { calls.push(['save', x]); return x }, delete: x => calls.push(['delete', x]), duplicate: x => { calls.push(['duplicate', x]); return accounts[0] }, reorder: x => { calls.push(['reorder', x]); return accounts } },
    logs: { list: arg => buckets.get(typeof arg === 'string' ? arg : arg.id) || [], clear: () => {} },
    audit: { recent: () => buckets.get('audit') || [] },
    status: () => ({ status: 'online' }),
    settings: { get: () => ({ uiScale: 100 }), save: x => { calls.push(['settings', x]); return x } },
    macros: { list: () => ({ macros: [{ id: 'm1', name: 'Macro' }] }), run: x => calls.push(['run', x]), stop: x => calls.push(['stop', x]) },
    bots: { connect: x => calls.push(['connect', x]), disconnect: x => calls.push(['disconnect', x]), sendChat: (...a) => calls.push(['chat', ...a]), dropItems: (...a) => calls.push(['drop', ...a]), control: x => calls.push(['control', x]) },
    notify: { test: x => calls.push(['notify', x]) }
  }
  core.commands = createCommandLayer({ core, now, audit: e => core._appendAudit(e) })
  const router = createApiRouter({ core, auth, now, isLoopbackIp: ip => ip === '127.0.0.1' })
  const session = auth.createSession()
  const responses = []
  async function request(pathname, body = {}, credential = session, method = 'POST', ip = '127.0.0.1') {
    const headers = typeof credential === 'string' ? { authorization: `Bearer ${credential}` } : credential ? { cookie: `afk_session=${credential.id}`, 'x-afk-csrf': credential.csrfToken } : {}
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v } }
    await router.handleApi({ headers }, res, { pathname, method, body, clientIp: ip, sendJson: (_res, status, json) => { res.status = status; res.json = json; responses.push(json) } })
    return res
  }
  const invoke = (channel, args, credential = session, extra = {}) => request('/api/invoke', { channel, args, ...extra }, credential)
  return { auth, buckets, core, calls, session, request, invoke, responses }
}
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.messages = []; this.closed = null; this.terminated = false }
  send(value) { this.messages.push(JSON.parse(value)) }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close') }
  terminate() { this.terminated = true; this.close(1006) }
}
function wsHarness(t, f, now = Date.now) {
  const remote = createRemoteServer({ core: f.core, auth: f.auth, port: 8787, bind: '127.0.0.1', now })
  t.after(() => remote.stop())
  let upgradeHook = null
  remote.wss.handleUpgrade = (_req, socket, _head, callback) => {
    upgradeHook?.()
    const ws = new FakeWs()
    callback(ws)
    socket.resolve({ ws })
  }
  function upgrade(credential, { origin = 'http://127.0.0.1:8787', csrf = credential?.csrfToken, hook = null } = {}) {
    upgradeHook = hook
    return new Promise(resolve => {
      const socket = { remoteAddress: '127.0.0.1', resolve, response: '', write(x) { this.response += x }, destroy() { resolve({ rejected: this.response }) } }
      const headers = { host: '127.0.0.1:8787', origin }
      if (typeof credential === 'string') headers.authorization = `Bearer ${credential}`
      else if (credential) { headers.cookie = `afk_session=${credential.id}`; if (csrf) headers['sec-websocket-protocol'] = `afk-csrf.${csrf}` }
      remote.httpServer.emit('upgrade', { url: '/ws', headers, socket }, socket, Buffer.alloc(0))
    })
  }
  return { remote, upgrade }
}

test('R2-1: real audit and account buckets never expose authenticating actor IDs; audit requires admin session', async t => {
  const f = fixture(t)
  const token = f.auth.createTokenSync({ scope: 'read' })
  recordAudit(f.core, Date.now, { actor: { kind: 'session', id: f.session.id, scope: 'admin' }, command: 'account.connect', accountId: 'a1', result: 'allowed' })
  recordAudit(f.core, Date.now, { actor: { kind: 'token', id: token.record.id, scope: 'read' }, command: 'status', accountId: 'a1', result: 'allowed' })
  assert.equal(f.buckets.get('audit').length, 2)
  assert.equal(f.buckets.get('a1').length, 2)
  const persisted = JSON.stringify([...f.buckets.values()])
  assert.ok(!persisted.includes(f.session.id)); assert.ok(!persisted.includes(token.record.id))
  const auditId = f.buckets.get('audit')[0].actor.id
  assert.match(auditId, /^[a-f0-9]{24}$/)
  assert.equal(f.auth.getSession(auditId), null)
  f.core.eventStore.append('a1', { type: 'log', kind: 'chat', message: 'hello', actor: { id: f.session.id } })
  f.core.eventStore.append('a1', { type: 'status', status: 'online' })
  for (const channel of ['audit:recent', 'logs:list']) assert.equal((await f.invoke(channel, channel === 'logs:list' ? { id: 'audit' } : {}, token.token)).status, 403)
  assert.equal((await f.request('/api/commands/audit.recent', {}, token.token)).status, 403)
  const accountLogs = await f.invoke('logs:list', { id: 'a1' }, token.token)
  assert.equal(accountLogs.json.result.length, 2)
  assert.ok(accountLogs.json.result.every(e => !e.actor && e.type !== 'audit'))
  const adminToken = f.auth.createTokenSync({ scope: 'admin' }).token
  assert.equal((await f.invoke('logs:list', { id: 'audit' }, adminToken)).status, 403)
  assert.equal((await f.invoke('logs:list', { id: 'audit' })).status, 200)
})

test('R2-2: remoteAccess is rejected before core hooks and account/settings writes require an admin session', async t => {
  const f = fixture(t), token = f.auth.createTokenSync({ scope: 'admin' }).token
  for (const credential of [token, f.session]) {
    for (const remoteAccess of [null, {}, { adminPassword: 'Replacement!1234' }, { bind: '0.0.0.0', trustProxy: true, enabled: false }]) {
      assert.equal((await f.invoke('settings:save', { remoteAccess }, credential)).status, 403)
    }
    for (const args of [[{ remoteAccess: {} }], { macros: [{ remoteAccess: {} }] }]) assert.equal((await f.invoke('settings:save', args, credential)).status, 403)
  }
  for (const channel of ['accounts:save', 'accounts:delete', 'accounts:duplicate-profile', 'accounts:reorder', 'settings:save']) assert.equal((await f.invoke(channel, {}, token)).status, 403)
  assert.equal((await f.request('/api/password', { currentPassword: PASSWORD, newPassword: 'Replacement!1234' }, token)).status, 403)
  assert.deepEqual(f.calls, [])
  assert.equal((await f.invoke('settings:save', { uiScale: 100 })).status, 200)
})

test('R2-3: revocation and expiry during asynchronous bearer scrypt cannot authenticate', async t => {
  let now = 1000
  const f = fixture(t, { now: () => now })
  for (const action of ['revoke', 'expire']) {
    const created = f.auth.createTokenSync({ ttlMs: 10 })
    const pending = f.auth.verifyBearerToken(`Bearer ${created.token}`)
    if (action === 'revoke') f.auth.revokeToken(created.record.id); else now += 11
    assert.equal(await pending, null)
  }
})

test('R2-3: each WS delivery checks idle, absolute, token expiry and revocation; upgrade rechecks credentials', async t => {
  let now = 1000
  const f = fixture(t, { now: () => now }), h = wsHarness(t, f, () => now)
  for (const kind of ['idle', 'absolute', 'token-expiry', 'token-revoke', 'session-revoke']) {
    let credential = f.auth.createSession(), token
    if (kind.startsWith('token')) { token = f.auth.createTokenSync({ ttlMs: 100 }); credential = token.token }
    const { ws } = await h.upgrade(credential)
    assert.ok(ws)
    ws.messages = []
    if (kind === 'idle') now += IDLE_TIMEOUT_MS
    if (kind === 'absolute') { now += ABSOLUTE_TIMEOUT_MS; credential.lastActiveAt = now }
    if (kind === 'token-expiry') now += 100
    if (kind === 'token-revoke') f.auth.revokeToken(token.record.id)
    if (kind === 'session-revoke') f.auth.revokeSession(credential.id)
    h.remote.broadcast('bot:event', { type: 'status', id: 'a1', payload: { status: 'online' } })
    assert.equal(ws.closed, 4401, kind); assert.equal(ws.messages.length, 0, kind)
  }
  const session = f.auth.createSession()
  const result = await h.upgrade(session, { hook: () => f.auth.revokeSession(session.id) })
  assert.equal(result.ws.closed, 4401)
  const token = f.auth.createTokenSync({})
  const verify = f.auth.verifyBearerToken.bind(f.auth)
  f.auth.verifyBearerToken = async (...args) => { const record = await verify(...args); f.auth.revokeToken(token.record.id); return record }
  assert.match((await h.upgrade(token.token)).rejected, /401/)
})

test('R2-4: complete origins and session-bound WS CSRF reject cross-port, cross-scheme and missing proofs', async t => {
  const origins = buildAllowedOrigins('127.0.0.1', ['https://desk.test:9443'], 8787, false)
  for (const origin of ['http://localhost:9999', 'https://localhost:8787', 'http://localhost', 'https://desk.test:9444', 'http://desk.test:8787', 'https://desk.test:8787', 'http://localhost:8787/path', 'http://user@localhost:8787']) assert.equal(isOriginHeaderAllowed(origin, origins), false, origin)
  assert.equal(isOriginHeaderAllowed('http://localhost:8787', origins), true)
  assert.equal(isOriginHeaderAllowed('https://desk.test:9443', origins), true)
  const f = fixture(t), h = wsHarness(t, f)
  for (const options of [{ csrf: null }, { csrf: 'incorrect' }, { origin: 'http://127.0.0.1:9999' }, { origin: 'https://127.0.0.1:8787' }]) assert.match((await h.upgrade(f.session, options)).rejected, /403/)
  assert.ok((await h.upgrade(f.session)).ws)
})

test('R2-5: parallel logins reserve attempts before hashing and reject a fifth concurrent hash', async t => {
  const f = fixture(t)
  f.auth.setAdminPasswordSync(PASSWORD)
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.request('/api/login', { username: `user${i}`, password: 'wrong-password' }, null)))
  assert.equal(responses.filter(r => r.status === 401).length, 4)
  assert.equal(responses.filter(r => r.status === 429).length, 8)
  assert.equal(f.auth.loginAttemptsByIp.get('127.0.0.1').attempts.length, 5)
  assert.equal(f.auth.loginAttemptsByUser.size, 5)
})

test('R2-5: bearer work is rate-limited before scrypt; tracker maps and credential retention are bounded', async t => {
  let now = 1000
  const f = fixture(t, { now: () => now })
  f.auth.bearerAttemptsByIp.set('attacker', Array(120).fill(now))
  await assert.rejects(f.auth.verifyBearerToken('Bearer afk_1234567890abcdef_1234567890123456', 'attacker'), e => e.statusCode === 429)
  for (let i = 0; i < MAX_TRACKERS; i++) {
    f.auth.apiCallsByActor.set(`actor${i}`, [now])
    f.auth.loginAttemptsByIp.set(`ip${i}`, { attempts: [], failures: 0, lockedUntil: 0, updatedAt: now })
    f.auth.loginAttemptsByUser.set(`user${i}`, { attempts: [], failures: 0, lockedUntil: 0, updatedAt: now })
    f.auth.bearerAttemptsByIp.set(`ip${i}`, [now])
  }
  f.auth.bearerAttemptsByIp.delete('attacker')
  assert.equal(f.auth.checkApiRateLimit('extra').allowed, false)
  assert.equal(f.auth.reserveLoginAttempt('extra', 'extra').allowed, false)
  assert.equal(f.auth.checkWindow(f.auth.bearerAttemptsByIp, 'extra', 120).allowed, false)
  for (const map of [f.auth.apiCallsByActor, f.auth.loginAttemptsByIp, f.auth.loginAttemptsByUser, f.auth.bearerAttemptsByIp]) assert.equal(map.size, MAX_TRACKERS)
  now += TRACKER_TTL_MS + 1
  for (const map of [f.auth.apiCallsByActor, f.auth.loginAttemptsByIp, f.auth.loginAttemptsByUser, f.auth.bearerAttemptsByIp]) { f.auth.pruneTrackers(map); assert.equal(map.size, 0) }
  for (let i = 0; i < 20; i++) f.auth.createSession()
  assert.equal(f.auth.sessions.size, MAX_SESSIONS_PER_USER)
  for (let i = 0; i < MAX_SESSIONS + 2; i++) f.auth.createSession({ username: `u${i}` })
  assert.equal(f.auth.sessions.size, MAX_SESSIONS)
  const template = f.auth.createTokenSync({}).record
  f.auth.state.tokens = Array.from({ length: MAX_TOKENS }, (_, i) => ({ ...template, id: String(i), revokedAt: null, expiresAt: null }))
  assert.throws(() => f.auth.createTokenSync({}), /capacity/)
})

test('R2-5: token issuance shares the four-hash budget and reserves token capacity before await', async t => {
  const f = fixture(t)
  const pending = Array.from({ length: 4 }, () => f.auth.createToken())
  assert.throws(() => f.auth.createTokenSync(), e => e.statusCode === 429)
  await assert.rejects(f.auth.verifyBearerToken('Bearer afk_1234567890abcdef_1234567890123456'), e => e.statusCode === 429)
  await assert.rejects(f.auth.createToken(), e => e.statusCode === 429)
  await Promise.all(pending)
  const template = f.auth.state.tokens[0]
  f.auth.state.tokens = Array.from({ length: MAX_TOKENS - 1 }, (_, i) => ({ ...template, id: String(i) }))
  const last = f.auth.createToken()
  await assert.rejects(f.auth.createToken(), e => e.statusCode === 429)
  await last
  assert.equal(f.auth.state.tokens.length, MAX_TOKENS)
  assert.equal(f.auth.pendingTokens, 0)
  assert.equal((await f.request('/api/tokens')).status, 429)
})

test('R2-5: expired quiet sockets are pruned before retaining another connection', async t => {
  let now = 1
  const f = fixture(t, { now: () => now }), h = wsHarness(t, f, () => now)
  const token = f.auth.createTokenSync({ ttlMs: 10 })
  const { ws } = await h.upgrade(token.token)
  now += 10
  assert.ok((await h.upgrade(f.auth.createSession())).ws)
  assert.equal(ws.closed, 4401)
  assert.equal(f.auth.wsConnections.has(`token:${token.record.id}`), false)
})

test('R2-6: all global logout aliases reject bearer tokens and non-admin sessions', async t => {
  const f = fixture(t)
  const read = f.auth.createTokenSync({ scope: 'read' }).token
  const admin = f.auth.createTokenSync({ scope: 'admin' }).token
  const low = f.auth.createSession({ scope: 'read' })
  for (const credential of [read, admin, low]) for (const [url, body] of [['/api/logout-all', {}], ['/api/logout', { everywhere: true }], ['/api/logout', { all: true }]]) {
    assert.equal((await f.request(url, body, credential)).status, 403)
    assert.ok(f.auth.getSession(f.session.id))
  }
  assert.equal((await f.request('/api/logout-all')).status, 200)
  assert.equal(f.auth.sessions.size, 0)
})

test('R2-7: password change requires current password, rotates cookie/CSRF and revokes all old sockets', async t => {
  const f = fixture(t), h = wsHarness(t, f)
  f.auth.setAdminPasswordSync(PASSWORD)
  const stolen = f.auth.createSession()
  const a = (await h.upgrade(f.session)).ws, b = (await h.upgrade(stolen)).ws
  assert.equal((await f.request('/api/password', { newPassword: 'Replacement!1234' })).status, 401)
  const res = await f.request('/api/password', { currentPassword: PASSWORD, newPassword: 'Replacement!1234' })
  assert.equal(res.status, 200)
  assert.equal(a.closed, 4401); assert.equal(b.closed, 4401)
  assert.equal(f.auth.getSession(stolen.id), null); assert.equal(f.auth.getSession(f.session.id), null)
  const newId = res.headers['set-cookie'].split(';')[0].split('=')[1]
  assert.notEqual(newId, f.session.id); assert.notEqual(res.json.csrfToken, f.session.csrfToken)
  assert.ok(f.auth.getSession(newId)); assert.equal(f.auth.sessions.size, 1)
})

test('R2-7: revocation while hashing a new password cannot replace credentials or resurrect a session', async t => {
  const f = fixture(t)
  f.auth.setAdminPasswordSync(PASSWORD)
  const original = f.auth.setAdminPassword.bind(f.auth)
  f.auth.setAdminPassword = (...args) => {
    const pending = original(...args)
    f.auth.revokeSession(f.session.id)
    return pending
  }
  const res = await f.request('/api/password', { currentPassword: PASSWORD, newPassword: 'Replacement!1234' })
  assert.equal(res.status, 401)
  assert.equal(f.auth.sessions.size, 0)
  assert.equal(await f.auth.verifyAdminPassword(PASSWORD), true)
})

test('R2-8: invoke attacks encounter command validation, confirmation, and shared per-actor limits', async t => {
  const f = fixture(t)
  assert.equal((await f.invoke('bot:chat', { id: 'a1', message: 'x'.repeat(300) })).status, 400)
  assert.equal((await f.invoke('bot:connect', 'missing-account')).status, 400)
  for (const channel of ['bot:disconnect', 'bot:drop-stack', 'bot:drop-items']) {
    const args = channel === 'bot:disconnect' ? 'a1' : { id: 'a1', slot: 1 }
    const denied = await f.invoke(channel, args)
    assert.equal(denied.status, 409); assert.equal(denied.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal((await f.invoke(channel, args, f.session, { confirmed: true })).status, 200)
  }
  for (let i = 0; i < 60; i++) await f.core.commands.execute({ kind: 'session', id: f.session.id, scope: 'admin' }, 'status', {})
  assert.equal((await f.invoke('bot:connect', 'a1')).status, 429)
  assert.ok(!f.calls.some(c => c[0] === 'chat'))
})

test('R2-8: every allowlisted channel rejects unexpected fields and nested or out-of-bounds arguments', async t => {
  const f = fixture(t)
  for (const channel of Object.keys(CHANNEL_SPECS)) assert.throws(() => validateInvoke(channel, { unexpected: 'attack' }), undefined, channel)
  for (const args of [{ id: 'a1', control: 'jump', duration: 1e10 }, { id: 'a1', control: { nested: 'jump' } }, { id: 'a1', control: 'jump', duration: '100' }]) assert.equal((await f.invoke('bot:control', args)).status, 400)
  for (const [channel, args] of [['bot:control', { id: 'a1' }], ['accounts:reorder', { ids: ['a1'], unexpected: true }], ['logs:list', ['a1', { id: 'audit' }]], ['logs:list', { id: 'a1', kinds: {} }]]) assert.equal((await f.invoke(channel, args)).status, 400)
  assert.deepEqual(f.calls, [])
})

test('R2-8: browser bridge retries CONFIRM_REQUIRED only after explicit user confirmation', async () => {
  const requests = []
  let approved = false
  const bridge = createBrowserBridge({ WebSocketImpl: null, confirmImpl: () => approved,
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null
      if (url === '/api/login') return { ok: true, json: async () => ({ ok: true, scope: 'admin', csrfToken: 'csrf-proof' }) }
      requests.push(body)
      return body.confirmed === true
        ? { ok: true, json: async () => ({ ok: true, result: 'done' }) }
        : { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'CONFIRM_REQUIRED', message: 'Confirm' } }) }
    }
  })
  await bridge.login(PASSWORD)
  await assert.rejects(bridge.disconnect('a1'), e => e.code === 'CONFIRM_REQUIRED')
  assert.equal(requests.length, 1)
  approved = true
  assert.equal(await bridge.disconnect('a1'), 'done')
  assert.equal(requests.length, 3)
  assert.equal(requests[2].confirmed, true)
  bridge._close()
})

test('R2-8: command actor trackers reject overflow and expire after one minute', async t => {
  let now = 1
  const f = fixture(t, { now: () => now })
  // A no-op audit sink avoids creating a large log fixture for this map test.
  const commands = createCommandLayer({ core: f.core, now: () => now })
  for (let i = 0; i < MAX_TRACKERS; i++) assert.equal((await commands.execute({ kind: 'token', id: String(i), scope: 'read' }, 'status')).ok, true)
  assert.equal((await commands.execute({ kind: 'token', id: 'overflow', scope: 'read' }, 'status')).error.code, 'RATE_LIMITED')
  now += 60000
  assert.equal((await commands.execute({ kind: 'token', id: 'overflow', scope: 'read' }, 'status')).ok, true)
})

test('R2-9/10: WS only exposes projected data, admin sessions alone see login codes; inbound and outbound budgets close clients', async t => {
  const f = fixture(t), h = wsHarness(t, f)
  const token = f.auth.createTokenSync({ scope: 'admin' }).token
  const admin = (await h.upgrade(f.session)).ws, bearer = (await h.upgrade(token)).ws
  h.remote.broadcast('bot:event', { type: 'login-code', id: 'a1', payload: { userCode: 'DEVICE-CODE' } })
  assert.ok(admin.messages.some(m => m.payload.type === 'login-code'))
  assert.ok(!bearer.messages.some(m => m.payload.type === 'login-code'))
  for (let i = 0; i < 10; i++) bearer.emit('message', Buffer.from('x'))
  assert.equal(bearer.closed, null)
  bearer.emit('message', Buffer.from('x')); assert.equal(bearer.closed, 1008)
  admin.bufferedAmount = 1024 * 1024 + 1
  h.remote.broadcast('bot:event', { type: 'status', id: 'a1', payload: { status: 'online' } })
  assert.equal(admin.terminated, true)
  const next = (await h.upgrade(f.auth.createSession())).ws
  next.send = () => { next.bufferedAmount = 1024 * 1024 + 1 }
  h.remote.broadcast('bot:event', { type: 'status', id: 'a1', payload: { status: 'online' } })
  assert.equal(next.terminated, true, 'queue crossing the bound during send is terminated immediately')
})

test('R2-sweep: populated API and WS fixtures never expose proxy/webhook/bot secrets, emails or authentication IDs', async t => {
  const f = fixture(t), h = wsHarness(t, f)
  const token = f.auth.createTokenSync({ scope: 'read' })
  const secrets = { password: 'fake-proxy-password', webhookUrl: 'https://discord.com/api/webhooks/123/fake-secret', botToken: '123456789:FAKE_TOKEN_12345678901234567890', username: 'private@example.com', sessionId: f.session.id, token: token.token }
  const ws = (await h.upgrade(f.session)).ws
  recordAudit(f.core, Date.now, { actor: { kind: 'session', id: f.session.id, scope: 'admin' }, command: 'status', accountId: 'a1' })
  const echoedSecrets = Object.values(secrets).join(' ')
  f.core.eventStore.append('a1', { type: 'log', kind: 'chat', ...secrets, message: echoedSecrets })
  for (const type of ['status', 'telemetry', 'log', 'identity', 'version', 'storage-warning']) {
    h.remote.broadcast('bot:event', { type, id: 'a1', payload: { ...secrets, kind: 'chat', status: 'online', detail: echoedSecrets, message: echoedSecrets, name: echoedSecrets } })
  }
  for (const [channel, args] of [['accounts:list'], ['logs:list', { id: 'audit' }], ['logs:list', { id: 'a1' }], ['settings:get'], ['audit:recent']]) assert.equal((await f.invoke(channel, args)).status, 200)
  await f.request('/api/commands/status', { args: {} })
  await f.request('/api/session', {}, f.session, 'GET')
  await f.request('/api/capabilities', {}, f.session, 'GET')
  const setup = f.auth.issueSetupToken()
  assert.equal((await f.request('/api/setup', { setupToken: setup.token, username: 'private@example.com', password: PASSWORD }, null)).status, 200)
  await f.invoke('private@example.com')
  await f.invoke('logs:list', { id: 'a1', kinds: {} })
  const all = JSON.stringify([f.responses, ws.messages])
  for (const secret of [...Object.values(secrets), '@example.com', token.record.id, token.token.split('_')[2]]) assert.ok(!all.includes(secret), secret)
  const account = (await f.invoke('accounts:list')).json.result[0]
  assert.deepEqual(Object.keys(account).sort(), ['edition', 'id', 'name', 'server', 'status'])
})
