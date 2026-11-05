'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { RECIPES } = require('../src/macro-editor.js')
const { validateGraph } = require('../electron/macro/graph-model.cjs')

test('recipe factories produce independent disabled valid v3 graphs', () => {
  for (const [id, make] of Object.entries(RECIPES)) {
    const first = make(), second = make()
    assert.equal(first.version, 3, id)
    assert.equal(first.enabled, false, id)
    assert.deepEqual(validateGraph(first), [], id)
    first.nodes[0].params.changed = true
    assert.equal(second.nodes[0].params.changed, undefined, id)
  }
})

test('recipes contain their intended trigger and action', () => {
  const kinds = graph => graph.nodes.map(node => node.kind)
  assert.deepEqual(kinds(RECIPES['auto-sell']()).sort(), ['chat', 'trigger.inventoryFull'])
  assert.deepEqual(kinds(RECIPES['timed-kit']()).sort(), ['chat', 'trigger.schedule'])
  assert.deepEqual(kinds(RECIPES['vote-reminder']()).sort(), ['notify', 'trigger.schedule'])
})
