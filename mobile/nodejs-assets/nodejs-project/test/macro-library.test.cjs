'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { loadMacroLibrary, saveMacroLibrary, syncMacroLibrary, toggleMacro, storeGraph } = require('../../../macro-library.cjs')
const { createMacroRuntime } = require('../macro-runtime.cjs')
const { BotManager } = require('../bot-manager.cjs')
const { clock, fakeBot } = require('./macro-fixture.cjs')

function storage(initial = null) {
  let value = initial
  return { async getItem(key) { assert.equal(key, 'afkdesk.mobile.sharedMacros.v1'); return value }, async setItem(key, next) { assert.equal(key, 'afkdesk.mobile.sharedMacros.v1'); value = next } }
}
const timer = { version: 2, id: 'v2', enabled: true, targets: { mode: 'all' }, trigger: { type: 'timer', intervalMs: 1000 }, defaultDelayMs: 0, steps: [{ type: 'chat', message: 'v2 timer' }] }
const graph = { version: 3, id: 'v3', enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, defaultDelayMs: 0,
  nodes: [{ id: 'manual', kind: 'trigger.manual', params: {} }, { id: 'timer', kind: 'trigger.timer', params: { intervalMs: 1500 } }, { id: 'chat', kind: 'chat', params: { message: 'graph timer' } }],
  edges: [{ id: 'e', from: { node: 'timer', port: 'out' }, to: { node: 'chat', port: 'in' } }] }

test('saved library round-trips, rejects invalid storage and enables imports on the selected account', async () => {
  const store = storage()
  assert.deepEqual(await loadMacroLibrary(store), [])
  const imported = [{ ...timer, enabled: false, targets: { mode: 'accounts', accountIds: [] } }]
  const enabled = toggleMacro(imported, 0, 'phone-account')
  assert.equal(imported[0].enabled, false)
  assert.equal(enabled[0].enabled, true)
  assert.deepEqual(enabled[0].targets.accountIds, ['phone-account'])
  await saveMacroLibrary(store, enabled)
  assert.deepEqual(await loadMacroLibrary(store), enabled)
  assert.equal(toggleMacro(enabled, 0, 'phone-account')[0].enabled, false)
  for (const value of ['{}', 'null', 'broken']) await assert.rejects(loadMacroLibrary(storage(value)))
  await assert.rejects(saveMacroLibrary({ setItem: async () => { throw new Error('disk full') } }, enabled), /disk full/)
  await assert.rejects(syncMacroLibrary(async () => { throw new Error('engine offline') }, enabled), /engine offline/)
})

function phone(t) {
  const time = clock(), bots = [], posted = [], handlers = new Map()
  const bridge = { app: { datadir: () => '/tmp/afk-macro-test', on() {} }, channel: { post: (...args) => posted.push(args), on: (type, fn) => handlers.set(type, fn) } }
  let manager, runtime
  class FakeManager extends BotManager {
    constructor(options) { super({ ...options, createBot: () => { const bot = fakeBot(); bots.push(bot); return bot } }); manager = this }
  }
  const file = path.resolve(__dirname, '../main.js'), localRequire = createRequire(file)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require(name) {
    if (name === 'rn-bridge') return bridge
    if (name === './bot-manager.cjs') return { BotManager: FakeManager }
    if (name === './macro-runtime.cjs') return { createMacroRuntime: (m, emit) => (runtime = createMacroRuntime(m, emit, { ...time, chatIntervalMs: 500 })) }
    return localRequire(name)
  } }, { filename: file })
  let requestId = 0
  const command = async payload => {
    const id = ++requestId
    await handlers.get('engine-command')({ requestId: id, ...payload })
    const reply = posted.find(([type, event]) => type === 'engine-reply' && event.requestId === id)[1]
    if (!reply.ok) throw new Error(reply.error)
    // rn-bridge serializes values across the JS runtimes.
    return JSON.parse(JSON.stringify(reply.value))
  }
  t.after(async () => { await command({ action: 'shutdown' }) })
  return { ...time, manager, runtime, bots, command, posted }
}

