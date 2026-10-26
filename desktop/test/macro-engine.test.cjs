'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { MacroEngine, createScheduler } = require('../electron/macro/engine.cjs')
const { FACADE_METHODS, LIMITS, MacroActionError, assertFacade } = require('../electron/macro/contract.cjs')

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

// ---------------------------------------------------------------------------
// Fakes: a controllable clock/timers, a facade built from FACADE_METHODS, and a
// trigger matcher implementing the contract interface.
// ---------------------------------------------------------------------------

function createFakeClock(start = 1000000) {
  let now = start
  let nextId = 0
  let setCount = 0
  let maxPending = 0
  const timers = new Map()
  const flush = async () => {
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = ++nextId
        setCount += 1
        timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, id })
        maxPending = Math.max(maxPending, timers.size)
        return id
      },
      clearTimeout(id) { timers.delete(id) }
    },
    pending: () => timers.size,
    setCount: () => setCount,
    maxPending: () => maxPending,
    resetMaxPending() { maxPending = timers.size },
    flush,
    async advance(ms) {
      const target = now + ms
      for (;;) {
        await flush()
        let next = null
        for (const timer of timers.values()) {
          if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer
        }
        if (!next) break
        timers.delete(next.id)
        now = Math.max(now, next.at)
        next.fn()
      }
      now = target
      await flush()
    }
  }
}

function createFakeFacade(clock) {
  const calls = []
  const releases = []
  const sessions = new Map()
  const states = new Map()
  const handlers = {}
  const facade = {}
  for (const name of FACADE_METHODS) {
    facade[name] = (accountId, args, ctx) => {
      calls.push({ name, accountId, args, ctx, at: clock.now() })
      return handlers[name] ? handlers[name](accountId, args, ctx) : Promise.resolve(true)
    }
  }
  facade.sessionId = (accountId) => (sessions.has(accountId) ? sessions.get(accountId) : null)
  facade.state = (accountId) => states.get(accountId) || { online: sessions.has(accountId) }
  facade.releaseOwner = (accountId, owner) => { releases.push({ accountId, owner }) }
  assertFacade(facade)
  return {
    facade, calls, releases, sessions, states, handlers,
    stepCalls: (name) => calls.filter((call) => !name || call.name === name)
  }
}

class FakeMatcher {
  constructor() {
    this.macros = []
    this.resolve = () => []
    this.resets = []
    this.events = []
    this.joined = new Map()
    this.throwOnEvent = false
  }
  setMacros(macros, resolveTargets) { this.macros = macros; this.resolve = resolveTargets }
  _for(accountId, type) { return this.macros.filter((m) => m.enabled && m.trigger.type === type && this.resolve(m).includes(accountId)) }
  onEvent(event) {
    this.events.push(event)
    if (this.throwOnEvent) throw new Error('matcher exploded')
    const type = { spawn: 'join', chat: 'chat', death: 'death', disconnected: 'disconnected' }[event.type]
    if (!type) return []
    if (event.type === 'spawn') {
      if (this.joined.get(event.accountId) === event.sessionId) return []
      this.joined.set(event.accountId, event.sessionId)
    }
    return this._for(event.accountId, type)
      .filter((m) => type !== 'chat' || String(event.payload?.text || '').includes(m.trigger.pattern))
      .map((m) => ({ macroId: m.id, accountId: event.accountId, triggerType: type, variables: { ...(event.payload?.variables || {}) } }))
  }
  timedTriggers(accountId) {
    return this.macros
      .filter((m) => m.enabled && (m.trigger.type === 'timer' || m.trigger.type === 'schedule') && this.resolve(m).includes(accountId))
      .map((m) => ({ macroId: m.id, trigger: m.trigger }))
  }
  resetAccount(accountId) { this.resets.push(accountId); this.joined.delete(accountId) }
}

function macro(id, overrides = {}) {
  return {
    id, name: id, enabled: true, targets: { mode: 'all' }, trigger: { type: 'manual' }, stopWhen: [],
    concurrency: 'skip', onError: 'continue', defaultDelayMs: 0, maxRuntimeMs: null, steps: [], notify: {}, origin: {},
    ...overrides
  }
}

