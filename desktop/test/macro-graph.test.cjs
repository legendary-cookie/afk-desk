'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { TEMPLATES } = require('../src/macro-editor.js')
const { migrateV2, toV2, validateGraph } = require('../electron/macro/graph-model.cjs')
const { MacroEngine } = require('../electron/macro/engine.cjs')
const { FACADE_METHODS } = require('../electron/macro/contract.cjs')

test('every template round trips through graph migration', () => {
  for (const [name, make] of Object.entries(TEMPLATES)) {
    const original = make(), graph = migrateV2(original)
    assert.deepEqual(validateGraph(graph), [], name)
    assert.deepEqual(toV2(graph), original, name)
  }
})

test('validation reports bad kinds, edges, required inputs and unsafe cycles', () => {
  const graph = { nodes: [
    { id: 'a', kind: 'wait', params: {} }, { id: 'b', kind: 'chat', params: {} },
    { id: 'c', kind: 'health', params: {} }, { id: 'd', kind: 'wat', params: {} }
  ], edges: [
    { id: '1', from: { node: 'b', port: 'out' }, to: { node: 'b', port: 'in' } },
    { id: '2', from: { node: 'c', port: 'value' }, to: { node: 'b', port: 'message' } },
    { id: '3', from: { node: 'missing', port: 'out' }, to: { node: 'a', port: 'in' } }
  ] }
  const codes = validateGraph(graph).map(e => e.code)
  for (const code of ['UNKNOWN_KIND', 'MISSING_TRIGGER', 'DANGLING_EDGE', 'PORT_TYPE_MISMATCH', 'REQUIRED_INPUT', 'CYCLE_WITHOUT_WAIT']) assert.ok(codes.includes(code), code)
})

async function run(macro) {
  let time = 0
  const calls = [], facade = {}
  for (const method of FACADE_METHODS) facade[method] = async (account, args) => { calls.push([method, args]); return '' }
  facade.state = () => ({ online: true, health: 20, food: 7, inventory: [], entities: [] })
  facade.sessionId = () => 'session'
  facade.releaseOwner = () => {}
  const scheduler = { after(ms, fn) { let cancelled = false; if (ms >= 300000) return () => { cancelled = true }; queueMicrotask(() => { if (!cancelled) { time += ms; fn() } }); return () => { cancelled = true } }, cancelKey() {}, dispose() {} }
  const matcher = { setMacros() {}, onEvent() { return [] }, timedTriggers() { return [] }, resetAccount() {} }
  const engine = new MacroEngine({ facade, matcher, scheduler, now: () => time, random: () => 0.5, resolveTargets: () => ['a'] })
  engine.setLibrary([{ ...macro, id: 'test', enabled: true }])
  const result = await engine.run('a', 'test')
  await engine.shutdown()
  return { calls, status: result.status }
}

test('migrated templates make the same facade calls as v2', async () => {
  for (const [name, make] of Object.entries(TEMPLATES)) {
    const macro = make()
    assert.deepEqual(await run(migrateV2(macro)), await run(macro), name)
  }
})

test('nested branches and loops preserve v2 calls and structure', async () => {
  const macro = { version: 2, trigger: { type: 'manual' }, defaultDelayMs: 0, steps: [
    { type: 'if', condition: { type: 'always' }, then: [{ type: 'repeat', times: 2, steps: [{ type: 'chat', message: 'hello' }] }], else: [{ type: 'notify', message: 'no' }] },
    { type: 'wait', ms: 1 }, { type: 'stop' }, { type: 'chat', message: 'unreachable' }
  ] }
  const graph = migrateV2(macro)
  assert.deepEqual(validateGraph(graph), [])
  assert.deepEqual(toV2(graph), macro)
  assert.deepEqual(await run(graph), await run(macro))
})

test('value wires are evaluated from current account state', async () => {
  const graph = migrateV2({ trigger: { type: 'manual' }, defaultDelayMs: 0, steps: [{ type: 'selectHotbar', slot: 0 }] })
  graph.nodes.push({ id: 'health', kind: 'food', params: {}, position: { x: 0, y: 0 } })
  const target = graph.nodes.find(n => n.kind === 'selectHotbar')
  graph.edges.push({ id: 'value', from: { node: 'health', port: 'value' }, to: { node: target.id, port: 'slot' } })
  assert.deepEqual(validateGraph(graph), [])
  assert.deepEqual((await run(graph)).calls, [['selectHotbar', { slot: 7 }]])
})

