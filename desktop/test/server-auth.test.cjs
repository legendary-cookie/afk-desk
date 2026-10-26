'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  AuthManager,
  SCRYPT_PARAMS,
  SALT_BYTES,
  KEY_BYTES,
  MIN_PASSWORD_LENGTH,
  IDLE_TIMEOUT_MS,
  ABSOLUTE_TIMEOUT_MS,
  SETUP_TOKEN_TTL_MS,
  validatePassword,
  hashSecretSync,
  verifySecretSync,
  hashSecret,
  verifySecret,
  formatSessionCookie
} = require('../server/auth.cjs')
const {
  isLoopbackIp,
  isTailscaleIp,
  isPrivateIp,
  isWildcardIp,
  isPublicOrWildcardBind,
  detectNetworkInterfaces,
  detectTailscaleAddresses
} = require('../server/http-server.cjs')

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-server-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('password validation enforces minimum 12 chars, common-password list, and complexity', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12)
  assert.match(validatePassword('short123'), /at least 12/)
  assert.match(validatePassword('12345678901'), /at least 12/)
  assert.match(validatePassword('password1234'), /too common/i)
  assert.match(validatePassword('PASSWORD12345'), /too common/i)
  assert.match(validatePassword('admin1234567'), /too common/i)
  assert.match(validatePassword('aaaaaaaaaaaa'), /too common|too simple/i)
  assert.match(validatePassword('zzzzzzzzzzzz'), /too simple/i)
  assert.equal(validatePassword('CorrectHorseBatteryStaple!99'), null)
})

test('scrypt hashing uses N=2^15, r=8, p=1, 32-byte salt and timingSafeEqual verification', async () => {
  assert.equal(SCRYPT_PARAMS.N, 32768)
  assert.equal(SCRYPT_PARAMS.r, 8)
  assert.equal(SCRYPT_PARAMS.p, 1)
  assert.equal(SALT_BYTES, 32)
  assert.equal(KEY_BYTES, 64)

  const syncRecord = hashSecretSync('StrongAdminPass#2026!')
  assert.equal(Buffer.from(syncRecord.salt, 'hex').length, 32)
  assert.equal(Buffer.from(syncRecord.hash, 'hex').length, 64)
  assert.deepEqual(syncRecord.params, { N: 32768, r: 8, p: 1 })
  assert.equal(verifySecretSync('StrongAdminPass#2026!', syncRecord.salt, syncRecord.hash), true)
  assert.equal(verifySecretSync('WrongAdminPass#2026!', syncRecord.salt, syncRecord.hash), false)

  const asyncRecord = await hashSecret('AnotherStrongPass$2026')
  assert.equal(await verifySecret('AnotherStrongPass$2026', asyncRecord.salt, asyncRecord.hash), true)
  assert.equal(await verifySecret('WrongPass$2026', asyncRecord.salt, asyncRecord.hash), false)
})

