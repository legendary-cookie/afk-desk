'use strict'
// Macro engine v2 — Stage 0 interface contract.
// Design: docs/design/macro-engine.md. Every Stage 1 stream (A model, B triggers,
// C engine, D facade/actions) implements or consumes exactly what is declared
// here. Changing this file requires a contract update reviewed by the lead.
//
// Portability: this file and everything under electron/macro/ except facade.cjs
// must run on Node 18.20.4 (Android embedded engine). No Electron, Mineflayer,
// Node 20+ APIs (Promise.withResolvers, Array.prototype.toSorted, Set methods,
// Object.groupBy, etc.) or ESM.

// Resolved during Stage 1 (lead-reviewed; normative):
// - Time windows are half-open: an event exactly `window` ms after the start is outside it.
//   All matcher timing uses the injected now(); BotEvent.at is informational.
// - join: once per sessionId; also suppressed if another join was recorded for the account
//   < joinDuplicateWindowMs earlier (auto-reconnect waits >= 5 s, so real joins are unaffected).
// - Edge triggers (healthBelow, hungerBelow, inventoryFull) start ARMED: a first telemetry
//   already past the threshold fires. inventoryChanged never fires on a session's first telemetry.
// - Cooldowns are per (macro, account) and survive resetAccount/new sessions.
// - worldChange debounce is leading-edge; the first values of a session are a baseline only.
// - Glob: `*` may match empty text; `{name}` needs >= 1 char; shortest match; no escape for a
//   literal `*` (use contains). Chat matching never builds a RegExp from user input.
// - nextScheduleTime's 3rd argument may be { tzOffsetMinutesAt(ms) } (testable DST); default local.
// - Condition 'online' takes an optional boolean value (false = offline).
// - origin.fromV1 = { accountId, automationId } (automationId needed when ids collided).
//   origin.v2Only is set on any lossy migration; toV1 returns null for those.
// - Migrated macros use defaultDelayMs 0 (v1 had no inter-step delay) and onError 'continue'.
// - maxStepsPerMacro counts the whole step tree; an empty steps array is a blocking validation error.
// - Model extras: migrateV1 returns { library, migratedAccountIds, warnings } and accepts { now };
//   importMacros accepts { accountIds, editionOf }. Matcher extra: rejectedMacros().
// - Engine: RunEvent and RunRecord carry `reason` (e.g. 'busy', 'override', 'library', 'maxRuntime',
//   'engineError'). Library/override stops end as 'cancelled' + reason; 'stopped' is reserved for the
//   stop step, stopWhen and maxRuntime. Engine-internal errors: { runId: null, status: 'failed', reason: 'engineError' }.
// - stepPath encoding: [i] top level; [i, 0|1, j] inside if (0 = then, 1 = else); [i, j] inside repeat.
// - Timer phase starts at the first `spawn` of a new sessionId; Stage 2 must emit `spawn` for Bedrock too.
// - disconnect/reconnect steps: the engine adopts the session id seen after they settle instead of
//   fencing. Therefore the facade `reconnect` resolves only once the NEW session has spawned
//   (or rejects TIMEOUT/ABORTED).
// - Engine extras: constructor accepts { timers, nextScheduleTime, chatIntervalMs }; Stage 2 passes
//   triggers.nextScheduleTime. createScheduler accepts { onError }. RunRecord keeps ≤ 200 step entries.

const SCHEMA_VERSION = 2

const LIMITS = Object.freeze({
  maxMacros: 200,
  maxStepsPerMacro: 200,
  maxNestingDepth: 8,
  maxRunMacroDepth: 4,
  maxNameLength: 60,
  maxMessageLength: 256,
  maxPatternLength: 200,
  maxIpcPayloadBytes: 256 * 1024,
  runLogRingSize: 50,
  maxStepsPerSecond: 20,
  minLoopYieldMs: 50,
  defaultChatIntervalMs: 1500,
  minChatIntervalMs: 500,
  defaultDelayMs: 1000,
  cancelGraceMs: 2000,
  joinDuplicateWindowMs: 2000,
  worldChangeDebounceMs: 2000,
  ownMessageIgnoreMs: 5000,
  healthHysteresis: 2,
  hungerHysteresis: 2,
  webhookTimeoutMs: 10000,
  webhookMaxResponseBytes: 64 * 1024,
  webhookBatchWindowMs: 2000
})

