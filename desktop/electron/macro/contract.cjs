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
  manual: { editions: ['java', 'bedrock'] },
  join: { editions: ['java', 'bedrock'] },
  worldChange: { editions: ['java'] },
  timer: { editions: ['java', 'bedrock'] },
  schedule: { editions: ['java', 'bedrock'] },
  chat: { editions: ['java', 'bedrock'] },
  death: { editions: ['java'] },
  disconnected: { editions: ['java', 'bedrock'] },
  healthBelow: { editions: ['java'] },
  hungerBelow: { editions: ['java'] },
  inventoryFull: { editions: ['java'] },
  inventoryChanged: { editions: ['java'] },
  windowOpen: { editions: ['java'] }
})

const STEP_TYPES = Object.freeze({
  chat: { editions: ['java', 'bedrock'] },
  wait: { editions: ['java', 'bedrock'] },
  notify: { editions: ['java', 'bedrock'] },
  move: { editions: ['java'] },
  look: { editions: ['java'] },
  control: { editions: ['java'] }, // sneak/jump/sprint hold|release
  leftClick: { editions: ['java'] }, // once|hold|release
  rightClick: { editions: ['java'] }, // once|hold|release
  selectHotbar: { editions: ['java'] },
  holdItem: { editions: ['java'] },
  useInventory: { editions: ['java'] },
  useGui: { editions: ['java'] },
  closeGui: { editions: ['java'] },
  waitForWindow: { editions: ['java'] },
  drop: { editions: ['java'] },
  dropAll: { editions: ['java'] },
  deposit: { editions: ['java'] },
  disconnect: { editions: ['java', 'bedrock'] },
  reconnect: { editions: ['java', 'bedrock'] },
  set: { editions: ['java', 'bedrock'] },
  if: { editions: ['java', 'bedrock'] },
  repeat: { editions: ['java', 'bedrock'] },
  stop: { editions: ['java', 'bedrock'] }
})

// Steps executed by the engine itself; all others go through the facade.
const ENGINE_STEP_TYPES = Object.freeze(['wait', 'set', 'if', 'repeat', 'stop'])

const CONDITION_TYPES = Object.freeze(['always', 'online', 'healthBelow', 'hungerBelow', 'hasItem', 'inventoryFull', 'windowOpen', 'variableEquals', 'not'])

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
 *   reconnect   { delayMs? }
 *   set         { variable, value }
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
 * @property {'connected'|'spawn'|'respawn'|'login'|'serverSwitch'|'chat'|'telemetry'|'death'|'disconnected'|'windowOpen'|'windowClose'|'sentChat'} type
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
  'leftClick', // { action, only }                     hold uses input ownership
  'rightClick', // { action }
  'selectHotbar', // { slot }
  'holdItem', // { name }
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
  RUN_STATUSES,
  ERROR_CODES,
  MacroActionError,
  FACADE_METHODS,
  assertFacade,
  INPUTS,
  IPC
}
