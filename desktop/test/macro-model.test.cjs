const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LIMITS, TRIGGER_TYPES, STEP_TYPES, CONDITION_TYPES } = require('../electron/macro/contract.cjs')
const model = require('../electron/macro/model.cjs')
const { normalizeAutomations } = require('../electron/beta-core.cjs')

const { normalizeMacro, normalizeLibrary, validateMacro, migrateV1, toV1, exportMacros, importMacros } = model
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'macro', 'model', 'beta9-accounts.json'), 'utf8'))
const accountIds = ['acct-alpha', 'acct-beta', 'acct-gamma', 'acct-delta']
const editionOf = (id) => (id === 'acct-gamma' ? 'bedrock' : 'java')
const byId = (library, id) => library.macros.find((macro) => macro.id === id)
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child) }
  return value
}

function validMacro(overrides = {}) {
  return normalizeMacro({
    name: 'Valid', targets: { mode: 'accounts', accountIds: ['acct-alpha'] },
    trigger: { type: 'join' }, steps: [{ type: 'chat', message: '/afk' }], ...overrides
  })
}

test('exports exactly the contract API', () => {
  assert.deepEqual(Object.keys(model).sort(), ['exportMacros', 'importMacros', 'migrateV1', 'normalizeLibrary', 'normalizeMacro', 'toV1', 'validateMacro'])
})

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('normalizeMacro applies the documented defaults and generates an id', () => {
  const macro = normalizeMacro({})
  assert.match(macro.id, /^[0-9a-f-]{36}$/)
  assert.equal(macro.enabled, true)
  assert.deepEqual(macro.targets, { mode: 'accounts', accountIds: [] })
  assert.deepEqual(macro.stopWhen, [])
  assert.equal(macro.concurrency, 'skip')
  assert.equal(macro.onError, 'continue')
  assert.equal(macro.defaultDelayMs, LIMITS.defaultDelayMs)
  assert.equal(macro.maxRuntimeMs, null)
  assert.deepEqual(macro.trigger, { type: 'manual' })
  assert.deepEqual(macro.steps, [])
  assert.deepEqual(macro.notify, {})
  assert.deepEqual(macro.origin, {})
})

test('normalization never throws on garbage and always returns a macro and library', () => {
  const garbage = [undefined, null, 0, 1, NaN, true, 'x', [], {}, [1, 2, 3], () => {}, Symbol('s'), { steps: 'no', trigger: 7, targets: [] }, { steps: [null, 1, 'a', [], {}] }]
  for (const input of garbage) {
    const macro = normalizeMacro(input)
    assert.equal(typeof macro.id, 'string')
    assert.ok(Array.isArray(macro.steps))
    const library = normalizeLibrary(input)
    assert.equal(library.version, 2)
    assert.ok(Array.isArray(library.macros))
  }
})

test('normalization survives hostile getters and proxies', () => {
  const hostile = { get name() { throw new Error('boom') } }
  assert.doesNotThrow(() => normalizeMacro(hostile))
  assert.doesNotThrow(() => normalizeLibrary({ get macros() { throw new Error('boom') } }))
  assert.doesNotThrow(() => normalizeMacro(new Proxy({}, { get() { throw new Error('trap') } })))
})

test('clamps and drops values per LIMITS', () => {
  const macro = normalizeMacro({
    id: 'x'.repeat(500),
    name: 'n'.repeat(500),
    defaultDelayMs: 9e9,
    maxRuntimeMs: 5,
    concurrency: 'weird',
    onError: 'weird',
    trigger: { type: 'timer', intervalMs: 5, jitterMs: 9e9, cooldownMs: -5 },
    steps: [
      { type: 'chat', message: 'm'.repeat(1000), extra: 'dropped' },
      { type: 'wait', ms: -50 },
      { type: 'selectHotbar', slot: 99 },
      { type: 'notAType' },
      { type: '__proto__' },
      { type: 'constructor' },
      { type: 'toString' },
      { type: 'runMacro', macroId: 'abc' }
    ]
  })
  assert.equal(macro.id.length, 80)
  assert.equal(macro.name.length, LIMITS.maxNameLength)
  assert.equal(macro.defaultDelayMs, 60000)
  assert.equal(macro.maxRuntimeMs, 1000)
  assert.equal(macro.concurrency, 'skip')
  assert.equal(macro.onError, 'continue')
  assert.deepEqual(macro.trigger, { type: 'timer', cooldownMs: 0, intervalMs: 1000, jitterMs: 500 })
  assert.equal(macro.steps.length, 3)
  assert.equal(macro.steps[0].message.length, LIMITS.maxMessageLength)
  assert.equal(macro.steps[0].extra, undefined)
  assert.equal(macro.steps[1].ms, 0)
  assert.equal(macro.steps[2].slot, 8)
})

test('every contract trigger, step and condition type survives normalization; unknown ones are dropped', () => {
  for (const type of Object.keys(TRIGGER_TYPES)) assert.equal(normalizeMacro({ trigger: { type } }).trigger.type, type, type)
  for (const type of Object.keys(STEP_TYPES)) assert.equal(normalizeMacro({ steps: [{ type }] }).steps[0]?.type, type, type)
  for (const type of CONDITION_TYPES) assert.equal(normalizeMacro({ stopWhen: [{ type }] }).stopWhen[0].type, type, type)
  assert.equal(normalizeMacro({ trigger: { type: 'toString' } }).trigger.type, 'manual')
  assert.equal(normalizeMacro({ trigger: { type: 'playerAppears' } }).trigger.type, 'manual')
  assert.equal(normalizeMacro({ stopWhen: [{ type: 'playerAppears' }] }).stopWhen[0].type, 'always')
})