// ---------------------------------------------------------------------------
// Enumerations. `editions` lists where the item can run.
// ---------------------------------------------------------------------------

const TRIGGER_TYPES = Object.freeze({
  manual: { label: 'Manual (Run now)', category: 'Triggers', editions: ['java', 'bedrock'] },
  playerAppears: { label: 'Player appears', category: 'Triggers', editions: ['java'] },
  join: { label: 'On server join', category: 'Triggers', editions: ['java', 'bedrock'] },
  worldChange: { label: 'On world / server change', category: 'Triggers', editions: ['java'] },
  timer: { label: 'Timer interval', category: 'Triggers', editions: ['java', 'bedrock'] },
  schedule: { label: 'Daily schedule (HH:MM)', category: 'Triggers', editions: ['java', 'bedrock'] },
  chat: { label: 'Chat message match', category: 'Triggers', editions: ['java', 'bedrock'] },
  death: { label: 'On death', category: 'Triggers', editions: ['java'] },
  disconnected: { label: 'On disconnect', category: 'Triggers', editions: ['java', 'bedrock'] },
  healthBelow: { label: 'Health drops below', category: 'Triggers', editions: ['java'] },
  hungerBelow: { label: 'Hunger drops below', category: 'Triggers', editions: ['java'] },
  inventoryFull: { label: 'Inventory becomes full', category: 'Triggers', editions: ['java'] },
  inventoryChanged: { label: 'Inventory changes', category: 'Triggers', editions: ['java'] },
  windowOpen: { label: 'Server window opens', category: 'Triggers', editions: ['java'] }
})

const STEP_TYPES = Object.freeze({
  chat: { label: 'Send chat / command', category: 'Communication', editions: ['java', 'bedrock'] },
  wait: { label: 'Wait / delay', category: 'Control', editions: ['java', 'bedrock'] },
  notify: { label: 'Send notification', category: 'Communication', editions: ['java', 'bedrock'] },
  move: { label: 'Move (walk)', category: 'Movement', editions: ['java'] },
  look: { label: 'Look / rotate', category: 'Movement', editions: ['java'] },
  control: { label: 'Sneak / jump / sprint', category: 'Movement', editions: ['java'] }, // sneak/jump/sprint hold|release
  autoclick: { label: 'Autoclick', category: 'Clicking', editions: ['java'] },
  leftClick: { label: 'Left click', category: 'Clicking', editions: ['java'] }, // once|hold|release
  rightClick: { label: 'Right click', category: 'Clicking', editions: ['java'] }, // once|hold|release
  selectHotbar: { label: 'Select hotbar slot', category: 'Inventory', editions: ['java'] },
  holdItem: { label: 'Hold item by name', category: 'Inventory', editions: ['java'] },
  useInventory: { label: 'Click player inventory', category: 'Inventory', editions: ['java'] },
  useGui: { label: 'Click open GUI slot', category: 'Inventory', editions: ['java'] },
  closeGui: { label: 'Close open GUI', category: 'Inventory', editions: ['java'] },
  waitForWindow: { label: 'Wait for server window', category: 'Inventory', editions: ['java'] },
  drop: { label: 'Drop item', category: 'Inventory', editions: ['java'] },
  dropAll: { label: 'Drop all matching items', category: 'Inventory', editions: ['java'] },
  deposit: { label: 'Deposit item', category: 'Inventory', editions: ['java'] },
  disconnect: { label: 'Disconnect account', category: 'Control', editions: ['java', 'bedrock'] },
  reconnect: { label: 'Reconnect account', category: 'Control', editions: ['java', 'bedrock'] },
  setVar: { label: 'Set variable (persistent option)', category: 'Logic', editions: ['java', 'bedrock'] },
  clearVar: { label: 'Clear variable', category: 'Logic', editions: ['java', 'bedrock'] },
  readLore: { label: 'Read item lore', category: 'Inventory', editions: ['java'] },
  set: { label: 'Set variable', category: 'Logic', editions: ['java', 'bedrock'] },
  if: { label: 'If / Else branch', category: 'Logic', editions: ['java', 'bedrock'] },
  repeat: { label: 'Repeat loop', category: 'Logic', editions: ['java', 'bedrock'] },
  stop: { label: 'Stop macro run', category: 'Control', editions: ['java', 'bedrock'] }
})