function setup({ accounts = ['a'], macros = [], scheduler, ...options } = {}) {
  const clock = createFakeClock()
  const fake = createFakeFacade(clock)
  const matcher = new FakeMatcher()
  const events = []
  const engine = new MacroEngine({
    facade: fake.facade,
    matcher,
    scheduler,
    timers: clock.timers,
    now: clock.now,
    emit: (event) => events.push(event),
    getAccountState: (accountId) => fake.states.get(accountId) || { online: fake.sessions.has(accountId) },
    resolveTargets: (m) => (m.targets.mode === 'accounts' ? m.targets.accountIds : accounts),
    ...options
  })
  engine.setLibrary(macros)
  const online = (accountId, sessionId = `${accountId}-s1`) => {
    fake.sessions.set(accountId, sessionId)
    engine.onBotEvent({ type: 'connected', accountId, sessionId, at: clock.now() })
    engine.onBotEvent({ type: 'spawn', accountId, sessionId, at: clock.now() })
  }
  const offline = (accountId) => {
    const sessionId = fake.sessions.get(accountId)
    fake.sessions.delete(accountId)
    engine.onBotEvent({ type: 'disconnected', accountId, sessionId, at: clock.now(), payload: { reason: 'test', manual: false } })
  }
  const statuses = (filter = () => true) => events.filter(filter).map((event) => event.status)
  const final = (runId) => events.filter((event) => event.runId === runId && !['started', 'step', 'stepFailed'].includes(event.status)).map((event) => event.status)
  return { clock, fake, matcher, events, engine, online, offline, statuses, final }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const look = { type: 'look', mode: 'relative', yaw: 1, pitch: 0 }

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test('scheduler runs entries in time then insertion order on a single timeout', async () => {
  const clock = createFakeClock()
  const scheduler = createScheduler({ timers: clock.timers, now: clock.now })
  const order = []
  scheduler.at(clock.now() + 100, () => order.push('b'))
  scheduler.at(clock.now() + 50, () => order.push('a'))
  scheduler.at(clock.now() + 100, () => order.push('c'))
  scheduler.after(100, () => { throw new Error('boom') })
  scheduler.after(100, () => order.push('d'))
  scheduler.after(150, () => order.push('e'))
  assert.equal(scheduler.size(), 6)
  assert.equal(clock.pending(), 1)
  assert.equal(clock.maxPending(), 1)
  await clock.advance(100)
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
  assert.equal(scheduler.size(), 1)
  await clock.advance(50)
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(scheduler.size(), 0)
  assert.equal(clock.pending(), 0)
})

test('scheduler re-arms only when the head changes and supports cancel and cancelKey', async () => {
  const clock = createFakeClock()
  const scheduler = createScheduler({ timers: clock.timers, now: clock.now })
  const ran = []
  const cancelLate = scheduler.after(500, () => ran.push('late'))
  assert.equal(clock.setCount(), 1)
  scheduler.after(900, () => ran.push('later'))
  assert.equal(clock.setCount(), 1, 'a later entry does not re-arm')
  const cancelEarly = scheduler.after(100, () => ran.push('early'))
  assert.equal(clock.setCount(), 2, 'an earlier entry re-arms')
  assert.equal(clock.pending(), 1)
  cancelEarly()
  cancelEarly()
  assert.equal(clock.pending(), 1)
  assert.equal(scheduler.size(), 2)
  cancelLate()
  scheduler.after(200, () => ran.push('x1'), 'x')
  scheduler.after(300, () => ran.push('x2'), 'x')
  scheduler.after(250, () => ran.push('y'), 'y')
  scheduler.cancelKey('x')
  scheduler.cancelKey('missing')
  assert.equal(scheduler.size(), 2)
  assert.equal(clock.maxPending(), 1)
  await clock.advance(1000)
  assert.deepEqual(ran, ['y', 'later'])
  assert.equal(clock.pending(), 0)
})

test('scheduler survives throwing callbacks, defers entries added while firing, and disposes', async () => {
  const clock = createFakeClock()
  const errors = []
  const scheduler = createScheduler({ timers: clock.timers, now: clock.now, onError: (error) => errors.push(error.message) })
  const ran = []
  scheduler.after(10, () => { scheduler.after(0, () => ran.push('nested')); throw new Error('bad') })
  scheduler.after(10, () => ran.push('after-throw'))
  await clock.advance(10)
  assert.deepEqual(ran, ['after-throw', 'nested'])
  assert.deepEqual(errors, ['bad'])
  scheduler.after(10, () => ran.push('never'))
  scheduler.dispose()
  assert.equal(scheduler.size(), 0)
  assert.equal(clock.pending(), 0)
  scheduler.after(1, () => ran.push('never2'))
  await clock.advance(100)
  assert.deepEqual(ran, ['after-throw', 'nested'])
})

// ---------------------------------------------------------------------------
// Concurrency, errors, cancellation
// ---------------------------------------------------------------------------

test('a trigger while busy is skipped with concurrency skip and overrides with override', async () => {
  const h = setup({
    macros: [
      macro('long', { steps: [{ type: 'wait', ms: 10000 }, { type: 'chat', message: 'after' }] }),
      macro('polite', { steps: [{ type: 'chat', message: 'polite' }] }),
      macro('rude', { concurrency: 'override', steps: [{ type: 'chat', message: 'rude' }] })
    ]
  })
  h.online('a')
  const long = h.engine.run('a', 'long')
  await h.clock.flush()
  assert.equal(h.engine.isRunning('a'), true)
  const skipped = await h.engine.run('a', 'polite')
  assert.equal(skipped.status, 'skipped')
  assert.equal(h.fake.stepCalls('chat').length, 0)
  const rude = h.engine.run('a', 'rude')
  assert.equal((await long).status, 'cancelled')
  assert.equal((await rude).status, 'completed')
  assert.deepEqual(h.fake.stepCalls('chat').map((call) => call.args.message), ['rude'])
  const order = h.events.filter((e) => ['started', 'cancelled', 'completed', 'skipped'].includes(e.status)).map((e) => `${e.macroId}:${e.status}`)
  assert.deepEqual(order, ['long:started', 'polite:skipped', 'long:cancelled', 'rude:started', 'rude:completed'])
  assert.equal(h.events.find((e) => e.status === 'cancelled').reason, 'override')
  assert.equal(h.engine.isRunning('a'), false)
})

test('onError continue keeps going; stop fails the run; ABORTED and SESSION_CHANGED always end it', async () => {
  const h = setup({
    macros: [
      macro('cont', { steps: [look, { type: 'chat', message: 'still here' }] }),
      macro('halt', { onError: 'stop', steps: [look, { type: 'chat', message: 'never' }] })
    ]
  })
  h.online('a')
  h.fake.handlers.look = () => Promise.reject(new MacroActionError('NOT_FOUND', 'nothing to look at'))
  const settle = async (promise) => { await h.clock.advance(5000); return promise }
  const cont = await settle(h.engine.run('a', 'cont'))
  assert.equal(cont.status, 'completed')
  const failedEvent = h.events.find((e) => e.status === 'stepFailed')
  assert.deepEqual(failedEvent.error, { code: 'NOT_FOUND', message: 'nothing to look at' })
  assert.deepEqual(failedEvent.stepPath, [0])
  assert.equal(h.fake.stepCalls('chat').length, 1)
  const halt = await settle(h.engine.run('a', 'halt'))
  assert.equal(halt.status, 'failed')
  assert.equal(h.fake.stepCalls('chat').length, 1)
  const log = h.engine.runLog('halt')[0]
  assert.equal(log.status, 'failed')
  assert.equal(log.steps[0].ok, false)

  h.fake.handlers.look = () => Promise.reject(new MacroActionError('ABORTED', 'aborted inside'))
  assert.equal((await settle(h.engine.run('a', 'cont'))).status, 'cancelled')
  h.fake.handlers.look = () => Promise.reject(new MacroActionError('SESSION_CHANGED', 'new session'))
  assert.equal((await settle(h.engine.run('a', 'cont'))).status, 'interrupted')
  h.fake.handlers.look = () => { throw new Error('sync throw') }
  assert.equal((await settle(h.engine.run('a', 'cont'))).status, 'completed')
  assert.equal(h.fake.stepCalls('chat').length, 2)
  assert.equal(h.events.filter((e) => e.status === 'stepFailed').at(-1).error.code, 'INVALID')
})

test('stop awaits an in-flight facade operation that settles within the grace period', async () => {
  const h = setup({ macros: [macro('m', { steps: [look, { type: 'chat', message: 'no' }] })] })
  h.online('a')
  let seenSignal = null
  h.fake.handlers.look = (accountId, args, ctx) => {
    seenSignal = ctx.signal
    return new Promise((resolve) => h.clock.timers.setTimeout(() => resolve('done'), 500))
  }
  const run = h.engine.run('a', 'm')
  await h.clock.flush()
  const t0 = h.clock.now()
  let stoppedAt = null
  h.engine.stop('a').then(() => { stoppedAt = h.clock.now() })
  assert.equal(seenSignal.aborted, true)
  await h.clock.advance(499)
  assert.equal(stoppedAt, null, 'stop waits for the in-flight operation')
  assert.equal(h.engine.isRunning('a'), true)
  await h.clock.advance(1)
  assert.equal(stoppedAt, t0 + 500)
  assert.ok(stoppedAt < t0 + LIMITS.cancelGraceMs)
  assert.equal((await run).status, 'cancelled')
  assert.equal(h.fake.stepCalls('chat').length, 0)
  assert.equal(h.fake.releases.length, 1)
})

test('stop resolves at the grace period for a hung operation and fences the late result', async () => {
  const h = setup({ macros: [macro('m', { steps: [look, { type: 'chat', message: 'no' }] })] })
  h.online('a')
  const hung = deferred()
  h.fake.handlers.look = () => hung.promise
  const run = h.engine.run('a', 'm')
  await h.clock.flush()
  const t0 = h.clock.now()
  let stoppedAt = null
  h.engine.stop('a').then(() => { stoppedAt = h.clock.now() })
  await h.clock.advance(LIMITS.cancelGraceMs - 1)
  assert.equal(stoppedAt, null)
  await h.clock.advance(1)
  assert.equal(stoppedAt, t0 + LIMITS.cancelGraceMs)
  assert.equal((await run).status, 'cancelled')
  const eventsBefore = h.events.length
  const callsBefore = h.fake.calls.length
  hung.resolve('late')
  await h.clock.advance(5000)
  assert.equal(h.events.length, eventsBefore, 'late result emits nothing')
  assert.equal(h.fake.calls.length, callsBefore, 'late result issues no further steps')
  assert.equal(h.fake.releases.length, 1)
  // A hung op that later rejects must not surface as an unhandled rejection.
  const hung2 = deferred()
  h.fake.handlers.look = () => hung2.promise
  const run2 = h.engine.run('a', 'm')
  await h.clock.flush()
  h.engine.stop('a')
  await h.clock.advance(LIMITS.cancelGraceMs)
  assert.equal((await run2).status, 'cancelled')
  hung2.reject(new Error('late failure'))
  await h.clock.flush()
})

test('session fence trips after a facade call and before the next one', async () => {
  const h = setup({
    macros: [
      macro('after-call', { steps: [look, { type: 'chat', message: 'no' }] }),
      macro('during-wait', { steps: [{ type: 'wait', ms: 1000 }, { type: 'chat', message: 'no' }] })
    ]
  })
  h.online('a')
  h.fake.handlers.look = (accountId, args, ctx) => {
    assert.equal(ctx.sessionId, 'a-s1')
    assert.match(ctx.owner, /^macro:/)
    h.fake.sessions.set('a', 'a-s2')
    return Promise.resolve()
  }
  assert.equal((await h.engine.run('a', 'after-call')).status, 'interrupted')
  h.fake.sessions.set('a', 'a-s1')
  const run = h.engine.run('a', 'during-wait')
  await h.clock.flush()
  h.fake.sessions.set('a', 'a-s3')
  await h.clock.advance(1000)
  assert.equal((await run).status, 'interrupted')
  assert.equal(h.fake.stepCalls('chat').length, 0)
  assert.equal(h.fake.releases.length, 2)
})

test('releaseOwner is called exactly once on every exit path', async (t) => {
  const failing = () => Promise.reject(new MacroActionError('NOT_FOUND', 'x'))
  const cases = [
    { name: 'completed', overrides: { steps: [{ type: 'chat', message: 'hi' }] }, status: 'completed' },
    { name: 'failed', overrides: { onError: 'stop', steps: [look] }, before: (h) => { h.fake.handlers.look = failing }, status: 'failed' },
    { name: 'stop step', overrides: { steps: [{ type: 'stop' }, look] }, status: 'stopped' },
    { name: 'stopWhen', overrides: { stopWhen: [{ type: 'healthBelow', value: 10 }], steps: [look] }, before: (h) => h.fake.states.set('a', { online: true, health: 4 }), status: 'stopped' },
    { name: 'maxRuntime', overrides: { maxRuntimeMs: 1000, steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.clock.advance(1000), status: 'stopped' },
    { name: 'cancelled', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.stop('a'), status: 'cancelled' },
    { name: 'stopMacro', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.stopMacro('m'), status: 'cancelled' },
    { name: 'disconnect', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.offline('a'), status: 'interrupted' },
    { name: 'fence', overrides: { steps: [look] }, before: (h) => { h.fake.handlers.look = () => { h.fake.sessions.set('a', 'other'); return Promise.resolve() } }, status: 'interrupted' },
    { name: 'override', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.run('a', 'o'), status: 'cancelled' },
    { name: 'library removal', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.setLibrary([]), status: 'cancelled' },
    { name: 'library disable', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.setLibrary([macro('m', { enabled: false, steps: [{ type: 'wait', ms: 5000 }] })]), status: 'cancelled' },
    { name: 'library edit', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.setLibrary([macro('m', { steps: [{ type: 'wait', ms: 6000 }] })]), status: 'cancelled' },
    { name: 'shutdown', overrides: { steps: [{ type: 'wait', ms: 5000 }] }, act: (h) => h.engine.shutdown(), status: 'cancelled' }
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const h = setup({ macros: [macro('m', item.overrides), macro('o', { concurrency: 'override', steps: [] })] })
      h.online('a')
      if (item.before) item.before(h)
      const run = h.engine.run('a', 'm')
      await h.clock.flush()
      if (item.act) await Promise.race([item.act(h), h.clock.advance(0)])
      await h.clock.advance(LIMITS.cancelGraceMs)
      const result = await run
      assert.equal(result.status, item.status)
      await h.clock.advance(10000)
      const own = h.fake.releases.filter((release) => release.owner === `macro:${result.runId}`)
      assert.equal(own.length, 1, `${item.name}: releaseOwner once`)
      assert.equal(own[0].accountId, 'a')
      assert.equal(h.engine.isRunning('a'), false)
    })
  }
})