test('session lifecycle: 256-bit ID, cookie attributes, CSRF verification, 12h idle / 7d absolute TTL, logout & sign-out everywhere', async (t) => {
  const dir = makeTempDir(t)
  let currentNow = 1_700_000_000_000
  const revokedSessions = []
  const auth = new AuthManager({
    dataDir: dir,
    now: () => currentNow,
    onSessionRevoked: (id) => revokedSessions.push(id)
  })

  await auth.setAdminPassword('MySecureAdminPass!2026')
  assert.equal(auth.hasAdmin(), true)

  const session = auth.createSession({ username: 'admin', ip: '127.0.0.1' })
  assert.equal(Buffer.from(session.id, 'hex').length, 32) // 256 bits
  assert.equal(Buffer.from(session.csrfToken, 'hex').length, 32)

  // Cookie formatting
  const httpCookie = formatSessionCookie(session.id, { secure: false })
  assert.match(httpCookie, /^afk_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/)
  assert.doesNotMatch(httpCookie, /Secure/)

  const httpsCookie = formatSessionCookie(session.id, { secure: true })
  assert.match(httpsCookie, /HttpOnly/)
  assert.match(httpsCookie, /SameSite=Strict/)
  assert.match(httpsCookie, /Path=\//)
  assert.match(httpsCookie, /Secure/)

  // CSRF check
  assert.equal(auth.verifyCsrf(session, session.csrfToken), true)
  assert.equal(auth.verifyCsrf(session, 'wrong-csrf'), false)
  assert.equal(auth.verifyCsrf(session, ''), false)

  // Idle timeout (12h)
  currentNow += IDLE_TIMEOUT_MS - 1000
  assert.ok(auth.getSession(session.id)) // touches session
  currentNow += IDLE_TIMEOUT_MS + 1000
  assert.equal(auth.getSession(session.id), null)
  assert.ok(revokedSessions.includes(session.id))

  // Absolute timeout (7d) even when kept active
  const session2 = auth.createSession({ username: 'admin', ip: '127.0.0.1' })
  const step = 6 * 60 * 60 * 1000 // every 6 hours (< 12h idle)
  for (let elapsed = step; elapsed < ABSOLUTE_TIMEOUT_MS; elapsed += step) {
    currentNow += step
    assert.ok(auth.getSession(session2.id))
  }
  currentNow += step + 1000
  assert.equal(auth.getSession(session2.id), null)

  // Sign out everywhere
  const sA = auth.createSession({ username: 'admin', ip: '127.0.0.1' })
  const sB = auth.createSession({ username: 'admin', ip: '127.0.0.1' })
  assert.equal(auth.revokeAllSessions(), 2)
  assert.equal(auth.getSession(sA.id), null)
  assert.equal(auth.getSession(sB.id), null)
})

test('one-time setup token expires after 15 minutes and can only be used once', async (t) => {
  const dir = makeTempDir(t)
  let currentNow = 1_700_000_000_000
  const auth = new AuthManager({ dataDir: dir, now: () => currentNow })

  const setup = auth.issueSetupToken()
  assert.ok(setup.token.length >= 32)
  assert.equal(setup.expiresAt, currentNow + SETUP_TOKEN_TTL_MS)

  // Expired check
  currentNow += SETUP_TOKEN_TTL_MS + 1
  assert.throws(
    () => auth.consumeSetupToken(setup.token, 'ValidSetupPassword!123'),
    /expired/i
  )

  // Fresh token works once, then rejects second use
  const setup2 = auth.issueSetupToken()
  auth.consumeSetupToken(setup2.token, 'ValidSetupPassword!123')
  assert.equal(auth.hasAdmin(), true)
  assert.throws(
    () => auth.consumeSetupToken(setup2.token, 'AnotherPassword!12345'),
    /already exists/i
  )
})

test('API tokens follow afk_<id>_<secret> format, store only scrypt hashes, enforce expiry and revocation', async (t) => {
  const dir = makeTempDir(t)
  let currentNow = 1_700_000_000_000
  const revokedTokens = []
  const auth = new AuthManager({
    dataDir: dir,
    now: () => currentNow,
    onTokenRevoked: (id) => revokedTokens.push(id)
  })
  await auth.setAdminPassword('AdminTokenTestPass!99')

  const created = await auth.createToken({
    name: 'CI Read Token',
    scope: 'read',
    expiresAt: currentNow + 60_000
  })
  assert.match(created.token, /^afk_[0-9a-f]{16}_[0-9a-f]{48}$/)
  assert.equal(created.record.scope, 'read')

  // Verify raw secret is never on disk or in listTokens()
  const rawDisk = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')
  const secretPart = created.token.split('_')[2]
  assert.equal(rawDisk.includes(secretPart), false)
  assert.equal(rawDisk.includes(created.token), false)

  const listed = auth.listTokens()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.record.id)
  assert.equal('hash' in listed[0], false)
  assert.equal('salt' in listed[0], false)
  assert.equal('token' in listed[0], false)

  // Authenticate with Bearer token
  const authOk = await auth.verifyBearerToken(`Bearer ${created.token}`)
  assert.ok(authOk)
  assert.equal(authOk.scope, 'read')
  assert.equal(authOk.id, created.record.id)

  // Wrong secret rejected
  const wrongSecret = `Bearer afk_${created.record.id}_${'0'.repeat(48)}`
  const authBad = await auth.verifyBearerToken(wrongSecret)
  assert.equal(authBad, null)

  // Expiry enforced
  currentNow += 61_000
  const authExpired = await auth.verifyBearerToken(`Bearer ${created.token}`)
  assert.equal(authExpired, null)

  // Revocation enforced
  const created2 = await auth.createToken({ name: 'Control Token', scope: 'control' })
  assert.ok(await auth.verifyBearerToken(`Bearer ${created2.token}`))
  assert.equal(auth.revokeToken(created2.record.id), true)
  assert.ok(revokedTokens.includes(created2.record.id))
  const authRevoked = await auth.verifyBearerToken(`Bearer ${created2.token}`)
  assert.equal(authRevoked, null)
})