// Steps executed by the engine itself; all others go through the facade.
const ENGINE_STEP_TYPES = Object.freeze(['wait', 'set', 'setVar', 'clearVar', 'if', 'repeat', 'stop'])

const CONDITION_TYPES = Object.freeze(['always', 'online', 'healthBelow', 'hungerBelow', 'hasItem', 'itemCount', 'entityCount', 'inventoryFull', 'windowOpen', 'variableEquals', 'not'])

const CONDITION_METADATA = Object.freeze({
  always: { label: 'Always', category: 'Logic' },
  online: { label: 'Connection status', category: 'Logic' },
  healthBelow: { label: 'Health below', category: 'Logic' },
  hungerBelow: { label: 'Hunger below', category: 'Logic' },
  hasItem: { label: 'Has inventory item', category: 'Logic' },
  itemCount: { label: 'Inventory item count', category: 'Logic' },
  entityCount: { label: 'Nearby entity count', category: 'Logic' },
  inventoryFull: { label: 'Inventory is full', category: 'Logic' },
  windowOpen: { label: 'Server window is open', category: 'Logic' },
  variableEquals: { label: 'Variable equals', category: 'Logic' },
  not: { label: 'NOT (invert condition)', category: 'Logic' },
})

// Form fields describe the persisted keys. Empty schemas represent parameterless nodes.
const field = (type, label, options = {}) => ({ type, label, required: false, ...options })
const number = (label, min, max, defaultValue, required = false) => field('number', label, { min, max, default: defaultValue, required })
const string = (label, defaultValue = '', required = false) => field('string', label, { default: defaultValue, required })
const choice = (label, values, defaultValue, required = false) => field('string', label, { enum: values, default: defaultValue, required })
const bool = (label, defaultValue = false) => field('boolean', label, { default: defaultValue })
const condition = label => field('condition', label, { default: { type: 'always' } })
const selection = field('object', 'Item selector (slot, name or lore)', { default: { slot: 0 }, required: true })
const comparator = choice('Comparison', ['==', '!=', '<', '<=', '>', '>='], '>=')
const triggerSchemas = {
  playerAppears: { ignoreRegex: string('Ignore usernames matching regex') },
  timer: { intervalMs: number('Interval (ms)', 1000, 86400000, 60000, true), jitterMs: number('Jitter (ms)', 0, 43200000, 0) },
  schedule: { at: string('Time (HH:MM)', '', true) },
  chat: { match: choice('Match', ['contains', 'glob'], 'contains'), pattern: string('Pattern', '', true), sources: field('array', 'Sources (JSON)', { default: ['chat', 'system', 'actionBar'] }) },
  healthBelow: { below: number('Threshold', 0, 20, 8, true) }, hungerBelow: { below: number('Threshold', 0, 20, 14, true) },
  windowOpen: { title: string('Window title') }
}
const stepSchemas = {
  chat: { message: string('Message or command', '', true) },
  wait: { ms: number('Duration (ms)', 0, 3600000, 500), jitterMs: number('Jitter (ms)', 0, 60000, 0), minMs: number('Minimum (ms)', 0, 3600000, 0), maxMs: number('Maximum (ms)', 0, 3600000, 0) },
  notify: { message: string('Message', '', true), desktop: bool('Desktop', true), webhook: bool('Webhook') },
  move: { control: choice('Direction', ['forward', 'back', 'left', 'right'], 'forward', true), durationMs: number('Duration (ms)', 100, 10000, 350), distance: number('Distance', 0.5, 64, 1) },
  look: { mode: choice('Mode', ['absolute', 'relative', 'at'], 'relative', true), yaw: number('Yaw (radians)', -6.283185307, 6.283185307, 0), pitch: number('Pitch (radians)', -1.570796327, 1.570796327, 0), target: choice('Target', ['block', 'entity'], 'block'), x: number('X', -30000000, 30000000, 0), y: number('Y', -30000000, 30000000, 0), z: number('Z', -30000000, 30000000, 0), entity: string('Entity') },
  control: { control: choice('Control', ['sneak', 'jump', 'sprint'], 'sneak', true), action: choice('Action', ['hold', 'release'], 'hold', true) },
  autoclick: { button: choice('Button', ['left', 'right'], 'left'), cps: number('Clicks per second', 1, 20, 5), durationSec: number('Duration (seconds)', 1, 3600, null) },
  leftClick: { action: choice('Action', ['once', 'hold', 'release'], 'once', true), only: choice('Only', ['blocks', 'entities'], 'blocks') },
  rightClick: { action: choice('Action', ['once', 'hold', 'release'], 'once', true) },
  selectHotbar: { slot: number('Slot', 0, 8, 0, true) }, holdItem: { name: string('Item name', '', true) },
  useInventory: { select: selection, click: choice('Click', ['left', 'right', 'shift', 'drop'], 'left', true) },
  useGui: { select: selection, click: choice('Click', ['left', 'right', 'shift', 'drop'], 'left', true) },
  waitForWindow: { title: string('Window title'), giveUpAfterMs: number('Timeout (ms)', 100, 300000, 10000, true) },
  drop: { select: selection, count: number('Count', 1, 64, 1, true) }, deposit: { select: selection, count: number('Count', 1, 64, 1, true) }, dropAll: { filter: string('Name filter') },
  reconnect: { delaySec: number('Delay (seconds)', 0, 3600, 5), delayMs: number('Legacy delay (ms)', 0, 3600000, 0), maxAttempts: number('Maximum attempts', 1, 1000, 1) },
  set: { variable: string('Variable', '', true), value: field('primitive', 'Value', { default: '', required: true }), persist: bool('Persist') },
  setVar: { variable: string('Variable', '', true), value: field('primitive', 'Value', { default: '', required: true }), persist: bool('Persist') },
  clearVar: { variable: string('Variable', '', true) }, readLore: { select: selection, variable: string('Variable', '', true) },
  if: { condition: condition('If condition') }, repeat: { times: number('Repeat count', 1, 100000, 1), while: condition('While condition'), maxIterations: number('Maximum iterations', 1, 100000, 1000) }
}
const conditionSchemas = {
  online: { value: bool('Online', true) }, healthBelow: { value: number('Threshold', 0, 20, 8, true) }, hungerBelow: { value: number('Threshold', 0, 20, 14, true) },
  hasItem: { name: string('Item name', '', true), count: number('Count', 1, 2304, 1, true) },
  itemCount: { name: string('Item name', '', true), comparator, count: number('Count', 0, 1000000, 0, true) },
  entityCount: { entityType: choice('Entity type', ['mob', 'player', 'any'], 'any'), name: string('Name'), radius: number('Radius', 0, 256, 16), comparator, count: number('Count', 0, 1000000, 1) },
  windowOpen: { name: string('Window title') }, variableEquals: { name: string('Variable', '', true), value: field('primitive', 'Value', { default: '' }) }, not: { condition: condition('Condition') }
}
for (const [type, spec] of Object.entries(TRIGGER_TYPES)) spec.params = triggerSchemas[type] || {}
for (const [type, spec] of Object.entries(STEP_TYPES)) spec.params = stepSchemas[type] || {}
for (const [type, spec] of Object.entries(CONDITION_METADATA)) spec.params = conditionSchemas[type] || {}