// ---------------------------------------------------------------------------
// Budgets, loops, stopWhen
// ---------------------------------------------------------------------------

test('step budget: 25 instant steps take at least one second', async () => {
  const h = setup({ macros: [macro('m', { steps: Array.from({ length: 25 }, () => look) })] })
  h.online('a')
  const t0 = h.clock.now()
  const run = h.engine.run('a', 'm')
  await h.clock.advance(3000)
  assert.equal((await run).status, 'completed')
  const calls = h.fake.stepCalls('look')
  assert.equal(calls.length, 25)
  assert.equal(calls[LIMITS.maxStepsPerSecond - 1].at, t0)
  assert.ok(calls[LIMITS.maxStepsPerSecond].at >= t0 + 1000)
  assert.ok(calls[24].at - t0 >= 1000)
})

test('chat budget spaces chat steps per account, across macros', async () => {
  const h = setup({
    accounts: ['a', 'b'],
    macros: [
      macro('three', { steps: [{ type: 'chat', message: '1' }, { type: 'chat', message: '2' }, { type: 'chat', message: '3' }] }),
      macro('one', { steps: [{ type: 'chat', message: 'x' }] })
    ]
  })
  h.online('a')
  h.online('b')
  const t0 = h.clock.now()
  let endedA = null
  const runA = h.engine.run('a', 'three')
  // The next macro on the same account starts the moment the first one ends.
  const next = runA.then(() => { endedA = h.clock.now(); return h.engine.run('a', 'one') })
  const runB = h.engine.run('b', 'one')
  await h.clock.advance(6000)
  await Promise.all([runA, runB, next])
  const atA = h.fake.stepCalls('chat').filter((c) => c.accountId === 'a').map((c) => c.at - t0)
  assert.equal(endedA, t0 + 3000)
  assert.deepEqual(atA, [0, 1500, 3000, 4500], 'budget is shared across runs')
  assert.deepEqual(h.fake.stepCalls('chat').filter((c) => c.accountId === 'b').map((c) => c.at - t0), [0], 'other accounts are independent')
})