// Exercise the interpreter independently of the scheduler so value wiring and
// control routing can be checked with deterministic account state.
async function interpret(nodes, edges, overrides = {}) {
  const { runGraph } = require('../electron/macro/graph-interpreter.cjs')
  const calls = [], variables = {}, account = {}, persistent = {}
  const ctx = { macro: { nodes: [{ id: 'start', kind: 'trigger.manual', params: {} }, ...nodes], edges, nodeStepBudget: overrides.budget || 20 }, accountId: 'a', variables, record: { trigger: 'manual' }, signal: new AbortController().signal }
  const engine = {
    _state: () => ({ inventory: [{ name: 'stone', count: 3 }], entities: [{ type: 'player', distance: 2 }, { type: 'mob', distance: 1 }], health: 12, food: 8, position: { x: 1 } }),
    _unit: () => 0.5, _gate: async () => {}, _throwIfAborted: () => {}, _sleep: async () => {}, now: () => 0,
    _evaluate: (_ctx, value) => !!value, getPersistentVariables: () => persistent,
    graphAccountVariables: new Map([['a', account]]),
    _stepSet: async (_ctx, p) => { variables[p.variable] = p.value; if (p.persist) persistent[p.variable] = p.value },
    _stepFacade: async (_ctx, p, type, _path, throws) => { if (p.fail && throws) throw new Error('boom'); calls.push([type, p]) },
    _stepWait: async () => {}, _stepStop: async () => { throw new Error('stop') }
  }
  await runGraph(engine, ctx)
  return { calls, variables, account, persistent }
}
const n = (id, kind, params = {}) => ({ id, kind, params })
const e = (id, from, port, to, input = 'in') => ({ id, from: { node: from, port }, to: { node: to, port: input } })

test('shared data dependencies are evaluated once per control step', async () => {
  const nodes = [n('random', 'random')], edges = []
  let prev = 'random'
  for (let i = 0; i < 24; i++) {
    const id = `math${i}`; nodes.push(n(id, 'math'))
    edges.push(e(`a${i}`, prev, 'value', id, 'a'), e(`b${i}`, prev, 'value', id, 'b')); prev = id
  }
  nodes.push(n('set', 'setVar', { variable: 'result' }))
  edges.push(e('control', 'start', 'out', 'set'), e('result', prev, 'value', 'set', 'value'))
  const result = await interpret(nodes, edges)
  assert.equal(result.variables.result, 0.5 * 2 ** 24)
})

test('long data evaluation yields to cancellation', async () => {
  const { runGraph } = require('../electron/macro/graph-interpreter.cjs')
  const controller = new AbortController(), nodes = [n('start', 'trigger.manual'), n('seed', 'health')], edges = []
  let previous = 'seed'
  for (let i = 0; i < 130; i++) {
    const id = `v${i}`; nodes.push(n(id, 'math', { b: 1 }))
    edges.push(e(`wire${i}`, previous, 'value', id, 'a')); previous = id
  }
  nodes.push(n('action', 'selectHotbar', { slot: 0 }))
  edges.push(e('control', 'start', 'out', 'action'), e('last', previous, 'value', 'action', 'slot'))
  const ctx = { macro: { nodes, edges }, accountId: 'a', record: { trigger: 'manual' }, signal: controller.signal }
  const engine = { _state: () => ({ health: 1 }), _throwIfAborted: () => { if (controller.signal.aborted) throw Error('cancelled') }, _stepFacade: async () => assert.fail('cancelled action executed') }
  setImmediate(() => controller.abort())
  await assert.rejects(runGraph(engine, ctx), /cancelled/)
})

test('graph action parameters reject unsafe literals and wired values', async () => {
  const { validateMacro } = require('../electron/macro/model.cjs')
  const macro = { version: 3, name: 'click', targets: { mode: 'all' }, nodes: [n('start', 'trigger.manual'), n('click', 'autoclick', { button: 'left', cps: 100000 })], edges: [e('control', 'start', 'out', 'click')] }
  assert.ok(validateMacro(macro).some(error => error.path.endsWith('/cps')))
  const nodes = [n('value', 'math', { a: 50000, b: 50000 }), n('click', 'autoclick', { button: 'left', cps: 5 })]
  await assert.rejects(interpret(nodes, [e('control', 'start', 'out', 'click'), e('wire', 'value', 'value', 'click', 'cps')]), /Invalid cps/)
})