const RUN_STATUSES = Object.freeze(['started', 'step', 'stepFailed', 'skipped', 'completed', 'failed', 'cancelled', 'interrupted', 'stopped'])

const ERROR_CODES = Object.freeze({
  OFFLINE: 'OFFLINE', // account not online / no live session
  UNSUPPORTED: 'UNSUPPORTED', // edition or capability missing
  LOCKED_SLOT: 'LOCKED_SLOT', // item lock forbids the operation
  NOT_FOUND: 'NOT_FOUND', // item/slot/window/macro not found
  TIMEOUT: 'TIMEOUT', // waitForWindow etc. gave up
  INVALID: 'INVALID', // bad step arguments at run time
  ABORTED: 'ABORTED', // the run's AbortSignal fired
  SESSION_CHANGED: 'SESSION_CHANGED', // session fence tripped
  RATE_LIMITED: 'RATE_LIMITED' // only for hard refusals; budgets delay instead
})

class MacroActionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MacroActionError'
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.INVALID
  }
}

// ---------------------------------------------------------------------------
// Data model (stream A normalizes/validates to exactly these shapes).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ version: 2, macros: Macro[], migratedFromV1?: { at: number, accountIds: string[] } }} MacroLibrary
 *
 * @typedef {Object} Macro
 * @property {string} id                     uuid, ≤80 chars
 * @property {string} name                   ≤60 chars
 * @property {boolean} enabled
 * @property {Targets} targets
 * @property {Trigger} trigger
 * @property {Condition[]} stopWhen          checked before each step and on events
 * @property {'skip'|'override'} concurrency
 * @property {'continue'|'stop'} onError
 * @property {number} defaultDelayMs         0..60000, inserted between facade steps
 * @property {number|null} maxRuntimeMs      null = unlimited
 * @property {Step[]} steps
 * @property {{ webhookRef?: string }} notify  secret stored elsewhere (safeStorage), only a ref here
 * @property {{ fromV1?: { accountId: string }, v2Only?: boolean }} origin  migration bookkeeping
 *
 * @typedef {{ mode: 'all' } | { mode: 'accounts', accountIds: string[] } | { mode: 'tags', tags: string[] }} Targets
 *
 * @typedef {Object} Trigger
 * @property {keyof typeof TRIGGER_TYPES} type
 * @property {number} [cooldownMs]           0..86400000
 * @property {number} [intervalMs]           timer: 1000..86400000
 * @property {number} [jitterMs]             timer: 0..intervalMs/2
 * @property {string} [at]                   schedule: "HH:MM" local machine time
 * @property {string} [pattern]              chat: contains-text or glob with * and {name}
 * @property {'contains'|'glob'} [match]     chat
 * @property {('chat'|'system'|'actionBar')[]} [sources] chat
 * @property {number} [below]                healthBelow 0..20 / hungerBelow 0..20
 * @property {string} [ignoreRegex]          playerAppears: JavaScript regex for usernames to skip
 * @property {string} [title]                windowOpen: optional contains-match on title
 *
 * @typedef {Object} Condition
 * @property {(typeof CONDITION_TYPES)[number]} type
 * @property {number|string|boolean} [value]
 * @property {string} [name]                 item name or variable name
 * @property {number} [count]
 * @property {Condition} [condition]         for 'not'
 *
 * Step = { type } plus the fields below for that type. Unknown fields are dropped.
 *   chat        { message }                         ({var} interpolation)
 *   wait        { ms, jitterMs? } | { minMs, maxMs }
 *   notify      { message, desktop?: boolean, webhook?: boolean }
 *   move        { control: 'forward'|'back'|'left'|'right', durationMs } | { control, distance }
 *   look        { mode: 'absolute', yaw, pitch } | { mode: 'relative', yaw, pitch } | { mode: 'at', target: 'block'|'entity', x?, y?, z?, entity? }
 *   control     { control: 'sneak'|'jump'|'sprint', action: 'hold'|'release' }
 *   leftClick   { action: 'once'|'hold'|'release', only?: 'blocks'|'entities' }
 *   rightClick  { action: 'once'|'hold'|'release' }
 *   selectHotbar{ slot: 0..8 }
 *   holdItem    { name }
 *   useInventory{ select: { slot } | { name } | { lore }, click: 'left'|'right'|'shift'|'drop' }
 *   useGui      { select: { slot } | { name } | { lore }, click: 'left'|'right'|'shift'|'drop' }
 *   closeGui    {}
 *   waitForWindow { title?, giveUpAfterMs }
 *   drop        { select: { slot } | { name }, count }
 *   dropAll     { filter? }                         (name contains; empty = all unlocked)
 *   deposit     { select: { slot } | { name }, count }
 *   disconnect  {}
 *   reconnect   { delaySec?: 0..3600 (default 5), maxAttempts?: 1..1000 (default 1) }
 *   set         { variable, value, persist?: boolean }
 *   setVar      { variable, value, persist?: boolean }
 *   clearVar    { variable } (also removes the persisted value)
 *   readLore    { select: { slot } | { name }, variable } (inventory lore joined by newlines)
 *   if          { condition, then: Step[], else: Step[] }
 *   repeat      { times } | { while: Condition, maxIterations? } with { steps: Step[] }
 *   stop        {}
 * @typedef {{ type: keyof typeof STEP_TYPES, [field: string]: any }} Step
 */