test('chat interval is configurable per account but never below the minimum', async () => {
  const h = setup({ chatIntervalMs: (accountId) => (accountId === 'a' ? 100 : 2500), accounts: ['a', 'b'], macros: [macro('two', { steps: [{ type: 'chat', message: '1' }, { type: 'chat', message: '2' }] })] })
  h.online('a')
  h.online('b')
  const t0 = h.clock.now()
  const runs = [h.engine.run('a', 'two'), h.engine.run('b', 'two')]
  await h.clock.advance(5000)
  await Promise.all(runs)
  const at = (id) => h.fake.stepCalls('chat').filter((c) => c.accountId === id).map((c) => c.at - t0)
  assert.deepEqual(at('a'), [0, LIMITS.minChatIntervalMs])
  assert.deepEqual(at('b'), [0, 2500])
})

test('defaultDelayMs is inserted between facade steps only', async () => {
  const h = setup({ macros: [macro('m', { defaultDelayMs: 300, steps: [look, { type: 'set', variable: 'x', value: 1 }, look] })] })
  h.online('a')
  const t0 = h.clock.now()
  const run = h.engine.run('a', 'm')
  await h.clock.advance(1000)
  await run
  assert.deepEqual(h.fake.stepCalls('look').map((c) => c.at - t0), [0, 300])
})

