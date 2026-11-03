'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeMacro } = require('../electron/macro/model.cjs')
const { ChatHistory } = require('../src/chat-history.js')
const { MacroEngine } = require('../electron/macro/engine.cjs')

test('reconnect parameters default, clamp and preserve legacy delays', () => {
  const steps = normalizeMacro({ steps: [{ type: 'reconnect' }, { type: 'reconnect', delaySec: 4000, maxAttempts: 3 }, { type: 'reconnect', delayMs: 2500 }] }).steps
  assert.deepEqual(steps, [{ type: 'reconnect', delaySec: 5 }, { type: 'reconnect', delaySec: 3600, maxAttempts: 3 }, { type: 'reconnect', delayMs: 2500 }])
})

test('stop condition retains all-account scope', () => {
  assert.equal(normalizeMacro({ stopWhen: [{ type: 'online', allAccounts: true }] }).stopWhen[0].allAccounts, true)
})

test('all-account stop only stops other runs of the same macro', () => {
  const engine = Object.create(MacroEngine.prototype)
  const ctx = { macroId: 'm', macro: { stopWhen: [{ type: 'always', allAccounts: true }] } }
  const same = { macroId: 'm' }
  const other = { macroId: 'other' }
  engine.runs = new Map([['a', ctx], ['b', same], ['c', other]])
  const stopped = []
  engine._requestStop = (run) => stopped.push(run)
  assert.equal(engine._stopWhenMatches(ctx), true)
  assert.deepEqual(stopped, [same])
})

test('history is shared across inputs and isolated by account', () => {
  const history = new ChatHistory()
  history.add('a', 'first')
  history.add('b', 'other')
  assert.equal(history.navigate('a', 'up', ''), 'first')
  assert.equal(history.navigate('b', 'up', ''), 'other')
})

test('item count compares the total of matching inventory stacks', () => {
  const engine = Object.create(MacroEngine.prototype)
  engine._state = () => ({ inventory: [{ name: 'stone', count: 3 }, { name: 'stone', count: 4 }, { name: 'dirt', count: 9 }] })
  const ctx = { accountId: 'a' }
  assert.equal(engine._evaluate(ctx, { type: 'itemCount', name: 'stone', comparator: '>=', count: 7 }, 0), true)
  assert.equal(engine._evaluate(ctx, { type: 'itemCount', name: 'stone', comparator: '<', count: 7 }, 0), false)
})

test('entity count filters type, name and radius and compares totals', () => {
  const engine = Object.create(MacroEngine.prototype)
  engine._state = () => ({ entities: [
    { type: 'mob', name: 'zombie', distance: 4 },
    { type: 'mob', name: 'zombie', distance: 20 },
    { type: 'player', username: 'Alex', distance: 3 }
  ] })
  const ctx = { accountId: 'a' }
  assert.equal(engine._evaluate(ctx, { type: 'entityCount', entityType: 'mob', name: 'ZOMBIE', radius: 5, comparator: '==', count: 1 }, 0), true)
  assert.equal(engine._evaluate(ctx, { type: 'entityCount', entityType: 'player', name: 'alex', radius: 5, comparator: '>', count: 1 }, 0), false)
  assert.equal(engine._evaluate(ctx, { type: 'entityCount', entityType: 'any', radius: 5, comparator: '<=', count: 2 }, 0), true)
  assert.deepEqual(normalizeMacro({ stopWhen: [{ type: 'entityCount', entityType: 'mob', radius: 999, count: 2 }] }).stopWhen[0], { type: 'entityCount', entityType: 'mob', name: '', radius: 256, comparator: '>=', count: 2 })
})