// ---------------------------------------------------------------------------
// Bot events fed to the trigger matcher (stream E adapts BotManager events to
// this shape; streams B and C consume it).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BotEvent
 * @property {'connected'|'spawn'|'respawn'|'login'|'serverSwitch'|'chat'|'telemetry'|'death'|'disconnected'|'windowOpen'|'windowClose'|'sentChat'|'playerAppears'} type
 * @property {string} accountId
 * @property {string} sessionId     changes on every new connection (TCP session)
 * @property {number} at            epoch ms
 * @property {Object} [payload]
 *   chat:        { text: string (formatting stripped), source: 'chat'|'system'|'actionBar' }
 *   sentChat:    { text }                         (own outgoing, for own-message ignore)
 *   telemetry:   { health, food, inventoryFull: boolean, inventorySignature: string, dimension, world }
 *   respawn/login/serverSwitch: { dimension?, world?, backend? }
 *   disconnected:{ reason: string, manual: boolean }
 *   windowOpen:  { title }
 *   playerAppears: { username }
 */

// ---------------------------------------------------------------------------
// Stream B — trigger matcher (electron/macro/triggers.cjs). Pure; injected clock.
// ---------------------------------------------------------------------------

/**
 * module.exports = { TriggerMatcher, compileChatPattern, nextScheduleTime }
 *
 * class TriggerMatcher {
 *   constructor({ now: () => number })
 *   setMacros(macros: Macro[], resolveTargets: (macro) => string[] /* accountIds *\/): void
 *     Builds the per-account trigger index. Only enabled macros. Rebuild is O(macros).
 *   onEvent(event: BotEvent): TriggerMatch[]
 *     Edge detection, hysteresis, cooldowns, join de-dup, world-change debounce,
 *     own-message ignore. Never throws on malformed payloads (returns []).
 *   timedTriggers(accountId): { macroId, trigger }[]   timer + schedule entries for the
 *     engine's scheduler (engine owns timing; matcher owns semantics).
 *   resetAccount(accountId): void                       on disconnect: clears edge/debounce state
 * }
 * @typedef {{ macroId: string, accountId: string, triggerType: string, variables: Object<string,string>, reason?: string }} TriggerMatch
 *
 * compileChatPattern(pattern: string, mode: 'contains'|'glob'): { test(text: string): null | Object<string,string> }
 *   Case-insensitive. Linear time in text length (no RegExp built from user input).
 *   Throws MacroActionError('INVALID') for patterns that fail validation.
 *
 * nextScheduleTime(at: "HH:MM", fromMs: number, tz?: 'local'): number
 *   Next fire strictly after fromMs in machine local time. DST: a nonexistent local
 *   time fires at the next valid minute; a repeated local time fires once.
 */