test('phone storage reaches the bridge: v2 and graph timers appear in Next runs, fire, and restart after reconnect', async t => {
  const { command, bots, tick } = phone(t)
  const store = storage(JSON.stringify([timer, graph, { ...timer, id: 'disabled', enabled: false }]))
  await syncMacroLibrary(command, await loadMacroLibrary(store))
  const account = { id: 'a', username: 'fake', host: 'localhost', antiAfk: false, autoReconnect: true }
  await command({ action: 'connect', account }); bots[0].emit('spawn')
  const upcoming = () => command({ action: 'getUpcomingRuns', accountId: 'a' })
  assert.deepEqual(await upcoming(), [{ kind: 'macro timer', at: 2000 }, { kind: 'macro timer', at: 2500 }])
  await tick(1000)
  assert.deepEqual(bots[0].calls.filter(c => c[0] === 'chat'), [['chat', 'v2 timer']])
  await tick(500)
  assert.deepEqual(bots[0].calls.filter(c => c[0] === 'chat'), [['chat', 'v2 timer'], ['chat', 'graph timer']])
  bots[0].emit('end', 'connection lost')
  assert.deepEqual(await upcoming(), [])
  await command({ action: 'connect', account }); bots[1].emit('spawn')
  assert.equal((await upcoming()).length, 2)
  await tick(1000)
  assert.deepEqual(bots[1].calls.filter(c => c[0] === 'chat'), [['chat', 'v2 timer']])
  await syncMacroLibrary(command, [])
  assert.deepEqual(await upcoming(), [])
  await tick(5000)
  assert.equal(bots[1].calls.filter(c => c[0] === 'chat').length, 1)
})

test('library arriving after spawn schedules timers immediately and library edits preserve unchanged phases', async t => {
  const { command, bots, tick } = phone(t)
  await command({ action: 'connect', account: { id: 'a', username: 'fake', host: 'localhost', antiAfk: false } }); bots[0].emit('spawn')
  await syncMacroLibrary(command, [timer, graph])
  await tick(250)
  await syncMacroLibrary(command, [timer, { ...graph, enabled: false }])
  assert.deepEqual(await command({ action: 'getUpcomingRuns', accountId: 'a' }), [{ kind: 'macro timer', at: 2000 }])
  await tick(750)
  assert.deepEqual(bots[0].calls.filter(c => c[0] === 'chat'), [['chat', 'v2 timer']])
})

test('saving graph JSON validates, binds, persists and replaces the graph without duplicating its timer', async t => {
  const { command, bots, tick } = phone(t)
  const store = storage()
  let macros = storeGraph([timer], { ...graph, id: undefined }, 'a')
  const saved = macros[1]
  assert.ok(saved.id); assert.equal(saved.enabled, true)
  assert.deepEqual(saved.targets.accountIds, ['a'])
  assert.equal(graph.id, 'v3')
  macros = storeGraph(macros, { ...saved, name: 'Edited graph' }, 'a')
  assert.equal(macros.length, 2)
  await saveMacroLibrary(store, macros)
  await syncMacroLibrary(command, await loadMacroLibrary(store))
  await command({ action: 'connect', account: { id: 'a', username: 'fake', host: 'localhost', antiAfk: false } }); bots[0].emit('spawn')
  assert.equal((await command({ action: 'getUpcomingRuns', accountId: 'a' })).length, 2)
  await tick(1500)
  assert.ok(bots[0].calls.some(c => c[0] === 'chat' && c[1] === 'graph timer'))
  assert.throws(() => storeGraph([], graph, ''), /Select an account/)
  assert.throws(() => storeGraph([], timer, 'a'), /version 3/)
  assert.throws(() => storeGraph([], { version: 3, nodes: [], edges: [] }, 'a'), /trigger/)
})

test('App loads and syncs the library at startup, saves edits, and masks notification messages', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8')
  assert.match(app, /loadMacroLibrary\(AsyncStorage\)/)
  assert.match(app, /syncMacroLibrary\(engineCommand, macros\)/)
  assert.match(app, /saveMacroLibrary\(AsyncStorage, next\)/)
  assert.match(app, /toggleMacro\(macros, index, selected.id\)/)
  assert.match(app, /storeGraph\(macros, JSON.parse\(json\), accountId\)/)
  assert.match(app, /macro-notify.*maskNames\(payload.message, accountsRef.current, streamerModeRef.current\)/)
  assert.doesNotMatch(app, /Macro execution is not available on mobile|cannot run them/)
})
