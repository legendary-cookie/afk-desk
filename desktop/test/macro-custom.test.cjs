'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const edit = require('../src/macro-graph-edit.js')
const { NODE_KINDS } = require('../electron/macro/graph-contract.cjs')
const model = require('../electron/macro/graph-model.cjs')
const { MacroLibraryStore } = require('../electron/macro/library-store.cjs')
const share = require('../electron/share-links.cjs')
const macroModel = require('../electron/macro/model.cjs')

function fixture() {
  return { version: 3, nodes: [
    { id: 'start', kind: 'trigger.manual', params: {} },
    { id: 'health', kind: 'health', params: {} },
    { id: 'slot', kind: 'selectHotbar', params: {} },
    { id: 'wait', kind: 'wait', params: { ms: 1 } },
    { id: 'next', kind: 'notify', params: { message: 'next' } }
  ], edges: [
    { id: 'begin', from: { node: 'start', port: 'out' }, to: { node: 'slot', port: 'in' } },
    { id: 'value', from: { node: 'health', port: 'value' }, to: { node: 'slot', port: 'slot' } },
    { id: 'inside', from: { node: 'slot', port: 'out' }, to: { node: 'wait', port: 'in' } },
    { id: 'end', from: { node: 'wait', port: 'out' }, to: { node: 'next', port: 'in' } }
  ] }
}
const group = input => edit.makeCustom(input || fixture(), ['slot', 'wait'], NODE_KINDS, 'lib', 'group', 'A <custom>')

const { interpret } = require('../test-fixtures/macro/graph-runtime.cjs')

test('group extraction exposes deduplicated typed boundary ports and preserves every wire', () => {
  const original = fixture(), before = structuredClone(original), result = group(original)
  assert.deepEqual(original, before)
  assert.deepEqual(result.definition.inputs, { in1: { type: 'control', node: 'slot', port: 'in' }, in2: { type: 'number', required: true, node: 'slot', port: 'slot' } })
  assert.deepEqual(result.definition.outputs, { out1: { type: 'control', node: 'wait', port: 'out' } })
  assert.deepEqual(model.validateGraph(result.graph), [])
  assert.deepEqual(model.validateCustom(result.definition), [])
  result.definition.name = 'external mutation'
  assert.equal(result.graph.nodes.at(-1).params.definition.name, 'A <custom>')
  assert.throws(() => edit.makeCustom(original, ['start'], NODE_KINDS, 'x', 'y'), /Triggers/)
  assert.throws(() => edit.makeCustom(original, [], NODE_KINDS, 'x', 'y'), /Select/)
})

test('interpreter preserves action order, lazy values and output continuation through nested group placements', async () => {
  const result = group()
  assert.deepEqual((await interpret(result.graph)).calls, (await interpret(fixture())).calls)
  const nested = edit.makeCustom(result.graph, ['group'], NODE_KINDS, 'outer-lib', 'outer')
  assert.deepEqual(model.validateGraph(nested.graph), [])
  assert.deepEqual((await interpret(nested.graph)).calls, (await interpret(fixture())).calls)
  const repeat = edit.pasteSelection(result.graph, { nodes: [result.graph.nodes.at(-1)], edges: [] }, () => 'second-group')
  repeat.edges.push({ id: 'second', from: { node: 'next', port: 'out' }, to: { node: 'second-group', port: 'in1' } }, { id: 'second-value', from: { node: 'health', port: 'value' }, to: { node: 'second-group', port: 'in2' } })
  assert.deepEqual(model.validateGraph(repeat), [])
  assert.equal((await interpret(repeat)).calls.filter(([type]) => type === 'selectHotbar').length, 2)
  assert.equal(new Set(model.expandGroups(repeat).nodes.map(node => node.id)).size, model.expandGroups(repeat).nodes.length)
})

test('value outputs from groups and per-placement input constants are evaluated lazily', async () => {
  let graph = edit.makeCustom(fixture(), ['health'], NODE_KINDS, 'health-lib', 'health-group').graph
  assert.deepEqual(model.validateGraph(graph), [])
  assert.equal((await interpret(graph)).calls[0][1].slot, 6)
  const result = group(); graph = result.graph
  graph.edges = graph.edges.filter(edge => edge.id !== 'value')
  graph.nodes.at(-1).params.in2 = 3
  assert.deepEqual(model.validateGraph(graph), [])
  assert.equal((await interpret(graph)).calls[0][1].slot, 3)
})

