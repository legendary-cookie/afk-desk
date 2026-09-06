const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_MACRO_STEPS = 1000
const MAX_MACRO_RUNTIME_MS = 5 * 60 * 1000

function identityIdFor(edition, username) {
  const key = `${edition === 'bedrock' ? 'bedrock' : 'java'}:${String(username || '').trim().toLowerCase()}`
  return `identity-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`
}

function normalizeEdition(value) { return value === 'bedrock' ? 'bedrock' : 'java' }

function normalizeAutomations(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 100).flatMap((item, index) => {
    const name = String(item?.name || `Automation ${index + 1}`).trim().slice(0, 60)
    const trigger = normalizeTrigger(item?.trigger)
    const steps = normalizeSteps(item?.steps, 0)
    if (!steps.length) return []
    return [{ id: String(item?.id || crypto.randomUUID()).slice(0, 80), name, enabled: item?.enabled !== false, trigger, steps }]
  })
}

function normalizeTrigger(input = {}) {
  const allowed = new Set(['manual', 'connected', 'disconnected', 'chat', 'health', 'inventory', 'window', 'timer'])
  const type = allowed.has(input?.type) ? input.type : 'manual'
  return {
    type,
    contains: String(input?.contains || '').slice(0, 160),
    below: bounded(input?.below, 0, 20, 8),
    intervalSeconds: bounded(input?.intervalSeconds, 2, 86400, 60)
  }
}

function normalizeSteps(input, depth) {
  if (!Array.isArray(input) || depth > 8) return []
  return input.slice(0, 200).flatMap((step) => {
    const type = String(step?.type || '')
    const allowed = new Set(['chat', 'wait', 'move', 'look', 'drop', 'deposit', 'equip', 'clickGui', 'attackNearest', 'useHeld', 'notify', 'set', 'if', 'repeat'])
    if (!allowed.has(type)) return []
    const normalized = {
      type,
      message: String(step?.message || '').slice(0, 256),
      control: String(step?.control || '').slice(0, 20),
      direction: String(step?.direction || '').slice(0, 20),
      destination: String(step?.destination || '').slice(0, 20),
      variable: String(step?.variable || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40),
      value: primitive(step?.value),
      milliseconds: bounded(step?.milliseconds, 0, 60000, 500),
      duration: bounded(step?.duration, 100, 10000, 350),
      slot: integer(step?.slot, 0, 255, 0),
      count: integer(step?.count, 1, 64, 1),
      times: integer(step?.times, 1, 100, 1),
      condition: normalizeCondition(step?.condition),
      then: normalizeSteps(step?.then, depth + 1),
      else: normalizeSteps(step?.else, depth + 1),
      steps: normalizeSteps(step?.steps, depth + 1)
    }
    return [normalized]
  })
}

function normalizeCondition(input = {}) {
  const allowed = new Set(['always', 'status', 'healthBelow', 'hungerBelow', 'chatContains', 'hasItem', 'variableEquals'])
  return {
    type: allowed.has(input?.type) ? input.type : 'always',
    value: primitive(input?.value),
    name: String(input?.name || '').slice(0, 80),
    count: integer(input?.count, 1, 2304, 1)
  }
}

class PersistentEventStore {
  constructor(userDataPath, { maxBytes = MAX_EVENT_BYTES } = {}) {
    this.directory = path.join(userDataPath, 'events')
    this.maxBytes = maxBytes
  }

  append(profileId, event) {
    const file = this.fileFor(profileId)
    fs.mkdirSync(this.directory, { recursive: true })
    rotate(file, this.maxBytes)
    fs.appendFileSync(file, `${JSON.stringify(redact({ ...event, profileId: String(profileId), at: Number(event?.at) || Date.now() }))}\n`, 'utf8')
  }

  list(profileId, { limit = 1000, kinds = [] } = {}) {
    const file = this.fileFor(profileId)
    if (!fs.existsSync(file)) return []
    const allowed = new Set(Array.isArray(kinds) ? kinds.map(String) : [])
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(Number(limit) || 1000, 5000))).flatMap((line) => {
      try {
        const event = JSON.parse(line)
        return allowed.size && !allowed.has(String(event.kind || event.type)) ? [] : [event]
      } catch { return [] }
    })
  }

  clear(profileId) {
    const file = this.fileFor(profileId)
    if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
  }

  fileFor(profileId) { return path.join(this.directory, `${String(profileId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100)}.jsonl`) }
}

class AlertManager {
  constructor(notify, { cooldownMs = 30_000 } = {}) {
    this.notify = notify
    this.cooldownMs = cooldownMs
    this.last = new Map()
  }