test('step shapes carry only their declared fields', () => {
  const macro = normalizeMacro({
    steps: [
      { type: 'wait', minMs: 900, maxMs: 300 },
      { type: 'wait', ms: 2000, jitterMs: 500 },
      { type: 'move', control: 'left', distance: 3, evil: 1 },
      { type: 'look', mode: 'at', target: 'entity', entity: 'Zombie', yaw: 1 },
      { type: 'look', mode: 'absolute', yaw: 100, pitch: -100 },
      { type: 'control', control: 'jump', action: 'release' },
      { type: 'useInventory', select: { lore: 'Shop', slot: 'nope' }, click: 'shift' },
      { type: 'useGui', select: { slot: 400 }, click: 'bad' },
      { type: 'drop', select: { lore: 'x' }, count: 1000 },
      { type: 'waitForWindow', title: 'Shop' },
      { type: 'reconnect', delayMs: 5000 },
      { type: 'repeat', while: { type: 'online' }, maxIterations: 5, steps: [{ type: 'stop' }] }
    ]
  })
  assert.deepEqual(macro.steps[0], { type: 'wait', minMs: 300, maxMs: 900 })
  assert.deepEqual(macro.steps[1], { type: 'wait', ms: 2000, jitterMs: 500 })
  assert.deepEqual(macro.steps[2], { type: 'move', control: 'left', distance: 3 })
  assert.deepEqual(macro.steps[3], { type: 'look', mode: 'at', target: 'entity', entity: 'Zombie' })
  assert.equal(macro.steps[4].yaw, Math.PI * 2)
  assert.equal(macro.steps[4].pitch, -Math.PI / 2)
  assert.deepEqual(macro.steps[6].select, { lore: 'Shop' })
  assert.deepEqual(macro.steps[7].select, { slot: 255 })
  assert.equal(macro.steps[7].click, 'left')
  assert.deepEqual(macro.steps[8].select, { name: '' })
  assert.equal(macro.steps[8].count, 64)
  assert.deepEqual(macro.steps[9], { type: 'waitForWindow', giveUpAfterMs: 10000, title: 'Shop' })
  assert.deepEqual(macro.steps[10], { type: 'reconnect', delayMs: 5000 })
  assert.deepEqual(macro.steps[11], { type: 'repeat', while: { type: 'online' }, maxIterations: 5, steps: [{ type: 'stop' }] })
})

test('huge arrays are bounded by the total step budget', () => {
  const many = Array.from({ length: 50000 }, () => ({ type: 'chat', message: 'x' }))
  assert.equal(normalizeMacro({ steps: many }).steps.length, LIMITS.maxStepsPerMacro)
  const nestedBomb = { type: 'repeat', times: 2, steps: Array.from({ length: 200 }, () => ({ type: 'repeat', times: 2, steps: Array.from({ length: 200 }, () => ({ type: 'chat', message: 'y' })) })) }
  const started = Date.now()
  const macro = normalizeMacro({ steps: Array.from({ length: 200 }, () => nestedBomb) })
  const count = (steps) => steps.reduce((sum, step) => sum + 1 + count(step.steps || []) + count(step.then || []) + count(step.else || []), 0)
  assert.ok(count(macro.steps) <= LIMITS.maxStepsPerMacro)
  assert.ok(Date.now() - started < 1000)
  const library = normalizeLibrary({ macros: Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, name: 'm' })) })
  assert.equal(library.macros.length, LIMITS.maxMacros)
  const targets = normalizeMacro({ targets: { mode: 'accounts', accountIds: Array.from({ length: 5000 }, (_, i) => `a${i}`) } }).targets
  assert.ok(targets.accountIds.length <= 500)
})

test('nesting depth is enforced for steps and conditions without recursion overflow', () => {
  let step = { type: 'chat', message: 'leaf' }
  for (let i = 0; i < 5000; i += 1) step = { type: 'if', condition: { type: 'always' }, then: [step], else: [] }
  let condition = { type: 'online' }
  for (let i = 0; i < 5000; i += 1) condition = { type: 'not', condition }
  const macro = normalizeMacro({ steps: [step], stopWhen: [condition] })
  let depth = 0
  for (let cursor = macro.steps[0]; cursor && cursor.then; cursor = cursor.then[0]) depth += 1
  assert.ok(depth <= LIMITS.maxNestingDepth + 1, `depth ${depth}`)
  let conditionDepth = 0
  for (let cursor = macro.stopWhen[0]; cursor && cursor.condition; cursor = cursor.condition) conditionDepth += 1
  assert.ok(conditionDepth <= LIMITS.maxNestingDepth + 1)
  // Self-referential input must not loop forever either.
  const cyclic = { type: 'if', condition: { type: 'always' }, then: [], else: [] }
  cyclic.then.push(cyclic)
  assert.doesNotThrow(() => normalizeMacro({ steps: [cyclic] }))
})

