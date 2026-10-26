'use strict'
// Macro engine v2 - Stream B: trigger matcher.
// Contract: electron/macro/contract.cjs ("Stream B"). Design: docs/design/macro-engine.md s3, s5.
//
// Pure and portable (Node 18, CommonJS). No Electron, Mineflayer, timers or I/O.
//
// Normative decisions made here (the contract leaves them open):
//  * Time comes only from the injected `now()`. `event.at` is not trusted or used.
//  * Windows are half-open: a window of W ms that starts at t covers [t, t + W).
//    An event exactly W ms later is outside the window.
//  * worldChange debounce is LEADING-EDGE: the first qualifying change fires, further
//    changes inside LIMITS.worldChangeDebounceMs are suppressed (the last-seen
//    dimension/world/backend are still tracked, so the next change is compared to the
//    newest value). There are no timers here, so a trailing emit is impossible.
//  * join fires once per sessionId. In addition a join is dropped when another join was
//    recorded for the same account less than LIMITS.joinDuplicateWindowMs ago, even if the
//    sessionId changed (guards against double 'connected' bursts). resetAccount() clears
//    that memory.
//  * Cooldown is kept per (macro, account) and survives resetAccount()/new sessions, so a
//    reconnect loop cannot bypass it. Edge state is consumed when a trigger fires even if
//    the cooldown then suppresses the match.
//  * Edge triggers (healthBelow, hungerBelow, inventoryFull) start ARMED, so the first
//    telemetry of a session that is already low/full fires. inventoryChanged does not fire
//    on the first telemetry (it only records the baseline).
//  * Glob: `*` may match empty text; a `{name}` capture must match at least one character.
//    Both match the shortest text that lets the rest of the pattern match.

const { LIMITS, TRIGGER_TYPES, MacroActionError } = require('./contract.cjs')

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/
const MAX_CAPTURES = 8
const ALL_SOURCES = Object.freeze(['chat', 'system', 'actionBar'])
const MAX_TRACKED_SENT = 16
const MAX_FIELD_LENGTH = 256

function invalid(message) {
  return new MacroActionError('INVALID', message)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// Define a data property even for names like `__proto__`.
function setVar(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true })
}

// ---------------------------------------------------------------------------
// Case folding that never changes string length, so indices computed on the folded
// text are valid on the original (captures are sliced from the original text).
// ---------------------------------------------------------------------------

function fold(text) {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const l = ch.toLowerCase()
    out += l.length === 1 ? l : ch
  }
  return out
}

// ---------------------------------------------------------------------------
// KMP substring search. Guaranteed O(text + literal); we do not depend on the engine's
// indexOf worst case.
// ---------------------------------------------------------------------------

function failureTable(lit) {
  const fail = new Int32Array(lit.length)
  let k = 0
  for (let i = 1; i < lit.length; i += 1) {
    while (k > 0 && lit.charCodeAt(i) !== lit.charCodeAt(k)) k = fail[k - 1]
    if (lit.charCodeAt(i) === lit.charCodeAt(k)) k += 1
    fail[i] = k
  }
  return fail
}

// First start index >= from where lit occurs in text, or -1.
function kmpFind(text, from, lit, fail) {
  const n = text.length
  const m = lit.length
  let k = 0
  for (let i = from; i < n; i += 1) {
    const c = text.charCodeAt(i)
    while (k > 0 && c !== lit.charCodeAt(k)) k = fail[k - 1]
    if (c === lit.charCodeAt(k)) k += 1
    if (k === m) return i - m + 1
  }
  return -1
}

// ---------------------------------------------------------------------------
// compileChatPattern
// ---------------------------------------------------------------------------

