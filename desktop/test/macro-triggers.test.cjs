'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { LIMITS, MacroActionError } = require('../electron/macro/contract.cjs')
const triggersPath = require.resolve('../electron/macro/triggers.cjs')
const { TriggerMatcher, compileChatPattern, nextScheduleTime } = require(triggersPath)

const FIXTURES = path.join(__dirname, '..', 'test-fixtures', 'macro', 'triggers')
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

function macro(id, trigger, extra = {}) {
  return {
    id,
    name: id,
    enabled: true,
    targets: { mode: 'all' },
    trigger,
    stopWhen: [],
    concurrency: 'skip',
    onError: 'continue',
    defaultDelayMs: 1000,
    maxRuntimeMs: null,
    steps: [],
    notify: {},
    origin: {},
    ...extra
  }
}

function setup(macros, resolve = () => ['a1']) {
  const clock = makeClock()
  const matcher = new TriggerMatcher({ now: clock.now })
  matcher.setMacros(macros, resolve)
  return { clock, matcher }
}

let evSeq = 0
function ev(type, accountId, payload, sessionId = 's1') {
  evSeq += 1
  const e = { type, accountId, sessionId, at: evSeq }
  if (payload !== undefined) e.payload = payload
  return e
}

const ids = (matches) => matches.map((m) => m.macroId)
const tele = (payload) => ev('telemetry', 'a1', payload)

// ---------------------------------------------------------------------------
// exports / contract
// ---------------------------------------------------------------------------

test('exports exactly the contract surface', () => {
  assert.equal(typeof TriggerMatcher, 'function')
  assert.equal(typeof compileChatPattern, 'function')
  assert.equal(typeof nextScheduleTime, 'function')
  assert.deepEqual(Object.keys(require(triggersPath)).sort(), ['TriggerMatcher', 'compileChatPattern', 'nextScheduleTime'])
})