// ---------------------------------------------------------------------------
// Stream C — engine (electron/macro/engine.cjs). Pure; injected timers/clock.
// ---------------------------------------------------------------------------

/**
 * module.exports = { MacroEngine, createScheduler }
 *
 * createScheduler({ timers = globalThis, now = Date.now }) => {
 *   at(timeMs, fn, key?): () => void      returns cancel; one underlying setTimeout total
 *   after(ms, fn, key?): () => void
 *   cancelKey(key): void                  cancel every entry sharing key (e.g. accountId)
 *   size(): number
 *   dispose(): void
 * }
 *
 * class MacroEngine {
 *   constructor({ facade: MacroFacade, matcher: TriggerMatcher, scheduler, now,
 *                 emit: (event: RunEvent) => void,
 *                 getAccountState: (accountId) => AccountState,
 *                 resolveTargets: (macro) => string[],
 *                 random?: () => number })
 *   setLibrary(macros: Macro[]): void                 replans timers; stops runs of macros that were
 *                                                      deleted, disabled or edited (AFKCC behaviour)
 *   onBotEvent(event: BotEvent): void                  feeds matcher, starts runs, checks stopWhen
 *   run(accountId, macroId, { trigger?, variables? }): Promise<RunResult>   manual / programmatic
 *   stop(accountId, reason?): Promise<void>            resolves after cancellation settles (≤ cancelGraceMs)
 *   stopMacro(macroId): Promise<void>
 *   isRunning(accountId): boolean
 *   runLog(macroId): RunRecord[]                       ring buffer, newest last
 *   shutdown(): Promise<void>                          stops everything, releases all claims
 * }
 *
 * @typedef {{ online: boolean, sessionId: string|null, edition: 'java'|'bedrock', health?: number, food?: number,
 *             inventoryFull?: boolean, windowOpen?: boolean, inventory?: {name:string,count:number,slot:number}[] }} AccountState
 * @typedef {{ runId: string, macroId: string, accountId: string, status: (typeof RUN_STATUSES)[number],
 *             stepPath?: number[], stepType?: string, error?: { code: string, message: string }, at: number }} RunEvent
 * @typedef {{ runId: string, status: string, startedAt: number, endedAt: number, trigger: string,
 *             steps: { path: number[], type: string, ok: boolean, ms: number, error?: string }[] }} RunRecord
 * @typedef {{ runId: string, status: string }} RunResult
 *
 * Engine rules (normative): one run per account; 'skip' vs 'override'; onError
 * continue|stop; per-account step and chat budgets (delay, never fail); loops yield
 * ≥ minLoopYieldMs; session fence after every awaited facade call; cooperative
 * cancellation awaited up to cancelGraceMs, then fenced; claims released via
 * facade.releaseOwner(accountId, `macro:${runId}`) on every exit path.
 */

