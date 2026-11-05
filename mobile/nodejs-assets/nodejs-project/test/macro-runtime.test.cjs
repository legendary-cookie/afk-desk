'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMacroRuntime } = require('../macro-runtime.cjs')
function setup() {
  const sent = []
  const manager = { sessions: new Map([['a', { ready: true, bot: { entity: {} } }]]), sendChat: (_id, message) => sent.push(message) }
  return { runtime: createMacroRuntime(manager), sent }
}
const graph = { version: 3, id: 'g', nodes: [{ id: 't', kind: 'trigger.manual', params: {} }, { id: 'c', kind: 'chat', params: { message: 'hello' } }], edges: [{ id: 'e', from: { node: 't', port: 'out' }, to: { node: 'c', port: 'in' } }] }
test('runs a validated graph on the selected account and stops a waiting run', async () => {
  const { runtime, sent } = setup()
  runtime.runGraph('a', graph)
  await runtime.engine.runs.get('a').done
  assert.deepEqual(sent, ['hello'])
  const waiting = { ...graph, nodes: [graph.nodes[0], { id: 'c', kind: 'wait', params: { durationMs: 10000 } }] }
  runtime.runGraph('a', waiting)
  await runtime.stop('a')
  assert.equal(runtime.engine.isRunning('a'), false)
  assert.throws(() => runtime.runGraph('a', { version: 3, nodes: [], edges: [] }))
  await runtime.engine.shutdown()
})
test('reports planned graph and v2 timer triggers and clears them on disconnect', async () => {
  const { runtime } = setup()
  runtime.setLibrary([{ id: 'v2', enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'timer', intervalMs: 5000 }, steps: [] }, { ...graph, enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, nodes: [{ id: 't', kind: 'trigger.timer', params: { intervalMs: 6000 } }] , edges: [] }])
  runtime.event('a', 'spawn')
  assert.equal(runtime.upcoming('a').length, 2)
  runtime.event('a', 'disconnected')
  assert.deepEqual(runtime.upcoming('a'), [])
  await runtime.engine.shutdown()
})

test('the interpreter releases held inputs when a mobile run stops', async () => {
  const { clock, fakeBot, flush } = require('./macro-fixture.cjs')
  const time = clock(), bot = fakeBot()
  const manager = { sessions: new Map([['a', { ready: true, bot }]]), requireOnline: () => bot }
  const runtime = createMacroRuntime(manager, () => {}, time)
  runtime.setLibrary([{ id: 'hold', enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, defaultDelayMs: 0,
    trigger: { type: 'manual' }, steps: [{ type: 'control', control: 'jump', action: 'hold' }, { type: 'wait', ms: 10000 }] }])
  const running = runtime.engine.run('a', 'hold')
  await flush()
  assert.deepEqual(bot.calls, [['setControlState', 'jump', true]])
  await runtime.stop('a'); await running
  assert.deepEqual(bot.calls.at(-1), ['setControlState', 'jump', false])
  assert.equal(time.size(), 0)
  await runtime.engine.shutdown()
})

test('event adapter forwards chat, telemetry, windows and player data with session identity', async () => {
  const { runtime } = setup()
  const received = []; runtime.engine.onBotEvent = event => received.push(event)
  runtime.forward('status', 'a', { status: 'online' })
  runtime.forward('log', 'a', { kind: 'chat', message: '§aHello' })
  runtime.forward('telemetry', 'a', { health: 20, inventory: [] })
  runtime.forward('window', 'a', { open: true, title: 'Shop' })
  runtime.forward('playerAppears', 'a', { username: 'Alex' })
  assert.deepEqual(received.map(e => e.type), ['connected', 'spawn', 'chat', 'telemetry', 'windowOpen', 'playerAppears'])
  assert.equal(received[2].payload.text, 'Hello'); assert.equal(received[4].payload.title, 'Shop')
  assert.equal(received[5].payload.username, 'Alex'); assert.ok(received.every(e => e.sessionId === received[0].sessionId))
  await runtime.engine.shutdown()
})

test('forwarded chat triggers an enabled macro for the matching session', async () => {
  const { runtime, sent } = setup()
  runtime.setLibrary([{ id: 'chat-trigger', enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'chat', pattern: 'hello', match: 'contains' }, defaultDelayMs: 0, steps: [{ type: 'chat', message: 'matched' }] }])
  runtime.forward('status', 'a', { status: 'online' })
  runtime.forward('log', 'a', { kind: 'chat', message: 'hello there' })
  const run = runtime.engine.runs.get('a')
  assert.ok(run)
  await run.done
  assert.deepEqual(sent, ['matched'])
  await runtime.engine.shutdown()
})
