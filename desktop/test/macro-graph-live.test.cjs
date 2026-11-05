'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const live = require('../src/macro-graph-live.js')
const { runGraph } = require('../electron/macro/graph-interpreter.cjs')

const graph = { version: 3, nodes: [
  { id: 'start', kind: 'trigger.manual', params: {}, position: { x: 0, y: 0 } },
  { id: 'health', kind: 'health', params: {}, position: { x: 0, y: 120 } },
  { id: 'action', kind: 'selectHotbar', params: { slot: 0 }, position: { x: 240, y: 0 } }
], edges: [
  { id: 'control', from: { node: 'start', port: 'out' }, to: { node: 'action', port: 'in' } },
  { id: 'value', from: { node: 'health', port: 'value' }, to: { node: 'action', port: 'slot' } }
] }

test('interpreter emits node, value and pinned failure on the existing event stream', async () => {
  const events = [], ctx = { macro: graph, macroId: 'm', accountId: 'a', runId: 'r', record: { trigger: 'manual' }, signal: new AbortController().signal }
  const engine = { _emit: e => events.push(e), _throwIfAborted() {}, _state: () => ({ health: 12 }), _stepFacade: async () => { throw Error('bad <player>') } }
  await assert.rejects(runGraph(engine, ctx), /bad/)
  assert.deepEqual(events.map(e => [e.status, e.nodeId || e.edgeId]), [['graphNode', 'start'], ['graphValue', 'control'], ['graphNode', 'action'], ['graphValue', 'value'], ['graphError', 'action']])
  assert.equal(events[3].value, '12')
  assert.equal(events[4].error.message, 'bad <player>')
  assert.ok(events.every(e => e.runId === 'r' && e.accountId === 'a' && e.macroId === 'm'))
})

test('live state retains wire values and errors until the next run and ignores stale events', () => {
  let state = live.update(null, { runId: 'r', status: 'started' }, graph)
  for (const event of [{ status: 'graphNode', nodeId: 'action' }, { status: 'graphValue', edgeId: 'value', value: '<player>' }, { status: 'stepFailed', stepPath: [2], error: { message: 'bad' } }, { status: 'step', stepPath: [0] }]) state = live.update(state, { runId: 'r', ...event }, graph)
  assert.equal(state.nodeId, 'action'); assert.equal(state.values.value, '<player>'); assert.equal(state.errors.action, 'bad')
  state = live.update(state, { runId: 'r', status: 'failed' }, graph)
  assert.equal(state.nodeId, null); assert.equal(state.status, 'failed'); assert.equal(state.errors.action, 'bad')
  state = live.update(state, { runId: 'new', status: 'started' }, graph)
  assert.deepEqual(state.values, {}); assert.deepEqual(state.errors, {})
  assert.equal(live.update(state, { runId: 'r', status: 'completed' }, graph), state)
})

test('graph rendering uses text content and masks wire values and errors', () => {
  const old = global.document
  function element() { return { children: [], style: {}, classList: { add() {} }, append(...items) { this.children.push(...items) }, prepend(item) { this.children.unshift(item) }, replaceChildren(...items) { this.children = items }, setAttribute() {} } }
  global.document = { createElement: element, createElementNS: element }
  try {
    const container = element(), state = { status: 'started', nodeId: 'action', values: { value: '<player>' }, errors: { action: '<player>' } }
    live.render(container, graph, state, text => String(text).replaceAll('<player>', 'masked'))
    const all = []; const visit = node => { all.push(node); node.children.forEach(visit) }; visit(container)
    assert.ok(all.some(node => node.textContent?.includes('masked')))
    assert.ok(all.some(node => node.className?.includes('live-running')))
    assert.ok(all.some(node => node.className?.includes('live-failed')))
    assert.ok(all.every(node => !('innerHTML' in node)))
  } finally { global.document = old }
})

test('live graph events reach the UI without persisting transient wire data', () => {
  const { AppCore } = require('../core/app-core.cjs')
  const sent = [], persisted = []
  const core = { _sendUi: (...args) => sent.push(args), _persistEventSafely: (...args) => persisted.push(args) }
  for (const status of ['graphNode', 'graphValue', 'graphError', 'completed']) AppCore.prototype.emitMacroRunEvent.call(core, { accountId: 'a', status })
  assert.equal(sent.length, 4)
  assert.deepEqual(persisted.map(entry => entry[2].status), ['completed'])
})
