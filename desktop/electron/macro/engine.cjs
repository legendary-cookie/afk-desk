'use strict'
// Macro engine v2 — stream C (engine + shared scheduler).
// Contract: electron/macro/contract.cjs ("Stream C — engine"). Design: docs/design/macro-engine.md §3, §6.
//
// Pure core: no Electron, Mineflayer or other stream imports. Timers, clock, randomness,
// the bot facade and the trigger matcher are all injected. Node 18.20.4 compatible.
//
// Additive constructor options beyond the contract (all optional):
//   timers            { setTimeout, clearTimeout } used by the default scheduler (default globalThis)
//   nextScheduleTime  (at: "HH:MM", fromMs) => epoch ms of the next fire strictly after fromMs.
//                     Stream E should pass triggers.cjs#nextScheduleTime (DST-aware). The default
//                     is a simple local-time implementation.
//   chatIntervalMs    number | (accountId) => number. Per-account chat spacing, default
//                     LIMITS.defaultChatIntervalMs, clamped to ≥ LIMITS.minChatIntervalMs.
// Additive RunEvent fields: reason, trigger. Additive RunRecord fields: accountId, reason, error,
// droppedSteps.

const { LIMITS, ENGINE_STEP_TYPES, FACADE_METHODS, ERROR_CODES, MacroActionError, assertFacade } = require('./contract.cjs')

const MAX_TIMEOUT_MS = 2147483647
const MAX_WAIT_MS = 86400000
const MIN_TIMER_INTERVAL_MS = 1000
const MAX_RECORDED_STEPS = LIMITS.maxStepsPerMacro
const DEFAULT_WHILE_ITERATIONS = 10000
const NON_STEP_FACADE_METHODS = new Set(['sessionId', 'state', 'releaseOwner'])
const FACADE_STEP_TYPES = new Set(FACADE_METHODS.filter((name) => !NON_STEP_FACADE_METHODS.has(name) && !ENGINE_STEP_TYPES.includes(name)))
// Steps that intentionally change the session; the run adopts the new session id instead of fencing.
const SESSION_CHANGING_STEPS = new Set(['disconnect', 'reconnect'])
const TIMED_TRIGGER_TYPES = new Set(['timer', 'schedule'])
const MATCHER_METHODS = ['setMacros', 'onEvent', 'timedTriggers', 'resetAccount']
const noop = () => {}

// ---------------------------------------------------------------------------
// Shared scheduler: a binary min-heap ordered by (time, insertion seq) with exactly one
// underlying timeout armed to the earliest entry.
// ---------------------------------------------------------------------------

function createScheduler({ timers = globalThis, now = Date.now, onError = noop } = {}) {
  const heap = []
  const keyed = new Map()
  let seq = 0
  let handle = null
  let armedAt = Infinity
  let firing = false
  let disposed = false

  const less = (a, b) => a.time < b.time || (a.time === b.time && a.seq < b.seq)
  function place(entry, index) { heap[index] = entry; entry.index = index }
  function siftUp(index) {
    const entry = heap[index]
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!less(entry, heap[parent])) break
      place(heap[parent], index)
      index = parent
    }
    place(entry, index)
  }
  function siftDown(index) {
    const entry = heap[index]
    const length = heap.length
    for (;;) {
      const left = 2 * index + 1
      if (left >= length) break
      const right = left + 1
      const child = right < length && less(heap[right], heap[left]) ? right : left
      if (!less(heap[child], entry)) break
      place(heap[child], index)
      index = child
    }
    place(entry, index)
  }
  function removeEntry(entry) {
    const index = entry.index
    entry.index = -1
    entry.done = true
    const last = heap.pop()
    if (last !== entry) {
      place(last, index)
      siftDown(index)
      siftUp(last.index)
    }
    if (entry.key !== undefined) {
      const set = keyed.get(entry.key)
      if (set) { set.delete(entry); if (!set.size) keyed.delete(entry.key) }
    }
  }
  function disarm() {
    if (handle !== null) timers.clearTimeout(handle)
    handle = null
    armedAt = Infinity
  }
  function arm() {
    if (disposed || firing) return
    if (!heap.length) { disarm(); return }
    const target = heap[0].time
    if (handle !== null && armedAt === target) return
    disarm()
    armedAt = target
    handle = timers.setTimeout(fire, Math.min(MAX_TIMEOUT_MS, Math.max(0, target - now())))
  }
  function fire() {
    handle = null
    armedAt = Infinity
    if (disposed) return
    firing = true
    try {
      const current = now()
      const lastSeq = seq
      // Entries added while firing (seq > lastSeq) wait for the next turn so a callback that
      // re-schedules itself at "now" cannot starve the event loop.
      while (heap.length && heap[0].time <= current && heap[0].seq <= lastSeq) {
        const entry = heap[0]
        removeEntry(entry)
        try { entry.fn() } catch (error) { try { onError(error) } catch (_) { /* ignore */ } }
      }
    } finally {
      firing = false
      arm()
    }
  }
  function at(timeMs, fn, key) {
    if (typeof fn !== 'function') throw new TypeError('scheduler.at requires a callback')
    if (disposed) return noop
    const time = Number.isFinite(Number(timeMs)) ? Number(timeMs) : now()
    const entry = { time, seq: ++seq, fn, key, index: -1, done: false }
    heap.push(entry)
    siftUp(heap.length - 1)
    if (key !== undefined) {
      let set = keyed.get(key)
      if (!set) { set = new Set(); keyed.set(key, set) }
      set.add(entry)
    }
    arm()
    return function cancel() {
      if (entry.done) return
      removeEntry(entry)
      arm()
    }
  }
  return {
    at,
    after(ms, fn, key) { return at(now() + Math.max(0, Number(ms) || 0), fn, key) },
    cancelKey(key) {
      const set = keyed.get(key)
      if (!set) return
      for (const entry of [...set]) if (!entry.done) removeEntry(entry)
      keyed.delete(key)
      arm()
    },
    size() { return heap.length },
    dispose() {
      disposed = true
      disarm()
      for (const entry of heap) { entry.done = true; entry.index = -1 }
      heap.length = 0
      keyed.clear()
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class RunEnd {
  constructor(status, reason, error) {
    this.status = status
    this.reason = reason
    if (error) this.error = error
  }
}

function abortError(message = 'Macro run was cancelled.') { return new MacroActionError(ERROR_CODES.ABORTED, message) }

function errorInfo(error) {
  const code = error && typeof error.code === 'string' && ERROR_CODES[error.code] ? error.code : ERROR_CODES.INVALID
  const message = String((error && error.message) || error || 'Unknown error').slice(0, 300)
  return { code, message }
}

function safe(fn, fallback) {
  try { return fn() } catch (_) { return fallback }
}

function list(value) { return Array.isArray(value) ? value : [] }

function finiteOr(value, fallback) {
  const number = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)) }

