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
