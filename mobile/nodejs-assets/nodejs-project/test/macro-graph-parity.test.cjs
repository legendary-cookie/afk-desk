'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
async function interpret(nodes, edges, overrides = {}) {
  const { runGraph } = require('../macro/graph-interpreter.cjs')
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
  const { runGraph } = require('../macro/graph-interpreter.cjs')
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
  const { validateMacro } = require('../macro/model.cjs')
  const macro = { version: 3, name: 'click', targets: { mode: 'all' }, nodes: [n('start', 'trigger.manual'), n('click', 'autoclick', { button: 'left', cps: 100000 })], edges: [e('control', 'start', 'out', 'click')] }
  assert.ok(validateMacro(macro).some(error => error.path.endsWith('/cps')))
  const nodes = [n('value', 'math', { a: 50000, b: 50000 }), n('click', 'autoclick', { button: 'left', cps: 5 })]
  await assert.rejects(interpret(nodes, [e('control', 'start', 'out', 'click'), e('wire', 'value', 'value', 'click', 'cps')]), /Invalid cps/)
})


test('unsafe regex repetition is rejected', () => {
  assert.equal(require('../macro/safe-regex.cjs').safeRegex('.*_.*_.*_.*_.*X'), false)
})