test('prototype-pollution keys do not pollute and are not copied', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"name":"p","constructor":{"prototype":{"polluted2":true}},"trigger":{"type":"manual","__proto__":{"polluted3":true}},"steps":[{"type":"chat","message":"x","__proto__":{"polluted4":true}},{"type":"set","variable":"__proto__","value":"x"}],"targets":{"mode":"accounts","accountIds":["__proto__","constructor"],"__proto__":{"polluted5":true}},"notify":{"__proto__":{"polluted6":true}},"origin":{"__proto__":{"polluted7":true}}}')
  const macro = normalizeMacro(payload)
  const library = normalizeLibrary({ macros: [payload], __proto__: { polluted8: true } })
  exportMacros([payload])
  importMacros(JSON.stringify({ macros: [payload] }), { accountIds: ['__proto__'] })
  migrateV1([{ id: 'a', automations: [JSON.parse('{"id":"__proto__","name":"x","trigger":{"type":"manual"},"steps":[{"type":"chat","message":"m","__proto__":{"polluted9":true}}]}')] }], library)
  for (let i = 1; i <= 9; i += 1) assert.equal({}[`polluted${i === 1 ? '' : i}`], undefined)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.keys(macro).includes('__proto__'), false)
  assert.equal(Object.keys(macro.trigger).includes('__proto__'), false)
  assert.equal(macro.steps[0].polluted4, undefined)
  assert.equal(Object.getPrototypeOf(macro.targets), Object.prototype)
  assert.equal(macro.steps[1].variable, '__proto__'.replace(/[^A-Za-z0-9_.-]/g, ''))
})

test('normalizeLibrary dedupes ids, keeps migratedFromV1, and is idempotent', () => {
  const library = normalizeLibrary({
    version: 99,
    macros: [{ id: 'same', name: 'a' }, { id: 'same', name: 'b' }, { name: 'c' }],
    migratedFromV1: { at: 5, accountIds: ['a', 'a', 'b', 7] }
  })
  assert.equal(library.version, 2)
  assert.equal(new Set(library.macros.map((macro) => macro.id)).size, 3)
  assert.deepEqual(library.migratedFromV1, { at: 5, accountIds: ['a', 'b'] })
  assert.deepEqual(normalizeLibrary(library), library)
  assert.deepEqual(normalizeMacro(library.macros[0]), library.macros[0])
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a complete macro validates cleanly', () => {
  assert.deepEqual(validateMacro(validMacro(), { accountIds, editionOf }), [])
})

test('validateMacro reports blocking errors with JSON-pointer paths', () => {
  const macro = normalizeMacro({
    targets: { mode: 'accounts', accountIds: [] },
    trigger: { type: 'schedule', at: '25:99' },
    steps: [
      { type: 'chat', message: '' },
      { type: 'notify', message: '  ' },
      { type: 'set', variable: '' },
      { type: 'holdItem', name: '' },
      { type: 'drop', select: { name: '' }, count: 1 },
      { type: 'if', condition: { type: 'hasItem', name: '' }, then: [{ type: 'chat', message: '' }], else: [] },
      { type: 'repeat', while: { type: 'variableEquals', name: '' }, steps: [] },
      { type: 'look', mode: 'at', target: 'block' },
      { type: 'notify', message: 'hook', webhook: true }
    ]
  })
  assert.equal(normalizeMacro({ name: '   ' }).name, 'Untitled macro')
  const errors = validateMacro({ ...macro, name: '   ' }, { accountIds, editionOf })
  const paths = errors.map((error) => error.path)
  for (const expected of ['/name', '/targets/accountIds', '/trigger/at', '/steps/0/message', '/steps/1/message', '/steps/2/variable', '/steps/3/name', '/steps/4/select', '/steps/5/condition/name', '/steps/5/then/0/message', '/steps/6/while/name', '/steps/7/x', '/steps/8/webhook']) {
    assert.ok(paths.includes(expected), `missing ${expected} in ${paths.join(', ')}`)
  }
  assert.ok(errors.every((error) => typeof error.message === 'string' && error.message))
})

test('validateMacro: schedule time format', () => {
  const at = (value) => validateMacro(validMacro({ trigger: { type: 'schedule', at: value } }), { accountIds, editionOf }).map((e) => e.path)
  assert.deepEqual(at('07:30'), [])
  assert.deepEqual(at('23:59'), [])
  for (const bad of ['7:30', '24:00', '12:60', '', 'noon', '12:3']) assert.deepEqual(at(bad), ['/trigger/at'], bad)
})

test('validateMacro: glob pattern length, targets and unknown accounts', () => {
  const long = validMacro({ trigger: { type: 'chat', match: 'glob', pattern: 'a'.repeat(LIMITS.maxPatternLength + 1) } })
  assert.deepEqual(validateMacro(long, { accountIds, editionOf }).map((e) => e.path), ['/trigger/pattern'])
  const exact = validMacro({ trigger: { type: 'chat', match: 'glob', pattern: 'a'.repeat(LIMITS.maxPatternLength) } })
  assert.deepEqual(validateMacro(exact, { accountIds, editionOf }), [])
  const ghost = validMacro({ targets: { mode: 'accounts', accountIds: ['acct-alpha', 'gone'] } })
  assert.deepEqual(validateMacro(ghost, { accountIds, editionOf }).map((e) => e.path), ['/targets/accountIds/1'])
  assert.deepEqual(validateMacro(validMacro({ targets: { mode: 'tags', tags: [] } }), { accountIds, editionOf }).map((e) => e.path), ['/targets/tags'])
  assert.deepEqual(validateMacro(validMacro({ targets: { mode: 'all' } }), { accountIds: [], editionOf }).map((e) => e.path), ['/targets'])
  assert.deepEqual(validateMacro(validMacro({ steps: [] }), { accountIds, editionOf }).map((e) => e.path), ['/steps'])
})