test('loops yield at least one tick per iteration and while/if use run variables', async () => {
  const h = setup({
    macros: [
      macro('times', { steps: [{ type: 'repeat', times: 4, steps: [{ type: 'set', variable: 'x', value: 1 }] }] }),
      macro('empty', { steps: [{ type: 'repeat', times: 3, steps: [] }] }),
      macro('while', {
        steps: [
          { type: 'set', variable: 'flag', value: 'go' },
          { type: 'repeat', while: { type: 'variableEquals', name: 'flag', value: 'go' }, steps: [{ type: 'set', variable: 'flag', value: 'halt' }] },
          { type: 'if', condition: { type: 'variableEquals', name: 'flag', value: 'halt' }, then: [{ type: 'chat', message: 'flag={flag}' }], else: [{ type: 'chat', message: 'wrong' }] }
        ]
      }),
      macro('capped', { steps: [{ type: 'repeat', while: { type: 'always' }, maxIterations: 5, steps: [look] }] })
    ]
  })
  h.online('a')
  for (const [id, minimum] of [['times', 4 * LIMITS.minLoopYieldMs], ['empty', 3 * LIMITS.minLoopYieldMs]]) {
    const t0 = h.clock.now()
    let endedAt = null
    const run = h.engine.run('a', id).then((result) => { endedAt = h.clock.now(); return result })
    await h.clock.advance(1000)
    assert.equal((await run).status, 'completed')
    assert.ok(endedAt - t0 >= minimum, `${id} took ${endedAt - t0}ms`)
  }
  const whileRun = h.engine.run('a', 'while')
  await h.clock.advance(1000)
  assert.equal((await whileRun).status, 'completed')
  assert.deepEqual(h.fake.stepCalls('chat').map((c) => c.args.message), ['flag=halt'])
  const stepEvent = h.events.find((e) => e.status === 'step' && e.stepType === 'chat')
  assert.deepEqual(stepEvent.stepPath, [2, 0, 0])
  const capped = h.engine.run('a', 'capped')
  await h.clock.advance(1000)
  await capped
  assert.equal(h.fake.stepCalls('look').length, 5)
})

test('conditions read account state: hasItem, healthBelow, hungerBelow, inventoryFull, windowOpen, online, not', async () => {
  const branch = (condition) => macro(`c-${JSON.stringify(condition)}`, { steps: [{ type: 'if', condition, then: [{ type: 'chat', message: 'T' }], else: [{ type: 'chat', message: 'F' }] }] })
  const conditions = [
    [{ type: 'hasItem', name: 'bread', count: 5 }, 'T'],
    [{ type: 'hasItem', name: 'bread', count: 6 }, 'F'],
    [{ type: 'healthBelow', value: 10 }, 'T'],
    [{ type: 'hungerBelow', value: 5 }, 'F'],
    [{ type: 'inventoryFull' }, 'T'],
    [{ type: 'windowOpen' }, 'F'],
    [{ type: 'online' }, 'T'],
    [{ type: 'not', condition: { type: 'windowOpen' } }, 'T'],
    [{ type: 'not' }, 'F'],
    [{ type: 'mystery' }, 'F'],
    [{ type: 'always' }, 'T']
  ]
  const macros = conditions.map(([condition]) => branch(condition))
  const h = setup({ macros, chatIntervalMs: 500 })
  h.online('a')
  h.fake.states.set('a', { online: true, health: 8, food: 12, inventoryFull: true, windowOpen: false, inventory: [{ name: 'bread', count: 3, slot: 1 }, { name: 'bread', count: 2, slot: 2 }] })
  const messages = []
  for (const m of macros) {
    const run = h.engine.run('a', m.id)
    await h.clock.advance(600)
    await run
    messages.push(h.fake.stepCalls('chat').at(-1).args.message)
  }
  assert.deepEqual(messages, conditions.map(([, expected]) => expected))
})

test('stopWhen is checked before each step and on bot events', async () => {
  const h = setup({
    macros: [macro('m', { stopWhen: [{ type: 'healthBelow', value: 6 }], steps: [look, { type: 'wait', ms: 10000 }, { type: 'chat', message: 'no' }] })]
  })
  h.online('a')
  h.fake.states.set('a', { online: true, health: 20 })
  const run = h.engine.run('a', 'm')
  await h.clock.advance(100)
  assert.equal(h.fake.stepCalls('look').length, 1)
  h.fake.states.set('a', { online: true, health: 3 })
  h.engine.onBotEvent({ type: 'telemetry', accountId: 'a', sessionId: 'a-s1', at: h.clock.now(), payload: { health: 3 } })
  await h.clock.flush()
  const result = await run
  assert.equal(result.status, 'stopped')
  assert.equal(h.events.find((e) => e.runId === result.runId && e.status === 'stopped').reason, 'stopWhen')
  assert.equal(h.fake.stepCalls('chat').length, 0)
  // Already matching at start: stops before the first step.
  const second = await h.engine.run('a', 'm')
  assert.equal(second.status, 'stopped')
  assert.equal(h.fake.stepCalls('look').length, 1)
})

