'use strict'
const { SCOPES, COMMANDS, scopeAllows } = require('../core/command-contract.cjs')
const {
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  parseCookies,
  formatSessionCookie
} = require('./auth.cjs')

const ELECTRON_ONLY_CHANNELS = Object.freeze(new Set([
  'auth:open-isolated',
  'system:open-external',
  'dialog:open-file',
  'dialog:save-file',
  'file:open-dialog',
  'file:save-dialog',
  'app:auto-launch',
  'system:auto-launch',
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:controls'
]))

function extractId(arg) {
  if (typeof arg === 'string') return arg
  if (arg && typeof arg === 'object') return arg.id ?? arg.accountId ?? arg.macroId ?? ''
  return ''
}

function extractArray(arg) {
  if (Array.isArray(arg)) {
    if (arg.length === 1 && Array.isArray(arg[0])) return arg[0]
    return arg
  }
  if (arg && typeof arg === 'object' && Array.isArray(arg.orderedIds)) return arg.orderedIds
  if (arg && typeof arg === 'object' && Array.isArray(arg.ids)) return arg.ids
  return []
}

function extractTargetAccountId(channel, args) {
  const first = Array.isArray(args) ? args[0] : args
  if (!first) return undefined
  if (typeof first === 'string') {
    if (
      channel.startsWith('bot:') ||
      channel.startsWith('accounts:') ||
      channel === 'logs:list' ||
      channel === 'logs:clear'
    ) {
      return first
    }
    return undefined
  }
  if (typeof first === 'object') {
    return first.accountId || first.id || undefined
  }
  return undefined
}