// ---------------------------------------------------------------------------
// Stream D — facade (electron/macro/facade.cjs) over BotManager. Every method:
//   (accountId, args, ctx) => Promise<any>
//   ctx = { signal: AbortSignal, owner: string /* 'macro:<runId>' */, sessionId: string }
// Must reject with MacroActionError (codes above). Must check ctx.signal before
// sending anything, and reject SESSION_CHANGED if the live session id ≠ ctx.sessionId.
// Item locks are enforced here, before any packet is sent.
// ---------------------------------------------------------------------------

const FACADE_METHODS = Object.freeze([
  'sessionId', // (accountId) => string|null   (sync)
  'state', // (accountId) => AccountState     (sync)
  'chat', // { message }
  'notify', // { message, desktop, webhook, macroId }
  'move', // { control, durationMs } | { control, distance }
  'look', // { mode, yaw, pitch, target, x, y, z, entity }
  'control', // { control, action }                 uses input ownership
  'autoclick', // { button, cps, durationSec }
  'leftClick', // { action, only }                     hold uses input ownership
  'rightClick', // { action }
  'selectHotbar', // { slot }
  'holdItem', // { name }
  'readLore', // { select, variable } -> plain text
  'useInventory', // { select, click }
  'useGui', // { select, click }
  'closeGui', // {}
  'waitForWindow', // { title, giveUpAfterMs }
  'drop', // { select, count }
  'dropAll', // { filter }
  'deposit', // { select, count }
  'disconnect', // {}                                  suppresses auto-reconnect
  'reconnect', // { delayMs }
  'releaseOwner' // (accountId, owner) => void (sync)  releases every claim held by owner
])