test('maxRuntimeMs stops the run with a reason; null means unlimited', async () => {
  const h = setup({
    macros: [
      macro('capped', { maxRuntimeMs: 2500, steps: [{ type: 'repeat', times: 100000, steps: [{ type: 'wait', ms: 1000 }] }] }),
      macro('free', { maxRuntimeMs: null, steps: [{ type: 'wait', ms: 3600000 }] })
    ]
  })
  h.online('a')
  const t0 = h.clock.now()
  const run = h.engine.run('a', 'capped')
  await h.clock.advance(3000)
  const result = await run
  assert.equal(result.status, 'stopped')
  const end = h.events.find((e) => e.runId === result.runId && e.status === 'stopped')
  assert.equal(end.reason, 'maxRuntime')
  assert.equal(end.at, t0 + 2500)
  const free = h.engine.run('a', 'free')
  await h.clock.advance(3600000)
  assert.equal((await free).status, 'completed')
})

test('variables from the trigger match are interpolated into chat and notify without evaluation', async () => {
  const h = setup({
    macros: [macro('greet', {
      trigger: { type: 'chat', pattern: 'joined' },
      steps: [{ type: 'chat', message: 'hi {name}, {unknown} {constructor} {1}' }, { type: 'notify', message: '{name} came', desktop: true }]
    })]
  })
  h.online('a')
  h.engine.onBotEvent({ type: 'chat', accountId: 'a', sessionId: 'a-s1', at: h.clock.now(), payload: { text: 'Steve joined', source: 'chat', variables: { name: 'Steve', 1: 'one' } } })
  await h.clock.advance(100)
  assert.equal(h.fake.stepCalls('chat')[0].args.message, 'hi Steve, {unknown} {constructor} one')
  const notify = h.fake.stepCalls('notify')[0]
  assert.equal(notify.args.message, 'Steve came')
  assert.equal(notify.args.macroId, 'greet')
  assert.equal(notify.args.desktop, true)
  assert.equal(h.events.find((e) => e.status === 'started').trigger, 'chat')
})

// ---------------------------------------------------------------------------
// Timed triggers
// ---------------------------------------------------------------------------

test('timers only fire while online, restart their phase at join, and skip while busy', async () => {
  const h = setup({ macros: [macro('tick', { trigger: { type: 'timer', intervalMs: 10000, jitterMs: 0 }, steps: [{ type: 'notify', message: 'tick' }] })] })
  const startedAt = () => h.events.filter((e) => e.status === 'started').map((e) => e.at)
  await h.clock.advance(30000)
  assert.equal(startedAt().length, 0, 'offline: never fires')
  const join1 = h.clock.now()
  h.online('a')
  await h.clock.advance(9999)
  assert.equal(startedAt().length, 0)
  await h.clock.advance(1)
  assert.deepEqual(startedAt(), [join1 + 10000])
  // A respawn in the same session does not restart the phase.
  h.engine.onBotEvent({ type: 'spawn', accountId: 'a', sessionId: 'a-s1', at: h.clock.now() })
  await h.clock.advance(5000)
  h.offline('a')
  await h.clock.advance(60000)
  assert.equal(startedAt().length, 1, 'disconnect cancels the timer')
  const join2 = h.clock.now()
  h.online('a', 'a-s2')
  await h.clock.advance(10000)
  assert.deepEqual(startedAt(), [join1 + 10000, join2 + 10000], 'phase restarts at join')
  assert.ok(h.matcher.resets.includes('a'))
})