const CHANNEL_SPECS = Object.freeze({
  // Read scope channels
  'accounts:list': {
    scope: 'read',
    invoke: (core) => core.accounts.list()
  },
  'app:version': {
    scope: 'read',
    invoke: (core) => (core.app?.version ? core.app.version() : '')
  },
  'app:supported-versions': {
    scope: 'read',
    invoke: (core) => (core.app?.supportedVersions ? core.app.supportedVersions() : [])
  },
  'app:capabilities': {
    scope: 'read',
    invoke: (_core, _args, ctx) => ctx.getCapabilities()
  },
  'logs:list': {
    scope: 'read',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.logs.list(args[0], args[1])
      return core.logs.list(args)
    }
  },
  'macros:list': {
    scope: 'read',
    invoke: (core) => core.macros.list()
  },
  'macros:runs': {
    scope: 'read',
    invoke: (core, args) => core.macros.runs(extractId(Array.isArray(args) ? args[0] : args))
  },
  'macros:export': {
    scope: 'read',
    invoke: (core, args) => core.macros.exportJson(extractArray(args))
  },
  'proxy:health': {
    scope: 'read',
    invoke: (core) => (core.proxies?.health ? core.proxies.health() : [])
  },
  'bot:world-snapshot': {
    scope: 'read',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.worldSnapshot(args[0], args[1], args[2])
      return core.bots.worldSnapshot(args)
    }
  },
  'settings:get': {
    scope: 'read',
    invoke: (core, _args, ctx) => {
      const base = core.settings?.get ? core.settings.get() : {}
      const sanitized = sanitizeOutput(base)
      if (!scopeAllows(ctx.actor?.scope, 'admin') && sanitized && typeof sanitized === 'object') {
        const { remoteAccess: _omit, ...rest } = sanitized
        return rest
      }
      if (ctx.getRemoteAccessStatus && scopeAllows(ctx.actor?.scope, 'admin')) {
        return { ...sanitized, remoteAccess: ctx.getRemoteAccessStatus() }
      }
      return sanitized
    }
  },
  'audit:recent': {
    scope: 'admin',
    invoke: (core, args) => {
      const limit = typeof args === 'number' ? args : args?.limit || 50
      return core.audit?.recent ? core.audit.recent(limit) : core.logs?.recent?.(limit) || []
    }
  },

  // Control scope channels (bot actions & macro execution)
  'bot:connect': {
    scope: 'control',
    invoke: (core, args) => core.bots.connect(extractId(Array.isArray(args) ? args[0] : args))
  },
  'bot:disconnect': {
    scope: 'control',
    invoke: (core, args) => core.bots.disconnect(extractId(Array.isArray(args) ? args[0] : args))
  },
  'bot:chat': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.chat(args[0], args[1])
      return core.bots.chat(args)
    }
  },
  'bot:complete-chat': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.completeChat(args[0], args[1])
      return core.bots.completeChat(args)
    }
  },
  'bot:control': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.control(args[0], args[1], args[2])
      return core.bots.control(args)
    }
  },
  'bot:control-state': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.setControlState(args[0], args[1], args[2])
      return core.bots.setControlState(args)
    }
  },
  'bot:look': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.look(args[0], args[1])
      return core.bots.look(args)
    }
  },
  'bot:look-delta': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.lookDelta(args[0], args[1], args[2])
      return core.bots.lookDelta(args)
    }
  },
  'bot:drop-stack': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.dropStack(args[0], args[1])
      return core.bots.dropStack(args)
    }
  },
  'bot:drop-items': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.dropItems(args[0], args[1], args[2])
      return core.bots.dropItems(args)
    }
  },
  'bot:deposit-slot': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.depositSlot(args[0], args[1], args[2])
      return core.bots.depositSlot(args)
    }
  },
  'bot:item-lock': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.itemLock(args[0], args[1], args[2])
      return core.bots.itemLock(args)
    }
  },
  'bot:inventory-move': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.moveInventory(args[0], args[1], args[2])
      return core.bots.moveInventory(args)
    }
  },
  'bot:equip-item': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.equipItem(args[0], args[1], args[2])
      return core.bots.equipItem(args)
    }
  },
  'bot:window-click': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.windowClick(args[0], args[1])
      return core.bots.windowClick(args)
    }
  },
  'bot:window-close': {
    scope: 'control',
    invoke: (core, args) => core.bots.windowClose(extractId(Array.isArray(args) ? args[0] : args))
  },
  'bot:world-action': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.worldAction(args[0], args[1], args[2])
      return core.bots.worldAction(args)
    }
  },
  'bot:auto-deposit': {
    scope: 'control',
    invoke: (core, args) => {
      if (Array.isArray(args)) return core.bots.autoDeposit(args[0], args[1])
      return core.bots.autoDeposit(args)
    }
  },
  'macros:run': {
    scope: 'control',
    invoke: (core, args) => core.macros.run(Array.isArray(args) ? args[0] : args)
  },
  'macros:stop': {
    scope: 'control',
    invoke: (core, args) => core.macros.stop(Array.isArray(args) ? args[0] : args)
  },

  // Admin scope channels (accounts, settings, notify, macros management, log clearing)
  'accounts:save': {
    scope: 'admin',
    invoke: (core, args) => core.accounts.save(Array.isArray(args) ? args[0] : args)
  },
  'accounts:delete': {
    scope: 'admin',
    invoke: (core, args) => core.accounts.delete(extractId(Array.isArray(args) ? args[0] : args))
  },
  'accounts:duplicate-profile': {
    scope: 'admin',
    invoke: (core, args) => core.accounts.duplicate(extractId(Array.isArray(args) ? args[0] : args))
  },
  'accounts:reorder': {
    scope: 'admin',
    invoke: (core, args) => core.accounts.reorder(extractArray(args))
  },
  'logs:clear': {
    scope: 'admin',
    invoke: (core, args) => core.logs.clear(extractId(Array.isArray(args) ? args[0] : args))
  },
  'macros:save': {
    scope: 'admin',
    invoke: (core, args) => core.macros.save(Array.isArray(args) ? args[0] : args)
  },
  'macros:delete': {
    scope: 'admin',
    invoke: (core, args) => core.macros.remove(extractId(Array.isArray(args) ? args[0] : args))
  },
  'macros:set-enabled': {
    scope: 'admin',
    invoke: (core, args) => core.macros.setEnabled(Array.isArray(args) ? args[0] : args)
  },
  'macros:import': {
    scope: 'admin',
    invoke: (core, args) => core.macros.importJson(Array.isArray(args) ? args[0] : args)
  },
  'notify:list': {
    scope: 'admin',
    invoke: (core) => core.notify.list()
  },
  'notify:save': {
    scope: 'admin',
    invoke: (core, args) => core.notify.save(Array.isArray(args) ? args[0] : args)
  },
  'notify:delete': {
    scope: 'admin',
    invoke: (core, args) => core.notify.delete(extractId(Array.isArray(args) ? args[0] : args))
  },
  'notify:test': {
    scope: 'admin',
    invoke: (core, args) => core.notify.test(extractId(Array.isArray(args) ? args[0] : args))
  },
  'settings:save': {
    scope: 'admin',
    invoke: (core, args, ctx) => {
      const payload = Array.isArray(args) ? args[0] : args
      const saved = core.settings.save(payload)
      if (ctx.saveRemoteAccessSettings && payload?.remoteAccess) {
        return { ...sanitizeOutput(saved), remoteAccess: ctx.saveRemoteAccessSettings(payload.remoteAccess) }
      }
      return sanitizeOutput(saved)
    }
  }
})