function assertFacade(facade) {
  const missing = FACADE_METHODS.filter((name) => typeof facade?.[name] !== 'function')
  if (missing.length) throw new TypeError(`Macro facade is missing: ${missing.join(', ')}`)
  return facade
}

// ---------------------------------------------------------------------------
// Input ownership (stream D adds to BotManager; existing manual paths become the
// 'manual' owner, anti-AFK becomes 'antiAfk'). The bot input is pressed while any
// owner holds it; an owner releases only its own claim.
//
//   bots.claimInput(accountId, input, owner): void
//   bots.releaseInput(accountId, input, owner): void
//   bots.releaseOwner(accountId, owner): void
//   bots.inputOwners(accountId, input): string[]
//   input ∈ INPUTS
// ---------------------------------------------------------------------------

const INPUTS = Object.freeze(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'leftClick', 'rightClick'])

// ---------------------------------------------------------------------------
// Stream A — model (electron/macro/model.cjs). Pure.
// ---------------------------------------------------------------------------

/**
 * module.exports = { normalizeMacro, normalizeLibrary, validateMacro, migrateV1, toV1,
 *                    exportMacros, importMacros }
 *
 * normalizeMacro(input): Macro                     clamps/drops; never throws on bad input
 * normalizeLibrary(input): MacroLibrary
 * validateMacro(macro, { accountIds, editionOf }): { path: string, message: string }[]
 *   Errors block enabling (e.g. missing inputs, unsupported edition for a target, runMacro cycles later).
 * migrateV1(accounts: {id, automations?}[], library: MacroLibrary): { library, migratedAccountIds: string[] }
 *   Idempotent via library.migratedFromV1.accountIds. Preserves v1 ids.
 * toV1(macro): object|null                         v1 automation shape, or null if v2-only
 * exportMacros(macros): string                     JSON; strips webhook refs and origin
 * importMacros(json, { accountIds }): { macros: Macro[], errors }   new ids; disabled if invalid
 */

// ---------------------------------------------------------------------------
// IPC (stream E). Registered via registerTrustedHandler; payloads ≤ maxIpcPayloadBytes.
// ---------------------------------------------------------------------------

const IPC = Object.freeze({
  contract: 'macros:contract',
  list: 'macros:list', // () => { macros, validation: {[macroId]: errors[]} }
  save: 'macros:save', // (macro) => macro
  remove: 'macros:delete', // (macroId) => void
  setEnabled: 'macros:set-enabled', // ({ macroId, enabled }) => macro
  run: 'macros:run', // ({ accountId, macroId }) => RunResult
  stop: 'macros:stop', // ({ accountId }) => void
  runs: 'macros:runs', // (macroId) => RunRecord[]
  importJson: 'macros:import', // (json) => { macros, errors }
  exportJson: 'macros:export', // (macroIds) => string
  event: 'macro-run' // main → renderer push, payload RunEvent
})

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  TRIGGER_TYPES,
  STEP_TYPES,
  ENGINE_STEP_TYPES,
  CONDITION_TYPES,
  CONDITION_METADATA,
  RUN_STATUSES,
  ERROR_CODES,
  MacroActionError,
  FACADE_METHODS,
  assertFacade,
  INPUTS,
  IPC
}