test('a timer tick while the account is busy is skipped, not queued', async () => {
  const h = setup({
    macros: [
      macro('tick', { trigger: { type: 'timer', intervalMs: 10000, jitterMs: 0 }, steps: [{ type: 'notify', message: 'tick' }] }),
      macro('busy', { steps: [{ type: 'wait', ms: 15000 }] })
    ]
  })
  h.online('a')
  const busy = h.engine.run('a', 'busy')
  await h.clock.advance(10000)
  const skipped = h.events.filter((e) => e.status === 'skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].macroId, 'tick')
  assert.equal(skipped[0].trigger, 'timer')
  await h.clock.advance(5000)
  assert.equal((await busy).status, 'completed')
  assert.equal(h.fake.stepCalls('notify').length, 0, 'the skipped tick is not replayed')
  await h.clock.advance(5000)
  assert.equal(h.fake.stepCalls('notify').length, 1)
})

test('timer jitter uses the injected random source and schedule uses injected nextScheduleTime', async () => {
  let unit = 1
  const scheduleCalls = []
  const h = setup({
    random: () => unit,
    nextScheduleTime: (at, fromMs) => { scheduleCalls.push(at); return fromMs + 60000 },
    macros: [
      macro('jitter', { trigger: { type: 'timer', intervalMs: 10000, jitterMs: 2000 }, steps: [] }),
      macro('daily', { trigger: { type: 'schedule', at: '07:30' }, steps: [] })
    ]
  })
  const join = h.clock.now()
  h.online('a')
  unit = 0
  await h.clock.advance(70000)
  const starts = (id) => h.events.filter((e) => e.macroId === id && e.status === 'started').map((e) => e.at - join)
  assert.deepEqual(starts('jitter').slice(0, 3), [12000, 18000, 28000])
  assert.deepEqual(starts('daily'), [60000])
  assert.deepEqual(scheduleCalls.slice(0, 2), ['07:30', '07:30'])
})

test('setLibrary edits stop the running macro, keep unchanged runs, and re-plan only affected accounts', async () => {
  const keep = macro('keep', { targets: { mode: 'accounts', accountIds: ['b'] }, steps: [{ type: 'wait', ms: 10000 }] })
  const edit = macro('edit', { targets: { mode: 'accounts', accountIds: ['a'] }, steps: [{ type: 'wait', ms: 10000 }] })
  const timerB = macro('timerB', { targets: { mode: 'accounts', accountIds: ['b'] }, trigger: { type: 'timer', intervalMs: 4000 }, steps: [] })
  const h = setup({ accounts: ['a', 'b'], macros: [keep, edit, timerB] })
  h.online('a')
  h.online('b')
  const keepRun = h.engine.run('b', 'keep')
  const editRun = h.engine.run('a', 'edit')
  await h.clock.advance(1000)
  const setsBefore = h.clock.setCount()
  h.engine.setLibrary([keep, timerB, { ...edit, steps: [{ type: 'wait', ms: 20000 }] }])
  await h.clock.flush()
  const edited = await editRun
  assert.equal(edited.status, 'cancelled')
  assert.equal(h.events.find((e) => e.runId === edited.runId && e.status === 'cancelled').reason, 'edited')
  assert.equal(h.engine.isRunning('b'), true, 'unchanged macro keeps running')
  assert.ok(h.clock.setCount() - setsBefore <= 2, 'unchanged timers are not re-armed')
  await h.clock.advance(9000)
  assert.equal((await keepRun).status, 'completed')
  // The unchanged timer kept its phase (join + 4000k); ticks at 4000/8000 were skipped while busy.
  assert.ok(h.events.some((e) => e.macroId === 'timerB' && e.status === 'skipped'))
})

test('10 accounts × 3 timer macros share one underlying timeout', async () => {
  const clock = createFakeClock()
  const scheduler = createScheduler({ timers: clock.timers, now: clock.now })
  const accounts = Array.from({ length: 10 }, (_, index) => `acc${index}`)
  const macros = [5000, 7000, 11000].map((intervalMs, index) => macro(`t${index}`, { trigger: { type: 'timer', intervalMs, jitterMs: 500 }, steps: [] }))
  const fake = createFakeFacade(clock)
  const matcher = new FakeMatcher()
  const events = []
  const engine = new MacroEngine({ facade: fake.facade, matcher, scheduler, now: clock.now, emit: (e) => events.push(e), getAccountState: () => ({ online: true }), resolveTargets: () => accounts, random: () => 0.5 })
  engine.setLibrary(macros)
  clock.resetMaxPending()
  for (const accountId of accounts) {
    fake.sessions.set(accountId, `${accountId}-s`)
    engine.onBotEvent({ type: 'connected', accountId, sessionId: `${accountId}-s`, at: clock.now() })
    engine.onBotEvent({ type: 'spawn', accountId, sessionId: `${accountId}-s`, at: clock.now() })
  }
  assert.equal(scheduler.size(), 30)
  assert.equal(clock.pending(), 1)
  await clock.advance(60000)
  assert.equal(clock.maxPending(), 1, 'never more than one underlying timeout')
  for (const accountId of accounts) {
    const fired = events.filter((e) => e.accountId === accountId && (e.status === 'started' || e.status === 'skipped')).length
    assert.equal(fired, 12 + 8 + 5)
  }
  for (const accountId of accounts) engine.onBotEvent({ type: 'disconnected', accountId, sessionId: `${accountId}-s`, at: clock.now() })
  assert.equal(scheduler.size(), 0)
  assert.equal(clock.pending(), 0)
  await engine.shutdown()
})

// ---------------------------------------------------------------------------
// Events, robustness, logs
// ---------------------------------------------------------------------------

test('join and disconnected triggers; a disconnect interrupts the run before the disconnected macro starts', async () => {
  const h = setup({
    macros: [
      macro('onJoin', { trigger: { type: 'join' }, steps: [{ type: 'chat', message: '/afk' }] }),
      macro('long', { steps: [{ type: 'wait', ms: 60000 }] }),
      macro('onDrop', { trigger: { type: 'disconnected' }, steps: [{ type: 'notify', message: 'dropped' }] })
    ]
  })
  h.online('a')
  await h.clock.advance(100)
  assert.deepEqual(h.fake.stepCalls('chat').map((c) => c.args.message), ['/afk'])
  const long = h.engine.run('a', 'long')
  await h.clock.flush()
  h.offline('a')
  await h.clock.advance(100)
  assert.equal((await long).status, 'interrupted')
  const order = h.events.filter((e) => ['interrupted', 'started', 'completed'].includes(e.status)).map((e) => `${e.macroId}:${e.status}`)
  assert.deepEqual(order.slice(-3), ['long:interrupted', 'onDrop:started', 'onDrop:completed'])
  assert.equal(h.fake.stepCalls('notify').length, 1)
})

test('onBotEvent never throws, ignores unknown accounts, and surfaces matcher failures as events', async () => {
  const h = setup({ accounts: ['a'], macros: [macro('m', { targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'death' }, steps: [] })] })
  for (const event of [null, undefined, 42, {}, { type: 'chat' }, { accountId: 5, type: 'chat' }, { accountId: 'a' }]) {
    assert.doesNotThrow(() => h.engine.onBotEvent(event))
  }
  h.engine.onBotEvent({ type: 'death', accountId: 'stranger', sessionId: 'x', at: h.clock.now() })
  assert.equal(h.matcher.events.length, 0, 'unknown accounts are not fed to the matcher')
  h.matcher.throwOnEvent = true
  assert.doesNotThrow(() => h.engine.onBotEvent({ type: 'death', accountId: 'a', sessionId: 'a-s1', at: h.clock.now() }))
  const failure = h.events.find((e) => e.status === 'failed')
  assert.equal(failure.reason, 'engineError')
  assert.equal(failure.error.message, 'matcher exploded')
  h.matcher.throwOnEvent = false
  // A throwing emit listener does not break the engine either.
  const engine2 = new MacroEngine({ facade: h.fake.facade, matcher: new FakeMatcher(), timers: h.clock.timers, now: h.clock.now, emit: () => { throw new Error('listener') }, resolveTargets: () => ['a'] })
  engine2.setLibrary([macro('m', { steps: [] })])
  assert.equal((await engine2.run('a', 'm')).status, 'completed')
})