function parseGlob(pattern) {
  const tokens = []
  const names = new Set()
  let literal = ''
  let captures = 0
  const flushLiteral = () => {
    if (literal) {
      const folded = fold(literal)
      tokens.push({ wc: false, lit: folded, fail: failureTable(folded) })
      literal = ''
    }
  }
  const pushWildcard = (name) => {
    flushLiteral()
    const last = tokens[tokens.length - 1]
    if (last && last.wc) throw invalid('Pattern has two adjacent wildcards; put literal text between them')
    tokens.push({ wc: true, name, minLen: name ? 1 : 0 })
  }
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      pushWildcard(null)
      i += 1
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i + 1)
      if (close < 0) throw invalid('Pattern has an unclosed "{"')
      const name = pattern.slice(i + 1, close)
      if (!NAME_RE.test(name)) throw invalid(`Invalid capture name "${name.slice(0, 40)}"`)
      if (names.has(name)) throw invalid(`Duplicate capture name "${name}"`)
      captures += 1
      if (captures > MAX_CAPTURES) throw invalid(`Pattern has more than ${MAX_CAPTURES} captures`)
      names.add(name)
      pushWildcard(name)
      i = close + 1
    } else {
      literal += ch
      i += 1
    }
  }
  flushLiteral()
  return tokens
}

/**
 * @param {string} pattern
 * @param {'contains'|'glob'} mode
 * @returns {{ test(text: string): null|Object<string,string>, testFolded(text: string, folded: string): null|Object<string,string> }}
 *   `testFolded` is an optimisation used by TriggerMatcher: `folded` must be fold(text).
 */
function compileChatPattern(pattern, mode) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw invalid('Pattern must be a non-empty string')
  if (pattern.length > LIMITS.maxPatternLength) {
    throw invalid(`Pattern is longer than ${LIMITS.maxPatternLength} characters`)
  }
  if (mode !== 'contains' && mode !== 'glob') throw invalid('Match mode must be "contains" or "glob"')

  if (mode === 'contains') {
    const lit = fold(pattern)
    const fail = failureTable(lit)
    const testFolded = (_text, folded) => (kmpFind(folded, 0, lit, fail) >= 0 ? {} : null)
    return {
      test: (text) => (typeof text === 'string' ? testFolded(text, fold(text)) : null),
      testFolded
    }
  }

  const tokens = parseGlob(pattern)
  const lastIndex = tokens.length - 1

  const testFolded = (text, t) => {
    const n = t.length
    const captures = {}
    let pos = 0
    let pending = null // wildcard token waiting for the next literal (or the end)
    let wcStart = 0
    for (let idx = 0; idx <= lastIndex; idx += 1) {
      const tok = tokens[idx]
      if (tok.wc) {
        pending = tok
        wcStart = pos
        continue
      }
      const minStart = pos + (pending ? pending.minLen : 0)
      const lit = tok.lit
      let start
      if (idx === 0) {
        // Anchored at the start of the text.
        if (!t.startsWith(lit, 0)) return null
        start = 0
        if (idx === lastIndex && n !== lit.length) return null
      } else if (idx === lastIndex) {
        // Anchored at the end of the text.
        start = n - lit.length
        if (start < minStart || !t.startsWith(lit, start)) return null
      } else {
        start = kmpFind(t, minStart, lit, tok.fail)
        if (start < 0) return null
      }
      if (pending && pending.name) setVar(captures, pending.name, text.slice(wcStart, start))
      pending = null
      pos = start + lit.length
    }
    if (pending) {
      if (n - pos < pending.minLen) return null
      if (pending.name) setVar(captures, pending.name, text.slice(pos))
    }
    return captures
  }

  return {
    test: (text) => (typeof text === 'string' ? testFolded(text, fold(text)) : null),
    testFolded
  }
}

// ---------------------------------------------------------------------------
// nextScheduleTime
// ---------------------------------------------------------------------------

const DAY_MS = 86400000
const AT_RE = /^(\d{1,2}):(\d{2})$/

const defaultOffsetMinutesAt = (ms) => -new Date(ms).getTimezoneOffset()

