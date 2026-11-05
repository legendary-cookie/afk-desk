'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {graphCards} = require('../../../macro-graph-view.cjs')
test('v3 graph cards preserve labels, parameters and outgoing port connections', () => {
  const graph = {version: 3, name: 'Example', nodes: [{id: 'a', kind: 'trigger', label: '<Alex>', params: {message: 'hi'}}, {id: 'b', kind: 'chat', disabled: true}], edges: [{from: {node: 'a', port: 'out'}, to: {node: 'b', port: 'in'}}]}
  const cards = graphCards(JSON.stringify(graph))
  assert.equal(cards.nodes[0].label, '<Alex>')
  assert.deepEqual(cards.nodes[0].connections, ['out → b · in'])
  assert.match(cards.nodes[0].params, /hi/)
  assert.equal(cards.nodes[1].disabled, true)
  assert.deepEqual(cards.nodes[1].connections, [])
})
test('graph viewer rejects malformed JSON and broken connections', () => {
  for (const value of ['{', '{}', JSON.stringify({version: 3, nodes: [{id: 'a', kind: 'x'}], edges: [{from: {node: 'a', port: 'out'}, to: {node: 'missing', port: 'in'}}]})]) assert.throws(() => graphCards(value))
})