test('validateMacro: edition support for triggers and steps on target accounts', () => {
  const macro = validMacro({
    targets: { mode: 'accounts', accountIds: ['acct-alpha', 'acct-gamma'] },
    trigger: { type: 'death' },
    steps: [{ type: 'chat', message: 'hi' }, { type: 'move', control: 'forward', durationMs: 300 }, { type: 'if', condition: { type: 'always' }, then: [{ type: 'look', mode: 'relative', yaw: 0.1, pitch: 0 }], else: [] }]
  })
  const errors = validateMacro(macro, { accountIds, editionOf })
  assert.deepEqual(errors.map((error) => error.path), ['/trigger/type', '/steps/1/type', '/steps/2/then/0/type'])
  assert.match(errors[0].message, /Bedrock/)
  assert.match(errors[0].message, /acct-gamma/)
  // Java-only targets are fine with the same macro.
  assert.deepEqual(validateMacro({ ...macro, targets: { mode: 'accounts', accountIds: ['acct-alpha'] } }, { accountIds, editionOf }), [])
  // mode "all" resolves against the supplied accounts.
  assert.equal(validateMacro({ ...macro, targets: { mode: 'all' } }, { accountIds, editionOf }).length, 3)
  // Bedrock-safe macro passes on a Bedrock account; a throwing editionOf is tolerated.
  const safe = validMacro({ targets: { mode: 'accounts', accountIds: ['acct-gamma'] }, trigger: { type: 'chat', pattern: 'hi' }, steps: [{ type: 'chat', message: 'x' }, { type: 'wait', ms: 10 }, { type: 'notify', message: 'n' }] })
  assert.deepEqual(validateMacro(safe, { accountIds, editionOf }), [])
  assert.doesNotThrow(() => validateMacro(safe, { accountIds, editionOf: () => { throw new Error('nope') } }))
})

test('validateMacro never throws on malformed input', () => {
  for (const input of [null, undefined, 5, 'x', [], { steps: 'x', trigger: 5, targets: 5 }, new Proxy({}, { get() { throw new Error('x') } })]) {
    assert.doesNotThrow(() => validateMacro(input, { accountIds, editionOf }))
    assert.ok(Array.isArray(validateMacro(input, { accountIds, editionOf })))
  }
  assert.doesNotThrow(() => validateMacro(validMacro()))
})

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('migrateV1 maps every trigger type', () => {
  const triggers = [
    [{ type: 'manual' }, { type: 'manual' }],
    [{ type: 'connected' }, { type: 'join' }],
    [{ type: 'disconnected' }, { type: 'disconnected' }],
    [{ type: 'chat', contains: 'Hello' }, { type: 'chat', match: 'contains', pattern: 'Hello' }],
    [{ type: 'health', below: 7 }, { type: 'healthBelow', below: 7 }],
    [{ type: 'inventory' }, { type: 'inventoryChanged' }],
    [{ type: 'window' }, { type: 'windowOpen' }],
    [{ type: 'timer', intervalSeconds: 90 }, { type: 'timer', intervalMs: 90000, jitterMs: 0 }],
    [{ type: 'timer', intervalSeconds: 1 }, { type: 'timer', intervalMs: 2000, jitterMs: 0 }],
    [{ type: 'unknown' }, { type: 'manual' }]
  ]
  const accounts = [{ id: 'a', automations: triggers.map(([trigger], i) => ({ id: `t${i}`, name: `T${i}`, trigger, steps: [{ type: 'chat', message: 'x' }] })) }]
  const { library } = migrateV1(accounts, undefined)
  triggers.forEach(([, expected], i) => assert.deepEqual(byId(library, `t${i}`).trigger, expected, `trigger ${i}`))
})