  handle(account, type, payload = {}) {
    const rules = account?.alerts || {}
    let key = ''
    let body = ''
    if (type === 'status' && ['offline', 'reconnecting'].includes(payload.status) && rules.disconnect !== false) {
      key = 'disconnect'; body = payload.detail || `Status changed to ${payload.status}`
    } else if (type === 'log' && payload.kind === 'error' && rules.errors !== false) {
      key = 'error'; body = payload.message
    } else if (type === 'telemetry' && Number(payload.health) <= Number(rules.healthBelow ?? 6)) {
      key = 'health'; body = `Health is ${payload.health}/20`
    }
    if (!key || !body) return
    const throttleKey = `${account.id}:${key}`
    const now = Date.now()
    if (now - (this.last.get(throttleKey) || 0) < this.cooldownMs) return
    this.last.set(throttleKey, now)
    this.notify({ title: `${account.profileName || account.label || 'AFK Desk'} — ${key}`, body: String(body).slice(0, 240) })
  }
}

class SmartProxyManager {
  constructor() {
    this.health = new Map()
    this.leases = new Map()
    this.sticky = new Map()
  }

  select(account, accounts) {
    if (account?.proxyMode !== 'smart') return account?.proxy || { enabled: false }
    const candidates = (accounts || []).filter((item) => item.id !== account.id && item?.shareProxyToPool === true && item?.proxy?.enabled === true).map((item) => ({ owner: item, proxy: item.proxy }))
    if (!candidates.length) throw new Error('No enabled shared proxies are available in the smart pool.')
    const stickyId = this.sticky.get(account.identityId)
    const ranked = candidates.filter(({ owner }) => (this.leases.get(owner.id) || 0) < Math.max(1, Number(owner.proxyMaxSessions) || 1)).sort((a, b) => this.score(b.owner.id) - this.score(a.owner.id))
    const selected = ranked.find(({ owner }) => owner.id === stickyId) || ranked[0]
    if (!selected) throw new Error('Every smart proxy is currently at its session limit.')
    this.sticky.set(account.identityId, selected.owner.id)
    this.leases.set(selected.owner.id, (this.leases.get(selected.owner.id) || 0) + 1)
    return { ...selected.proxy, enabled: true, poolOwnerId: selected.owner.id, poolLabel: selected.owner.proxyLabel || selected.proxy.host }
  }

  release(proxy) {
    if (!proxy?.poolOwnerId) return
    this.leases.set(proxy.poolOwnerId, Math.max(0, (this.leases.get(proxy.poolOwnerId) || 0) - 1))
  }

  report(proxy, ok) {
    if (!proxy?.poolOwnerId) return
    const state = this.health.get(proxy.poolOwnerId) || { successes: 0, failures: 0, cooldownUntil: 0 }
    if (ok) state.successes += 1
    else { state.failures += 1; state.cooldownUntil = Date.now() + Math.min(15 * 60_000, 30_000 * state.failures) }
    this.health.set(proxy.poolOwnerId, state)
  }

  score(id) {
    const state = this.health.get(id) || { successes: 0, failures: 0, cooldownUntil: 0 }
    if (state.cooldownUntil > Date.now()) return -100000
    return state.successes * 5 - state.failures * 12 - (this.leases.get(id) || 0) * 3
  }

  snapshot() { return [...this.health].map(([id, value]) => ({ id, ...value, leases: this.leases.get(id) || 0, score: this.score(id) })) }
}

class MacroEngine {
  constructor({ getAccount, getState, execute, emit = () => {}, timers = globalThis } = {}) {
    this.getAccount = getAccount
    this.getState = getState
    this.execute = execute
    this.emit = emit
    this.timers = timers
    this.running = new Map()
    this.timerHandles = new Map()
  }

  sync(account) {
    this.cancelTimers(account.id)
    for (const macro of normalizeAutomations(account.automations)) {
      if (!macro.enabled || macro.trigger.type !== 'timer') continue
      const handle = this.timers.setInterval(() => this.run(account.id, macro.id, { type: 'timer' }).catch(() => {}), macro.trigger.intervalSeconds * 1000)
      const handles = this.timerHandles.get(account.id) || []
      handles.push(handle); this.timerHandles.set(account.id, handles)
    }
  }