test('rate limits: login 5/min with exponential lockout, API 120/min, WS 1/session and 5/token', async (t) => {
  const dir = makeTempDir(t)
  let currentNow = 1_700_000_000_000
  const auth = new AuthManager({ dataDir: dir, now: () => currentNow })
  await auth.setAdminPassword('RateLimitAdminPass!2026')

  // 5 failed login attempts trigger lockout
  for (let i = 1; i <= 5; i++) {
    const check = auth.checkLoginRateLimit('10.0.0.5', 'admin')
    assert.equal(check.allowed, true)
    const valid = await auth.verifyAdminPassword('WrongPassword!12345', 'admin')
    assert.equal(valid, false)
    auth.recordLoginAttempt('10.0.0.5', 'admin', false)
  }

  // 6th attempt is blocked by lockout
  const blockedCheck = auth.checkLoginRateLimit('10.0.0.5', 'admin')
  assert.equal(blockedCheck.allowed, false)
  assert.ok(blockedCheck.retryAfterMs >= 60_000)

  // Advance past 60s lockout -> allowed again
  currentNow += 61_000
  const allowedAgain = auth.checkLoginRateLimit('10.0.0.5', 'admin')
  assert.equal(allowedAgain.allowed, true)
  const validPass = await auth.verifyAdminPassword('RateLimitAdminPass!2026', 'admin')
  assert.equal(validPass, true)
  auth.recordLoginAttempt('10.0.0.5', 'admin', true)

  // API rate limit: 120/min per actor
  const actorKey = 'session:test-actor'
  for (let i = 0; i < 120; i++) {
    assert.equal(auth.checkApiRateLimit(actorKey).allowed, true)
  }
  const overLimit = auth.checkApiRateLimit(actorKey)
  assert.equal(overLimit.allowed, false)
  assert.ok(overLimit.retryAfterMs > 0)

  // WS connection limit: 1 per session, 5 per token
  const sessionActor = { kind: 'session', id: auth.createSession().id }
  const ws1 = {}
  assert.equal(auth.canAttachWebSocket(sessionActor), true)
  const detachS1 = auth.attachWebSocket(sessionActor, ws1)
  assert.equal(auth.canAttachWebSocket(sessionActor), false)
  detachS1()
  assert.equal(auth.canAttachWebSocket(sessionActor), true)

  const tokenActor = { kind: 'token', id: auth.createTokenSync().record.id }
  const detaches = []
  for (let i = 0; i < 5; i++) {
    assert.equal(auth.canAttachWebSocket(tokenActor), true)
    detaches.push(auth.attachWebSocket(tokenActor, { idx: i }))
  }
  assert.equal(auth.canAttachWebSocket(tokenActor), false)
  detaches[0]()
  assert.equal(auth.canAttachWebSocket(tokenActor), true)
})

test('IP classification and Tailscale CGNAT (100.64.0.0/10) + ULA (fd7a:115c:a1e0::/48) detection', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true)
  assert.equal(isLoopbackIp('::1'), true)
  assert.equal(isTailscaleIp('100.64.0.1'), true)
  assert.equal(isTailscaleIp('100.100.100.100'), true)
  assert.equal(isTailscaleIp('100.127.255.254'), true)
  assert.equal(isTailscaleIp('100.63.255.255'), false)
  assert.equal(isTailscaleIp('100.128.0.1'), false)
  assert.equal(isTailscaleIp('fd7a:115c:a1e0:ab12::1'), true)
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::1'), true)
  assert.equal(isPrivateIp('192.168.1.50'), true)
  assert.equal(isPrivateIp('10.1.2.3'), true)
  assert.equal(isPrivateIp('172.16.0.1'), true)
  assert.equal(isWildcardIp('0.0.0.0'), true)
  assert.equal(isPublicOrWildcardBind('0.0.0.0'), true)
  assert.equal(isPublicOrWildcardBind('203.0.113.42'), true)
  assert.equal(isPublicOrWildcardBind('100.88.1.2'), false)

  const mockIfaces = {
    tailscale0: [{ address: '100.88.1.2', family: 'IPv4', internal: false }],
    eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  }
  const detected = detectNetworkInterfaces(mockIfaces)
  assert.equal(detected.length, 3)
  const ts = detectTailscaleAddresses(mockIfaces)
  assert.equal(ts.length, 1)
  assert.equal(ts[0].address, '100.88.1.2')
  assert.equal(ts[0].tailscale, true)
  assert.match(ts[0].label, /Tailscale/)
})