test('migrateV1 maps every step type', () => {
  const v1 = {
    id: 'steps', name: 'All steps', trigger: { type: 'manual' },
    steps: [
      { type: 'chat', message: '/hi' },
      { type: 'wait', milliseconds: 750 },
      { type: 'move', control: 'back', duration: 600 },
      { type: 'look', direction: 'left' },
      { type: 'look', direction: 'right' },
      { type: 'drop', slot: 12, count: 3 },
      { type: 'deposit', slot: 14, count: 9 },
      { type: 'equip', slot: 38, destination: 'head' },
      { type: 'clickGui', slot: 21 },
      { type: 'attackNearest' },
      { type: 'useHeld' },
      { type: 'notify', message: 'done' },
      { type: 'set', variable: 'count', value: 2 },
      { type: 'if', condition: { type: 'healthBelow', value: 9 }, then: [{ type: 'chat', message: 'low' }], else: [{ type: 'chat', message: 'ok' }] },
      { type: 'repeat', times: 4, steps: [{ type: 'wait', milliseconds: 100 }] }
    ]
  }
  const { library, warnings } = migrateV1([{ id: 'a', automations: [v1] }], undefined)
  const macro = byId(library, 'steps')
  assert.deepEqual(macro.steps, [
    { type: 'chat', message: '/hi' },
    { type: 'wait', ms: 750 },
    { type: 'move', control: 'back', durationMs: 600 },
    { type: 'look', mode: 'relative', yaw: -0.45, pitch: 0 },
    { type: 'look', mode: 'relative', yaw: 0.45, pitch: 0 },
    { type: 'drop', select: { slot: 12 }, count: 3 },
    { type: 'deposit', select: { slot: 14 }, count: 9 },
    { type: 'useGui', select: { slot: 21 }, click: 'left' },
    { type: 'leftClick', action: 'once', only: 'entities' },
    { type: 'rightClick', action: 'once' },
    { type: 'notify', message: 'done', desktop: true, webhook: false },
    { type: 'set', variable: 'count', value: 2 },
    { type: 'if', condition: { type: 'healthBelow', value: 9 }, then: [{ type: 'chat', message: 'low' }], else: [{ type: 'chat', message: 'ok' }] },
    { type: 'repeat', times: 4, steps: [{ type: 'wait', ms: 100 }] }
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /equip/)
  assert.equal(macro.origin.v2Only, true, 'a lossy migration is flagged so write-back never overwrites the richer v1 data')
})

test('migrateV1 maps conditions and records defaults for migrated macros', () => {
  const { library, warnings } = migrateV1([{ id: 'a', automations: [{
    id: 'c', name: 'C', enabled: false, trigger: { type: 'manual' },
    steps: [
      { type: 'if', condition: { type: 'status', value: 'online' }, then: [{ type: 'chat', message: '1' }], else: [] },
      { type: 'if', condition: { type: 'status', value: 'offline' }, then: [{ type: 'chat', message: '2' }], else: [] },
      { type: 'if', condition: { type: 'hungerBelow', value: 12 }, then: [{ type: 'chat', message: '3' }], else: [] },
      { type: 'if', condition: { type: 'hasItem', name: 'iron', count: 5 }, then: [{ type: 'chat', message: '4' }], else: [] },
      { type: 'if', condition: { type: 'variableEquals', name: 'v', value: 'x' }, then: [{ type: 'chat', message: '5' }], else: [] },
      { type: 'if', condition: { type: 'chatContains', value: 'zzz' }, then: [{ type: 'chat', message: '6' }], else: [] },
      { type: 'if', condition: { type: 'status', value: 'connecting' }, then: [{ type: 'chat', message: '7' }], else: [] }
    ]
  }] }], undefined)
  const macro = byId(library, 'c')
  assert.deepEqual(macro.steps.map((step) => step.condition), [
    { type: 'online', value: true },
    { type: 'not', condition: { type: 'online', value: true } },
    { type: 'hungerBelow', value: 12 },
    { type: 'hasItem', name: 'iron', count: 5 },
    { type: 'variableEquals', name: 'v', value: 'x' },
    { type: 'always' },
    { type: 'always' }
  ])
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /chat contains/)
  assert.equal(macro.enabled, false, 'enabled flag preserved')
  assert.deepEqual(macro.targets, { mode: 'accounts', accountIds: ['a'] })
  assert.equal(macro.defaultDelayMs, 0)
  assert.equal(macro.onError, 'continue')
  assert.equal(macro.concurrency, 'skip')
  assert.deepEqual(macro.origin, { fromV1: { accountId: 'a' }, v2Only: true })
})

test('migrateV1 expands timed jump/sneak/sprint moves (no v2 timed equivalent)', () => {
  const { library, warnings } = migrateV1([{ id: 'a', automations: [{ id: 'j', name: 'J', trigger: { type: 'manual' }, steps: [{ type: 'move', control: 'jump', duration: 400 }] }] }], undefined)
  assert.deepEqual(byId(library, 'j').steps, [
    { type: 'control', control: 'jump', action: 'hold' },
    { type: 'wait', ms: 400 },
    { type: 'control', control: 'jump', action: 'release' }
  ])
  assert.deepEqual(warnings, [])
  assert.equal(byId(library, 'j').origin.v2Only, true)
})

test('migrateV1 on the beta.9-shaped fixture', () => {
  const accounts = fixture()
  const { library, migratedAccountIds, warnings } = migrateV1(accounts, undefined, { now: 1234 })
  assert.deepEqual(migratedAccountIds, ['acct-alpha', 'acct-beta', 'acct-gamma'])
  assert.deepEqual(library.migratedFromV1, { at: 1234, accountIds: ['acct-alpha', 'acct-beta', 'acct-gamma'] })
  // 8 usable alpha automations (the step-less one never ran in v1 and is not migrated) + 1 beta + 1 gamma.
  assert.equal(library.macros.length, 10)
  assert.equal(byId(library, 'auto-empty'), undefined)
  assert.equal(library.macros.filter((m) => m.targets.accountIds[0] === 'acct-delta').length, 0)
  assert.equal(byId(library, 'auto-disconnect').enabled, false)
  assert.equal(byId(library, 'auto-window').enabled, false)
  assert.equal(byId(library, 'auto-bedrock').trigger.pattern, 'hello gamma')
  assert.ok(warnings.some((w) => /equip/.test(w) && /Alpha main/.test(w)))
  assert.ok(warnings.some((w) => /chat contains/.test(w)))
  // Every migrated macro is valid for its account and normalization is a fixed point.
  for (const macro of library.macros) {
    assert.deepEqual(normalizeMacro(macro), macro)
    assert.deepEqual(validateMacro(macro, { accountIds, editionOf }), [], macro.id)
  }
  assert.deepEqual(normalizeLibrary(library), library)
})