test('custom validation rejects malformed interfaces, triggers, missing nodes, nested cycles and excessive depth', () => {
  for (const mutate of [
    d => { d.inputs.in1.port = 'missing' }, d => { d.outputs.out1.type = 'number' },
    d => { d.nodes[0].kind = 'trigger.manual' }, d => { d.edges[0].to.node = 'missing' },
    d => { d.nodes.push(structuredClone(d.nodes[0])) }
  ]) { const d = group().definition; mutate(d); assert.ok(model.validateCustom(d).length) }
  let d = group().definition
  for (let i = 0; i < 10; i++) d = { id: `nested${i}`, name: 'nested', nodes: [{ id: 'g', kind: 'group', params: { definition: d } }], edges: [], inputs: {}, outputs: {} }
  assert.match(model.validateCustom(d)[0].message, /deeply/)
  const result = group(), loop = result.graph
  loop.edges.push({ id: 'cycle', from: { node: 'group', port: 'out1' }, to: { node: 'group', port: 'in1' } })
  assert.deepEqual(model.validateGraph(loop), []) // the custom node contains a wait
  loop.nodes.at(-1).params.definition.nodes.find(node => node.kind === 'wait').kind = 'merge'
  assert.ok(model.validateGraph(loop).some(error => error.code === 'CYCLE_WITHOUT_WAIT'))
})

test('custom library persists snapshots beside macros, survives migration/replacement, and delete leaves placed graphs executable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-library-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new MacroLibraryStore(dir); store.load()
  const result = group(); store.saveCustom(result.definition); store.save({ ...result.graph, id: 'macro', targets: { mode: 'all' } })
  store.saveCustom({ ...result.definition, name: 'Renamed' })
  assert.equal(store.customNodes().length, 1)
  assert.equal(store.customNodes()[0].name, 'Renamed')
  const snapshot = store.customNodes(); snapshot[0].nodes.length = 0
  assert.equal(store.customNodes()[0].nodes.length, 2)
  const reopened = new MacroLibraryStore(dir); reopened.load()
  reopened.replaceAll(reopened.list())
  assert.equal(macroModel.migrateV1([], reopened.library).library.customNodes[0].name, 'Renamed')
  reopened.removeCustom('lib')
  assert.equal(new MacroLibraryStore(dir).load().customNodes.length, 0)
  assert.equal((await interpret(reopened.get('macro'))).calls[0][0], 'selectHotbar')
  assert.throws(() => reopened.saveCustom({ id: 'bad', name: 'Bad' }), /Invalid/)
})

test('custom and nested macro share links retain boundary wiring and redact all user text and ids', async () => {
  const result = group(), input = result.definition
  const portable = share.customData(input, macroModel), decoded = share.decode(share.encode('custom', portable))
  assert.equal(decoded.kind, 'custom')
  assert.deepEqual(model.validateCustom(decoded.data), [])
  assert.doesNotMatch(JSON.stringify(decoded.data), /A <custom>|"slot"(?=:"selectHotbar")|"lib"|"wait"(?=:"wait")/)
  const shared = share.macroData(result.graph, macroModel)
  assert.deepEqual(model.validateGraph(shared).filter(error => error.code !== 'REQUIRED_INPUT'), [])
  assert.equal(shared.nodes.at(-1).kind, 'group')
  assert.equal(shared.nodes.at(-1).params.definition.nodes.length, 2)
  const placed = { ...fixture(), nodes: fixture().nodes.filter(node => !['slot', 'wait'].includes(node.id)), edges: [] }
  placed.nodes.push({ id: 'custom', kind: 'group', params: { definition: portable, in2: 2 } })
  placed.edges.push({ id: 'start', from: { node: 'start', port: 'out' }, to: { node: 'custom', port: 'in1' } })
  assert.equal((await interpret(placed)).calls[0][1].slot, 2)
})


test('custom node runtime events and validation point to the containing canvas card and generated ids avoid collisions', async () => {
  const result = group()
  result.graph.nodes.push({ id: 'group/0:slot', kind: 'health', params: {} })
  const expanded = model.expandGroups(result.graph)
  assert.equal(new Set(expanded.nodes.map(node => node.id)).size, expanded.nodes.length)
  const { events } = await interpret(result.graph)
  assert.ok(events.some(event => event.status === 'graphNode' && event.nodeId === 'group'))
  assert.ok(!events.some(event => event.nodeId?.startsWith('group/')))
  result.graph.edges = result.graph.edges.filter(edge => edge.id !== 'value')
  assert.ok(model.validateGraph(result.graph).some(error => error.path === 'nodes.group'))
})

test('sharing custom data preserves structural math/comparison choices and imports redacted drafts for editing', () => {
  const graph = fixture()
  graph.nodes.push({ id: 'math', kind: 'math', params: { a: 4, b: 2, operation: 'multiply' } })
  const result = edit.makeCustom(graph, ['math', 'next'], NODE_KINDS, 'lib', 'custom')
  const portable = share.customData(result.definition, macroModel)
  assert.equal(portable.nodes.find(node => node.kind === 'math').params.operation, 'multiply')
  assert.equal(portable.nodes.find(node => node.kind === 'notify').params.message, '')
  assert.deepEqual(model.validateCustom(portable), [])
})