test('switch, parallel and merge route branches once', async () => {
  const nodes = [n('s', 'switch', { value: 'b', cases: ['a', 'b'] }), n('p', 'parallel'), n('a', 'selectHotbar', { slot: 1 }), n('b', 'selectHotbar', { slot: 2 }), n('m', 'merge'), n('end', 'selectHotbar', { slot: 3 })]
  const edges = [e('1', 'start', 'out', 's'), e('2', 's', 'case1', 'p'), e('3', 'p', 'out', 'a'), e('4', 'p', 'out', 'b'), e('5', 'a', 'out', 'm'), e('6', 'b', 'out', 'm'), e('7', 'm', 'out', 'end')]
  const result = await interpret(nodes, edges)
  assert.deepEqual(result.calls.map(c => c[1].slot), [1, 2, 3])
})

test('try/catch routes facade errors to its error port', async () => {
  const nodes = [n('try', 'tryCatch'), n('bad', 'selectHotbar', { slot: 1, fail: true }), n('catch', 'selectHotbar', { slot: 2 }), n('end', 'selectHotbar', { slot: 3 })]
  const edges = [e('1', 'start', 'out', 'try'), e('2', 'try', 'try', 'bad'), e('3', 'try', 'error', 'catch'), e('4', 'try', 'out', 'end')]
  const result = await interpret(nodes, edges)
  assert.equal(result.variables.error, 'boom')
  assert.deepEqual(result.calls.map(c => c[1].slot), [2, 3])
})

test('data nodes compute values through wires', async () => {
  const cases = [
    ['math', { a: 6, b: 2, operation: 'divide' }, 3], ['compare', { a: 2, b: 1, operator: '>' }, true],
    ['textFormat', { text: 'hello' }, 'hello'], ['regexExtract', { text: 'abc42', pattern: '(\\d+)', group: 1 }, '42'],
    ['random', { min: 2, max: 4 }, 3], ['inventoryCount', { name: 'stone' }, 3], ['entityCount', {}, 2],
    ['health', {}, 12], ['food', {}, 8], ['position', {}, { x: 1 }], ['nearestEntity', {}, { type: 'mob', distance: 1 }]
  ]
  for (const [kind, params, expected] of cases) {
    const nodes = [n('data', kind, params), n('set', 'setVar', { variable: 'result' })]
    const result = await interpret(nodes, [e('1', 'start', 'out', 'set'), e('2', 'data', 'value', 'set', 'value')])
    assert.deepEqual(result.variables.result, expected, kind)
  }
})

test('forEach exposes each item and waitUntil proceeds on a true condition', async () => {
  const nodes = [n('loop', 'forEach', { source: 'entities' }), n('set', 'setVar', { variable: 'item' }), n('wait', 'waitUntil', { condition: true }), n('end', 'selectHotbar', { slot: 4 })]
  const edges = [e('1', 'start', 'out', 'loop'), e('2', 'loop', 'each', 'set'), e('3', 'loop', 'item', 'set', 'value'), e('4', 'loop', 'done', 'wait'), e('5', 'wait', 'out', 'end')]
  const result = await interpret(nodes, edges)
  assert.equal(result.variables.item.type, 'mob')
  assert.equal(result.calls[0][1].slot, 4)
})

test('step budget terminates a control cycle with a wait', async () => {
  const nodes = [n('wait', 'wait', { ms: 1 })]
  await assert.rejects(interpret(nodes, [e('1', 'start', 'out', 'wait'), e('2', 'wait', 'out', 'wait')], { budget: 3 }), /step budget/)
})

test('account and persistent variable scopes are available to getVar', async () => {
  for (const scope of ['account', 'persistent']) {
    const nodes = [n('set', 'setVar', { variable: 'x', value: 7, scope }), n('get', 'getVar', { variable: 'x', scope }), n('out', 'setVar', { variable: 'result' })]
    const result = await interpret(nodes, [e('1', 'start', 'out', 'set'), e('2', 'set', 'out', 'out'), e('3', 'get', 'value', 'out', 'value')])
    assert.equal(result.variables.result, 7, scope)
  }
})

