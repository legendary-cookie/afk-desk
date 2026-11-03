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
  facade.state = () => ({ online: true, health: 20, food: 20, inventory: [], entities: [] })
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
  graph.nodes.push({ id: 'health', kind: 'health', params: {}, position: { x: 0, y: 0 } })
  const target = graph.nodes.find(n => n.kind === 'selectHotbar')
  graph.edges.push({ id: 'value', from: { node: 'health', port: 'value' }, to: { node: target.id, port: 'slot' } })
  assert.deepEqual(validateGraph(graph), [])
  assert.deepEqual((await run(graph)).calls, [['selectHotbar', { slot: 20 }]])
})