test('migrateV1 is idempotent: a second run adds nothing and skips migrated accounts', () => {
  const accounts = fixture()
  const first = migrateV1(accounts, undefined, { now: 1 })
  const second = migrateV1(accounts, first.library, { now: 2 })
  assert.deepEqual(second.migratedAccountIds, [])
  assert.deepEqual(second.library, first.library)
  assert.equal(second.library.macros.length, first.library.macros.length)
  assert.equal(second.library.migratedFromV1.at, 1)
  // A profile imported later is migrated on its own, once.
  const later = [...accounts, { id: 'acct-late', automations: [{ id: 'late-1', name: 'Late', trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'late' }] }] }]
  const third = migrateV1(later, second.library, { now: 3 })
  assert.deepEqual(third.migratedAccountIds, ['acct-late'])
  assert.equal(third.library.macros.length, first.library.macros.length + 1)
  assert.deepEqual(third.library.migratedFromV1.accountIds, ['acct-alpha', 'acct-beta', 'acct-gamma', 'acct-late'])
  assert.deepEqual(migrateV1(later, third.library).migratedAccountIds, [])
})

test('migrateV1 resolves id collisions and keeps the v1 id for write-back', () => {
  const accounts = fixture()
  const { library } = migrateV1(accounts, undefined)
  const alpha = byId(library, 'auto-join')
  assert.equal(alpha.targets.accountIds[0], 'acct-alpha')
  assert.deepEqual(alpha.origin, { fromV1: { accountId: 'acct-alpha' } })
  const beta = library.macros.find((macro) => macro.targets.accountIds[0] === 'acct-beta')
  assert.notEqual(beta.id, 'auto-join')
  assert.equal(beta.origin.fromV1.automationId, 'auto-join')
  assert.equal(toV1(beta).id, 'auto-join', 'write-back targets the original v1 automation id')
  assert.equal(new Set(library.macros.map((m) => m.id)).size, library.macros.length)
  // Collision with a pre-existing v2 macro too.
  const existing = normalizeLibrary({ macros: [{ id: 'auto-bedrock', name: 'Existing' }] })
  const merged = migrateV1(accounts, existing).library
  assert.equal(merged.macros.length, 11)
  assert.equal(merged.macros[0].name, 'Existing')
  assert.equal(new Set(merged.macros.map((m) => m.id)).size, merged.macros.length)
})

test('migrateV1 never mutates its inputs', () => {
  const accounts = deepFreeze(fixture())
  const library = deepFreeze(normalizeLibrary({ macros: [{ id: 'keep', name: 'Keep', steps: [{ type: 'chat', message: 'x' }] }] }))
  const accountsBefore = JSON.stringify(accounts)
  const libraryBefore = JSON.stringify(library)
  const result = migrateV1(accounts, library)
  assert.equal(JSON.stringify(accounts), accountsBefore)
  assert.equal(JSON.stringify(library), libraryBefore)
  assert.notEqual(result.library, library)
  assert.equal(result.library.macros.length, 11)
})

test('migrateV1 tolerates junk input and respects the library cap', () => {
  assert.deepEqual(migrateV1(null, null).library, { version: 2, macros: [] })
  assert.deepEqual(migrateV1([null, 5, {}, { id: 'a' }, { id: 'b', automations: 'x' }, { id: 'c', automations: [null, 3] }], undefined).migratedAccountIds, [])
  const full = normalizeLibrary({ macros: Array.from({ length: LIMITS.maxMacros }, (_, i) => ({ id: `m${i}`, name: 'm' })) })
  const result = migrateV1([{ id: 'a', profileName: 'Full', automations: [{ id: 'x', name: 'X', trigger: {}, steps: [{ type: 'chat', message: 'x' }] }] }], full)
  assert.deepEqual(result.migratedAccountIds, [])
  assert.equal(result.library.macros.length, LIMITS.maxMacros)
  assert.match(result.warnings[0], /library is full/)
})

// ---------------------------------------------------------------------------
// toV1 / write-back
// ---------------------------------------------------------------------------

test('toV1 round trip reproduces an equivalent v1 automation for every representable fixture', () => {
  const accounts = fixture()
  const { library } = migrateV1(accounts, undefined)
  const v1Normalized = new Map(accounts.flatMap((account) => normalizeAutomations(account.automations).map((a) => [`${account.id}:${a.id}`, a])))
  let representable = 0
  for (const macro of library.macros) {
    const back = toV1(macro)
    const key = `${macro.origin.fromV1.accountId}:${macro.origin.fromV1.automationId || macro.id}`
    if (macro.origin.v2Only) { assert.equal(back, null, `${macro.id} is v2Only`); continue }
    representable += 1
    assert.ok(back, `${macro.id} should be representable`)
    assert.deepEqual(back, v1Normalized.get(key), macro.id)
    // The result is a fixed point of the beta.9 normalizer, i.e. beta.9 would load it unchanged.
    assert.deepEqual(normalizeAutomations([back]), [back], macro.id)
  }
  assert.equal(representable, 8)
  assert.equal(toV1(byId(library, 'auto-lossy')), null)
  assert.equal(toV1(byId(library, 'auto-window')), null)
})