const SECRET_KEY_PATTERN = /^(?:password|passwordEncrypted|secret|secretEncrypted|webhookUrl|botToken|accessToken|refreshToken|clientSecret|privateKey|secretKey)$/i
const DISCORD_WEBHOOK_VALUE_PATTERN = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/gi
const TELEGRAM_TOKEN_VALUE_PATTERN = /\b\d{5,15}:[A-Za-z0-9_-]{10,}\b/g

function sanitizeStringValue(str) {
  return str
    .replace(DISCORD_WEBHOOK_VALUE_PATTERN, '[redacted-webhook]')
    .replace(TELEGRAM_TOKEN_VALUE_PATTERN, '[redacted-token]')
}

function sanitizeOutput(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return value
  if (typeof value === 'string') return sanitizeStringValue(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeOutput(item, depth + 1))

  const out = {}
  let hadPassword = false
  let hadSecret = false
  let secretHint = typeof value.secretHint === 'string' ? value.secretHint : ''

  for (const [k, v] of Object.entries(value)) {
    if (k === 'notifyChannels') continue
    if (SECRET_KEY_PATTERN.test(k)) {
      const nonEmpty = typeof v === 'string' ? v.length > 0 : Boolean(v)
      if (/password/i.test(k)) {
        hadPassword = hadPassword || nonEmpty
      } else {
        hadSecret = hadSecret || nonEmpty
        if (nonEmpty && typeof v === 'string' && !/Encrypted$/i.test(k) && !secretHint) {
          secretHint = `••••${v.slice(-4)}`
        }
      }
      continue
    }
    out[k] = sanitizeOutput(v, depth + 1)
  }

  if (hadPassword && out.hasPassword === undefined) {
    out.hasPassword = true
  }
  if (hadSecret) {
    if (out.hasSecret === undefined) out.hasSecret = true
    if (secretHint && out.secretHint === undefined) out.secretHint = secretHint
  }
  return out
}

function recordAudit(core, now, entry) {
  const timestamp = typeof now === 'function' ? now() : Date.now()
  const record = {
    at: timestamp,
    type: 'audit',
    kind: 'audit',
    actor: {
      kind: entry.actor?.kind || 'anonymous',
      id: entry.actor?.id || 'anonymous',
      scope: entry.actor?.scope || 'none',
      ip: entry.ip || entry.actor?.ip || ''
    },
    scope: entry.actor?.scope || 'none',
    command: String(entry.command || ''),
    ...(entry.accountId ? { accountId: String(entry.accountId), targetAccount: String(entry.accountId) } : {}),
    result: String(entry.result || 'unknown'),
    ip: String(entry.ip || entry.actor?.ip || ''),
    ...(entry.code ? { code: String(entry.code) } : {}),
    ...(entry.detail ? { detail: String(entry.detail).slice(0, 200) } : {})
  }
  try {
    if (typeof core?._appendAudit === 'function') {
      core._appendAudit(record)
      return
    }
    if (typeof core?.eventStore?.append === 'function') {
      core.eventStore.append('audit', record)
      if (record.accountId && record.accountId !== 'audit') {
        core.eventStore.append(record.accountId, record)
      }
      return
    }
    if (typeof core?.audit?.record === 'function') {
      core.audit.record(record)
    }
  } catch {}
}