function offsetAdapter(tz) {
  if (tz === undefined || tz === null || tz === 'local') return defaultOffsetMinutesAt
  if (typeof tz === 'object' && typeof tz.tzOffsetMinutesAt === 'function') return tz.tzOffsetMinutesAt
  throw invalid('tz must be "local" or { tzOffsetMinutesAt(ms) }')
}

// All UTC instants whose local wall clock reads `wallMs` (wallMs is the wall time encoded as
// if it were UTC). Returns the earliest valid instant; if the wall time is skipped (spring
// forward) returns the instant the clock jumps over it (the first valid minute after the gap).
function wallToInstant(wallMs, offsetAt) {
  const before = offsetAt(wallMs - DAY_MS)
  const after = offsetAt(wallMs + DAY_MS)
  let best = null
  const candidates = before === after ? [before] : [before, after]
  for (const offset of candidates) {
    const instant = wallMs - offset * 60000
    if (offsetAt(instant) === offset && (best === null || instant < best)) best = instant
  }
  if (best !== null) return best
  // Gap. In a real spring-forward `after > before`, so wallMs - after < wallMs - before.
  let lo = wallMs - Math.max(before, after) * 60000
  let hi = wallMs - Math.min(before, after) * 60000
  const target = offsetAt(hi)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (offsetAt(mid) === target) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Next fire of a daily "HH:MM" local wall-clock schedule, strictly after fromMs.
 * Third argument (superset of the contract's `'local'`): `{ tzOffsetMinutesAt(ms) }` returns
 * the zone's offset from UTC in minutes, EAST positive (UTC+1 -> 60), at UTC instant `ms`.
 * It exists so DST rules can be tested without depending on the machine zone; the default is
 * `-new Date(ms).getTimezoneOffset()`.
 *   - Nonexistent local time (spring forward): fires when the clock jumps, i.e. the first
 *     valid minute after the gap.
 *   - Repeated local time (fall back): only the first occurrence ever fires.
 */
function nextScheduleTime(at, fromMs, tz) {
  const m = typeof at === 'string' ? AT_RE.exec(at) : null
  if (!m) throw invalid('Schedule time must be "HH:MM"')
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw invalid('Schedule time must be "HH:MM"')
  if (typeof fromMs !== 'number' || !Number.isFinite(fromMs)) throw invalid('fromMs must be a finite number')
  const offsetAt = offsetAdapter(tz)

  const local = new Date(fromMs + offsetAt(fromMs) * 60000)
  const y = local.getUTCFullYear()
  const mo = local.getUTCMonth()
  const d = local.getUTCDate()
  for (let k = 0; k < 4; k += 1) {
    const instant = wallToInstant(Date.UTC(y, mo, d + k, hour, minute), offsetAt)
    if (instant > fromMs) return instant
  }
  throw invalid('Could not compute the next schedule time')
}

// ---------------------------------------------------------------------------
// TriggerMatcher
// ---------------------------------------------------------------------------

function newAccountState() {
  return {
    sessionId: '',
    joined: false,
    lastJoinAt: null,
    world: { dimension: undefined, world: undefined, backend: undefined },
    worldSuppressUntil: -Infinity,
    edges: new Map(), // macroId -> armed (boolean)
    invSig: undefined,
    sent: [] // [{ text, at }]
  }
}

function resetSessionState(state) {
  state.joined = false
  state.world = { dimension: undefined, world: undefined, backend: undefined }
  state.worldSuppressUntil = -Infinity
  state.edges = new Map()
  state.invSig = undefined
  state.sent = []
}

function str(value) {
  if (value === undefined || value === null) return ''
  return String(value).slice(0, MAX_FIELD_LENGTH)
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

class TriggerMatcher {
  /** @param {{ now?: () => number }} [options] */
  constructor(options) {
    const now = options && options.now
    this._now = typeof now === 'function' ? now : Date.now
    this._index = new Map() // accountId -> Map(triggerType -> entry[])
    this._timed = new Map() // accountId -> { macroId, trigger }[]
    this._state = new Map() // accountId -> per-session state
    this._cooldowns = new Map() // `${macroId}\0${accountId}` -> last match time
    this._rejected = []
  }

  /**
   * Rebuild the index (O(macros x targets)). Only enabled macros are indexed. Macros whose
   * trigger cannot be compiled (e.g. bad chat pattern) are skipped, never thrown on; see
   * rejectedMacros().
   * @param {object[]} macros normalized Macro objects
   * @param {(macro: object) => string[]} resolveTargets
   */
  setMacros(macros, resolveTargets) {
    const index = new Map()
    const timed = new Map()
    const live = new Set()
    const rejected = []
    const list = Array.isArray(macros) ? macros : []
    for (const macro of list) {
      try {
        if (!isObject(macro) || macro.enabled !== true || typeof macro.id !== 'string') continue
        const trigger = macro.trigger
        if (!isObject(trigger) || typeof trigger.type !== 'string' || !hasOwn(TRIGGER_TYPES, trigger.type)) continue
        if (trigger.type === 'manual') continue
        const accounts = this._targets(macro, resolveTargets)
        if (accounts.length === 0) continue
        live.add(macro.id)
        if (trigger.type === 'timer' || trigger.type === 'schedule') {
          const item = { macroId: macro.id, trigger }
          for (const accountId of accounts) {
            if (!timed.has(accountId)) timed.set(accountId, [])
            timed.get(accountId).push(item)
          }
          continue
        }
        const entry = this._compileEntry(macro, trigger)
        for (const accountId of accounts) {
          let byType = index.get(accountId)
          if (!byType) {
            byType = new Map()
            index.set(accountId, byType)
          }
          let bucket = byType.get(trigger.type)
          if (!bucket) {
            bucket = []
            byType.set(trigger.type, bucket)
          }
          bucket.push(entry)
        }
      } catch (error) {
        rejected.push({ macroId: isObject(macro) ? macro.id : undefined, message: error && error.message })
      }
    }
    this._index = index
    this._timed = timed
    this._rejected = rejected
    for (const key of Array.from(this._cooldowns.keys())) {
      if (!live.has(key.slice(0, key.indexOf('\0')))) this._cooldowns.delete(key)
    }
    for (const state of this._state.values()) {
      for (const id of Array.from(state.edges.keys())) {
        if (!live.has(id)) state.edges.delete(id)
      }
    }
  }

  /** Macros skipped by the last setMacros(): [{ macroId, message }]. */
  rejectedMacros() {
    return this._rejected.slice()
  }

  /** @returns {{ macroId: string, trigger: object }[]} timer + schedule entries for the account */
  timedTriggers(accountId) {
    const list = this._timed.get(accountId)
    return list ? list.slice() : []
  }

  /** Clear edge, debounce, join and own-message state (call on disconnect). Cooldowns persist. */
  resetAccount(accountId) {
    this._state.delete(accountId)
  }

  /**
   * @param {object} event BotEvent
   * @returns {{ macroId: string, accountId: string, triggerType: string, variables: Object<string,string>, reason?: string }[]}
   */
  onEvent(event) {
    try {
      return this._onEvent(event)
    } catch (_error) {
      return []
    }
  }

  // -- internals ------------------------------------------------------------

  _targets(macro, resolveTargets) {
    let raw
    if (typeof resolveTargets === 'function') raw = resolveTargets(macro)
    else raw = macro.targets && macro.targets.mode === 'accounts' ? macro.targets.accountIds : []
    if (!Array.isArray(raw)) return []
    const seen = new Set()
    for (const id of raw) if (typeof id === 'string' && id) seen.add(id)
    return Array.from(seen)
  }

  _compileEntry(macro, trigger) {
    const entry = {
      macroId: macro.id,
      type: trigger.type,
      cooldownMs: typeof trigger.cooldownMs === 'number' && trigger.cooldownMs > 0 ? trigger.cooldownMs : 0
    }
    if (trigger.type === 'chat') {
      entry.pattern = compileChatPattern(trigger.pattern, trigger.match === 'glob' ? 'glob' : 'contains')
      const sources = Array.isArray(trigger.sources) ? trigger.sources.filter((s) => ALL_SOURCES.includes(s)) : []
      entry.sources = new Set(sources.length ? sources : ALL_SOURCES)
    } else if (trigger.type === 'healthBelow' || trigger.type === 'hungerBelow') {
      if (typeof trigger.below !== 'number' || !Number.isFinite(trigger.below)) {
        throw invalid(`${trigger.type} needs a numeric "below"`)
      }
      entry.below = trigger.below
      entry.hysteresis = trigger.type === 'healthBelow' ? LIMITS.healthHysteresis : LIMITS.hungerHysteresis
    } else if (trigger.type === 'windowOpen') {
      entry.title = typeof trigger.title === 'string' && trigger.title ? fold(trigger.title) : ''
    }
    return entry
  }

  _stateFor(accountId, sessionId) {
    let state = this._state.get(accountId)
    if (!state) {
      state = newAccountState()
      this._state.set(accountId, state)
    }
    if (sessionId && sessionId !== state.sessionId) {
      resetSessionState(state)
      state.sessionId = sessionId
    }
    return state
  }

  _bucket(accountId, type) {
    const byType = this._index.get(accountId)
    return (byType && byType.get(type)) || null
  }

  _push(out, entry, accountId, now, variables, reason) {
    if (entry.cooldownMs > 0) {
      const key = `${entry.macroId}\0${accountId}`
      const last = this._cooldowns.get(key)
      if (last !== undefined && now - last < entry.cooldownMs) return
      this._cooldowns.set(key, now)
    }
    const match = { macroId: entry.macroId, accountId, triggerType: entry.type, variables }
    if (reason !== undefined) match.reason = reason
    out.push(match)
  }

  _onEvent(event) {
    if (!isObject(event) || typeof event.type !== 'string') return []
    const accountId = event.accountId
    if (typeof accountId !== 'string' || !accountId) return []
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
    const state = this._stateFor(accountId, sessionId)
    const payload = isObject(event.payload) ? event.payload : null
    const now = this._now()
    const out = []

    switch (event.type) {
      case 'spawn': {
        if (state.joined) return out
        state.joined = true
        if (state.lastJoinAt !== null && now - state.lastJoinAt < LIMITS.joinDuplicateWindowMs) return out
        state.lastJoinAt = now
        for (const entry of this._bucket(accountId, 'join') || []) this._push(out, entry, accountId, now, {})
        return out
      }
      case 'respawn':
      case 'login':
      case 'serverSwitch':
        return this._world(event.type, accountId, state, payload, now, out)
      case 'chat':
        return this._chat(accountId, state, payload, now, out)
      case 'sentChat': {
        if (payload && typeof payload.text === 'string') {
          state.sent.push({ text: payload.text, at: now })
          if (state.sent.length > MAX_TRACKED_SENT) state.sent.shift()
        }
        return out
      }
      case 'telemetry':
        return payload ? this._telemetry(accountId, state, payload, now, out) : out
      case 'death':
        for (const entry of this._bucket(accountId, 'death') || []) this._push(out, entry, accountId, now, {})
        return out
      case 'disconnected': {
        const reason = payload ? str(payload.reason) : ''
        const manual = payload && payload.manual === true ? 'true' : 'false'
        for (const entry of this._bucket(accountId, 'disconnected') || []) {
          this._push(out, entry, accountId, now, { reason, manual }, reason)
        }
        return out
      }
      case 'windowOpen': {
        const title = payload && typeof payload.title === 'string' ? payload.title.slice(0, MAX_FIELD_LENGTH) : ''
        const folded = title ? fold(title) : ''
        for (const entry of this._bucket(accountId, 'windowOpen') || []) {
          if (entry.title && !folded.includes(entry.title)) continue
          this._push(out, entry, accountId, now, { title })
        }
        return out
      }
      default:
        // connected, windowClose and unknown types only maintain session state.
        return out
    }
  }

  _world(type, accountId, state, payload, now, out) {
    const changed = []
    if (payload) {
      for (const field of ['dimension', 'world', 'backend']) {
        const value = payload[field]
        if (value === undefined || value === null) continue
        const text = str(value)
        const prev = state.world[field]
        if (prev !== undefined && prev !== text) changed.push(field)
        state.world[field] = text
      }
    }
    if (changed.length === 0) return out
    if (now < state.worldSuppressUntil) return out
    state.worldSuppressUntil = now + LIMITS.worldChangeDebounceMs
    let reason = 'dimension'
    if (changed.includes('backend') || type === 'serverSwitch') reason = 'server-switch'
    else if (changed.includes('world')) reason = 'world'
    const variables = {
      reason,
      dimension: state.world.dimension === undefined ? '' : state.world.dimension,
      world: state.world.world === undefined ? '' : state.world.world
    }
    for (const entry of this._bucket(accountId, 'worldChange') || []) {
      this._push(out, entry, accountId, now, Object.assign({}, variables), reason)
    }
    return out
  }

  _chat(accountId, state, payload, now, out) {
    if (!payload || typeof payload.text !== 'string') return out
    const source = payload.source === undefined ? 'chat' : payload.source
    if (!ALL_SOURCES.includes(source)) return out
    const text = payload.text

    if (state.sent.length) {
      state.sent = state.sent.filter((s) => now - s.at < LIMITS.ownMessageIgnoreMs)
      const own = state.sent.findIndex((s) => s.text === text)
      if (own >= 0) {
        state.sent.splice(own, 1)
        return out
      }
    }

    const bucket = this._bucket(accountId, 'chat')
    if (!bucket) return out
    const folded = fold(text)
    for (const entry of bucket) {
      if (!entry.sources.has(source)) continue
      const captures = entry.pattern.testFolded(text, folded)
      if (captures) this._push(out, entry, accountId, now, captures)
    }
    return out
  }

  _telemetry(accountId, state, payload, now, out) {
    // Fill the world baseline if it is still unknown; never overwrite it (respawn/login own that).
    for (const field of ['dimension', 'world']) {
      if (state.world[field] === undefined && payload[field] !== undefined && payload[field] !== null) {
        state.world[field] = str(payload[field])
      }
    }

    const level = (type, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      for (const entry of this._bucket(accountId, type) || []) {
        let armed = state.edges.get(entry.macroId)
        if (armed === undefined) armed = true
        let fire = false
        if (armed) {
          if (value < entry.below) {
            fire = true
            armed = false
          }
        } else if (value >= entry.below + entry.hysteresis) {
          armed = true
        }
        state.edges.set(entry.macroId, armed)
        if (fire) this._push(out, entry, accountId, now, { [type === 'healthBelow' ? 'health' : 'food']: String(value) })
      }
    }
    level('healthBelow', payload.health)
    level('hungerBelow', payload.food)

    if (typeof payload.inventoryFull === 'boolean') {
      for (const entry of this._bucket(accountId, 'inventoryFull') || []) {
        let armed = state.edges.get(entry.macroId)
        if (armed === undefined) armed = true
        if (payload.inventoryFull) {
          if (armed) {
            state.edges.set(entry.macroId, false)
            this._push(out, entry, accountId, now, {})
          }
        } else if (!armed) {
          state.edges.set(entry.macroId, true)
        }
      }
    }

    if (typeof payload.inventorySignature === 'string') {
      const prev = state.invSig
      state.invSig = payload.inventorySignature
      if (prev !== undefined && prev !== payload.inventorySignature) {
        for (const entry of this._bucket(accountId, 'inventoryChanged') || []) {
          this._push(out, entry, accountId, now, {})
        }
      }
    }
    return out
  }
}

module.exports = { TriggerMatcher, compileChatPattern, nextScheduleTime }