test('toV1 returns null for v2-only macros and multi-target macros', () => {
  const base = { name: 'V', targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'join' }, steps: [{ type: 'chat', message: 'x' }] }
  assert.ok(toV1(base))
  const nullCases = {
    twoAccounts: { targets: { mode: 'accounts', accountIds: ['a', 'b'] } },
    allMode: { targets: { mode: 'all' } },
    noAccount: { targets: { mode: 'accounts', accountIds: [] } },
    tagsMode: { targets: { mode: 'tags', tags: ['x'] } },
    stopWhen: { stopWhen: [{ type: 'online' }] },
    override: { concurrency: 'override' },
    webhook: { notify: { webhookRef: 'ref' } },
    v2OnlyTrigger: { trigger: { type: 'schedule', at: '08:00' } },
    worldChange: { trigger: { type: 'worldChange' } },
    death: { trigger: { type: 'death' } },
    cooldown: { trigger: { type: 'join', cooldownMs: 5000 } },
    globChat: { trigger: { type: 'chat', match: 'glob', pattern: 'a*' } },
    chatSources: { trigger: { type: 'chat', pattern: 'a', sources: ['system'] } },
    titledWindow: { trigger: { type: 'windowOpen', title: 'Shop' } },
    timerJitter: { trigger: { type: 'timer', intervalMs: 60000, jitterMs: 1000 } },
    timerFraction: { trigger: { type: 'timer', intervalMs: 61500 } },
    hunger: { trigger: { type: 'hungerBelow', below: 5 } },
    empty: { steps: [] },
    v2OnlyStep: { steps: [{ type: 'selectHotbar', slot: 1 }] },
    waitJitter: { steps: [{ type: 'wait', ms: 500, jitterMs: 100 }] },
    waitRange: { steps: [{ type: 'wait', minMs: 100, maxMs: 200 }] },
    waitLong: { steps: [{ type: 'wait', ms: 120000 }] },
    moveDistance: { steps: [{ type: 'move', control: 'forward', distance: 4 }] },
    lookAbsolute: { steps: [{ type: 'look', mode: 'absolute', yaw: 1, pitch: 0 }] },
    lookOddAngle: { steps: [{ type: 'look', mode: 'relative', yaw: 0.2, pitch: 0 }] },
    dropByName: { steps: [{ type: 'drop', select: { name: 'dirt' }, count: 1 }] },
    guiRight: { steps: [{ type: 'useGui', select: { slot: 1 }, click: 'right' }] },
    clickBlocks: { steps: [{ type: 'leftClick', action: 'once', only: 'blocks' }] },
    clickHold: { steps: [{ type: 'rightClick', action: 'hold' }] },
    notifyWebhook: { steps: [{ type: 'notify', message: 'x', webhook: true }] },
    repeatWhile: { steps: [{ type: 'repeat', while: { type: 'online' }, steps: [] }] },
    repeatMany: { steps: [{ type: 'repeat', times: 500, steps: [{ type: 'stop' }] }] },
    ifWindowOpen: { steps: [{ type: 'if', condition: { type: 'windowOpen' }, then: [], else: [] }] },
    ifNotHealth: { steps: [{ type: 'if', condition: { type: 'not', condition: { type: 'healthBelow', value: 3 } }, then: [], else: [] }] },
    nestedUnsupported: { steps: [{ type: 'if', condition: { type: 'always' }, then: [{ type: 'closeGui' }], else: [] }] },
    v2OnlyFlag: { origin: { v2Only: true } }
  }
  for (const [label, override] of Object.entries(nullCases)) assert.equal(toV1({ ...base, ...override }), null, label)
  assert.equal(toV1(null), null)
  assert.equal(toV1('x'), null)
})

test('toV1 maps native v2 macros that happen to be v1-representable', () => {
  const v1 = toV1({
    id: 'native', name: 'Native', enabled: false, targets: { mode: 'accounts', accountIds: ['acct-alpha'] },
    trigger: { type: 'timer', intervalMs: 30000 },
    steps: [{ type: 'if', condition: { type: 'online' }, then: [{ type: 'chat', message: 'up' }], else: [{ type: 'if', condition: { type: 'not', condition: { type: 'online' } }, then: [{ type: 'notify', message: 'down' }], else: [] }] }]
  })
  assert.equal(v1.id, 'native')
  assert.equal(v1.enabled, false)
  assert.deepEqual(v1.trigger, { type: 'timer', contains: '', below: 8, intervalSeconds: 30 })
  assert.deepEqual(normalizeAutomations([v1]), [v1])
})

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

test('exportMacros strips webhook refs and origin, and keeps everything else', () => {
  const macro = validMacro({
    notify: { webhookRef: 'secret-ref-123' },
    origin: { fromV1: { accountId: 'acct-alpha' }, v2Only: true },
    steps: [{ type: 'notify', message: 'hi', webhook: true }]
  })
  const json = exportMacros([macro])
  assert.ok(!json.includes('secret-ref-123'))
  assert.ok(!json.includes('webhookRef'))
  assert.ok(!json.includes('fromV1'))
  assert.ok(!json.includes('v2Only'))
  const parsed = JSON.parse(json)
  assert.equal(parsed.version, 2)
  assert.equal(parsed.macros[0].name, 'Valid')
  assert.equal(parsed.macros[0].steps[0].webhook, true)
  assert.deepEqual(parsed.macros[0].notify, {})
  assert.deepEqual(parsed.macros[0].origin, {})
  // The input is untouched.
  assert.equal(macro.notify.webhookRef, 'secret-ref-123')
  assert.equal(exportMacros(null), '{\n  "version": 2,\n  "macros": []\n}')
})

