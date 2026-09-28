const test = require('node:test')
const assert = require('node:assert/strict')
const { MacroEngine, SmartProxyManager } = require('../electron/beta-core.cjs')

const flush = () => new Promise(resolve => setImmediate(resolve))
class Timers {
  constructor() { this.handles = new Map(); this.next = 0 }
  setTimeout(callback, delay) { const id = ++this.next; this.handles.set(id, { callback, delay }); return id }
  clearTimeout(id) { this.handles.delete(id) }
  fire(delay) {
    for (const [id, timer] of [...this.handles]) {
      if (timer.delay === delay) { this.handles.delete(id); timer.callback() }
    }
  }
}
function fixture(steps, execute = async () => {}, trigger = { type: 'manual' }) {
  const events = [], timers = new Timers()
  const account = { id: 'one', automations: [{ id: 'macro', trigger, steps }] }
  const engine = new MacroEngine({ getAccount: () => account, getState: () => ({}), execute, timers, emit: (...args) => events.push(args[2]) })
  return { engine, events, timers }
}

test('smart proxy cooldown excludes a failed sticky proxy and recovers after expiry', () => {
  const manager = new SmartProxyManager()
  const account = { id: 'client', identityId: 'identity', proxyMode: 'smart' }
  const pool = ['a', 'b'].map(id => ({ id, shareProxyToPool: true, proxy: { enabled: true, host: id } }))
  const first = manager.select(account, pool)
  manager.report(first, false)
  manager.release(first)
  const second = manager.select(account, pool)
  assert.equal(second.poolOwnerId, 'b')
  manager.report(second, false)
  manager.release(second)
  assert.throws(() => manager.select(account, pool), /cooldown|cooling/i)
  manager.health.get('a').cooldownUntil = Date.now() - 1
  assert.equal(manager.select(account, pool).poolOwnerId, 'a')
})

test('inventory macros run on changed telemetry inventory but not repeated snapshots', async () => {
  const messages = []
  const { engine } = fixture([{ type: 'chat', message: 'changed' }], async (_id, step) => messages.push(step.message), { type: 'inventory' })
  await engine.handleEvent('one', 'telemetry', { health: 20, inventory: [] })
  await flush()
  await engine.handleEvent('one', 'telemetry', { health: 20, inventory: [{ slot: 9, name: 'stone', count: 1 }] })
  await flush()
  await engine.handleEvent('one', 'telemetry', { health: 19, inventory: [{ slot: 9, name: 'stone', count: 1 }] })
  await flush()
  assert.deepEqual(messages, ['changed'])
})

test('stopping a pending macro settles cancellation and blocks later steps', async () => {
  let finish, context
  const calls = []
  const { engine, events, timers } = fixture([{ type: 'chat', message: 'first' }, { type: 'chat', message: 'second' }], (_id, step, ctx) => {
    calls.push(step.message); context = ctx
    return new Promise(resolve => { finish = resolve })
  })
  let settled = false
  engine.run('one', 'macro').then(() => { settled = true })
  engine.stop('one')
  await flush()
  assert.equal(settled, true)
  assert.equal(context.signal.aborted, true)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal(timers.handles.size, 0)
  finish()
  await flush()
  assert.deepEqual(calls, ['first'])
})

test('hung macro action reaches runtime deadline and releases timers and running state', async () => {
  let context
  const { engine, events, timers } = fixture([{ type: 'chat' }], (_id, _step, ctx) => {
    context = ctx
    return new Promise(() => {})
  })
  let error
  engine.run('one', 'macro').catch(value => { error = value })
  timers.fire(300000)
  await flush()
  assert.match(error?.message || '', /runtime limit/i)
  assert.equal(context.signal.aborted, true)
  assert.equal(engine.running.size, 0)
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(timers.handles.size, 0)
})

test('stopping a wait clears both wait and deadline timers', async () => {
  const { engine, events, timers } = fixture([{ type: 'wait', milliseconds: 10000 }])
  let settled = false
  engine.run('one', 'macro').then(() => { settled = true })
  engine.stop('one')
  await flush()
  assert.equal(settled, true)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal(timers.handles.size, 0)
})

test('successful macro clears its deadline timer', async () => {
  const { engine, timers, events } = fixture([{ type: 'set', variable: 'result', value: 1 }])
  await engine.run('one', 'macro')
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(timers.handles.size, 0)
})

test('health triggers and conditional repeated steps keep their existing behavior', async () => {
  const messages = []
  const { engine, events, timers } = fixture([
    { type: 'set', variable: 'ready', value: true },
    { type: 'if', condition: { type: 'variableEquals', name: 'ready', value: true },
      then: [{ type: 'repeat', times: 2, steps: [{ type: 'chat', message: 'low health' }] }],
      else: [{ type: 'chat', message: 'wrong branch' }] }
  ], async (_id, step) => messages.push(step.message), { type: 'health', below: 8 })
  await engine.handleEvent('one', 'telemetry', { health: 20, inventory: [] })
  await engine.handleEvent('one', 'telemetry', { health: 4, inventory: [] })
  await flush()
  assert.deepEqual(messages, ['low health', 'low health'])
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(timers.handles.size, 0)
})

test('failed actions propagate their error and clear the deadline', async () => {
  const { engine, events, timers } = fixture([{ type: 'chat' }], async () => { throw new Error('Connection closed') })
  await assert.rejects(engine.run('one', 'macro'), /Connection closed/)
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(timers.handles.size, 0)
  assert.equal(engine.running.size, 0)
})
