'use strict'
// Macro engine v2 — Stream A: data model, normalization, validation, v1 migration.
// Pure and portable: CommonJS, Node 18 compatible, no Electron/Mineflayer imports.
// Interface: see "Stream A — model" in ./contract.cjs.

const crypto = require('node:crypto')
const { SCHEMA_VERSION, LIMITS, TRIGGER_TYPES, STEP_TYPES, CONDITION_TYPES } = require('./contract.cjs')

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const MAX_ID_LENGTH = 80
const MAX_TARGET_ACCOUNTS = 500
const MAX_TARGET_TAGS = 50
const MAX_PATTERN_HARD = 1000 // normalization hard cap; validation reports > LIMITS.maxPatternLength
const MAX_NAME_FIELD = 80
const DEFAULT_TRIGGER_TYPE = 'manual'
const TWO_PI = Math.PI * 2
const HALF_PI = Math.PI / 2
const LOOK_STEP_RADIANS = 0.45 // BotManager.look turns by this much per v1 step

// ---------------------------------------------------------------------------
// Primitive helpers (never throw on any input).
// ---------------------------------------------------------------------------

function num(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}
function bounded(value, min, max, fallback) {
  const n = num(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : fallback
}
function int(value, min, max, fallback) { return Math.round(bounded(value, min, max, fallback)) }
function str(value, max) {
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max)
  return ''
}
function primitive(value) {
  if (typeof value === 'string') return value.slice(0, 256)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  return ''
}
function oneOf(value, list, fallback) { return typeof value === 'string' && list.includes(value) ? value : fallback }
function variableName(value) { return str(value, 200).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) }
function uniqueStrings(input, maxItems, maxLength) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (let i = 0; i < input.length && i < maxItems * 4 && out.length < maxItems; i += 1) {
    const value = typeof input[i] === 'string' ? input[i].trim().slice(0, maxLength) : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
function newId() { return crypto.randomUUID() }
function cleanId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, MAX_ID_LENGTH) : ''
  return id || ''
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function normalizeCondition(input, depth = 0) {
  if (!isObj(input)) return { type: 'always' }
  const type = typeof input.type === 'string' && CONDITION_TYPES.includes(input.type) ? input.type : 'always'
  switch (type) {
    case 'online': return typeof input.value === 'boolean' ? { type, value: input.value } : { type }
    case 'healthBelow': return { type, value: bounded(input.value, 0, 20, 8) }
    case 'hungerBelow': return { type, value: bounded(input.value, 0, 20, 14) }
    case 'hasItem': return { type, name: str(input.name, MAX_NAME_FIELD), count: int(input.count, 1, 2304, 1) }
    case 'windowOpen': {
      const name = str(input.name, MAX_NAME_FIELD)
      return name ? { type, name } : { type }
    }
    case 'variableEquals': return { type, name: variableName(input.name), value: primitive(input.value) }
    case 'not': return { type, condition: depth >= LIMITS.maxNestingDepth ? { type: 'always' } : normalizeCondition(input.condition, depth + 1) }
    default: return { type }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function normalizeSelect(input, allowLore) {
  if (isObj(input)) {
    if (Number.isFinite(num(input.slot))) return { slot: int(input.slot, 0, 255, 0) }
    const name = str(input.name, MAX_NAME_FIELD).trim()
    if (name) return { name }
    if (allowLore) {
      const lore = str(input.lore, MAX_NAME_FIELD).trim()
      if (lore) return { lore }
    }
  }
  return { name: '' } // flagged by validateMacro; never silently targets slot 0
}

const MOVE_CONTROLS = ['forward', 'back', 'left', 'right']
const HOLD_CONTROLS = ['sneak', 'jump', 'sprint']
const CLICKS = ['left', 'right', 'shift', 'drop']

function normalizeStep(raw, depth, ctx) {
  if (!isObj(raw)) return null
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (!hasOwn(STEP_TYPES, type)) return null
  if (ctx.remaining <= 0) return null
  ctx.remaining -= 1
  switch (type) {
    case 'chat': return { type, message: str(raw.message, LIMITS.maxMessageLength) }
    case 'wait': {
      const hasRange = Number.isFinite(num(raw.minMs)) || Number.isFinite(num(raw.maxMs))
      if (hasRange && !Number.isFinite(num(raw.ms))) {
        const a = bounded(raw.minMs, 0, 3600000, 0)
        const b = bounded(raw.maxMs, 0, 3600000, a)
        return { type, minMs: Math.min(a, b), maxMs: Math.max(a, b) }
      }
      const ms = int(raw.ms, 0, 3600000, 500)
      const jitter = int(raw.jitterMs, 0, Math.min(ms, 60000), 0)
      return jitter > 0 ? { type, ms, jitterMs: jitter } : { type, ms }
    }
    case 'notify': return {
      type,
      message: str(raw.message, LIMITS.maxMessageLength),
      desktop: typeof raw.desktop === 'boolean' ? raw.desktop : true,
      webhook: raw.webhook === true
    }
    case 'move': {
      const control = oneOf(raw.control, MOVE_CONTROLS, 'forward')
      if (!Number.isFinite(num(raw.durationMs)) && Number.isFinite(num(raw.distance))) return { type, control, distance: bounded(raw.distance, 0.5, 64, 1) }
      return { type, control, durationMs: int(raw.durationMs, 100, 10000, 350) }
    }
    case 'look': {
      const mode = oneOf(raw.mode, ['absolute', 'relative', 'at'], 'relative')
      if (mode === 'at') {
        const out = { type, mode, target: oneOf(raw.target, ['block', 'entity'], 'block') }
        for (const axis of ['x', 'y', 'z']) if (Number.isFinite(num(raw[axis]))) out[axis] = bounded(raw[axis], -30000000, 30000000, 0)
        const entity = str(raw.entity, 64).trim()
        if (entity) out.entity = entity
        return out
      }
      return { type, mode, yaw: bounded(raw.yaw, -TWO_PI, TWO_PI, 0), pitch: bounded(raw.pitch, -HALF_PI, HALF_PI, 0) }
    }
    case 'control': return { type, control: oneOf(raw.control, HOLD_CONTROLS, 'sneak'), action: oneOf(raw.action, ['hold', 'release'], 'hold') }
    case 'leftClick': {
      const out = { type, action: oneOf(raw.action, ['once', 'hold', 'release'], 'once') }
      const only = oneOf(raw.only, ['blocks', 'entities'], '')
      if (only) out.only = only
      return out
    }
    case 'rightClick': return { type, action: oneOf(raw.action, ['once', 'hold', 'release'], 'once') }
    case 'selectHotbar': return { type, slot: int(raw.slot, 0, 8, 0) }
    case 'holdItem': return { type, name: str(raw.name, MAX_NAME_FIELD).trim() }
    case 'useInventory':
    case 'useGui': return { type, select: normalizeSelect(raw.select, true), click: oneOf(raw.click, CLICKS, 'left') }
    case 'closeGui': return { type }
    case 'waitForWindow': {
      const out = { type, giveUpAfterMs: int(raw.giveUpAfterMs, 100, 300000, 10000) }
      const title = str(raw.title, MAX_NAME_FIELD).trim()
      if (title) out.title = title
      return out
    }
    case 'drop':
    case 'deposit': return { type, select: normalizeSelect(raw.select, false), count: int(raw.count, 1, 64, 1) }
    case 'dropAll': {
      const filter = str(raw.filter, MAX_NAME_FIELD).trim()
      return filter ? { type, filter } : { type }
    }
    case 'disconnect': return { type }
    case 'reconnect': return Number.isFinite(num(raw.delayMs)) ? { type, delayMs: int(raw.delayMs, 0, 3600000, 0) } : { type }
    case 'set': return { type, variable: variableName(raw.variable), value: primitive(raw.value) }
    case 'if': return {
      type,
      condition: normalizeCondition(raw.condition, 0),
      then: normalizeStepList(raw.then, depth + 1, ctx),
      else: normalizeStepList(raw.else, depth + 1, ctx)
    }
    case 'repeat': {
      if (isObj(raw.while)) {
        return { type, while: normalizeCondition(raw.while, 0), maxIterations: int(raw.maxIterations, 1, 100000, 1000), steps: normalizeStepList(raw.steps, depth + 1, ctx) }
      }
      return { type, times: int(raw.times, 1, 100000, 1), steps: normalizeStepList(raw.steps, depth + 1, ctx) }
    }
    case 'stop': return { type }
    default: return null
  }
}

function normalizeStepList(input, depth, ctx) {
  if (!Array.isArray(input) || depth > LIMITS.maxNestingDepth) return []
  const out = []
  const limit = Math.min(input.length, LIMITS.maxStepsPerMacro)
  for (let i = 0; i < limit; i += 1) {
    const step = normalizeStep(input[i], depth, ctx)
    if (step) out.push(step)
  }
  return out
}

// ---------------------------------------------------------------------------
// Triggers, targets, macro, library
// ---------------------------------------------------------------------------

function normalizeTrigger(input) {
  const raw = isObj(input) ? input : {}
  const type = typeof raw.type === 'string' && hasOwn(TRIGGER_TYPES, raw.type) ? raw.type : DEFAULT_TRIGGER_TYPE
  const out = { type }
  if (Number.isFinite(num(raw.cooldownMs))) out.cooldownMs = int(raw.cooldownMs, 0, 86400000, 0)
  switch (type) {
    case 'timer': {
      out.intervalMs = int(raw.intervalMs, 1000, 86400000, 60000)
      out.jitterMs = int(raw.jitterMs, 0, Math.floor(out.intervalMs / 2), 0)
      break
    }
    case 'schedule': out.at = str(raw.at, 16).trim(); break
    case 'chat': {
      out.match = oneOf(raw.match, ['contains', 'glob'], 'contains')
      out.pattern = str(raw.pattern, MAX_PATTERN_HARD)
      if (Array.isArray(raw.sources)) {
        const sources = raw.sources.slice(0, 16).filter((s) => s === 'chat' || s === 'system' || s === 'actionBar')
        const unique = sources.filter((s, i) => sources.indexOf(s) === i)
        if (unique.length) out.sources = unique
      }
      break
    }
    case 'healthBelow': out.below = bounded(raw.below, 0, 20, 8); break
    case 'hungerBelow': out.below = bounded(raw.below, 0, 20, 14); break
    case 'windowOpen': {
      const title = str(raw.title, MAX_NAME_FIELD).trim()
      if (title) out.title = title
      break
    }
    default: break
  }
  return out
}

function normalizeTargets(input) {
  const raw = isObj(input) ? input : {}
  if (raw.mode === 'all') return { mode: 'all' }
  if (raw.mode === 'tags') return { mode: 'tags', tags: uniqueStrings(raw.tags, MAX_TARGET_TAGS, 40) }
  return { mode: 'accounts', accountIds: uniqueStrings(raw.accountIds, MAX_TARGET_ACCOUNTS, MAX_ID_LENGTH) }
}

function normalizeOrigin(input) {
  const out = {}
  if (isObj(input)) {
    if (isObj(input.fromV1)) {
      const accountId = cleanId(input.fromV1.accountId)
      if (accountId) {
        out.fromV1 = { accountId }
        const automationId = cleanId(input.fromV1.automationId)
        if (automationId) out.fromV1.automationId = automationId
      }
    }
    if (input.v2Only === true) out.v2Only = true
  }
  return out
}

function normalizeNotify(input) {
  const webhookRef = isObj(input) ? str(input.webhookRef, 200).trim() : ''
  return webhookRef ? { webhookRef } : {}
}

function normalizeMacro(input) {
  try {
    const raw = isObj(input) ? input : {}
    const ctx = { remaining: LIMITS.maxStepsPerMacro }
    const name = str(raw.name, LIMITS.maxNameLength).trim()
    return {
      id: cleanId(raw.id) || newId(),
      name: name || 'Untitled macro',
      enabled: raw.enabled !== false,
      targets: normalizeTargets(raw.targets),
      trigger: normalizeTrigger(raw.trigger),
      stopWhen: Array.isArray(raw.stopWhen) ? raw.stopWhen.slice(0, 16).map((c) => normalizeCondition(c, 0)) : [],
      concurrency: oneOf(raw.concurrency, ['skip', 'override'], 'skip'),
      onError: oneOf(raw.onError, ['continue', 'stop'], 'continue'),
      defaultDelayMs: int(raw.defaultDelayMs, 0, 60000, LIMITS.defaultDelayMs),
      maxRuntimeMs: Number.isFinite(num(raw.maxRuntimeMs)) && raw.maxRuntimeMs !== null ? int(raw.maxRuntimeMs, 1000, 7 * 86400000, 3600000) : null,
      steps: normalizeStepList(raw.steps, 0, ctx),
      notify: normalizeNotify(raw.notify),
      origin: normalizeOrigin(raw.origin)
    }
  } catch {
    return { id: newId(), name: 'Untitled macro', enabled: false, targets: { mode: 'accounts', accountIds: [] }, trigger: { type: DEFAULT_TRIGGER_TYPE }, stopWhen: [], concurrency: 'skip', onError: 'continue', defaultDelayMs: LIMITS.defaultDelayMs, maxRuntimeMs: null, steps: [], notify: {}, origin: {} }
  }
}

function normalizeMigratedFromV1(input) {
  if (!isObj(input)) return undefined
  const at = num(input.at)
  return { at: Number.isFinite(at) ? at : 0, accountIds: uniqueStrings(input.accountIds, 5000, 100) }
}

function normalizeLibrary(input) {
  try {
    const raw = Array.isArray(input) ? { macros: input } : isObj(input) ? input : {}
    const macros = []
    const seen = new Set()
    const list = Array.isArray(raw.macros) ? raw.macros : []
    for (let i = 0; i < list.length && macros.length < LIMITS.maxMacros; i += 1) {
      const macro = normalizeMacro(list[i])
      if (seen.has(macro.id)) macro.id = newId()
      seen.add(macro.id)
      macros.push(macro)
    }
    const library = { version: SCHEMA_VERSION, macros }
    const migrated = normalizeMigratedFromV1(raw.migratedFromV1)
    if (migrated) library.migratedFromV1 = migrated
    return library
  } catch {
    return { version: SCHEMA_VERSION, macros: [] }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function editionName(edition) { return edition === 'bedrock' ? 'Bedrock' : 'Java' }

function resolveTargetEditions(macro, options) {
  // Returns { bedrock: string[], java: string[] } for the resolvable target accounts.
  const result = { bedrock: [], java: [] }
  const targets = macro?.targets
  let ids = []
  if (targets?.mode === 'all') ids = Array.isArray(options?.accountIds) ? options.accountIds : []
  else if (targets?.mode === 'accounts' && Array.isArray(targets.accountIds)) ids = targets.accountIds
  if (typeof options?.editionOf !== 'function') return result
  for (const id of ids.slice(0, MAX_TARGET_ACCOUNTS)) {
    if (typeof id !== 'string') continue
    let edition
    try { edition = options.editionOf(id) } catch { continue }
    if (edition === 'bedrock') result.bedrock.push(id)
    else if (edition === 'java') result.java.push(id)
  }
  return result
}

function accountList(ids) {
  const shown = ids.slice(0, 3).join(', ')
  return ids.length > 3 ? `${shown} and ${ids.length - 3} more` : shown
}

function validateCondition(condition, path, errors, depth = 0) {
  if (!isObj(condition) || typeof condition.type !== 'string' || !CONDITION_TYPES.includes(condition.type)) {
    errors.push({ path: `${path}/type`, message: 'Unknown condition type.' })
    return
  }
  if (condition.type === 'hasItem' && !String(condition.name || '').trim()) errors.push({ path: `${path}/name`, message: 'Enter an item name.' })
  if (condition.type === 'variableEquals' && !String(condition.name || '').trim()) errors.push({ path: `${path}/name`, message: 'Enter a variable name.' })
  if ((condition.type === 'healthBelow' || condition.type === 'hungerBelow') && !(Number.isFinite(condition.value) && condition.value >= 0 && condition.value <= 20)) {
    errors.push({ path: `${path}/value`, message: 'Value must be between 0 and 20.' })
  }
  if (condition.type === 'not') {
    if (depth >= LIMITS.maxNestingDepth) errors.push({ path: `${path}/condition`, message: 'Conditions are nested too deeply.' })
    else validateCondition(condition.condition, `${path}/condition`, errors, depth + 1)
  }
}

function validateSelect(select, path, errors, allowLore) {
  if (!isObj(select)) { errors.push({ path, message: 'Choose a slot or an item.' }); return }
  const hasSlot = Number.isInteger(select.slot) && select.slot >= 0 && select.slot <= 255
  const hasName = typeof select.name === 'string' && select.name.trim() !== ''
  const hasLore = allowLore && typeof select.lore === 'string' && select.lore.trim() !== ''
  if (!hasSlot && !hasName && !hasLore) errors.push({ path, message: 'Choose a slot or an item.' })
}

function validateSteps(steps, path, depth, ctx) {
  if (!Array.isArray(steps)) return
  if (depth > LIMITS.maxNestingDepth) { ctx.errors.push({ path, message: `Steps are nested more than ${LIMITS.maxNestingDepth} levels deep.` }); return }
  steps.forEach((step, index) => {
    const here = `${path}/${index}`
    ctx.count += 1
    if (!isObj(step) || typeof step.type !== 'string' || !hasOwn(STEP_TYPES, step.type)) {
      ctx.errors.push({ path: `${here}/type`, message: 'Unknown step type.' })
      return
    }
    const errors = ctx.errors
    const type = step.type
    for (const edition of ['bedrock', 'java']) {
      const ids = ctx.editions[edition]
      if (ids.length && !STEP_TYPES[type].editions.includes(edition)) {
        errors.push({ path: `${here}/type`, message: `"${type}" is not supported on ${editionName(edition)} accounts (${accountList(ids)}).` })
      }
    }
    const message = typeof step.message === 'string' ? step.message : ''
    switch (type) {
      case 'chat':
        if (!message.trim()) errors.push({ path: `${here}/message`, message: 'Enter a chat message.' })
        else if (message.length > LIMITS.maxMessageLength) errors.push({ path: `${here}/message`, message: `Message is longer than ${LIMITS.maxMessageLength} characters.` })
        break
      case 'notify':
        if (!message.trim()) errors.push({ path: `${here}/message`, message: 'Enter a notification message.' })
        else if (message.length > LIMITS.maxMessageLength) errors.push({ path: `${here}/message`, message: `Message is longer than ${LIMITS.maxMessageLength} characters.` })
        if (step.webhook === true && !ctx.hasWebhookRef) errors.push({ path: `${here}/webhook`, message: 'Webhook is enabled but no webhook is configured for this macro.' })
        break
      case 'wait':
        if (Number.isFinite(step.minMs) || Number.isFinite(step.maxMs)) {
          if (!(step.minMs >= 0 && step.maxMs >= step.minMs)) errors.push({ path: `${here}/maxMs`, message: 'Maximum wait must be at least the minimum.' })
        } else if (!(Number.isFinite(step.ms) && step.ms >= 0)) errors.push({ path: `${here}/ms`, message: 'Enter a wait time in milliseconds.' })
        break
      case 'move':
        if (!MOVE_CONTROLS.includes(step.control)) errors.push({ path: `${here}/control`, message: 'Choose a direction.' })
        if (!(Number.isFinite(step.durationMs) || Number.isFinite(step.distance))) errors.push({ path: `${here}/durationMs`, message: 'Enter a duration or a distance.' })
        break
      case 'look':
        if (step.mode === 'at') {
          if (step.target === 'entity' && !String(step.entity || '').trim()) errors.push({ path: `${here}/entity`, message: 'Enter an entity name.' })
          if (step.target === 'block') for (const axis of ['x', 'y', 'z']) if (!Number.isFinite(step[axis])) errors.push({ path: `${here}/${axis}`, message: 'Enter block coordinates.' })
        } else if (step.mode !== 'absolute' && step.mode !== 'relative') errors.push({ path: `${here}/mode`, message: 'Unknown look mode.' })
        break
      case 'holdItem':
        if (!String(step.name || '').trim()) errors.push({ path: `${here}/name`, message: 'Enter an item name.' })
        break
      case 'useInventory':
      case 'useGui':
        validateSelect(step.select, `${here}/select`, errors, true)
        break
      case 'drop':
      case 'deposit':
        validateSelect(step.select, `${here}/select`, errors, false)
        break
      case 'set':
        if (!String(step.variable || '').trim()) errors.push({ path: `${here}/variable`, message: 'Enter a variable name.' })
        break
      case 'if':
        validateCondition(step.condition, `${here}/condition`, errors)
        validateSteps(step.then, `${here}/then`, depth + 1, ctx)
        validateSteps(step.else, `${here}/else`, depth + 1, ctx)
        break
      case 'repeat':
        if (step.while !== undefined) validateCondition(step.while, `${here}/while`, errors)
        else if (!(Number.isInteger(step.times) && step.times >= 1)) errors.push({ path: `${here}/times`, message: 'Enter how many times to repeat.' })
        validateSteps(step.steps, `${here}/steps`, depth + 1, ctx)
        break
      default: break
    }
  })
}

function validateMacro(macro, options = {}) {
  const errors = []
  try {
    if (!isObj(macro)) return [{ path: '', message: 'Macro must be an object.' }]
    if (typeof macro.name !== 'string' || !macro.name.trim()) errors.push({ path: '/name', message: 'Enter a macro name.' })
    else if (macro.name.length > LIMITS.maxNameLength) errors.push({ path: '/name', message: `Name is longer than ${LIMITS.maxNameLength} characters.` })

    // Targets
    const targets = macro.targets
    const known = new Set(Array.isArray(options.accountIds) ? options.accountIds.filter((id) => typeof id === 'string') : [])
    const haveKnown = Array.isArray(options.accountIds)
    if (!isObj(targets)) errors.push({ path: '/targets', message: 'Choose which accounts this macro runs on.' })
    else if (targets.mode === 'accounts') {
      const ids = Array.isArray(targets.accountIds) ? targets.accountIds : []
      if (!ids.length) errors.push({ path: '/targets/accountIds', message: 'Choose at least one account.' })
      ids.forEach((id, index) => {
        if (haveKnown && !known.has(id)) errors.push({ path: `/targets/accountIds/${index}`, message: 'This account no longer exists.' })
      })
    } else if (targets.mode === 'tags') {
      if (!Array.isArray(targets.tags) || !targets.tags.length) errors.push({ path: '/targets/tags', message: 'Choose at least one tag.' })
    } else if (targets.mode === 'all') {
      if (haveKnown && known.size === 0) errors.push({ path: '/targets', message: 'There are no accounts to run on.' })
    } else errors.push({ path: '/targets/mode', message: 'Unknown target mode.' })

    const editions = resolveTargetEditions(macro, options)

    // Trigger
    const trigger = macro.trigger
    if (!isObj(trigger) || typeof trigger.type !== 'string' || !hasOwn(TRIGGER_TYPES, trigger.type)) {
      errors.push({ path: '/trigger/type', message: 'Choose a trigger.' })
    } else {
      for (const edition of ['bedrock', 'java']) {
        if (editions[edition].length && !TRIGGER_TYPES[trigger.type].editions.includes(edition)) {
          errors.push({ path: '/trigger/type', message: `Trigger "${trigger.type}" is not supported on ${editionName(edition)} accounts (${accountList(editions[edition])}).` })
        }
      }
      if (trigger.cooldownMs !== undefined && !(Number.isFinite(trigger.cooldownMs) && trigger.cooldownMs >= 0 && trigger.cooldownMs <= 86400000)) {
        errors.push({ path: '/trigger/cooldownMs', message: 'Cooldown must be between 0 and 24 hours.' })
      }
      if (trigger.type === 'timer') {
        if (!(Number.isFinite(trigger.intervalMs) && trigger.intervalMs >= 1000 && trigger.intervalMs <= 86400000)) errors.push({ path: '/trigger/intervalMs', message: 'Interval must be between 1 second and 24 hours.' })
        else if (trigger.jitterMs !== undefined && !(Number.isFinite(trigger.jitterMs) && trigger.jitterMs >= 0 && trigger.jitterMs <= trigger.intervalMs / 2)) errors.push({ path: '/trigger/jitterMs', message: 'Jitter cannot exceed half the interval.' })
      }
      if (trigger.type === 'schedule' && !(typeof trigger.at === 'string' && TIME_PATTERN.test(trigger.at))) errors.push({ path: '/trigger/at', message: 'Enter a time as HH:MM (24-hour).' })
      if (trigger.type === 'chat') {
        const pattern = typeof trigger.pattern === 'string' ? trigger.pattern : ''
        if (pattern.length > LIMITS.maxPatternLength) errors.push({ path: '/trigger/pattern', message: `Pattern is longer than ${LIMITS.maxPatternLength} characters.` })
        if (trigger.match !== undefined && trigger.match !== 'contains' && trigger.match !== 'glob') errors.push({ path: '/trigger/match', message: 'Match must be "contains" or "glob".' })
      }
      if ((trigger.type === 'healthBelow' || trigger.type === 'hungerBelow') && !(Number.isFinite(trigger.below) && trigger.below >= 0 && trigger.below <= 20)) {
        errors.push({ path: '/trigger/below', message: 'Threshold must be between 0 and 20.' })
      }
    }

    // stopWhen
    if (Array.isArray(macro.stopWhen)) macro.stopWhen.forEach((condition, index) => validateCondition(condition, `/stopWhen/${index}`, errors))

    // Steps
    const steps = macro.steps
    if (!Array.isArray(steps) || steps.length === 0) errors.push({ path: '/steps', message: 'Add at least one step.' })
    else {
      const ctx = { errors, editions, count: 0, hasWebhookRef: Boolean(isObj(macro.notify) && macro.notify.webhookRef) }
      validateSteps(steps, '/steps', 0, ctx)
      if (ctx.count > LIMITS.maxStepsPerMacro) errors.push({ path: '/steps', message: `A macro can have at most ${LIMITS.maxStepsPerMacro} steps.` })
    }
  } catch {
    errors.push({ path: '', message: 'Macro could not be validated.' })
  }
  return errors
}

// ---------------------------------------------------------------------------
// v1 migration (beta.9 per-account `automations`) and write-back (toV1)
// ---------------------------------------------------------------------------

const V1_TRIGGER_MAP = { manual: 'manual', connected: 'join', disconnected: 'disconnected', chat: 'chat', health: 'healthBelow', inventory: 'inventoryChanged', window: 'windowOpen', timer: 'timer' }
const V1_STEP_TYPES = ['chat', 'wait', 'move', 'look', 'drop', 'deposit', 'equip', 'clickGui', 'attackNearest', 'useHeld', 'notify', 'set', 'if', 'repeat']
const V1_CONDITION_TYPES = ['always', 'status', 'healthBelow', 'hungerBelow', 'chatContains', 'hasItem', 'variableEquals']
const V1_MOVE_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

function v1TriggerToV2(raw) {
  const input = isObj(raw) ? raw : {}
  const v1Type = typeof input.type === 'string' && hasOwn(V1_TRIGGER_MAP, input.type) ? input.type : 'manual'
  const type = V1_TRIGGER_MAP[v1Type]
  if (type === 'chat') return { type, match: 'contains', pattern: str(input.contains, 160) }
  if (type === 'healthBelow') return { type, below: bounded(input.below, 0, 20, 8) }
  if (type === 'timer') return { type, intervalMs: int(input.intervalSeconds, 2, 86400, 60) * 1000 }
  return { type }
}

// Returns { condition, lossy } ; chatContains has no v2 equivalent.
function v1ConditionToV2(raw, ctx, where) {
  const input = isObj(raw) ? raw : {}
  const type = typeof input.type === 'string' && V1_CONDITION_TYPES.includes(input.type) ? input.type : 'always'
  switch (type) {
    case 'status': {
      const value = primitive(input.value)
      if (value === 'online') return { type: 'online', value: true }
      if (value === 'offline') return { type: 'not', condition: { type: 'online', value: true } }
      ctx.warn(`${where}: status condition "${String(value)}" has no v2 equivalent; the branch condition was replaced with "always".`)
      ctx.v2Only = true
      return { type: 'always' }
    }
    case 'healthBelow': return { type, value: bounded(input.value, 0, 20, 8) }
    case 'hungerBelow': return { type, value: bounded(input.value, 0, 20, 14) }
    case 'hasItem': return { type, name: str(input.name, MAX_NAME_FIELD), count: int(input.count, 1, 2304, 1) }
    case 'variableEquals': return { type, name: variableName(input.name), value: primitive(input.value) }
    case 'chatContains':
      ctx.warn(`${where}: "chat contains" conditions are not supported in v2; the branch condition was replaced with "always".`)
      ctx.v2Only = true
      return { type: 'always' }
    default: return { type: 'always' }
  }
}

function v1StepsToV2(input, depth, ctx, path) {
  if (!Array.isArray(input) || depth > LIMITS.maxNestingDepth) return []
  const out = []
  const limit = Math.min(input.length, 200)
  for (let i = 0; i < limit; i += 1) {
    const raw = input[i]
    if (!isObj(raw) || typeof raw.type !== 'string' || !V1_STEP_TYPES.includes(raw.type)) continue
    const where = `${ctx.label} step ${path}${i + 1}`
    if (ctx.remaining <= 0) { ctx.truncated = true; break }
    switch (raw.type) {
      case 'chat': ctx.remaining -= 1; out.push({ type: 'chat', message: str(raw.message, LIMITS.maxMessageLength) }); break
      case 'wait': ctx.remaining -= 1; out.push({ type: 'wait', ms: int(raw.milliseconds, 0, 60000, 500) }); break
      case 'move': {
        const control = typeof raw.control === 'string' && V1_MOVE_CONTROLS.includes(raw.control) ? raw.control : 'forward'
        const durationMs = int(raw.duration, 100, 10000, 350)
        if (MOVE_CONTROLS.includes(control)) { ctx.remaining -= 1; out.push({ type: 'move', control, durationMs }) } else {
          // Timed jump/sprint/sneak: hold, wait, release. Equivalent behaviour, not invertible.
          ctx.remaining -= 3
          out.push({ type: 'control', control, action: 'hold' }, { type: 'wait', ms: durationMs }, { type: 'control', control, action: 'release' })
          ctx.v2Only = true
        }
        break
      }
      case 'look': ctx.remaining -= 1; out.push({ type: 'look', mode: 'relative', yaw: raw.direction === 'left' ? -LOOK_STEP_RADIANS : LOOK_STEP_RADIANS, pitch: 0 }); break
      case 'drop':
      case 'deposit': ctx.remaining -= 1; out.push({ type: raw.type, select: { slot: int(raw.slot, 0, 255, 0) }, count: int(raw.count, 1, 64, 1) }); break
      case 'equip':
        ctx.warn(`${where}: "equip" has no v2 equivalent; the step was dropped (the v1 automation is still stored for rollback).`)
        ctx.v2Only = true
        break
      case 'clickGui': ctx.remaining -= 1; out.push({ type: 'useGui', select: { slot: int(raw.slot, 0, 255, 0) }, click: 'left' }); break
      case 'attackNearest': ctx.remaining -= 1; out.push({ type: 'leftClick', action: 'once', only: 'entities' }); break
      case 'useHeld': ctx.remaining -= 1; out.push({ type: 'rightClick', action: 'once' }); break
      case 'notify': ctx.remaining -= 1; out.push({ type: 'notify', message: str(raw.message, LIMITS.maxMessageLength), desktop: true, webhook: false }); break
      case 'set': ctx.remaining -= 1; out.push({ type: 'set', variable: variableName(raw.variable), value: primitive(raw.value) }); break
      case 'if': {
        ctx.remaining -= 1
        const condition = v1ConditionToV2(raw.condition, ctx, where)
        out.push({ type: 'if', condition, then: v1StepsToV2(raw.then, depth + 1, ctx, `${path}${i + 1}.then.`), else: v1StepsToV2(raw.else, depth + 1, ctx, `${path}${i + 1}.else.`) })
        break
      }
      case 'repeat': ctx.remaining -= 1; out.push({ type: 'repeat', times: int(raw.times, 1, 100, 1), steps: v1StepsToV2(raw.steps, depth + 1, ctx, `${path}${i + 1}.`) }); break
      default: break
    }
  }
  return out
}

function uniqueMacroId(base, taken) {
  if (!taken.has(base)) return base
  const stem = base.slice(0, 70)
  for (let n = 1; n < 10000; n += 1) {
    const candidate = n === 1 ? `${stem}-v1` : `${stem}-v1-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return newId()
}

function migrateV1(accounts, library, options = {}) {
  const next = normalizeLibrary(library)
  const migratedAccountIds = []
  const warnings = []
  const already = new Set(next.migratedFromV1 ? next.migratedFromV1.accountIds : [])
  const taken = new Set(next.macros.map((macro) => macro.id))
  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  const list = Array.isArray(accounts) ? accounts : []
  for (const account of list) {
    try {
      if (!isObj(account) || typeof account.id !== 'string' || !account.id || already.has(account.id)) continue
      if (!Array.isArray(account.automations) || account.automations.length === 0) continue
      const accountLabel = typeof account.profileName === 'string' && account.profileName ? account.profileName : account.id
      const converted = []
      for (const item of account.automations.slice(0, 100)) {
        if (!isObj(item)) continue
        const name = str(item.name, LIMITS.maxNameLength).trim() || `Automation ${converted.length + 1}`
        const ctx = {
          label: `${accountLabel} / "${name}"`,
          remaining: LIMITS.maxStepsPerMacro,
          truncated: false,
          v2Only: false,
          warn: (message) => warnings.push(message)
        }
        const steps = v1StepsToV2(item.steps, 0, ctx, '')
        if (!Array.isArray(item.steps) || !steps.length) {
          // v1 dropped step-less automations on load, so they never ran. Keep nothing.
          if (Array.isArray(item.steps) && item.steps.length) warnings.push(`${ctx.label}: every step was unsupported; the automation was not migrated.`)
          continue
        }
        if (ctx.truncated) warnings.push(`${ctx.label}: more than ${LIMITS.maxStepsPerMacro} steps; extra steps were not migrated.`)
        const v1Id = cleanId(item.id) || newId()
        const id = uniqueMacroId(v1Id, taken)
        const origin = { fromV1: { accountId: account.id } }
        if (id !== v1Id) origin.fromV1.automationId = v1Id
        if (ctx.v2Only || ctx.truncated) origin.v2Only = true
        converted.push(normalizeMacro({
          id,
          name,
          enabled: item.enabled !== false,
          targets: { mode: 'accounts', accountIds: [account.id] },
          trigger: v1TriggerToV2(item.trigger),
          stopWhen: [],
          concurrency: 'skip',
          onError: 'continue',
          defaultDelayMs: 0,
          maxRuntimeMs: null,
          steps,
          notify: {},
          origin
        }))
        taken.add(id)
      }
      if (!converted.length) continue
      if (next.macros.length + converted.length > LIMITS.maxMacros) {
        warnings.push(`${accountLabel}: the macro library is full (${LIMITS.maxMacros}); this account's automations were not migrated.`)
        continue
      }
      next.macros.push(...converted)
      already.add(account.id)
      migratedAccountIds.push(account.id)
    } catch (error) {
      warnings.push(`Could not migrate an account's automations: ${String(error?.message || error).slice(0, 120)}`)
    }
  }
  if (migratedAccountIds.length) {
    next.migratedFromV1 = {
      at: next.migratedFromV1 ? next.migratedFromV1.at : now,
      accountIds: Array.from(already)
    }
  }
  return { library: next, migratedAccountIds, warnings }
}

// --- toV1 ---

const V1_NOT_REPRESENTABLE = Symbol('v1-not-representable')

function v1Condition(extra) {
  return { type: 'always', value: '', name: '', count: 1, ...extra }
}
function v1Step(extra) {
  return {
    type: '', message: '', control: '', direction: '', destination: '', variable: '', value: '',
    milliseconds: 500, duration: 350, slot: 0, count: 1, times: 1,
    condition: v1Condition({}), then: [], else: [], steps: [], ...extra
  }
}

function conditionToV1(condition) {
  switch (condition?.type) {
    case 'always': return v1Condition({})
    case 'online': return condition.value === false ? v1Condition({ type: 'status', value: 'offline' }) : v1Condition({ type: 'status', value: 'online' })
    case 'not':
      if (condition.condition?.type === 'online' && condition.condition.value !== false) return v1Condition({ type: 'status', value: 'offline' })
      return V1_NOT_REPRESENTABLE
    case 'healthBelow':
    case 'hungerBelow': return v1Condition({ type: condition.type, value: condition.value })
    case 'hasItem': return v1Condition({ type: 'hasItem', name: condition.name, count: condition.count })
    case 'variableEquals': return v1Condition({ type: 'variableEquals', name: condition.name, value: condition.value })
    default: return V1_NOT_REPRESENTABLE
  }
}

function stepsToV1(steps, depth) {
  if (depth > 8) return V1_NOT_REPRESENTABLE
  const out = []
  for (const step of steps) {
    let v1
    switch (step.type) {
      case 'chat': v1 = v1Step({ type: 'chat', message: step.message }); break
      case 'wait':
        if (step.ms === undefined || step.jitterMs !== undefined || step.ms > 60000) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'wait', milliseconds: step.ms }); break
      case 'move':
        if (step.durationMs === undefined || step.distance !== undefined) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'move', control: step.control, duration: step.durationMs }); break
      case 'look':
        if (step.mode !== 'relative' || step.pitch !== 0) return V1_NOT_REPRESENTABLE
        if (Math.abs(step.yaw + LOOK_STEP_RADIANS) < 1e-9) v1 = v1Step({ type: 'look', direction: 'left' })
        else if (Math.abs(step.yaw - LOOK_STEP_RADIANS) < 1e-9) v1 = v1Step({ type: 'look', direction: 'right' })
        else return V1_NOT_REPRESENTABLE
        break
      case 'drop':
      case 'deposit':
        if (!Number.isInteger(step.select?.slot) || step.select.name !== undefined || step.count > 64) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: step.type, slot: step.select.slot, count: step.count }); break
      case 'useGui':
        if (!Number.isInteger(step.select?.slot) || step.click !== 'left') return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'clickGui', slot: step.select.slot }); break
      case 'leftClick':
        if (step.action !== 'once' || step.only !== 'entities') return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'attackNearest' }); break
      case 'rightClick':
        if (step.action !== 'once') return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'useHeld' }); break
      case 'notify':
        if (step.desktop === false || step.webhook === true) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'notify', message: step.message }); break
      case 'set': v1 = v1Step({ type: 'set', variable: step.variable, value: step.value }); break
      case 'if': {
        const condition = conditionToV1(step.condition)
        const thenSteps = stepsToV1(step.then, depth + 1)
        const elseSteps = stepsToV1(step.else, depth + 1)
        if (condition === V1_NOT_REPRESENTABLE || thenSteps === V1_NOT_REPRESENTABLE || elseSteps === V1_NOT_REPRESENTABLE) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'if', condition, then: thenSteps, else: elseSteps }); break
      }
      case 'repeat': {
        if (step.times === undefined || step.times > 100) return V1_NOT_REPRESENTABLE
        const inner = stepsToV1(step.steps, depth + 1)
        if (inner === V1_NOT_REPRESENTABLE) return V1_NOT_REPRESENTABLE
        v1 = v1Step({ type: 'repeat', times: step.times, steps: inner }); break
      }
      default: return V1_NOT_REPRESENTABLE
    }
    out.push(v1)
  }
  return out
}

