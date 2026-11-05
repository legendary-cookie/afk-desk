'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const edit = require('../src/macro-graph-edit.js')
const { NODE_KINDS } = require('../electron/macro/graph-contract.cjs')

const graph = () => ({ nodes: [
  { id: 'a', kind: 'trigger.manual', params: {}, position: { x: 0, y: 0 } },
  { id: 'b', kind: 'chat', params: { message: 'hello' }, position: { x: 200, y: 0 } },
  { id: 'c', kind: 'health', params: {}, position: { x: 0, y: 100 } }
], edges: [{ id: 'e', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }] })

test('port compatibility follows control and value types', () => {
  assert.equal(edit.compatible({ type: 'number' }, { type: 'any' }), true)
  assert.equal(edit.compatible({ type: 'number' }, { type: 'string' }), false)
  assert.equal(edit.compatible({ type: 'control' }, { type: 'any' }), false)
  assert.equal(edit.compatible(undefined, { type: 'any' }), false)
  assert.throws(() => edit.connect(graph(), NODE_KINDS, { id: 'x', from: { node: 'c', port: 'value' }, to: { node: 'b', port: 'in' } }), /Incompatible/)
})

test('inserting a node rewires a copy and rejects an incompatible insertion', () => {
  const original = graph(), node = { id: 'w', kind: 'wait', params: { ms: 1000 }, position: { x: 100, y: 0 } }
  const result = edit.insertOnEdge(original, NODE_KINDS, 'e', node, 'in', 'out', ['e1', 'e2'])
  assert.deepEqual(result.edges.map(e => [e.from.node, e.to.node]), [['a', 'w'], ['w', 'b']])
  assert.equal(original.edges[0].id, 'e')
  assert.throws(() => edit.insertOnEdge(original, NODE_KINDS, 'e', { ...node, kind: 'health' }, 'in', 'value', ['e1', 'e2']), /Incompatible/)
})

test('copy and paste remaps only internal connections and snaps positions', () => {
  const selection = edit.copySelection(graph(), ['a', 'b'])
  let n = 0
  const result = edit.pasteSelection(graph(), selection, () => `new${++n}`, 23)
  assert.equal(result.nodes[3].position.x, 20)
  assert.deepEqual(result.edges[1].from, { node: 'new1', port: 'out' })
  assert.deepEqual(result.edges[1].to, { node: 'new2', port: 'in' })
  assert.throws(() => edit.pasteSelection(graph(), selection, () => 'a'), /unique/)
  assert.equal(edit.snap(-29), -20)
})

test('palette search groups contract kinds and matches labels, kinds and categories', () => {
  const all = edit.searchPalette(NODE_KINDS)
  assert.deepEqual(all.flatMap(group => group.kinds).sort(), Object.keys(NODE_KINDS).sort())
  assert.ok(edit.searchPalette(NODE_KINDS, ' TRIGGER.manual ').some(g => g.kinds.includes('trigger.manual')))
  assert.ok(edit.searchPalette(NODE_KINDS, 'health').some(g => g.kinds.includes('health')))
  assert.ok(edit.searchPalette(NODE_KINDS, 'data').every(g => g.category === 'Data'))
  assert.deepEqual(edit.searchPalette(NODE_KINDS, 'no such node'), [])
})

test('validation messages map to nodes by id or index without treating graph errors as node errors', () => {
  const errors = edit.nodeErrors(graph(), [
    { path: '/nodes/b/message', message: 'Missing message' },
    { path: 'nodes.0.kind', message: 'Bad kind' },
    { path: '/edges', message: 'Bad edge' },
    { path: '/nodes/missing', message: 'Missing node' }
  ])
  assert.deepEqual({ ...errors }, { a: ['Bad kind'], b: ['Missing message'] })
})

test('history snapshots support first edit, redo branches, limits and isolation', () => {
  const original = graph(), history = edit.createHistory(original, 3)
  const changed = graph(); changed.nodes[0].params.value = 1
  assert.equal(history.commit(changed), true)
  changed.nodes[0].params.value = 99
  assert.equal(history.canUndo(), true)
  assert.deepEqual(history.undo(), original)
  assert.equal(history.redo().nodes[0].params.value, 1)
  history.undo()
  const replacement = graph(); replacement.nodes[0].params.value = 2
  history.commit(replacement)
  assert.equal(history.canRedo(), false)
  assert.equal(history.commit(replacement), false)
  for (let i = 3; i < 6; i++) { replacement.nodes[0].params.value = i; history.commit(replacement) }
  assert.equal(history.undo().nodes[0].params.value, 4)
  assert.equal(history.undo().nodes[0].params.value, 3)
  assert.equal(history.canUndo(), false)
})