test('run validates its inputs and the constructor validates collaborators', async () => {
  const h = setup({ macros: [macro('off', { enabled: false })] })
  await assert.rejects(h.engine.run('a', 'missing'), { code: 'NOT_FOUND' })
  await assert.rejects(h.engine.run('a', 'off'), { code: 'INVALID' })
  await assert.rejects(h.engine.run('', 'off'), { code: 'INVALID' })
  assert.throws(() => new MacroEngine({ facade: {}, matcher: new FakeMatcher() }), /facade is missing/)
  assert.throws(() => new MacroEngine({ facade: h.fake.facade, matcher: {} }), /matcher is missing/)
  await h.engine.shutdown()
  await assert.rejects(h.engine.run('a', 'off'), { code: 'INVALID' })
  assert.doesNotThrow(() => h.engine.onBotEvent({ type: 'spawn', accountId: 'a', sessionId: 's' }))
})

test('unsupported step types fail the step and follow onError', async () => {
  const h = setup({ macros: [macro('m', { steps: [{ type: 'teleport' }, { type: 'chat', message: 'ok' }] })] })
  h.online('a')
  assert.equal((await h.engine.run('a', 'm')).status, 'completed')
  assert.equal(h.events.find((e) => e.status === 'stepFailed').error.code, 'UNSUPPORTED')
  assert.equal(h.fake.stepCalls('chat').length, 1)
})

test('disconnect/reconnect steps adopt the new session instead of tripping the fence', async () => {
  const h = setup({ macros: [macro('cycle', { steps: [{ type: 'disconnect' }, { type: 'reconnect', delayMs: 0 }, { type: 'chat', message: 'back' }] })] })
  h.online('a')
  h.fake.handlers.disconnect = () => {
    h.fake.sessions.delete('a')
    h.engine.onBotEvent({ type: 'disconnected', accountId: 'a', sessionId: 'a-s1', at: h.clock.now() })
    return Promise.resolve()
  }
  h.fake.handlers.reconnect = () => { h.fake.sessions.set('a', 'a-s2'); return Promise.resolve() }
  assert.equal((await h.engine.run('a', 'cycle')).status, 'completed')
  assert.equal(h.fake.stepCalls('chat')[0].ctx.sessionId, 'a-s2')
})

test('runLog keeps a ring buffer of the last runs with per-step outcomes and returns copies', async () => {
  const h = setup({ macros: [macro('m', { steps: [{ type: 'set', variable: 'x', value: 1 }, look] })] })
  h.online('a')
  const ids = []
  for (let index = 0; index < LIMITS.runLogRingSize + 5; index += 1) {
    const run = h.engine.run('a', 'm')
    await h.clock.advance(1000)
    ids.push((await run).runId)
  }
  const log = h.engine.runLog('m')
  assert.equal(log.length, LIMITS.runLogRingSize)
  assert.equal(log.at(-1).runId, ids.at(-1))
  assert.equal(log[0].runId, ids[5])
  assert.equal(log[0].trigger, 'manual')
  assert.deepEqual(log[0].steps.map((s) => [s.type, s.ok, s.path]), [['set', true, [0]], ['look', true, [1]]])
  log[0].steps.length = 0
  assert.equal(h.engine.runLog('m')[0].steps.length, 2)
  assert.deepEqual(h.engine.runLog('nope'), [])
  h.engine.setLibrary([])
  assert.deepEqual(h.engine.runLog('m'), [], 'removed macros drop their log')
})

test('shutdown cancels runs, clears timers, and disposes the owned scheduler', async () => {
  const h = setup({ macros: [macro('tick', { trigger: { type: 'timer', intervalMs: 5000 }, steps: [] }), macro('long', { steps: [{ type: 'wait', ms: 60000 }] })] })
  h.online('a')
  const run = h.engine.run('a', 'long')
  await h.clock.flush()
  const done = h.engine.shutdown()
  assert.equal(h.engine.shutdown(), done)
  await h.clock.advance(0)
  await done
  assert.equal((await run).status, 'cancelled')
  assert.equal(h.clock.pending(), 0)
  await h.clock.advance(60000)
  assert.equal(h.events.filter((e) => e.macroId === 'tick').length, 0)
})

test('no unhandled promise rejections occurred', async () => {
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})