function stableStringify(value, depth = 0) {
  if (depth > 40) return '"[deep]"'
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
    if (typeof value === 'bigint') return JSON.stringify(String(value))
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== 'function').sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(',')}}`
}

const INTERPOLATION = /\{([A-Za-z0-9_]{1,64})\}/g
function interpolate(text, variables) {
  return String(text).replace(INTERPOLATION, (whole, name) => (
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : whole
  ))
}

function copyVariables(source) {
  const variables = Object.create(null)
  if (source && typeof source === 'object') {
    for (const key of Object.keys(source)) {
      const value = source[key]
      if (value === null || value === undefined || typeof value === 'object' || typeof value === 'function') continue
      variables[key] = value
    }
  }
  return variables
}

// Simple local-time "HH:MM" next-fire. Stream E should inject triggers.cjs#nextScheduleTime,
// which owns the DST rules from the design.
function localNextScheduleTime(at, fromMs) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at || ''))
  if (!match) return NaN
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59 || !Number.isFinite(fromMs)) return NaN
  const date = new Date(fromMs)
  date.setHours(hours, minutes, 0, 0)
  for (let attempt = 0; attempt < 3 && date.getTime() <= fromMs; attempt += 1) {
    date.setDate(date.getDate() + 1)
    date.setHours(hours, minutes, 0, 0)
  }
  return date.getTime() > fromMs ? date.getTime() : NaN
}

function copyRecord(record) {
  return { ...record, steps: record.steps.map((step) => ({ ...step, path: step.path.slice() })), ...(record.error ? { error: { ...record.error } } : {}) }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class MacroEngine {
  constructor({
    facade,
    matcher,
    scheduler,
    timers = globalThis,
    now = Date.now,
    emit = noop,
    getAccountState,
    resolveTargets = () => [],
    random = Math.random,
    nextScheduleTime = localNextScheduleTime,
    chatIntervalMs = LIMITS.defaultChatIntervalMs
  } = {}) {
    this.facade = assertFacade(facade)
    const missing = MATCHER_METHODS.filter((name) => typeof matcher?.[name] !== 'function')
    if (missing.length) throw new TypeError(`Macro trigger matcher is missing: ${missing.join(', ')}`)
    this.matcher = matcher
    this.now = now
    this.ownsScheduler = !scheduler
    this.scheduler = scheduler || createScheduler({ timers, now })
    this.emitFn = typeof emit === 'function' ? emit : noop
    this.getAccountState = typeof getAccountState === 'function' ? getAccountState : (accountId) => this.facade.state(accountId)
    this.resolveTargets = typeof resolveTargets === 'function' ? resolveTargets : () => []
    this.random = typeof random === 'function' ? random : Math.random
    this.nextScheduleTime = typeof nextScheduleTime === 'function' ? nextScheduleTime : localNextScheduleTime
    this.chatIntervalMs = chatIntervalMs

    this.macros = new Map() // macroId → { macro, hash }
    this.targets = new Map() // accountId → Set<macroId> (enabled macros only)
    this.sessions = new Map() // accountId → { sessionId, joined }
    this.timed = new Map() // accountId → Map<macroId, TimedEntry>
    this.runs = new Map() // accountId → RunContext
    this.pending = new Map() // accountId → PendingStart (starts after the current run settles)
    this.budgets = new Map() // accountId → { steps: number[], lastChatAt }
    this.logs = new Map() // macroId → RunRecord[]
    this.runCounter = 0
    this.closed = false
    this.shutdownPromise = null
  }

  // ----- public API --------------------------------------------------------

  setLibrary(macros) {
    if (this.closed) return
    const next = new Map()
    for (const macro of list(macros)) {
      if (!macro || typeof macro !== 'object' || typeof macro.id !== 'string' || !macro.id || next.has(macro.id)) continue
      next.set(macro.id, { macro, hash: stableStringify(macro) })
    }
    const changed = new Set()
    const affected = new Set()
    const mark = (id, entry) => {
      changed.add(id)
      for (const accountId of this._targetsOf(entry.macro)) affected.add(accountId)
    }
    for (const [id, old] of this.macros) {
      const entry = next.get(id)
      if (!entry || entry.hash !== old.hash) mark(id, old)
    }
    for (const [id, entry] of next) {
      const old = this.macros.get(id)
      if (!old || old.hash !== entry.hash) mark(id, entry)
    }

    // AFKCC behaviour: removing, disabling or editing a macro stops its running instances.
    for (const ctx of this.runs.values()) {
      if (!changed.has(ctx.macroId)) continue
      const entry = next.get(ctx.macroId)
      const reason = !entry ? 'removed' : entry.macro.enabled === false ? 'disabled' : 'edited'
      this._requestStop(ctx, 'cancelled', reason)
    }
    for (const id of this.macros.keys()) if (!next.has(id)) this.logs.delete(id)

    this.macros = next
    this.targets = new Map()
    for (const [id, entry] of next) {
      if (entry.macro.enabled === false) continue
      for (const accountId of this._targetsOf(entry.macro)) {
        let set = this.targets.get(accountId)
        if (!set) { set = new Set(); this.targets.set(accountId, set) }
        set.add(id)
      }
    }
    try {
      this.matcher.setMacros([...next.values()].map((entry) => entry.macro), (macro) => this._targetsOf(macro))
    } catch (error) {
      this._emitEngineError(null, error)
    }
    for (const accountId of affected) this._planTimed(accountId)
  }

  onBotEvent(event) {
    try {
      this._onBotEvent(event)
    } catch (error) {
      this._emitEngineError(event && typeof event.accountId === 'string' ? event.accountId : null, error)
    }
  }

  run(accountId, macroId, { trigger, variables } = {}) {
    if (this.closed) return Promise.reject(new MacroActionError(ERROR_CODES.INVALID, 'Macro engine is shut down.'))
    if (typeof accountId !== 'string' || !accountId) return Promise.reject(new MacroActionError(ERROR_CODES.INVALID, 'An account id is required.'))
    const entry = this.macros.get(macroId)
    if (!entry) return Promise.reject(new MacroActionError(ERROR_CODES.NOT_FOUND, 'Macro not found.'))
    if (entry.macro.enabled === false) return Promise.reject(new MacroActionError(ERROR_CODES.INVALID, 'Macro is disabled.'))
    return this._request(accountId, entry.macro, { triggerType: typeof trigger === 'string' && trigger ? trigger : 'manual', variables })
  }

  stop(accountId, reason = 'user') {
    this._dropPending(accountId, 'stopped')
    const ctx = this.runs.get(accountId)
    if (!ctx) return Promise.resolve()
    this._requestStop(ctx, 'cancelled', String(reason || 'user'))
    return ctx.done.then(noop)
  }

  stopMacro(macroId) {
    const waits = []
    for (const [accountId, pending] of [...this.pending]) if (pending.macroId === macroId) this._dropPending(accountId, 'stopped')
    for (const ctx of [...this.runs.values()]) {
      if (ctx.macroId !== macroId) continue
      this._requestStop(ctx, 'cancelled', 'user')
      waits.push(ctx.done)
    }
    return Promise.all(waits).then(noop)
  }

  isRunning(accountId) { return this.runs.has(accountId) || this.pending.has(accountId) }

  runLog(macroId) { return list(this.logs.get(macroId)).map(copyRecord) }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    for (const accountId of [...this.timed.keys()]) this._cancelTimed(accountId)
    for (const accountId of [...this.pending.keys()]) this._dropPending(accountId, 'shutdown')
    const waits = [...this.runs.values()].map((ctx) => {
      this._requestStop(ctx, 'cancelled', 'shutdown')
      return ctx.done
    })
    this.shutdownPromise = Promise.all(waits).then(() => {
      if (this.ownsScheduler) this.scheduler.dispose()
    })
    return this.shutdownPromise
  }

  // ----- events, sessions and timed triggers -------------------------------

  _onBotEvent(event) {
    if (this.closed || !event || typeof event !== 'object') return
    const { accountId, type } = event
    if (typeof accountId !== 'string' || !accountId || typeof type !== 'string') return
    const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null

    if (type === 'connected' || type === 'spawn') {
      let session = this.sessions.get(accountId)
      if (!session || session.sessionId !== sessionId) {
        this._cancelTimed(accountId)
        session = { sessionId, joined: false }
        this.sessions.set(accountId, session)
      }
      // The join is the first spawn of a session: the timer phase restarts here.
      if (type === 'spawn' && !session.joined) {
        session.joined = true
        this._planTimed(accountId)
      }
    } else if (type === 'disconnected') {
      const session = this.sessions.get(accountId)
      if (!session || !sessionId || session.sessionId === sessionId) {
        this.sessions.delete(accountId)
        this._cancelTimed(accountId)
      }
      const ctx = this.runs.get(accountId)
      if (ctx && ctx.sessionId && !ctx.changingSession && (!sessionId || ctx.sessionId === sessionId)) {
        this._requestStop(ctx, 'interrupted', 'disconnected')
      }
      try { this.matcher.resetAccount(accountId) } catch (error) { this._emitEngineError(accountId, error) }
    }

    if (!this.targets.has(accountId) && !this.runs.has(accountId)) return

    const ctx = this.runs.get(accountId)
    if (ctx && !ctx.stopRequest && type !== 'disconnected' && this._stopWhenMatches(ctx)) {
      this._requestStop(ctx, 'stopped', 'stopWhen')
    }

    let matches
    try {
      matches = this.matcher.onEvent(event)
    } catch (error) {
      this._emitEngineError(accountId, error)
      return
    }
    for (const match of list(matches)) {
      if (!match || typeof match !== 'object') continue
      const target = typeof match.accountId === 'string' && match.accountId ? match.accountId : accountId
      const entry = this.macros.get(match.macroId)
      if (!entry || entry.macro.enabled === false) continue
      this._request(target, entry.macro, {
        triggerType: typeof match.triggerType === 'string' && match.triggerType ? match.triggerType : type,
        variables: match.variables,
        reason: typeof match.reason === 'string' ? match.reason : undefined
      }).catch((error) => this._emitEngineError(target, error))
    }
  }

  _planTimed(accountId) {
    const existing = this.timed.get(accountId) || new Map()
    const session = this.sessions.get(accountId)
    if (this.closed || !session || !session.joined) {
      if (existing.size) this._cancelTimed(accountId)
      return
    }
    let entries = []
    try {
      entries = list(this.matcher.timedTriggers(accountId))
    } catch (error) {
      this._emitEngineError(accountId, error)
    }
    const wanted = new Map()
    for (const item of entries) {
      if (!item || typeof item.macroId !== 'string' || !item.trigger || !TIMED_TRIGGER_TYPES.has(item.trigger.type)) continue
      const entry = this.macros.get(item.macroId)
      if (!entry || entry.macro.enabled === false) continue
      wanted.set(item.macroId, { trigger: item.trigger, sig: stableStringify(item.trigger) })
    }
    for (const [macroId, timed] of existing) {
      const want = wanted.get(macroId)
      if (!want || want.sig !== timed.sig) { timed.cancel(); existing.delete(macroId) }
    }
    for (const [macroId, want] of wanted) {
      if (existing.has(macroId)) continue // unchanged trigger keeps its phase
      const timed = { trigger: want.trigger, sig: want.sig, sessionId: session.sessionId, base: null, cancel: noop }
      existing.set(macroId, timed)
      this._armTimed(accountId, macroId, timed)
    }
    if (existing.size) this.timed.set(accountId, existing)
    else this.timed.delete(accountId)
  }

  _armTimed(accountId, macroId, timed) {
    const now = this.now()
    let fireAt
    if (timed.trigger.type === 'timer') {
      const interval = finiteOr(timed.trigger.intervalMs, NaN)
      if (!(interval >= MIN_TIMER_INTERVAL_MS)) return
      if (timed.base === null) {
        timed.base = now + interval
      } else {
        timed.base += interval
        // Missed ticks (clock jump, long busy loop) are skipped, never replayed in a burst.
        if (timed.base <= now) timed.base += (Math.floor((now - timed.base) / interval) + 1) * interval
      }
      const jitter = clamp(finiteOr(timed.trigger.jitterMs, 0), 0, interval / 2)
      const unit = clamp(finiteOr(safe(() => this.random(), 0.5), 0.5), 0, 1)
      fireAt = Math.max(now, timed.base + Math.round((unit * 2 - 1) * jitter))
    } else {
      fireAt = finiteOr(safe(() => this.nextScheduleTime(timed.trigger.at, now), NaN), NaN)
      if (!(fireAt > now)) return
    }
    timed.cancel = this.scheduler.at(fireAt, () => this._fireTimed(accountId, macroId, timed), accountId)
  }

  _fireTimed(accountId, macroId, timed) {
    const map = this.timed.get(accountId)
    if (!map || map.get(macroId) !== timed || this.closed) return
    const session = this.sessions.get(accountId)
    if (!session || !session.joined || session.sessionId !== timed.sessionId) return
    this._armTimed(accountId, macroId, timed)
    const entry = this.macros.get(macroId)
    if (!entry || entry.macro.enabled === false) return
    // A tick while the account is busy is skipped, never queued.
    if (this.isRunning(accountId)) {
      this._emitSkipped(accountId, macroId, timed.trigger.type, 'busy')
      return
    }
    this._start(accountId, entry.macro, { triggerType: timed.trigger.type })
  }

  _cancelTimed(accountId) {
    this.scheduler.cancelKey(accountId)
    this.timed.delete(accountId)
  }

  // ----- run lifecycle -----------------------------------------------------

  _request(accountId, macro, trigger) {
    const current = this.runs.get(accountId)
    const pending = this.pending.get(accountId)
    if (!current && !pending) return this._start(accountId, macro, trigger)
    const override = macro.concurrency === 'override'
    const winding = !current || Boolean(current.stopRequest)
    // Busy with a live run, or a start is already queued: only 'override' may displace it.
    if ((!winding || pending) && !override) {
      return Promise.resolve(this._emitSkipped(accountId, macro.id, trigger.triggerType, 'busy'))
    }
    if (current && !current.stopRequest) this._requestStop(current, 'cancelled', 'override')
    this._dropPending(accountId, 'superseded')
    return new Promise((resolve) => {
      this.pending.set(accountId, { macroId: macro.id, trigger, resolve })
    })
  }

  _dropPending(accountId, reason) {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    pending.resolve(this._emitSkipped(accountId, pending.macroId, pending.trigger.triggerType, reason))
  }

  _drainPending(accountId) {
    const pending = this.pending.get(accountId)
    if (!pending || this.runs.has(accountId)) return
    this.pending.delete(accountId)
    const entry = this.macros.get(pending.macroId)
    if (this.closed || !entry || entry.macro.enabled === false) {
      pending.resolve(this._emitSkipped(accountId, pending.macroId, pending.trigger.triggerType, 'unavailable'))
      return
    }
    pending.resolve(this._start(accountId, entry.macro, pending.trigger))
  }

  _start(accountId, macro, trigger) {
    const runId = this._newRunId()
    const controller = new AbortController()
    const startedAt = this.now()
    const sessionId = safe(() => this.facade.sessionId(accountId), null)
    const ctx = {
      runId,
      macroId: macro.id,
      accountId,
      macro,
      owner: `macro:${runId}`,
      controller,
      signal: controller.signal,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      changingSession: false,
      variables: copyVariables(trigger.variables),
      stopRequest: null,
      facadeSteps: 0,
      maxRuntimeCancel: null,
      record: { runId, accountId, status: 'started', startedAt, endedAt: null, trigger: trigger.triggerType, steps: [], droppedSteps: 0 },
      done: null
    }
    this.runs.set(accountId, ctx)
    this._emit({ runId, macroId: macro.id, accountId, status: 'started', trigger: trigger.triggerType, ...(trigger.reason ? { reason: trigger.reason } : {}) })
    const maxRuntimeMs = finiteOr(macro.maxRuntimeMs, null)
    if (maxRuntimeMs !== null && maxRuntimeMs > 0) {
      ctx.maxRuntimeCancel = this.scheduler.after(maxRuntimeMs, () => this._requestStop(ctx, 'stopped', 'maxRuntime'))
    }
    ctx.done = this._execute(ctx).catch((error) => this._finish(ctx, { status: 'failed', reason: 'engineError', error: errorInfo(error) }))
    return ctx.done
  }

  async _execute(ctx) {
    let end
    try {
      await this._runSteps(ctx, list(ctx.macro.steps), [], 0)
      end = { status: 'completed' }
    } catch (error) {
      if (error instanceof RunEnd) end = error
      else if (ctx.signal.aborted || (error && error.code === ERROR_CODES.ABORTED)) end = { status: 'cancelled', reason: 'aborted' }
      else end = { status: 'failed', reason: 'engineError', error: errorInfo(error) }
    }
    // A requested stop (user, override, disconnect, stopWhen, maxRuntime, library change) wins.
    if (ctx.stopRequest) end = ctx.stopRequest
    return this._finish(ctx, end)
  }

  _finish(ctx, end) {
    if (ctx.finished) return ctx.finished
    if (ctx.maxRuntimeCancel) ctx.maxRuntimeCancel()
    if (!ctx.signal.aborted) ctx.controller.abort()
    try {
      this.facade.releaseOwner(ctx.accountId, ctx.owner)
    } catch (error) {
      this._emitEngineError(ctx.accountId, error)
    }
    const record = ctx.record
    record.status = end.status
    record.endedAt = this.now()
    if (end.reason) record.reason = end.reason
    if (end.error) record.error = { ...end.error }
    let ring = this.logs.get(ctx.macroId)
    if (!ring) { ring = []; if (this.macros.has(ctx.macroId)) this.logs.set(ctx.macroId, ring) }
    ring.push(record)
    while (ring.length > LIMITS.runLogRingSize) ring.shift()
    if (this.runs.get(ctx.accountId) === ctx) this.runs.delete(ctx.accountId)
    ctx.finished = { runId: ctx.runId, status: end.status }
    this._emit({
      runId: ctx.runId,
      macroId: ctx.macroId,
      accountId: ctx.accountId,
      status: end.status,
      ...(end.reason ? { reason: end.reason } : {}),
      ...(end.error ? { error: { ...end.error } } : {})
    })
    this._drainPending(ctx.accountId)
    return ctx.finished
  }

  _requestStop(ctx, status, reason) {
    if (ctx.stopRequest || ctx.finished) return
    ctx.stopRequest = { status, reason }
    ctx.controller.abort()
  }

  // ----- step execution ----------------------------------------------------

  async _runSteps(ctx, steps, path, depth) {
    if (depth > LIMITS.maxNestingDepth + 1) {
      throw new RunEnd('failed', 'nesting', { code: ERROR_CODES.INVALID, message: 'Steps are nested too deeply.' })
    }
    for (let index = 0; index < steps.length; index += 1) {
      this._throwIfAborted(ctx)
      const step = steps[index]
      const stepPath = path.concat(index)
      const type = step && typeof step === 'object' && typeof step.type === 'string' ? step.type : ''
      if (type === 'wait') await this._stepWait(ctx, step, stepPath)
      else if (type === 'set') await this._stepSet(ctx, step, stepPath)
      else if (type === 'stop') await this._stepStop(ctx, stepPath)
      else if (type === 'if') await this._stepIf(ctx, step, stepPath, depth)
      else if (type === 'repeat') await this._stepRepeat(ctx, step, stepPath, depth)
      else await this._stepFacade(ctx, step, type, stepPath)
    }
  }

  async _gate(ctx, stepPath, type) {
    await this._acquireStep(ctx)
    this._throwIfAborted(ctx)
    if (this._stopWhenMatches(ctx)) {
      this._requestStop(ctx, 'stopped', 'stopWhen')
      throw new RunEnd('stopped', 'stopWhen')
    }
    this._emit({ runId: ctx.runId, macroId: ctx.macroId, accountId: ctx.accountId, status: 'step', stepPath: stepPath.slice(), stepType: type })
  }

  async _stepWait(ctx, step, stepPath) {
    await this._gate(ctx, stepPath, 'wait')
    let ms
    if (step.minMs !== undefined || step.maxMs !== undefined) {
      const min = clamp(finiteOr(step.minMs, 0), 0, MAX_WAIT_MS)
      const max = clamp(finiteOr(step.maxMs, min), min, MAX_WAIT_MS)
      ms = min + this._unit() * (max - min)
    } else {
      const base = clamp(finiteOr(step.ms, 0), 0, MAX_WAIT_MS)
      const jitter = clamp(finiteOr(step.jitterMs, 0), 0, MAX_WAIT_MS)
      ms = Math.max(0, base + (this._unit() * 2 - 1) * jitter)
    }
    const startedAt = this.now()
    await this._sleep(ctx, Math.round(ms))
    this._record(ctx, stepPath, 'wait', true, this.now() - startedAt)
  }

  async _stepSet(ctx, step, stepPath) {
    await this._gate(ctx, stepPath, 'set')
    if (typeof step.variable === 'string' && step.variable) {
      const value = step.value
      ctx.variables[step.variable] = value === null || value === undefined || typeof value === 'object' ? '' : value
    }
    this._record(ctx, stepPath, 'set', true, 0)
  }

  async _stepStop(ctx, stepPath) {
    await this._gate(ctx, stepPath, 'stop')
    this._record(ctx, stepPath, 'stop', true, 0)
    throw new RunEnd('stopped', 'stopStep')
  }

  async _stepIf(ctx, step, stepPath, depth) {
    await this._gate(ctx, stepPath, 'if')
    const branch = this._evaluate(ctx, step.condition, 0) ? 0 : 1
    await this._runSteps(ctx, list(branch === 0 ? step.then : step.else), stepPath.concat(branch), depth + 1)
  }

  async _stepRepeat(ctx, step, stepPath, depth) {
    await this._gate(ctx, stepPath, 'repeat')
    const body = list(step.steps)
    const loopWhile = step.while && typeof step.while === 'object' ? step.while : null
    const limit = loopWhile
      ? Math.floor(clamp(finiteOr(step.maxIterations, DEFAULT_WHILE_ITERATIONS), 0, Number.MAX_SAFE_INTEGER))
      : Math.floor(clamp(finiteOr(step.times, 0), 0, Number.MAX_SAFE_INTEGER))
    for (let iteration = 0; iteration < limit; iteration += 1) {
      this._throwIfAborted(ctx)
      if (loopWhile && !this._evaluate(ctx, loopWhile, 0)) break
      const startedAt = this.now()
      await this._runSteps(ctx, body, stepPath, depth + 1)
      // Every iteration takes at least one game tick, so a loop without waits cannot spin.
      const elapsed = this.now() - startedAt
      if (elapsed < LIMITS.minLoopYieldMs) await this._sleep(ctx, LIMITS.minLoopYieldMs - elapsed)
    }
  }

  async _stepFacade(ctx, step, type, stepPath) {
    if (!FACADE_STEP_TYPES.has(type)) {
      await this._gate(ctx, stepPath, type || 'unknown')
      const info = { code: ERROR_CODES.UNSUPPORTED, message: `Unsupported step type "${String(type).slice(0, 40)}".` }
      this._record(ctx, stepPath, type || 'unknown', false, 0, info)
      this._stepFailed(ctx, stepPath, type || 'unknown', info)
      return
    }
    if (ctx.facadeSteps > 0) {
      const delay = clamp(finiteOr(ctx.macro.defaultDelayMs, LIMITS.defaultDelayMs), 0, MAX_WAIT_MS)
      if (delay > 0) await this._sleep(ctx, delay)
    }
    if (type === 'chat') await this._acquireChat(ctx)
    await this._gate(ctx, stepPath, type)
    this._checkFence(ctx)
    if (type === 'chat') this._budget(ctx.accountId).lastChatAt = this.now()

    const args = this._stepArgs(ctx, step, type)
    const opCtx = { signal: ctx.signal, owner: ctx.owner, sessionId: ctx.sessionId }
    const startedAt = this.now()
    const changing = SESSION_CHANGING_STEPS.has(type)
    let failure = null
    if (changing) ctx.changingSession = true
    try {
      await this._awaitOp(ctx, () => this.facade[type](ctx.accountId, args, opCtx))
    } catch (error) {
      const info = errorInfo(error)
      if (ctx.signal.aborted || info.code === ERROR_CODES.ABORTED) {
        this._record(ctx, stepPath, type, false, this.now() - startedAt, info)
        throw error
      }
      if (info.code === ERROR_CODES.SESSION_CHANGED) {
        this._record(ctx, stepPath, type, false, this.now() - startedAt, info)
        throw new RunEnd('interrupted', 'sessionChanged', info)
      }
      failure = info
    } finally {
      if (changing) ctx.changingSession = false
    }
    ctx.facadeSteps += 1
    const elapsed = this.now() - startedAt
    if (changing) {
      // disconnect/reconnect change the session on purpose: adopt the new identity.
      const live = safe(() => this.facade.sessionId(ctx.accountId), null)
      ctx.sessionId = typeof live === 'string' && live ? live : null
    } else if (!this._sessionMatches(ctx)) {
      this._record(ctx, stepPath, type, false, elapsed, failure || { code: ERROR_CODES.SESSION_CHANGED, message: 'Session changed.' })
      throw new RunEnd('interrupted', 'sessionChanged', { code: ERROR_CODES.SESSION_CHANGED, message: 'The account session changed during the step.' })
    }
    this._record(ctx, stepPath, type, !failure, elapsed, failure)
    if (failure) this._stepFailed(ctx, stepPath, type, failure)
  }

  _stepFailed(ctx, stepPath, type, info) {
    this._emit({ runId: ctx.runId, macroId: ctx.macroId, accountId: ctx.accountId, status: 'stepFailed', stepPath: stepPath.slice(), stepType: type, error: { ...info } })
    if (ctx.macro.onError === 'stop') throw new RunEnd('failed', 'stepFailed', info)
  }

  _stepArgs(ctx, step, type) {
    const args = {}
    for (const key of Object.keys(step)) if (key !== 'type') args[key] = step[key]
    if ((type === 'chat' || type === 'notify') && args.message !== undefined) args.message = interpolate(args.message, ctx.variables)
    if (type === 'notify') args.macroId = ctx.macroId
    return args
  }

  // Awaits an in-flight facade operation. After an abort it is given cancelGraceMs to settle;
  // past that the run moves on and the operation's late result is ignored (fenced).
  _awaitOp(ctx, invoke) {
    return new Promise((resolve, reject) => {
      const { signal } = ctx
      let settled = false
      let cancelGrace = null
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (cancelGrace) cancelGrace()
        settle(value)
      }
      const onAbort = () => {
        if (settled || cancelGrace) return
        cancelGrace = this.scheduler.after(LIMITS.cancelGraceMs, () => {
          ctx.fenced = true
          finish(reject, abortError('The in-flight step did not settle within the cancel grace period.'))
        })
      }
      let operation
      try {
        operation = Promise.resolve(invoke())
      } catch (error) {
        operation = Promise.reject(error)
      }
      operation.then((value) => finish(resolve, value), (error) => finish(reject, error))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    })
  }

  _sleep(ctx, ms) {
    if (ctx.signal.aborted) return Promise.reject(abortError())
    if (!(ms > 0)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let cancel = noop
      const onAbort = () => { cancel(); reject(abortError()) }
      cancel = this.scheduler.after(ms, () => {
        ctx.signal.removeEventListener('abort', onAbort)
        resolve()
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ----- budgets -----------------------------------------------------------

  _budget(accountId) {
    let budget = this.budgets.get(accountId)
    if (!budget) { budget = { steps: [], lastChatAt: -Infinity }; this.budgets.set(accountId, budget) }
    return budget
  }

  async _acquireStep(ctx) {
    const budget = this._budget(ctx.accountId)
    for (;;) {
      const now = this.now()
      while (budget.steps.length && budget.steps[0] <= now - 1000) budget.steps.shift()
      if (budget.steps.length < LIMITS.maxStepsPerSecond) {
        budget.steps.push(now)
        return
      }
      await this._sleep(ctx, budget.steps[0] + 1000 - now)
    }
  }

  async _acquireChat(ctx) {
    const budget = this._budget(ctx.accountId)
    const configured = typeof this.chatIntervalMs === 'function'
      ? safe(() => this.chatIntervalMs(ctx.accountId), LIMITS.defaultChatIntervalMs)
      : this.chatIntervalMs
    const interval = Math.max(LIMITS.minChatIntervalMs, finiteOr(configured, LIMITS.defaultChatIntervalMs))
    for (;;) {
      const wait = budget.lastChatAt + interval - this.now()
      if (!(wait > 0)) return
      await this._sleep(ctx, wait)
    }
  }

  // ----- conditions, fences ------------------------------------------------

  _state(accountId) {
    const state = safe(() => this.getAccountState(accountId), null)
    return state && typeof state === 'object' ? state : {}
  }

  _evaluate(ctx, condition, depth) {
    if (!condition || typeof condition !== 'object' || depth > LIMITS.maxNestingDepth) return false
    const flag = (value) => Boolean(value) === (condition.value !== false)
    switch (condition.type) {
      case 'always': return true
      case 'online': return flag(this._state(ctx.accountId).online)
      case 'healthBelow': {
        const health = this._state(ctx.accountId).health
        return typeof health === 'number' && Number.isFinite(health) && health < finiteOr(condition.value, -Infinity)
      }
      case 'hungerBelow': {
        const food = this._state(ctx.accountId).food
        return typeof food === 'number' && Number.isFinite(food) && food < finiteOr(condition.value, -Infinity)
      }
      case 'hasItem': {
        const name = String(condition.name || '').toLowerCase()
        if (!name) return false
        const needed = finiteOr(condition.count, 1)
        let total = 0
        for (const item of list(this._state(ctx.accountId).inventory)) {
          if (item && String(item.name || '').toLowerCase().includes(name)) total += finiteOr(item.count, 0)
        }
        return total >= needed
      }
      case 'inventoryFull': return flag(this._state(ctx.accountId).inventoryFull)
      case 'windowOpen': return flag(this._state(ctx.accountId).windowOpen)
      case 'variableEquals': {
        const name = String(condition.name || '')
        return Boolean(name) && Object.prototype.hasOwnProperty.call(ctx.variables, name) && String(ctx.variables[name]) === String(condition.value)
      }
      case 'not': {
        const inner = condition.condition
        if (!inner || typeof inner !== 'object') return false
        return !this._evaluate(ctx, inner, depth + 1)
      }
      default: return false
    }
  }

  _stopWhenMatches(ctx) {
    try {
      return list(ctx.macro.stopWhen).some((condition) => this._evaluate(ctx, condition, 0))
    } catch (_) {
      return false
    }
  }

  _sessionMatches(ctx) {
    const live = safe(() => this.facade.sessionId(ctx.accountId), null)
    return (typeof live === 'string' && live ? live : null) === ctx.sessionId
  }

  _checkFence(ctx) {
    if (!this._sessionMatches(ctx)) {
      throw new RunEnd('interrupted', 'sessionChanged', { code: ERROR_CODES.SESSION_CHANGED, message: 'The account session changed.' })
    }
  }

  _throwIfAborted(ctx) {
    if (ctx.signal.aborted) throw abortError()
  }

  // ----- bookkeeping -------------------------------------------------------

  _record(ctx, path, type, ok, ms, error) {
    const steps = ctx.record.steps
    steps.push({ path: path.slice(), type, ok, ms: Math.max(0, ms), ...(error ? { error: `${error.code}: ${error.message}` } : {}) })
    if (steps.length > MAX_RECORDED_STEPS) { steps.shift(); ctx.record.droppedSteps += 1 }
  }

  _targetsOf(macro) {
    const targets = safe(() => this.resolveTargets(macro), [])
    return list(targets).filter((id) => typeof id === 'string' && id)
  }

  _unit() {
    return clamp(finiteOr(safe(() => this.random(), 0.5), 0.5), 0, 1)
  }

  _newRunId() {
    this.runCounter += 1
    return `run-${this.now().toString(36)}-${this.runCounter.toString(36)}`
  }

  _emit(event) {
    try { this.emitFn({ ...event, at: this.now() }) } catch (_) { /* a listener must not break the engine */ }
  }

  _emitSkipped(accountId, macroId, triggerType, reason) {
    const runId = this._newRunId()
    this._emit({ runId, macroId, accountId, status: 'skipped', trigger: triggerType, reason })
    return { runId, status: 'skipped' }
  }

  _emitEngineError(accountId, error) {
    this._emit({ runId: null, macroId: null, accountId, status: 'failed', reason: 'engineError', error: errorInfo(error) })
  }
}

module.exports = { MacroEngine, createScheduler }