test('importMacros assigns new ids, drops unknown targets, disables invalid macros', () => {
  const good = validMacro({ id: 'orig-1', targets: { mode: 'accounts', accountIds: ['acct-alpha', 'stranger'] } })
  const empty = validMacro({ id: 'orig-2', targets: { mode: 'accounts', accountIds: ['stranger'] } })
  const bad = validMacro({ id: 'orig-3', steps: [{ type: 'chat', message: '' }] })
  const result = importMacros(exportMacros([good, empty, bad]), { accountIds })
  assert.equal(result.macros.length, 3)
  assert.deepEqual(result.macros.map((m) => m.id).filter((id) => id.startsWith('orig')), [])
  assert.deepEqual(result.macros[0].targets.accountIds, ['acct-alpha'])
  assert.equal(result.macros[0].enabled, true)
  assert.deepEqual(result.macros[1].targets.accountIds, [])
  assert.equal(result.macros[1].enabled, false)
  assert.equal(result.macros[2].enabled, false)
  assert.ok(result.errors.some((e) => e.index === 1 && e.path === '/targets/accountIds'))
  assert.ok(result.errors.some((e) => e.index === 2 && e.path === '/steps/0/message'))
  assert.ok(result.errors.every((e) => e.index !== 0))
  // Re-importing the same payload twice never collides.
  const again = importMacros(exportMacros([good]), { accountIds })
  assert.notEqual(again.macros[0].id, result.macros[0].id)
})

test('importMacros never trusts secrets or origin from the payload', () => {
  const payload = JSON.stringify({ macros: [{ name: 'Evil', trigger: { type: 'join' }, targets: { mode: 'all' }, steps: [{ type: 'notify', message: 'x', webhook: true }], notify: { webhookRef: 'stolen-ref' }, origin: { v2Only: false, fromV1: { accountId: 'acct-alpha' } } }] })
  const { macros, errors } = importMacros(payload, { accountIds })
  assert.deepEqual(macros[0].notify, {})
  assert.deepEqual(macros[0].origin, {})
  assert.equal(macros[0].enabled, false, 'webhook enabled without a configured webhook blocks enabling')
  assert.ok(errors.some((e) => e.path === '/steps/0/webhook'))
})

test('importMacros disables macros that target unsupported editions when editionOf is supplied', () => {
  const macro = validMacro({ targets: { mode: 'accounts', accountIds: ['acct-gamma'] }, steps: [{ type: 'move', control: 'forward', durationMs: 300 }] })
  const result = importMacros(exportMacros([macro]), { accountIds, editionOf })
  assert.equal(result.macros[0].enabled, false)
  assert.ok(result.errors.some((e) => e.path === '/steps/0/type'))
})

test('importMacros rejects invalid, oversized and malformed payloads', () => {
  for (const input of ['{not json', '', 'null', '42', '"str"', '{}', '{"macros":"x"}', undefined, null, 5, {}, Buffer.from('[]')]) {
    const result = importMacros(input, { accountIds })
    assert.deepEqual(result.macros, [], String(input))
    assert.ok(result.errors.length >= 1, String(input))
    assert.equal(typeof result.errors[0].message, 'string')
  }
  const oversized = JSON.stringify({ macros: [{ name: 'x'.repeat(LIMITS.maxIpcPayloadBytes) }] })
  assert.ok(oversized.length > LIMITS.maxIpcPayloadBytes)
  const result = importMacros(oversized, { accountIds })
  assert.deepEqual(result.macros, [])
  assert.match(result.errors[0].message, /larger than/)
  // Multi-byte characters count as bytes, not characters.
  const wide = JSON.stringify({ macros: [{ name: 'x', steps: [{ type: 'chat', message: '€'.repeat(LIMITS.maxIpcPayloadBytes / 3 + 100) }] }] })
  assert.ok(wide.length < LIMITS.maxIpcPayloadBytes && Buffer.byteLength(wide) > LIMITS.maxIpcPayloadBytes)
  assert.deepEqual(importMacros(wide, { accountIds }).macros, [])
  assert.doesNotThrow(() => importMacros('[1,2,"x",null]', undefined))
})

test('importMacros accepts a bare array or single macro and caps the count', () => {
  assert.equal(importMacros(JSON.stringify([validMacro()]), { accountIds }).macros.length, 1)
  assert.equal(importMacros(JSON.stringify(validMacro()), { accountIds }).macros.length, 1)
  const many = JSON.stringify(Array.from({ length: LIMITS.maxMacros + 20 }, () => ({ name: 'm', trigger: { type: 'manual' }, steps: [{ type: 'stop' }] })))
  const result = importMacros(many, { accountIds })
  assert.equal(result.macros.length, LIMITS.maxMacros)
  assert.ok(result.errors.some((e) => /first/.test(e.message)))
})

test('export then import round-trips content (minus ids, secrets and unknown accounts)', () => {
  const { library } = migrateV1(fixture(), undefined)
  const result = importMacros(exportMacros(library.macros), { accountIds })
  assert.equal(result.macros.length, library.macros.length)
  result.macros.forEach((imported, index) => {
    const original = library.macros[index]
    assert.equal(imported.name, original.name)
    assert.deepEqual(imported.steps, original.steps)
    assert.deepEqual(imported.trigger, original.trigger)
    assert.deepEqual(imported.origin, {})
  })
})
