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

const { interpret } = require('../test-fixtures/macro/graph-runtime.cjs')
test('all eight design recipes are shipped, fresh, disabled and have executable graph actions', () => {
  assert.deepEqual(Object.keys(RECIPES).sort(), ['auto-sell', 'afk-fishing', 'player-nearby', 'timed-kit', 'mob-farm', 'server-restart', 'eat-totem', 'vote-reminder'].sort())
  for (const make of Object.values(RECIPES)) {
    const graph = make()
    assert.deepEqual(validateGraph(graph), [])
    assert.equal(graph.onError, 'stop')
    assert.equal(graph.enabled, false)
  }
})

test('fishing checks live rod durability before catching and only repairs below the threshold', async () => {
  const graph = RECIPES['afk-fishing']()
  graph.nodes.find(node => node.kind === 'repeat').params.times = 2
  const worn = (await interpret(graph, { durability: 10 })).calls
  assert.deepEqual(worn.map(([type]) => type), ['holdItem', 'chat', 'wait', 'fish', 'wait', 'chat', 'wait', 'fish', 'wait'])
  assert.equal(worn[1][1].message, '/repair')
  const healthy = (await interpret(graph, { durability: 80 })).calls
  assert.deepEqual(healthy.map(([type]) => type), ['holdItem', 'fish', 'wait', 'fish', 'wait'])
})

test('nearby player recipe waits for screenshot success before disconnecting; screenshot failure prevents logout', async () => {
  const graph = RECIPES['player-nearby']()
  assert.ok(graph.nodes.some(node => node.kind === 'trigger.playerAppears'))
  assert.deepEqual((await interpret(graph)).calls.map(([type]) => type), ['screenshot', 'disconnect'])
  await assert.rejects(interpret(graph, { fail: 'screenshot' }), /failed/)
})

test('mob farm releases its attack loop before deposit; server restart rejoins before switching; safety recipe uses engine settings', async () => {
  const farm = (await interpret(RECIPES['mob-farm']())).calls
  assert.deepEqual(farm.map(([type]) => type), ['leftClick', 'wait', 'leftClick', 'deposit'])
  assert.equal(farm[0][1].action, 'hold'); assert.equal(farm[0][1].only, 'entities'); assert.equal(farm[2][1].action, 'release')
  const restart = (await interpret(RECIPES['server-restart']())).calls
  assert.deepEqual(restart.map(([type]) => type), ['reconnect', 'chat'])
  assert.equal(restart[1][1].message, '/server towny')
  assert.ok(restart[0][1].delaySec > 0)
  const safety = (await interpret(RECIPES['eat-totem']())).calls[0]
  assert.equal(safety[0], 'safetySettings')
  for (const key of ['autoEat', 'autoTotem', 'totemDisconnect']) assert.equal(safety[1][key], true)
  assert.equal(safety[1].autoEatThreshold, 14)
})