function triggerToV1(trigger) {
  const base = { type: 'manual', contains: '', below: 8, intervalSeconds: 60 }
  if (trigger.cooldownMs) return V1_NOT_REPRESENTABLE
  switch (trigger.type) {
    case 'manual': return base
    case 'join': return { ...base, type: 'connected' }
    case 'disconnected': return { ...base, type: 'disconnected' }
    case 'inventoryChanged': return { ...base, type: 'inventory' }
    case 'windowOpen': return trigger.title ? V1_NOT_REPRESENTABLE : { ...base, type: 'window' }
    case 'healthBelow': return { ...base, type: 'health', below: trigger.below }
    case 'chat':
      if (trigger.match !== 'contains' || trigger.sources || trigger.pattern.length > 160) return V1_NOT_REPRESENTABLE
      return { ...base, type: 'chat', contains: trigger.pattern }
    case 'timer': {
      if (trigger.jitterMs || trigger.intervalMs % 1000 !== 0) return V1_NOT_REPRESENTABLE
      const seconds = trigger.intervalMs / 1000
      if (seconds < 2 || seconds > 86400) return V1_NOT_REPRESENTABLE
      return { ...base, type: 'timer', intervalSeconds: seconds }
    }
    default: return V1_NOT_REPRESENTABLE
  }
}