  async handleEvent(profileId, type, payload) {
    const account = this.getAccount(profileId)
    if (!account) return
    const triggerType = type === 'status' && payload?.status === 'online' ? 'connected'
      : type === 'status' && payload?.status === 'offline' ? 'disconnected'
        : type === 'log' && payload?.kind === 'chat' ? 'chat'
          : type === 'telemetry' ? 'health'
            : type === 'window' && payload?.open ? 'window' : type
    for (const macro of normalizeAutomations(account.automations)) {
      if (!macro.enabled || macro.trigger.type !== triggerType) continue
      if (triggerType === 'chat' && macro.trigger.contains && !String(payload?.message || '').toLowerCase().includes(macro.trigger.contains.toLowerCase())) continue
      if (triggerType === 'health' && Number(payload?.health) >= macro.trigger.below) continue
      void this.run(profileId, macro.id, { type: triggerType, payload }).catch(() => {})
    }
  }

  async run(profileId, macroId, event = { type: 'manual' }) {
    const account = this.getAccount(profileId)
    const macro = normalizeAutomations(account?.automations).find((item) => item.id === macroId)
    if (!macro) throw new Error('Automation not found.')
    if (this.running.has(profileId)) throw new Error('Another automation is already running for this profile.')
    const context = { profileId, macro, event, variables: {}, steps: 0, startedAt: Date.now(), cancelled: false }
    this.running.set(profileId, context)
    this.emit('macro', profileId, { status: 'running', macroId, name: macro.name, at: Date.now() })
    try {
      await this.runSteps(context, macro.steps)
      this.emit('macro', profileId, { status: 'completed', macroId, name: macro.name, at: Date.now() })
    } catch (error) {
      const status = context.cancelled ? 'cancelled' : 'failed'
      this.emit('macro', profileId, { status, macroId, name: macro.name, error: String(error?.message || error).slice(0, 200), at: Date.now() })
      if (!context.cancelled) throw error
    } finally { if (this.running.get(profileId) === context) this.running.delete(profileId) }
  }

  stop(profileId) {
    const context = this.running.get(profileId)
    if (context) context.cancelled = true
  }

  async runSteps(context, steps) {
    for (const step of steps) {
      this.guard(context)
      if (step.type === 'wait') await wait(step.milliseconds)
      else if (step.type === 'set') context.variables[step.variable] = step.value
      else if (step.type === 'if') await this.runSteps(context, this.test(step.condition, context) ? step.then : step.else)
      else if (step.type === 'repeat') for (let index = 0; index < step.times; index += 1) { context.variables.index = index; await this.runSteps(context, step.steps) }
      else await this.execute(context.profileId, step, context)
    }
  }

  test(condition, context) {
    const state = this.getState(context.profileId) || {}
    if (condition.type === 'always') return true
    if (condition.type === 'status') return state.status === condition.value
    if (condition.type === 'healthBelow') return Number(state.telemetry?.health) < Number(condition.value)
    if (condition.type === 'hungerBelow') return Number(state.telemetry?.food) < Number(condition.value)
    if (condition.type === 'chatContains') return String(context.event?.payload?.message || '').toLowerCase().includes(String(condition.value || '').toLowerCase())
    if (condition.type === 'hasItem') return (state.telemetry?.inventory || []).filter((item) => String(item.name).includes(condition.name)).reduce((sum, item) => sum + Number(item.count || 0), 0) >= condition.count
    if (condition.type === 'variableEquals') return context.variables[condition.name] === condition.value
    return false
  }

  guard(context) {
    if (context.cancelled) throw new Error('Automation cancelled.')
    context.steps += 1
    if (context.steps > MAX_MACRO_STEPS) throw new Error('Automation exceeded the beta step limit.')
    if (Date.now() - context.startedAt > MAX_MACRO_RUNTIME_MS) throw new Error('Automation exceeded the beta runtime limit.')
  }

  cancelTimers(profileId) {
    for (const handle of this.timerHandles.get(profileId) || []) this.timers.clearInterval(handle)
    this.timerHandles.delete(profileId)
  }
}

function rotate(file, maxBytes) {
  if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return
  const previous = `${file}.1`
  if (fs.existsSync(previous)) fs.rmSync(previous)
  fs.renameSync(file, previous)
}

function redact(value, key = '') {
  if (/password|token|secret|authorization/i.test(key)) return '[redacted]'
  if (typeof value === 'string') return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]').slice(0, 4000)
  if (Array.isArray(value)) return value.slice(0, 512).map((entry) => redact(entry))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 512).map(([child, entry]) => [child, redact(entry, child)]))
  return value
}

function bounded(value, minimum, maximum, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(minimum, Math.min(number, maximum)) : fallback }
function integer(value, minimum, maximum, fallback) { return Math.round(bounded(value, minimum, maximum, fallback)) }
function primitive(value) { return ['string', 'number', 'boolean'].includes(typeof value) ? value : '' }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

module.exports = {
  AlertManager, MacroEngine, PersistentEventStore, SmartProxyManager,
  identityIdFor, normalizeAutomations, normalizeEdition, normalizeCondition
}
