'use strict'
const { COMMANDS, LIMITS, scopeAllows } = require('./command-contract.cjs')
const { stripFormatting } = require('../electron/macro/bot-events.cjs')

function createCommandLayer({ core, audit = () => {}, now = Date.now, timers = globalThis } = {}) {
  const calls = new Map()
  const accounts = () => core.accounts.list()
  const displayName = (a) => String(a?.profileName || a?.minecraftName || a?.label || 'Minecraft account').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '').slice(0, 60) || 'Minecraft account'
  const actorKey = (a) => `${a?.kind}:${a?.id}`
  const accountView = (a) => ({ id: a.id, name: displayName(a) })
  function list(actor) { return Object.entries(COMMANDS).filter(([, c]) => scopeAllows(actor?.scope, c.scope)).map(([name, c]) => ({ name, ...c })) }
  function accountsFor(actor) { return scopeAllows(actor?.scope, 'read') ? accounts().map(accountView) : [] }
  function macrosFor(actor, accountId) { if (!scopeAllows(actor?.scope, 'read')) return []; return (core.macros?.list?.().macros || core.macros?.list?.() || []).filter((m) => !accountId || !m.targets?.accountIds || m.targets.accountIds.includes(accountId)).map((m) => ({ id: m.id, name: String(m.name || '').slice(0, 80) })) }
  function validate(spec, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be an object.'
    for (const key of Object.keys(args)) if (!Object.hasOwn(spec.args, key)) return `Unexpected argument: ${key}.`
    for (const [key, rule] of Object.entries(spec.args)) {
      const v = args[key]
      if (v === undefined) { if (rule.required) return `${key} is required.`; continue }
      if (rule.type === 'accountId' && (typeof v !== 'string' || !accounts().some((a) => a.id === v))) return 'Account not found.'
      if (rule.type === 'macroId' && (typeof v !== 'string' || !macrosFor({ scope: 'read' }).some((m) => m.id === v))) return 'Macro not found.'
      if (rule.type === 'text' && (typeof v !== 'string' || v.length > rule.max)) return `${key} must be text up to ${rule.max} characters.`
      if (rule.type === 'int' && (!Number.isInteger(v) || v < rule.min || v > rule.max)) return `${key} must be an integer from ${rule.min} to ${rule.max}.`
      if (rule.type === 'slot' && (!Number.isInteger(v) || v < 0 || v > 44)) return 'slot must be an integer from 0 to 44.'
      if (rule.type === 'bool' && typeof v !== 'boolean') return `${key} must be a boolean.`
    }
    return null
  }
  async function execute(actor, name, args = {}, options = {}) {
    let result, code
    const spec = COMMANDS[name]
    const done = async (ok, value, err) => {
      result = ok ? value : undefined; code = ok ? undefined : err
      try { await audit({ at: now(), actor: { kind: actor?.kind, id: actor?.id, scope: actor?.scope, ip: actor?.ip }, command: name, ...(args?.accountId ? { accountId: args.accountId } : {}), result: ok ? 'allowed' : (err === 'FORBIDDEN' ? 'forbidden' : 'invalid'), ...(err ? { code: err } : {}) }) } catch {}
      return ok ? { ok: true, result: sanitize(value) } : { ok: false, error: { code: err, message: value } }
    }
    try {
      if (!spec) return await done(false, 'Unknown command.', 'INVALID')
      if (!scopeAllows(actor?.scope, spec.scope)) return await done(false, 'Insufficient scope.', 'FORBIDDEN')
      const invalid = validate(spec, args)
      if (invalid) return await done(false, invalid, 'INVALID')
      const key = actorKey(actor), timestamp = now(), recent = (calls.get(key) || []).filter((x) => timestamp - x < 60_000)
      if (recent.length >= LIMITS.perActorPerMinute) return await done(false, 'Rate limit exceeded.', 'RATE_LIMITED')
      recent.push(timestamp); calls.set(key, recent)
      if (spec.danger === 'confirm' && options.confirmed !== true) return await done(false, 'Confirmation required.', 'CONFIRM_REQUIRED')
      const invoke = (path, ...values) => path.split('.').reduce((o, k) => o?.[k], core)?.(...values)
      let value
      switch (name) {
        case 'status': value = accounts().map((a) => { const s = core.status?.(a.id) || {}; return { id: a.id, name: displayName(a), server: String(a.host || ''), state: s.status || s.state || 'offline', health: s.telemetry?.health ?? s.health ?? null, food: s.telemetry?.food ?? s.food ?? null, uptimeSec: s.uptimeSec ?? 0 } }); break
        case 'account.info': { const a = accounts().find((x) => x.id === args.accountId); value = { ...accountView(a), server: String(a.host || ''), state: core.status?.(a.id)?.status || 'offline' }; break }
        case 'account.connect': value = await invoke('bots.connect', args.accountId); break
        case 'account.disconnect': value = await invoke('bots.disconnect', args.accountId); break
        case 'account.reconnect': value = await invoke('bots.reconnect', args.accountId); break
        case 'chat.send': value = await invoke('bots.sendChat', args.accountId, args.message); break
        case 'chat.recent': value = (core.recentChat?.(args.accountId) || []).slice(-(args.limit || 20)).map((x) => ({ ...x, message: stripFormatting(x.message) })); break
        case 'inventory.view': value = await invoke('bots.inventory', args.accountId); break
        case 'inventory.drop': value = await invoke('bots.dropItems', args.accountId, args.slot, args.count || 64); break
        case 'macro.list': value = macrosFor(actor, args.accountId); break
        case 'macro.run': value = await invoke('macros.run', { accountId: args.accountId, macroId: args.macroId }); break
        case 'macro.stop': value = await invoke('macros.stop', { accountId: args.accountId }); break
        case 'antiAfk.set': value = await invoke('accounts.setAntiAfk', args.accountId, args.enabled); break
        case 'connectAll': value = await invoke('bots.connectAll'); break
        case 'disconnectAll': value = await invoke('bots.disconnectAll'); break
        case 'notify.test': value = await invoke('notify.test', args.channelId); break
        case 'audit.recent': value = await (invoke('audit.recent', args.limit || 50) ?? invoke('logs.recent', args.limit || 50)); break
      }
      return await done(true, value)
    } catch (error) { return await done(false, String(error?.message || error).slice(0, 200), 'FAILED') }
  }
  function sanitize(value) {
    if (Array.isArray(value)) return value.slice(0, 200).map(sanitize)
    if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]') : value
    const out = {}
    for (const [k, v] of Object.entries(value)) if (!/email|token|secret|password|credential|username/i.test(k)) out[k] = sanitize(v)
    return out
  }
  return { list, execute, accountsFor, macrosFor }
}
module.exports = { createCommandLayer }