function toV1(macro) {
  try {
    const m = normalizeMacro(macro)
    if (m.origin.v2Only) return null
    if (m.targets.mode !== 'accounts' || m.targets.accountIds.length !== 1) return null
    if (m.stopWhen.length || m.concurrency !== 'skip' || m.notify.webhookRef) return null
    if (!m.steps.length) return null
    const trigger = triggerToV1(m.trigger)
    if (trigger === V1_NOT_REPRESENTABLE) return null
    const steps = stepsToV1(m.steps, 0)
    if (steps === V1_NOT_REPRESENTABLE) return null
    return { id: m.origin.fromV1?.automationId || m.id, name: m.name, enabled: m.enabled, trigger, steps }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function sanitizeForSharing(macro) {
  const copy = normalizeMacro(macro)
  copy.notify = {}
  copy.origin = {}
  return copy
}

function exportMacros(macros) {
  const list = Array.isArray(macros) ? macros.slice(0, LIMITS.maxMacros) : []
  return JSON.stringify({ version: SCHEMA_VERSION, macros: list.map(sanitizeForSharing) }, null, 2)
}

function importMacros(json, options = {}) {
  const fail = (message) => ({ macros: [], errors: [{ index: null, path: '', message }] })
  if (typeof json !== 'string') return fail('Import data must be JSON text.')
  if (Buffer.byteLength(json, 'utf8') > LIMITS.maxIpcPayloadBytes) return fail(`Import is larger than ${Math.round(LIMITS.maxIpcPayloadBytes / 1024)} KB.`)
  let parsed
  try { parsed = JSON.parse(json) } catch { return fail('Import is not valid JSON.') }
  let list
  if (Array.isArray(parsed)) list = parsed
  else if (isObj(parsed) && Array.isArray(parsed.macros)) list = parsed.macros
  else if (isObj(parsed) && isObj(parsed.trigger)) list = [parsed]
  else return fail('Import does not contain any macros.')
  const accountIds = Array.isArray(options.accountIds) ? options.accountIds.filter((id) => typeof id === 'string') : []
  const known = new Set(accountIds)
  const macros = []
  const errors = []
  for (const raw of list.slice(0, LIMITS.maxMacros)) {
    const macro = normalizeMacro({ ...(isObj(raw) ? raw : {}), id: undefined, origin: undefined, notify: undefined })
    if (macro.targets.mode === 'accounts') macro.targets.accountIds = macro.targets.accountIds.filter((id) => known.has(id))
    const problems = validateMacro(macro, { accountIds, editionOf: options.editionOf })
    if (problems.length) {
      macro.enabled = false
      for (const problem of problems) errors.push({ index: macros.length, name: macro.name, path: problem.path, message: problem.message })
    }
    macros.push(macro)
  }
  if (list.length > LIMITS.maxMacros) errors.push({ index: null, path: '', message: `Only the first ${LIMITS.maxMacros} macros were imported.` })
  return { macros, errors }
}

module.exports = { normalizeMacro, normalizeLibrary, validateMacro, migrateV1, toV1, exportMacros, importMacros }