test('triggers.cjs builds no RegExp from input and has no Electron/Mineflayer/ESM imports', () => {
  const source = fs.readFileSync(triggersPath, 'utf8')
  assert.ok(!/new RegExp|[^.\w]RegExp\(/.test(source))
  assert.ok(!/require\(['"](electron|mineflayer|minecraft-protocol|\.\/model)/.test(source))
  assert.ok(!/^\s*import\s/m.test(source))
})

// ---------------------------------------------------------------------------
// compileChatPattern
// ---------------------------------------------------------------------------

test('compileChatPattern: fixture table of contains/glob cases', () => {
  const { cases, invalid } = readFixture('patterns.json')
  for (const c of cases) {
    const result = compileChatPattern(c.pattern, c.mode).test(c.text)
    assert.deepEqual(result, c.match, `${c.mode} ${JSON.stringify(c.pattern)} vs ${JSON.stringify(c.text)}`)
  }
  for (const c of invalid) {
    assert.throws(
      () => compileChatPattern(c.pattern, c.mode),
      (error) => error instanceof MacroActionError && error.code === 'INVALID',
      `${c.mode} ${JSON.stringify(c.pattern)} should be INVALID`
    )
  }
})

test('compileChatPattern: case-insensitive, captures keep the original case', () => {
  const p = compileChatPattern('{Who} SAID {what}', 'glob')
  assert.deepEqual(p.test('bOb said Hi There'), { Who: 'bOb', what: 'Hi There' })
})

test('compileChatPattern: no names gives {} and non-strings give null', () => {
  const p = compileChatPattern('a*b', 'glob')
  assert.deepEqual(p.test('aXXb'), {})
  assert.equal(p.test(42), null)
  assert.equal(p.test(undefined), null)
})

test('compileChatPattern: captures are minimal for non-final wildcards', () => {
  assert.deepEqual(compileChatPattern('{a}-{b}', 'glob').test('x-y-z'), { a: 'x', b: 'y-z' })
})

test('compileChatPattern: validation limits', () => {
  const ok = (p) => compileChatPattern(p, 'glob')
  const bad = (p, mode = 'glob') =>
    assert.throws(() => compileChatPattern(p, mode), (e) => e instanceof MacroActionError && e.code === 'INVALID')
  ok('x'.repeat(LIMITS.maxPatternLength))
  bad('x'.repeat(LIMITS.maxPatternLength + 1))
  bad('x'.repeat(LIMITS.maxPatternLength + 1), 'contains')
  bad('', 'contains')
  bad(null)
  const eight = Array.from({ length: 8 }, (_, i) => `{n${i}}`).join('.')
  ok(eight)
  bad(`${eight}.{n8}`)
  bad('{n}.{n}') // duplicate name
  bad('*{x}') // adjacent
  bad('{x}*') // adjacent
  bad('{x}{y}') // adjacent
  bad('a{b c}d') // bad name
  bad('{' + 'x'.repeat(33) + '}') // name too long
  ok('{' + 'x'.repeat(32) + '}')
})

test('compileChatPattern: __proto__ capture name is a normal data property', () => {
  const caps = compileChatPattern('a{__proto__}b', 'glob').test('aZb')
  assert.equal(Object.keys(caps).length, 1)
  assert.equal(Object.getOwnPropertyDescriptor(caps, '__proto__').value, 'Z')
  assert.equal(Object.getPrototypeOf(caps), Object.prototype)
})

test('compileChatPattern: pathological globs on a 100k-char line finish fast', () => {
  const sizes = 100_000
  const lines = [
    'a'.repeat(sizes),
    'a'.repeat(sizes - 1) + 'b',
    'ab'.repeat(sizes / 2),
    ('a'.repeat(199) + 'b').repeat(Math.floor(sizes / 200))
  ]
  const patterns = [
    '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*c',
    '{a}a{b}a{c}a{d}a{e}a{f}a{g}a{h}c',
    '*' + 'a'.repeat(198) + 'c*',
    '*' + ('a*'.repeat(80)) + 'c',
    '*aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab*b*b*b*b*b*c'
  ]
  const compiled = patterns.map((p) => compileChatPattern(p.slice(0, LIMITS.maxPatternLength), 'glob'))
  compiled[0].test('warm up a a a') // JIT warm-up outside the timed region
  for (const line of lines) {
    for (const pattern of compiled) {
      const t0 = process.hrtime.bigint()
      pattern.test(line)
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`)
    }
  }
  // Contains with a long self-overlapping needle.
  const contains = compileChatPattern('a'.repeat(199) + 'c', 'contains')
  const t0 = process.hrtime.bigint()
  assert.equal(contains.test('a'.repeat(sizes)), null)
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50)
})

test('compileChatPattern: result is correct on a large matching line', () => {
  const text = 'x'.repeat(50_000) + ' MID ' + 'y'.repeat(50_000)
  assert.deepEqual(compileChatPattern('{head} mid {tail}', 'glob').test(text), {
    head: 'x'.repeat(50_000),
    tail: 'y'.repeat(50_000)
  })
})

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('index: disabled macros are excluded and rebuilds replace the index', () => {
  const on = macro('on', { type: 'death' })
  const off = macro('off', { type: 'death' }, { enabled: false })
  const { matcher } = setup([on, off])
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1'))), ['on'])
  matcher.setMacros([off], () => ['a1'])
  assert.deepEqual(matcher.onEvent(ev('death', 'a1')), [])
  matcher.setMacros([macro('on', { type: 'death' }, { enabled: true })], () => ['a1'])
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1'))), ['on'])
})

test('index: multiple accounts are isolated and use resolveTargets', () => {
  const m = macro('m', { type: 'healthBelow', below: 10 })
  const { matcher } = setup([m], () => ['a1', 'a2', 'a1'])
  const a1 = matcher.onEvent(ev('telemetry', 'a1', { health: 5 }))
  assert.equal(a1.length, 1)
  assert.equal(a1[0].accountId, 'a1')
  // a2's edge state is independent of a1's.
  assert.equal(matcher.onEvent(ev('telemetry', 'a2', { health: 5 }, 't1')).length, 1)
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { health: 5 })).length, 0)
  // Account that is not a target never matches.
  assert.deepEqual(matcher.onEvent(ev('telemetry', 'a3', { health: 1 }, 'u1')), [])
})

test('index: default resolveTargets uses targets.accountIds for mode accounts', () => {
  const matcher = new TriggerMatcher({ now: makeClock().now })
  matcher.setMacros([macro('m', { type: 'death' }, { targets: { mode: 'accounts', accountIds: ['x'] } })])
  assert.equal(matcher.onEvent(ev('death', 'x')).length, 1)
  assert.equal(matcher.onEvent(ev('death', 'y')).length, 0)
})

test('index: invalid macros are skipped, not thrown; resolveTargets errors are contained', () => {
  const good = macro('good', { type: 'death' })
  const badChat = macro('bad', { type: 'chat', pattern: '**', match: 'glob' })
  const badHealth = macro('badh', { type: 'healthBelow' })
  const throwing = macro('boom', { type: 'death' })
  const matcher = new TriggerMatcher({ now: makeClock().now })
  matcher.setMacros([null, 5, badChat, badHealth, throwing, good], (m) => {
    if (m.id === 'boom') throw new Error('nope')
    return ['a1']
  })
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1'))), ['good'])
  assert.deepEqual(matcher.rejectedMacros().map((r) => r.macroId).sort(), ['bad', 'badh', 'boom'])
})

test('onEvent only touches the matching trigger type (O(matching))', () => {
  const macros = []
  for (let i = 0; i < 1000; i += 1) macros.push(macro(`c${i}`, { type: 'chat', pattern: `zzz${i}`, match: 'contains' }))
  macros.push(macro('d', { type: 'death' }))
  const { matcher } = setup(macros)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 2000; i += 1) matcher.onEvent(ev('death', 'a1'))
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200)
})

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

test('join: fires once per session on first spawn; duplicate spawns ignored', () => {
  const { matcher, clock } = setup([macro('j', { type: 'join' })])
  assert.deepEqual(ids(matcher.onEvent(ev('connected', 'a1'))), [])
  assert.deepEqual(ids(matcher.onEvent(ev('spawn', 'a1'))), ['j'])
  assert.deepEqual(matcher.onEvent(ev('spawn', 'a1')), [])
  clock.advance(LIMITS.joinDuplicateWindowMs + 1)
  assert.deepEqual(matcher.onEvent(ev('spawn', 'a1')), [])
  clock.advance(60_000)
  assert.deepEqual(matcher.onEvent(ev('spawn', 'a1')), [])
})

test('join: a new session fires again (auto-reconnect), a quick duplicate session does not', () => {
  const { matcher, clock } = setup([macro('j', { type: 'join' })])
  assert.equal(matcher.onEvent(ev('spawn', 'a1', undefined, 's1')).length, 1)
  clock.advance(500)
  assert.equal(matcher.onEvent(ev('spawn', 'a1', undefined, 's2')).length, 0)
  clock.advance(LIMITS.joinDuplicateWindowMs)
  assert.equal(matcher.onEvent(ev('spawn', 'a1', undefined, 's3')).length, 1)
})

test('join: resetAccount re-arms join and clears the duplicate window', () => {
  const { matcher } = setup([macro('j', { type: 'join' })])
  assert.equal(matcher.onEvent(ev('spawn', 'a1')).length, 1)
  matcher.resetAccount('a1')
  assert.equal(matcher.onEvent(ev('spawn', 'a1')).length, 1)
})

test('join: serverSwitch, login and respawn (even with changed backend) are not joins', () => {
  const { matcher } = setup([macro('j', { type: 'join' })])
  assert.deepEqual(matcher.onEvent(ev('login', 'a1', { backend: 'lobby' })), [])
  assert.deepEqual(matcher.onEvent(ev('respawn', 'a1', { backend: 'survival' })), [])
  assert.deepEqual(matcher.onEvent(ev('serverSwitch', 'a1', { backend: 'creative' })), [])
  // Real first spawn still fires afterwards, and later switches never do.
  assert.equal(matcher.onEvent(ev('spawn', 'a1')).length, 1)
  assert.deepEqual(matcher.onEvent(ev('serverSwitch', 'a1', { backend: 'lobby' })), [])
})

// ---------------------------------------------------------------------------
// worldChange
// ---------------------------------------------------------------------------

test('worldChange: first values are a baseline, later differences fire with variables', () => {
  const { matcher } = setup([macro('w', { type: 'worldChange' })])
  assert.deepEqual(matcher.onEvent(ev('login', 'a1', { dimension: 'overworld', world: 'w1' })), [])
  assert.deepEqual(matcher.onEvent(ev('respawn', 'a1', { dimension: 'overworld', world: 'w1' })), [])
  const m = matcher.onEvent(ev('respawn', 'a1', { dimension: 'nether', world: 'w1' }))
  assert.equal(m.length, 1)
  assert.deepEqual(m[0].variables, { reason: 'dimension', dimension: 'nether', world: 'w1' })
  assert.equal(m[0].reason, 'dimension')
  assert.equal(m[0].triggerType, 'worldChange')
})

test('worldChange: reasons dimension / world / server-switch', () => {
  const clock = makeClock()
  const matcher = new TriggerMatcher({ now: clock.now })
  matcher.setMacros([macro('w', { type: 'worldChange' })], () => ['a1'])
  const step = (type, payload) => {
    clock.advance(LIMITS.worldChangeDebounceMs + 1)
    return matcher.onEvent(ev(type, 'a1', payload))
  }
  step('login', { dimension: 'overworld', world: 'w1', backend: 'b1' })
  assert.equal(step('respawn', { dimension: 'end' })[0].variables.reason, 'dimension')
  assert.equal(step('respawn', { world: 'w2' })[0].variables.reason, 'world')
  assert.equal(step('respawn', { backend: 'b2' })[0].variables.reason, 'server-switch')
  assert.equal(step('serverSwitch', { world: 'w3' })[0].variables.reason, 'server-switch')
  // serverSwitch with nothing different does not fire.
  assert.deepEqual(step('serverSwitch', { world: 'w3' }), [])
  // Missing payload fields keep the last known value.
  assert.deepEqual(step('respawn', {}), [])
  assert.deepEqual(step('respawn'), [])
})

test('worldChange: leading-edge debounce suppresses changes inside the window, then fires again', () => {
  const { matcher, clock } = setup([macro('w', { type: 'worldChange' })])
  matcher.onEvent(ev('login', 'a1', { dimension: 'overworld' }))
  assert.equal(matcher.onEvent(ev('respawn', 'a1', { dimension: 'nether' })).length, 1)
  clock.advance(LIMITS.worldChangeDebounceMs - 1)
  assert.equal(matcher.onEvent(ev('respawn', 'a1', { dimension: 'end' })).length, 0)
  clock.advance(1) // exactly at the window end: outside
  // Last-seen was tracked while suppressed, so 'end' -> 'end' is not a change.
  assert.equal(matcher.onEvent(ev('respawn', 'a1', { dimension: 'end' })).length, 0)
  assert.equal(matcher.onEvent(ev('respawn', 'a1', { dimension: 'overworld' })).length, 1)
})

test('worldChange: telemetry seeds an unknown baseline but never overwrites it', () => {
  const { matcher } = setup([macro('w', { type: 'worldChange' })])
  matcher.onEvent(ev('telemetry', 'a1', { dimension: 'overworld', world: 'w1' }))
  assert.equal(matcher.onEvent(ev('respawn', 'a1', { dimension: 'nether' })).length, 1)
})

test('worldChange: a new session resets the baseline', () => {
  const { matcher, clock } = setup([macro('w', { type: 'worldChange' })])
  matcher.onEvent(ev('login', 'a1', { dimension: 'overworld' }, 's1'))
  clock.advance(10_000)
  assert.deepEqual(matcher.onEvent(ev('login', 'a1', { dimension: 'nether' }, 's2')), [])
})

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

const chatMacro = (extra = {}) => macro('c', { type: 'chat', pattern: 'hello', match: 'contains', ...extra })

test('chat: contains and glob with captures become variables', () => {
  const { matcher } = setup([
    chatMacro(),
    macro('g', { type: 'chat', pattern: '{player} whispers: {msg}', match: 'glob' })
  ])
  const m = matcher.onEvent(ev('chat', 'a1', { text: 'Steve whispers: HELLO bot', source: 'chat' }))
  assert.deepEqual(ids(m), ['c', 'g'])
  assert.deepEqual(m[0].variables, {})
  assert.deepEqual(m[1].variables, { player: 'Steve', msg: 'HELLO bot' })
})

test('chat: sources default to all three and can be filtered', () => {
  const { matcher } = setup([
    chatMacro(),
    macro('only-system', { type: 'chat', pattern: 'hello', match: 'contains', sources: ['system'] }),
    macro('empty-sources', { type: 'chat', pattern: 'hello', match: 'contains', sources: [] })
  ])
  const run = (source) => ids(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source })))
  assert.deepEqual(run('chat'), ['c', 'empty-sources'])
  assert.deepEqual(run('system'), ['c', 'only-system', 'empty-sources'])
  assert.deepEqual(run('actionBar'), ['c', 'empty-sources'])
  assert.deepEqual(matcher.onEvent(ev('chat', 'a1', { text: 'hello' })).length, 2) // source defaults to chat
  assert.deepEqual(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source: 'bogus' })), [])
})

test('chat: own sent message suppresses one identical incoming chat within the window', () => {
  const { matcher, clock } = setup([chatMacro()])
  matcher.onEvent(ev('sentChat', 'a1', { text: 'hello' }))
  clock.advance(1000)
  assert.deepEqual(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source: 'chat' })), [])
  // Only once.
  assert.equal(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source: 'chat' })).length, 1)
})

test('chat: own-message ignore expires and only suppresses identical text', () => {
  const { matcher, clock } = setup([chatMacro()])
  matcher.onEvent(ev('sentChat', 'a1', { text: 'hello' }))
  assert.equal(matcher.onEvent(ev('chat', 'a1', { text: 'hello there', source: 'chat' })).length, 1)
  clock.advance(LIMITS.ownMessageIgnoreMs)
  assert.equal(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source: 'chat' })).length, 1)
})

test('chat: own-message ignore is per account and cleared by resetAccount', () => {
  const { matcher } = setup([chatMacro()], () => ['a1', 'a2'])
  matcher.onEvent(ev('sentChat', 'a1', { text: 'hello' }))
  assert.equal(matcher.onEvent(ev('chat', 'a2', { text: 'hello', source: 'chat' }, 't1')).length, 1)
  matcher.resetAccount('a1')
  assert.equal(matcher.onEvent(ev('chat', 'a1', { text: 'hello', source: 'chat' })).length, 1)
})

test('chat: malformed payloads return []', () => {
  const { matcher } = setup([chatMacro()])
  for (const payload of [undefined, null, 5, 'x', {}, { text: 5 }, { text: null, source: 'chat' }]) {
    assert.deepEqual(matcher.onEvent(ev('chat', 'a1', payload)), [])
  }
})

// ---------------------------------------------------------------------------
// healthBelow / hungerBelow
// ---------------------------------------------------------------------------

test('health: oscillating around the threshold fires once', () => {
  const { matcher } = setup([macro('h', { type: 'healthBelow', below: 10 })])
  const fired = []
  for (const health of [20, 11, 10, 9, 10, 9, 11, 9, 8, 9.5, 11]) {
    fired.push(...matcher.onEvent(tele({ health })))
  }
  assert.equal(fired.length, 1)
  assert.equal(fired[0].variables.health, '9')
})

test('health: re-arms only at below + hysteresis, then fires on the next crossing', () => {
  const { matcher } = setup([macro('h', { type: 'healthBelow', below: 10 })])
  const fire = (health) => matcher.onEvent(tele({ health })).length
  assert.equal(fire(5), 1) // first telemetry already low fires
  assert.equal(fire(10), 0)
  assert.equal(fire(11.9), 0) // below + 2 is 12
  assert.equal(fire(5), 0) // still disarmed
  assert.equal(fire(12), 0) // re-arms
  assert.equal(fire(9.9), 1)
  assert.equal(fire(20), 0)
  assert.equal(fire(1), 1)
})

test('health: starts armed; a healthy first telemetry does not fire; value == below does not fire', () => {
  const { matcher } = setup([macro('h', { type: 'healthBelow', below: 10 })])
  assert.equal(matcher.onEvent(tele({ health: 20 })).length, 0)
  assert.equal(matcher.onEvent(tele({ health: 10 })).length, 0)
  assert.equal(matcher.onEvent(tele({ health: 9.99 })).length, 1)
})

test('hunger: edge + hysteresis use food and hungerHysteresis', () => {
  const { matcher } = setup([macro('u', { type: 'hungerBelow', below: 14 })])
  const fire = (food) => matcher.onEvent(tele({ food })).length
  assert.equal(fire(20), 0)
  assert.equal(fire(13), 1)
  assert.equal(fire(15), 0)
  assert.equal(fire(13), 0)
  assert.equal(fire(16), 0)
  assert.equal(fire(13), 1)
})

test('health: per-macro thresholds keep independent edge state', () => {
  const { matcher } = setup([
    macro('h10', { type: 'healthBelow', below: 10 }),
    macro('h5', { type: 'healthBelow', below: 5 })
  ])
  assert.deepEqual(ids(matcher.onEvent(tele({ health: 8 }))), ['h10'])
  assert.deepEqual(ids(matcher.onEvent(tele({ health: 4 }))), ['h5'])
  assert.deepEqual(ids(matcher.onEvent(tele({ health: 3 }))), [])
})

test('health: new session re-arms; resetAccount re-arms; non-numeric health is ignored', () => {
  const { matcher } = setup([macro('h', { type: 'healthBelow', below: 10 })])
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { health: 3 }, 's1')).length, 1)
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { health: 3 }, 's1')).length, 0)
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { health: 3 }, 's2')).length, 1)
  matcher.resetAccount('a1')
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { health: 3 }, 's2')).length, 1)
  for (const health of ['3', NaN, Infinity, null, undefined, {}]) {
    assert.deepEqual(matcher.onEvent(ev('telemetry', 'a1', { health }, 's3')), [])
  }
})

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

test('inventoryFull: edge false -> true, re-arms on true -> false', () => {
  const { matcher } = setup([macro('f', { type: 'inventoryFull' })])
  const fire = (inventoryFull) => matcher.onEvent(tele({ inventoryFull })).length
  assert.equal(fire(false), 0)
  assert.equal(fire(true), 1)
  assert.equal(fire(true), 0)
  assert.equal(fire(true), 0)
  assert.equal(fire(false), 0)
  assert.equal(fire(true), 1)
})

test('inventoryFull: first telemetry already full fires (armed initially); non-boolean ignored', () => {
  const { matcher } = setup([macro('f', { type: 'inventoryFull' })])
  assert.equal(matcher.onEvent(tele({ inventoryFull: 'yes' })).length, 0)
  assert.equal(matcher.onEvent(tele({ inventoryFull: true })).length, 1)
})

test('inventoryChanged: fires when the signature changes, not on the first telemetry', () => {
  const { matcher } = setup([macro('i', { type: 'inventoryChanged' })])
  const fire = (inventorySignature) => matcher.onEvent(tele({ inventorySignature })).length
  assert.equal(fire('a'), 0)
  assert.equal(fire('a'), 0)
  assert.equal(fire('b'), 1)
  assert.equal(fire('b'), 0)
  assert.equal(fire('a'), 1)
  assert.equal(matcher.onEvent(tele({ inventorySignature: 5 })).length, 0)
  // New session: first telemetry is a baseline again.
  assert.equal(matcher.onEvent(ev('telemetry', 'a1', { inventorySignature: 'z' }, 's2')).length, 0)
})

// ---------------------------------------------------------------------------
// death / disconnected / windowOpen
// ---------------------------------------------------------------------------

test('death fires on each death event', () => {
  const { matcher } = setup([macro('d', { type: 'death' })])
  assert.equal(matcher.onEvent(ev('death', 'a1')).length, 1)
  assert.equal(matcher.onEvent(ev('death', 'a1')).length, 1)
})

test('disconnected exposes reason and manual', () => {
  const { matcher } = setup([macro('x', { type: 'disconnected' })])
  const m = matcher.onEvent(ev('disconnected', 'a1', { reason: 'Kicked: AFK', manual: false }))
  assert.deepEqual(m[0].variables, { reason: 'Kicked: AFK', manual: 'false' })
  assert.equal(m[0].reason, 'Kicked: AFK')
  assert.deepEqual(matcher.onEvent(ev('disconnected', 'a1', { reason: 'bye', manual: true }))[0].variables, {
    reason: 'bye',
    manual: 'true'
  })
  assert.deepEqual(matcher.onEvent(ev('disconnected', 'a1'))[0].variables, { reason: '', manual: 'false' })
})

test('windowOpen: optional case-insensitive title contains-match', () => {
  const { matcher } = setup([
    macro('any', { type: 'windowOpen' }),
    macro('shop', { type: 'windowOpen', title: 'SHOP' })
  ])
  assert.deepEqual(ids(matcher.onEvent(ev('windowOpen', 'a1', { title: 'Server Shop - Blocks' }))), ['any', 'shop'])
  assert.deepEqual(ids(matcher.onEvent(ev('windowOpen', 'a1', { title: 'Chest' }))), ['any'])
  assert.deepEqual(ids(matcher.onEvent(ev('windowOpen', 'a1', {}))), ['any'])
  assert.deepEqual(matcher.onEvent(ev('windowOpen', 'a1', { title: 'Chest' }))[0].variables, { title: 'Chest' })
  assert.deepEqual(ids(matcher.onEvent(ev('windowClose', 'a1', { title: 'Shop' }))), [])
})

// ---------------------------------------------------------------------------
// cooldown
// ---------------------------------------------------------------------------

test('cooldown: per macro and account, survives resetAccount and new sessions', () => {
  const { matcher, clock } = setup(
    [macro('d', { type: 'death', cooldownMs: 10_000 }), macro('free', { type: 'death' })],
    () => ['a1', 'a2']
  )
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1'))), ['d', 'free'])
  clock.advance(9_999)
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1'))), ['free'])
  // Another account has its own cooldown.
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a2', undefined, 't1'))), ['d', 'free'])
  matcher.resetAccount('a1')
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1', undefined, 's9'))), ['free'])
  clock.advance(1)
  assert.deepEqual(ids(matcher.onEvent(ev('death', 'a1', undefined, 's9'))), ['d', 'free'])
})

test('cooldown: edge is consumed even when the cooldown suppresses the match', () => {
  const { matcher, clock } = setup([macro('h', { type: 'healthBelow', below: 10, cooldownMs: 60_000 })])
  assert.equal(matcher.onEvent(tele({ health: 5 })).length, 1)
  assert.equal(matcher.onEvent(tele({ health: 20 })).length, 0)
  clock.advance(1000)
  assert.equal(matcher.onEvent(tele({ health: 5 })).length, 0) // suppressed by cooldown
  assert.equal(matcher.onEvent(tele({ health: 5 })).length, 0) // edge was consumed, no re-fire
  clock.advance(60_000)
  assert.equal(matcher.onEvent(tele({ health: 20 })).length, 0)
  assert.equal(matcher.onEvent(tele({ health: 5 })).length, 1)
})

test('cooldown: removed macros drop their cooldown entries on setMacros', () => {
  const { matcher } = setup([macro('d', { type: 'death', cooldownMs: 60_000 })])
  assert.equal(matcher.onEvent(ev('death', 'a1')).length, 1)
  matcher.setMacros([], () => ['a1'])
  matcher.setMacros([macro('d', { type: 'death', cooldownMs: 60_000 })], () => ['a1'])
  assert.equal(matcher.onEvent(ev('death', 'a1')).length, 1)
})

// ---------------------------------------------------------------------------
// manual / timer / schedule, malformed
// ---------------------------------------------------------------------------

test('manual, timer and schedule never match events; timedTriggers lists timer + schedule', () => {
  const timer = macro('t', { type: 'timer', intervalMs: 5000 })
  const sched = macro('s', { type: 'schedule', at: '08:30' })
  const manual = macro('m', { type: 'manual' })
  const disabledTimer = macro('dt', { type: 'timer', intervalMs: 5000 }, { enabled: false })
  const { matcher } = setup(
    [timer, sched, manual, disabledTimer, macro('d', { type: 'death' })],
    (m) => (m.id === 's' ? ['a2'] : ['a1', 'a2'])
  )
  for (const type of ['connected', 'spawn', 'respawn', 'login', 'serverSwitch', 'death', 'disconnected', 'windowOpen']) {
    for (const m of matcher.onEvent(ev(type, 'a1'))) assert.ok(!['t', 's', 'm'].includes(m.macroId))
  }
  assert.deepEqual(matcher.timedTriggers('a1'), [{ macroId: 't', trigger: timer.trigger }])
  assert.deepEqual(matcher.timedTriggers('a2'), [
    { macroId: 't', trigger: timer.trigger },
    { macroId: 's', trigger: sched.trigger }
  ])
  assert.deepEqual(matcher.timedTriggers('nobody'), [])
  matcher.timedTriggers('a1').push('junk') // returned arrays are copies
  assert.equal(matcher.timedTriggers('a1').length, 1)
})

test('malformed events never throw and return []', () => {
  const { matcher } = setup([
    macro('c', { type: 'chat', pattern: 'x', match: 'contains' }),
    macro('h', { type: 'healthBelow', below: 10 }),
    macro('w', { type: 'worldChange' }),
    macro('d', { type: 'disconnected' }),
    macro('o', { type: 'windowOpen', title: 't' })
  ])
  const hostile = {
    get payload() { throw new Error('boom') },
    type: 'telemetry',
    accountId: 'a1',
    sessionId: 's1'
  }
  const events = [
    undefined, null, 0, 'x', [], {}, { type: 5 }, { type: 'chat' }, { type: 'chat', accountId: '' },
    { type: 'chat', accountId: 'a1', payload: 5 }, { type: 'telemetry', accountId: 'a1', payload: [] },
    { type: 'telemetry', accountId: 'a1', sessionId: 7, payload: { health: 'x', food: {} } },
    { type: 'respawn', accountId: 'a1', payload: { dimension: { toString() { throw new Error('x') } } } },
    { type: 'windowOpen', accountId: 'a1', payload: { title: 5 } },
    { type: 'nope', accountId: 'a1' }, hostile
  ]
  events.forEach((e, i) => assert.deepEqual(matcher.onEvent(e), [], `event #${i}`))
})

test('works without a clock option (defaults to Date.now)', () => {
  const matcher = new TriggerMatcher()
  matcher.setMacros([macro('d', { type: 'death' })], () => ['a1'])
  assert.equal(matcher.onEvent(ev('death', 'a1')).length, 1)
})

test('data-driven scenario fixture', () => {
  const scenario = readFixture('scenario-basic.json')
  const clock = makeClock()
  const matcher = new TriggerMatcher({ now: clock.now })
  matcher.setMacros(scenario.macros.map((m) => macro(m.id, m.trigger, { enabled: m.enabled })), (m) => scenario.accounts[m.id] || [])
  scenario.steps.forEach((step, i) => {
    if (step.advance) return clock.advance(step.advance)
    const got = matcher.onEvent({ at: 0, ...step.event })
    assert.deepEqual(
      got.map((g) => ({ macroId: g.macroId, triggerType: g.triggerType, variables: g.variables })),
      step.expect,
      `step ${i}`
    )
  })
})

// ---------------------------------------------------------------------------
// nextScheduleTime
// ---------------------------------------------------------------------------

const localMs = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime()

test('nextScheduleTime: later today, tomorrow, and exactly-now goes to tomorrow', () => {
  const from = localMs(2025, 5, 10, 10, 15)
  assert.equal(nextScheduleTime('11:00', from), localMs(2025, 5, 10, 11, 0))
  assert.equal(nextScheduleTime('09:00', from), localMs(2025, 5, 11, 9, 0))
  assert.equal(nextScheduleTime('10:15', from), localMs(2025, 5, 11, 10, 15))
  assert.equal(nextScheduleTime('10:15', from - 1), localMs(2025, 5, 10, 10, 15))
  assert.equal(nextScheduleTime('10:15', from + 30_000), localMs(2025, 5, 11, 10, 15))
  assert.equal(nextScheduleTime('00:00', localMs(2025, 5, 10, 23, 59)), localMs(2025, 5, 11, 0, 0))
  assert.equal(nextScheduleTime('23:59', localMs(2025, 5, 10, 0, 0)), localMs(2025, 5, 10, 23, 59))
  assert.equal(nextScheduleTime('9:05', from), localMs(2025, 5, 11, 9, 5))
  assert.equal(nextScheduleTime('09:00', from, 'local'), localMs(2025, 5, 11, 9, 0))
})

test('nextScheduleTime: month and year rollover', () => {
  assert.equal(nextScheduleTime('01:00', localMs(2025, 11, 31, 12, 0)), localMs(2026, 0, 1, 1, 0))
  assert.equal(nextScheduleTime('01:00', localMs(2024, 1, 28, 12, 0)), localMs(2024, 1, 29, 1, 0))
})

test('nextScheduleTime: invalid input throws INVALID', () => {
  const isInvalid = (e) => e instanceof MacroActionError && e.code === 'INVALID'
  for (const at of ['', '24:00', '12:60', '1230', 'ab:cd', '12:5', null, undefined, 12]) {
    assert.throws(() => nextScheduleTime(at, 0), isInvalid, String(at))
  }
  assert.throws(() => nextScheduleTime('10:00', NaN), isInvalid)
  assert.throws(() => nextScheduleTime('10:00', '5'), isInvalid)
  assert.throws(() => nextScheduleTime('10:00', 0, 'utc'), isInvalid)
})

// US-style zone, injected so the rules are testable on any machine zone.
// 2024-03-10 07:00Z: 02:00 EST -> 03:00 EDT. 2024-11-03 06:00Z: 02:00 EDT -> 01:00 EST.
const SPRING = Date.UTC(2024, 2, 10, 7, 0)
const FALL = Date.UTC(2024, 10, 3, 6, 0)
const usZone = {
  tzOffsetMinutesAt: (ms) => (ms < SPRING ? -300 : ms < FALL ? -240 : -300)
}
const utc = (...a) => Date.UTC(...a)

test('nextScheduleTime DST: plain day in an injected zone', () => {
  assert.equal(nextScheduleTime('09:00', utc(2024, 0, 15, 12, 0), usZone), utc(2024, 0, 15, 14, 0)) // 09:00 EST today
  assert.equal(nextScheduleTime('07:00', utc(2024, 0, 15, 12, 0), usZone), utc(2024, 0, 16, 12, 0)) // 07:00 EST tomorrow
  assert.equal(nextScheduleTime('09:00', utc(2024, 6, 15, 14, 0), usZone), utc(2024, 6, 16, 13, 0)) // 09:00 EDT tomorrow
})

test('nextScheduleTime DST: spring forward, nonexistent 02:30 fires at the first valid minute (03:00)', () => {
  const midnight = utc(2024, 2, 10, 5, 0) // 00:00 EST
  assert.equal(nextScheduleTime('02:30', midnight, usZone), SPRING) // 03:00 EDT
  assert.equal(nextScheduleTime('02:00', midnight, usZone), SPRING)
  assert.equal(nextScheduleTime('03:00', midnight, usZone), SPRING)
  // The following day it is a normal 02:30 EDT.
  assert.equal(nextScheduleTime('02:30', SPRING, usZone), utc(2024, 2, 11, 6, 30))
  // A time before the gap is untouched.
  assert.equal(nextScheduleTime('01:59', midnight, usZone), utc(2024, 2, 10, 6, 59))
  // A time after the gap uses the new offset.
  assert.equal(nextScheduleTime('03:30', midnight, usZone), utc(2024, 2, 10, 7, 30))
})

test('nextScheduleTime DST: fall back, repeated 01:30 fires only at the first occurrence', () => {
  const midnight = utc(2024, 10, 3, 4, 0) // 00:00 EDT
  const first = utc(2024, 10, 3, 5, 30) // 01:30 EDT
  const second = utc(2024, 10, 3, 6, 30) // 01:30 EST (never fires)
  assert.equal(nextScheduleTime('01:30', midnight, usZone), first)
  assert.equal(nextScheduleTime('01:30', first, usZone), utc(2024, 10, 4, 6, 30))
  assert.equal(nextScheduleTime('01:30', first + 15 * 60000, usZone), utc(2024, 10, 4, 6, 30))
  assert.notEqual(nextScheduleTime('01:30', first, usZone), second)
  // 02:30 after the fall back is a normal single occurrence in EST.
  assert.equal(nextScheduleTime('02:30', midnight, usZone), utc(2024, 10, 3, 7, 30))
})

test('nextScheduleTime DST: southern-hemisphere style and half-hour offsets', () => {
  // UTC+10:30 -> UTC+11 at 2024-10-05T16:00Z (02:00 local -> 02:30 local): 02:15 does not exist.
  const t = Date.UTC(2024, 9, 5, 15, 30) // transition instant: 02:00 at +10:30 is 15:30Z
  const zone = { tzOffsetMinutesAt: (ms) => (ms < t ? 630 : 660) }
  assert.equal(nextScheduleTime('02:15', utc(2024, 9, 5, 0, 0), zone), t)
  assert.equal(nextScheduleTime('02:45', utc(2024, 9, 5, 0, 0), zone), utc(2024, 9, 5, 15, 45))
})

test('nextScheduleTime: real machine-zone DST via TZ=America/New_York child process', (t) => {
  const code = `
    const { nextScheduleTime } = require(${JSON.stringify(triggersPath)})
    const jan = -new Date(Date.UTC(2024, 0, 15)).getTimezoneOffset()
    if (jan !== -300) { console.log(JSON.stringify({ skip: true })); process.exit(0) }
    const s = Date.UTC(2024, 2, 10, 5, 0)
    const f = Date.UTC(2024, 10, 3, 4, 0)
    console.log(JSON.stringify([
      nextScheduleTime('02:30', s),
      nextScheduleTime('01:30', f),
      nextScheduleTime('01:30', Date.UTC(2024, 10, 3, 5, 45))
    ]))`
  let out
  try {
    out = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }))
  } catch (error) {
    return t.skip(`could not run child: ${error.message}`)
  }
  if (out.skip) return t.skip('TZ environment variable is not honoured on this platform')
  assert.deepEqual(out, [SPRING, utc(2024, 10, 3, 5, 30), utc(2024, 10, 4, 6, 30)])
})