function createApiRouter({
  core,
  auth,
  now = Date.now,
  pkgVersion = '0.10.0-beta.9',
  isLoopbackIp = () => false,
  isSecureRequest = () => false,
  getCapabilities = () => ({
    mode: 'server',
    headless: true,
    isolatedLoginWindow: false,
    openExternal: false,
    autoLaunch: false,
    fileDialogs: false,
    windowControls: false,
    deviceCodeSignIn: true,
    bedrock: true
  }),
  getRemoteAccessStatus = null,
  saveRemoteAccessSettings = null
}) {
  async function authenticateRequest(req, clientIp) {
    const authHeader = req.headers.authorization
    if (authHeader) {
      const tokenRecord = await auth.verifyBearerToken(authHeader)
      if (!tokenRecord) return { actor: null, session: null, error: 'Invalid or expired API token.' }
      return {
        actor: {
          kind: 'token',
          id: tokenRecord.id,
          name: tokenRecord.name,
          scope: tokenRecord.scope,
          ip: clientIp
        },
        session: null
      }
    }
    const cookies = parseCookies(req.headers.cookie)
    const sessionId = cookies[SESSION_COOKIE_NAME]
    if (sessionId) {
      const session = auth.getSession(sessionId, { touch: true })
      if (!session) return { actor: null, session: null, error: 'Session expired or invalid.' }
      return {
        actor: {
          kind: 'session',
          id: session.id,
          username: session.username,
          scope: session.scope,
          ip: clientIp
        },
        session
      }
    }
    return { actor: null, session: null, error: 'Authentication required.' }
  }

  async function handleApi(req, res, { pathname, method, body, clientIp, sendJson }) {
    // 1. Unauthenticated health check
    if (pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } })
      }
      let version = pkgVersion
      try {
        const v = core?.app?.version?.()
        if (v) version = String(v)
      } catch {}
      return sendJson(res, 200, { ok: true, version })
    }

    // 2. One-time loopback setup token endpoint
    if (pathname === '/api/setup' && method === 'POST') {
      if (!isLoopbackIp(clientIp)) {
        recordAudit(core, now, {
          actor: { kind: 'anonymous', id: 'setup', scope: 'none', ip: clientIp },
          command: 'auth.setup',
          result: 'forbidden',
          code: 'LOOPBACK_ONLY',
          ip: clientIp
        })
        return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Setup token is only valid from loopback.' } })
      }
      const suppliedToken = body?.setupToken || body?.token
      const password = body?.password
      const username = body?.username || 'admin'
      try {
        const admin = auth.consumeSetupToken(suppliedToken, password, username)
        const session = auth.createSession({ username: admin.username, scope: 'admin', ip: clientIp })
        const secure = isSecureRequest(req)
        res.setHeader('Set-Cookie', formatSessionCookie(session.id, { secure }))
        recordAudit(core, now, {
          actor: { kind: 'session', id: session.id, scope: 'admin', ip: clientIp },
          command: 'auth.setup',
          result: 'allowed',
          ip: clientIp
        })
        return sendJson(res, 200, {
          ok: true,
          username: session.username,
          scope: session.scope,
          csrfToken: session.csrfToken,
          capabilities: getCapabilities()
        })
      } catch (error) {
        recordAudit(core, now, {
          actor: { kind: 'anonymous', id: 'setup', scope: 'none', ip: clientIp },
          command: 'auth.setup',
          result: 'denied',
          detail: error.message,
          ip: clientIp
        })
        return sendJson(res, 400, { ok: false, error: { code: 'SETUP_FAILED', message: error.message } })
      }
    }

    // 3. Login endpoint
    if (pathname === '/api/login') {
      if (method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } })
      }
      const username = typeof body?.username === 'string' && body.username.trim() ? body.username.trim() : 'admin'
      const password = typeof body?.password === 'string' ? body.password : ''

      const rateCheck = auth.checkLoginRateLimit(clientIp, username)
      if (!rateCheck.allowed) {
        recordAudit(core, now, {
          actor: { kind: 'anonymous', id: username, scope: 'none', ip: clientIp },
          command: 'auth.login',
          result: 'rate_limited',
          code: 'RATE_LIMITED',
          ip: clientIp
        })
        res.setHeader('Retry-After', String(Math.ceil(rateCheck.retryAfterMs / 1000)))
        return sendJson(res, 429, {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many login attempts. Please wait before trying again.',
            retryAfterMs: rateCheck.retryAfterMs
          }
        })
      }

      const valid = await auth.verifyAdminPassword(password, username)
      auth.recordLoginAttempt(clientIp, username, valid)
      if (!valid) {
        recordAudit(core, now, {
          actor: { kind: 'anonymous', id: username, scope: 'none', ip: clientIp },
          command: 'auth.login',
          result: 'denied',
          code: 'INVALID_CREDENTIALS',
          ip: clientIp
        })
        return sendJson(res, 401, {
          ok: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' }
        })
      }

      const session = auth.createSession({ username: auth.getAdminUsername(), scope: 'admin', ip: clientIp })
      const secure = isSecureRequest(req)
      res.setHeader('Set-Cookie', formatSessionCookie(session.id, { secure }))
      recordAudit(core, now, {
        actor: { kind: 'session', id: session.id, scope: 'admin', ip: clientIp },
        command: 'auth.login',
        result: 'allowed',
        ip: clientIp
      })
      return sendJson(res, 200, {
        ok: true,
        username: session.username,
        scope: session.scope,
        csrfToken: session.csrfToken,
        capabilities: getCapabilities()
      })
    }

    // 4. All other /api/* endpoints require authentication
    const { actor, session, error: authError } = await authenticateRequest(req, clientIp)
    if (!actor) {
      recordAudit(core, now, {
        actor: { kind: 'anonymous', id: 'anonymous', scope: 'none', ip: clientIp },
        command: `${method} ${pathname}`,
        result: 'unauthorized',
        code: 'UNAUTHORIZED',
        ip: clientIp
      })
      return sendJson(res, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: authError || 'Authentication required.' }
      })
    }

    // 5. CSRF synchronizer token check on every non-GET/HEAD request using a session cookie
    if (session && method !== 'GET' && method !== 'HEAD') {
      const csrfHeader = req.headers[CSRF_HEADER_NAME]
      if (!auth.verifyCsrf(session, csrfHeader)) {
        recordAudit(core, now, {
          actor,
          command: `${method} ${pathname}`,
          result: 'forbidden',
          code: 'CSRF_INVALID',
          ip: clientIp
        })
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'CSRF_INVALID', message: 'Missing or invalid X-AFK-CSRF token.' }
        })
      }
    }

    // 6. Per-session / per-token API rate limit (120 req/min)
    const apiRate = auth.checkApiRateLimit(`${actor.kind}:${actor.id}`)
    if (!apiRate.allowed) {
      recordAudit(core, now, {
        actor,
        command: `${method} ${pathname}`,
        result: 'rate_limited',
        code: 'RATE_LIMITED',
        ip: clientIp
      })
      res.setHeader('Retry-After', String(Math.ceil(apiRate.retryAfterMs / 1000)))
      return sendJson(res, 429, {
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'API rate limit exceeded (120 requests/min).' }
      })
    }

    // 7. GET /api/session
    if (pathname === '/api/session' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        authenticated: true,
        kind: actor.kind,
        username: actor.username || actor.name || 'admin',
        scope: actor.scope,
        csrfToken: session ? session.csrfToken : null,
        capabilities: getCapabilities()
      })
    }

    // 8. GET /api/capabilities
    if (pathname === '/api/capabilities' && method === 'GET') {
      return sendJson(res, 200, { ok: true, capabilities: getCapabilities() })
    }

    // 9. POST /api/logout & POST /api/logout-all
    if ((pathname === '/api/logout' || pathname === '/api/logout-all') && method === 'POST') {
      const everywhere = pathname === '/api/logout-all' || body?.everywhere === true || body?.all === true
      if (everywhere) {
        auth.revokeAllSessions()
        recordAudit(core, now, { actor, command: 'auth.logoutAll', result: 'allowed', ip: clientIp })
      } else if (session) {
        auth.revokeSession(session.id)
        recordAudit(core, now, { actor, command: 'auth.logout', result: 'allowed', ip: clientIp })
      }
      const secure = isSecureRequest(req)
      res.setHeader('Set-Cookie', formatSessionCookie('', { secure, clear: true }))
      return sendJson(res, 200, { ok: true, everywhere })
    }

    // 10. Tokens management endpoints (admin only)
    if (pathname === '/api/tokens' || pathname.startsWith('/api/tokens/')) {
      if (!scopeAllows(actor.scope, 'admin')) {
        recordAudit(core, now, { actor, command: `tokens.${method.toLowerCase()}`, result: 'forbidden', code: 'FORBIDDEN', ip: clientIp })
        return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Admin scope is required to manage API tokens.' } })
      }
      if (pathname === '/api/tokens' && method === 'GET') {
        const tokens = auth.listTokens()
        recordAudit(core, now, { actor, command: 'tokens.list', result: 'allowed', ip: clientIp })
        return sendJson(res, 200, { ok: true, tokens })
      }
      if (pathname === '/api/tokens' && method === 'POST') {
        try {
          const scope = body?.scope || 'read'
          if (!SCOPES.includes(scope)) {
            return sendJson(res, 400, { ok: false, error: { code: 'INVALID_SCOPE', message: 'Invalid token scope.' } })
          }
          const ttlMs = body?.ttlMs != null
            ? Number(body.ttlMs)
            : (body?.expiresInSeconds != null
                ? Number(body.expiresInSeconds) * 1000
                : (body?.expiresInDays != null ? Number(body.expiresInDays) * 24 * 60 * 60 * 1000 : null))
          const created = await auth.createToken({
            name: body?.name || 'API token',
            scope,
            expiresAt: body?.expiresAt ?? null,
            ttlMs
          })
          recordAudit(core, now, { actor, command: 'tokens.create', result: 'allowed', detail: `${created.record.id}:${scope}`, ip: clientIp })
          return sendJson(res, 201, { ok: true, token: created.token, record: created.record })
        } catch (error) {
          recordAudit(core, now, { actor, command: 'tokens.create', result: 'invalid', detail: error.message, ip: clientIp })
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID', message: error.message } })
        }
      }
      const tokenMatch = /^\/api\/tokens\/([a-zA-Z0-9_-]+)(?:\/revoke)?$/.exec(pathname)
      if (tokenMatch && (method === 'DELETE' || method === 'POST')) {
        const tokenId = tokenMatch[1]
        const revoked = auth.revokeToken(tokenId)
        if (!revoked) {
          recordAudit(core, now, { actor, command: 'tokens.revoke', result: 'not_found', detail: tokenId, ip: clientIp })
          return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Token not found.' } })
        }
        recordAudit(core, now, { actor, command: 'tokens.revoke', result: 'allowed', detail: tokenId, ip: clientIp })
        return sendJson(res, 200, { ok: true, id: tokenId })
      }
      return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } })
    }

    // 11. Admin password change endpoint (admin only)
    if (pathname === '/api/password' && method === 'POST') {
      if (!scopeAllows(actor.scope, 'admin')) {
        recordAudit(core, now, { actor, command: 'auth.password', result: 'forbidden', code: 'FORBIDDEN', ip: clientIp })
        return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Admin scope is required.' } })
      }
      const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
      const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
      if (auth.hasAdmin()) {
        const valid = await auth.verifyAdminPassword(currentPassword, auth.getAdminUsername())
        if (!valid) {
          recordAudit(core, now, { actor, command: 'auth.password', result: 'denied', code: 'INVALID_CREDENTIALS', ip: clientIp })
          return sendJson(res, 401, { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' } })
        }
      }
      try {
        await auth.setAdminPassword(newPassword, auth.getAdminUsername())
        recordAudit(core, now, { actor, command: 'auth.password', result: 'allowed', ip: clientIp })
        return sendJson(res, 200, { ok: true })
      } catch (error) {
        recordAudit(core, now, { actor, command: 'auth.password', result: 'invalid', detail: error.message, ip: clientIp })
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PASSWORD', message: error.message } })
      }
    }

    // 12. Shared Command Layer endpoints: GET /api/commands & POST /api/commands/:name
    if (pathname === '/api/commands' && method === 'GET') {
      const list = core.commands ? core.commands.list(actor) : []
      return sendJson(res, 200, { ok: true, commands: list })
    }
    if (pathname.startsWith('/api/commands/') && method === 'POST') {
      const commandName = decodeURIComponent(pathname.slice('/api/commands/'.length))
      if (!core.commands || typeof core.commands.execute !== 'function') {
        return sendJson(res, 501, { ok: false, error: { code: 'UNSUPPORTED', message: 'Command layer is unavailable.' } })
      }
      let cmdArgs = {}
      let confirmed = false
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (body.args && typeof body.args === 'object' && !Array.isArray(body.args)) {
          cmdArgs = body.args
          confirmed = body.confirmed === true
        } else {
          const { confirmed: c, ...rest } = body
          confirmed = c === true
          cmdArgs = rest
        }
      }
      const outcome = await core.commands.execute(actor, commandName, cmdArgs, { confirmed })
      if (outcome.ok) {
        return sendJson(res, 200, { ok: true, result: sanitizeOutput(outcome.result) })
      }
      const errCode = outcome.error?.code
      const status =
        errCode === 'FORBIDDEN' ? 403
          : errCode === 'RATE_LIMITED' ? 429
            : errCode === 'NOT_FOUND' ? 404
              : errCode === 'CONFIRM_REQUIRED' ? 409
                : 400
      return sendJson(res, status, outcome)
    }

    // 13. POST /api/invoke { channel, args }
    if (pathname === '/api/invoke' && method === 'POST') {
      const channel = typeof body?.channel === 'string' ? body.channel.trim() : ''
      const args = body?.args

      if (!channel) {
        recordAudit(core, now, { actor, command: 'invoke:<empty>', result: 'invalid', code: 'INVALID_CHANNEL', ip: clientIp })
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_CHANNEL', message: 'channel is required.' } })
      }

      if (ELECTRON_ONLY_CHANNELS.has(channel)) {
        recordAudit(core, now, { actor, command: `invoke:${channel}`, result: 'unsupported', code: 'UNSUPPORTED', ip: clientIp })
        return sendJson(res, 501, {
          ok: false,
          error: { code: 'UNSUPPORTED', message: `Channel "${channel}" is only available in the desktop app.` }
        })
      }

      const spec = CHANNEL_SPECS[channel]
      if (!spec) {
        recordAudit(core, now, { actor, command: `invoke:${channel}`, result: 'denied', code: 'UNKNOWN_CHANNEL', ip: clientIp })
        return sendJson(res, 400, {
          ok: false,
          error: { code: 'UNKNOWN_CHANNEL', message: `Channel "${channel}" is not allowlisted.` }
        })
      }

      const accountId = extractTargetAccountId(channel, args)
      if (!scopeAllows(actor.scope, spec.scope)) {
        recordAudit(core, now, {
          actor,
          command: `invoke:${channel}`,
          accountId,
          result: 'forbidden',
          code: 'FORBIDDEN',
          ip: clientIp
        })
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'FORBIDDEN', message: `Channel "${channel}" requires "${spec.scope}" scope.` }
        })
      }

      try {
        const rawResult = await spec.invoke(core, args, {
          actor,
          getCapabilities,
          getRemoteAccessStatus,
          saveRemoteAccessSettings
        })
        const result = sanitizeOutput(rawResult)
        recordAudit(core, now, {
          actor,
          command: `invoke:${channel}`,
          accountId,
          result: 'allowed',
          ip: clientIp
        })
        return sendJson(res, 200, { ok: true, result: result === undefined ? null : result })
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300)
        recordAudit(core, now, {
          actor,
          command: `invoke:${channel}`,
          accountId,
          result: 'failed',
          code: error?.code || 'FAILED',
          detail: message,
          ip: clientIp
        })
        return sendJson(res, 400, {
          ok: false,
          error: {
            code: String(error?.code || 'FAILED'),
            message,
            ...(error?.validation ? { validation: error.validation } : {})
          }
        })
      }
    }

    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } })
  }

  return {
    handleApi,
    authenticateRequest,
    sanitizeOutput,
    recordAudit
  }
}

module.exports = {
  createApiRouter,
  CHANNEL_SPECS,
  ELECTRON_ONLY_CHANNELS,
  sanitizeOutput,
  recordAudit,
   COMMANDS
}