test('different event triggers start only their connected branch', async () => {
  const { TriggerMatcher } = require('../electron/macro/triggers.cjs')
  const calls = [], facade = {}
  for (const method of FACADE_METHODS) facade[method] = async (_account, args) => { calls.push([method, args]); return '' }
  facade.state = () => ({ online: true }); facade.sessionId = () => 's'; facade.releaseOwner = () => {}
  const engine = new MacroEngine({ facade, matcher: new TriggerMatcher(), resolveTargets: () => ['a'] })
  const macro = { id: 'multi', enabled: true, version: 3, defaultDelayMs: 0, nodes: [n('join', 'trigger.join'), n('death', 'trigger.death'), n('a', 'selectHotbar', { slot: 1 }), n('b', 'selectHotbar', { slot: 2 })], edges: [e('1', 'join', 'out', 'a'), e('2', 'death', 'out', 'b')] }
  engine.setLibrary([macro])
  engine.onBotEvent({ type: 'spawn', accountId: 'a', sessionId: 's' })
  await new Promise(resolve => setTimeout(resolve, 20))
  engine.onBotEvent({ type: 'death', accountId: 'a', sessionId: 's' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(calls.map(c => c[1].slot), [1, 2])
  await engine.shutdown()
})

function liveEngine(state) {
  const facade = {}
  for (const method of FACADE_METHODS) facade[method] = async () => ''
  facade.state = account => state[account] || {}; facade.sessionId = () => 's'; facade.releaseOwner = () => {}
  const matcher = { setMacros() {}, onEvent() { return [] }, timedTriggers() { return [] }, resetAccount() {} }
  return new MacroEngine({ facade, matcher, resolveTargets: () => ['a', 'b'] })
}
function waitingGraph(extra = {}) {
  return { id: 'waiting', version: 3, enabled: true, ...extra, nodes: [n('start', 'trigger.manual'), n('parallel', 'parallel'), n('w1', 'wait', { ms: 10000 }), n('w2', 'wait', { ms: 10000 })], edges: [e('1', 'start', 'out', 'parallel'), e('2', 'parallel', 'out', 'w1'), e('3', 'parallel', 'out', 'w2')] }
}
test('cancellation interrupts both parallel waits', async () => {
  const engine = liveEngine({ a: { online: true } })
  engine.setLibrary([waitingGraph()])
  const run = engine.run('a', 'waiting')
  await new Promise(resolve => setTimeout(resolve, 10))
  await engine.stop('a')
  assert.equal((await run).status, 'cancelled')
  await engine.shutdown()
})
test('graph timeout stops a run', async () => {
  const engine = liveEngine({ a: { online: true } })
  engine.setLibrary([waitingGraph({ maxRuntimeMs: 20 })])
  assert.equal((await engine.run('a', 'waiting')).status, 'stopped')
  await engine.shutdown()
})
test('allAccounts stop condition stops other graph runs', async () => {
  const state = { a: { online: true, health: 20 }, b: { online: true, health: 20 } }
  const engine = liveEngine(state)
  engine.setLibrary([waitingGraph({ stopWhen: [{ type: 'healthBelow', value: 5, allAccounts: true }] })])
  const a = engine.run('a', 'waiting'), b = engine.run('b', 'waiting')
  await new Promise(resolve => setTimeout(resolve, 10))
  state.a.health = 1
  engine.onBotEvent({ type: 'telemetry', accountId: 'a', sessionId: 's', payload: { health: 1 } })
  assert.deepEqual([(await a).status, (await b).status], ['stopped', 'stopped'])
  await engine.shutdown()
})

test('while and each inventory and player collection use the current account state', async () => {
  for (const [source, expected] of [['items', 'stone'], ['players', 'player']]) {
    const nodes = [n('while', 'while', { condition: false }), n('loop', 'forEach', { source }), n('set', 'setVar', { variable: 'last' })]
    const result = await interpret(nodes, [e('1', 'start', 'out', 'while'), e('2', 'while', 'done', 'loop'), e('3', 'loop', 'each', 'set'), e('4', 'loop', 'item', 'set', 'value')])
    assert.equal(result.variables.last.name || result.variables.last.type, expected)
  }
})

test('engine executes extracted custom groups with the same facade actions as the original graph', async () => {
  const edit = require('../src/macro-graph-edit.js'), { NODE_KINDS } = require('../electron/macro/graph-contract.cjs')
  const original = migrateV2({ targets: { mode: 'all' }, trigger: { type: 'manual' }, defaultDelayMs: 0, steps: [{ type: 'chat', message: 'before' }, { type: 'wait', ms: 1 }, { type: 'chat', message: 'after' }] })
  const selected = original.nodes.filter(node => node.kind === 'wait' || node.params.message === 'before').map(node => node.id)
  const grouped = edit.makeCustom(original, selected, NODE_KINDS, 'library', 'custom').graph
  assert.deepEqual(await run(grouped), await run(original))
  const nested = edit.makeCustom(grouped, ['custom'], NODE_KINDS, 'outer-library', 'nested').graph
  assert.deepEqual(await run(nested), await run(original))
})
