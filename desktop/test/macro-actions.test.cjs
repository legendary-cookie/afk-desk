'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager } = require('../electron/bot-manager.cjs')
const { createFacade } = require('../electron/macro/facade.cjs')
const actions = require('../electron/macro/actions.cjs')
const { FACADE_METHODS, STEP_TYPES, ENGINE_STEP_TYPES, assertFacade } = require('../electron/macro/contract.cjs')

const SYNC_METHODS = ['sessionId', 'state', 'releaseOwner']
const ASYNC_METHODS = FACADE_METHODS.filter((name) => !SYNC_METHODS.includes(name))
const LIFECYCLE_METHODS = ['disconnect', 'reconnect']
const OWNER = 'macro:r1'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Timers the test fires by hand.
class ManualTimers {
  constructor() { this.pending = [] }
  setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    this.pending.push(timer)
    return timer
  }
  clearTimeout = (timer) => { if (timer) timer.cleared = true }
  active() { return this.pending.filter((timer) => !timer.cleared) }
  fire(delay) {
    const timer = this.active().find((entry) => entry.delay === delay)
    assert.ok(timer, `no active timer with delay ${delay}`)
    timer.cleared = true
    timer.callback()
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function item(slot, name, extra = {}) {
  return { slot, name, displayName: name, count: 4, type: slot, ...extra }
}

function fakeBot({ entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 } } = {}) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.username = 'Player'
  bot.players = {}
  bot.health = 20
  bot.food = 18
  bot.game = { dimension: 'overworld' }
  bot.entity = entity
  bot.quickBarSlot = 0
  bot.currentWindow = null
  bot.calls = []
  bot.inventory = new EventEmitter()
  bot.inventory.inventoryStart = 9
  bot.inventory.slots = []
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  const record = (name) => (...args) => { bot.calls.push([name, ...args]) }
  bot.setControlState = record('setControlState')
  bot.stopDigging = record('stopDigging')
  bot.deactivateItem = record('deactivateItem')
  bot.activateItem = record('activateItem')
  bot.swingArm = record('swingArm')
  bot.lookAt = async (...args) => { bot.calls.push(['lookAt', ...args]) }
  bot.look = async (...args) => { bot.calls.push(['look', ...args]) }
  bot.clickWindow = async (...args) => { bot.calls.push(['clickWindow', ...args]) }
  bot.transfer = async (options) => { bot.calls.push(['transfer', options.sourceStart, options.count]) }
  bot.setQuickBarSlot = (slot) => { bot.quickBarSlot = slot; bot.calls.push(['setQuickBarSlot', slot]) }
  bot.moveSlotItem = async (from, to) => { bot.calls.push(['moveSlotItem', from, to]) }
  bot.closeWindow = (window) => { bot.currentWindow = null; bot.calls.push(['closeWindow', window.title]) }
  bot.quit = () => bot.emit('end')
  return bot
}

// A real BotManager over a fake bot, with the facade on top.
function realSetup(t, { account = {}, bot = fakeBot() } = {}) {
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'a', username: 'u', host: 'localhost', antiAfk: false, autoReconnect: false, ...account })
  t.after(() => manager.disconnect('a'))
  const facade = createFacade({ bots: manager })
  const ctx = (extra = {}) => ({ owner: OWNER, sessionId: facade.sessionId('a'), ...extra })
  return { manager, bot, facade, ctx }
}

// A manager whose every call is recorded as [method, ...args].
function spyManager(session) {
  const calls = []
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result }
  const manager = {
    sessions: new Map([['a', session]]),
    reconnects: new Map(),
    calls
  }
  const methods = {
    sendChat: undefined, claimInput: undefined, releaseInput: undefined, releaseOwner: undefined,
    lookAbsolute: undefined, lookDelta: undefined, lookAtEntity: undefined, swingArm: undefined,
    holdItemByName: undefined, clickInventorySlot: undefined, clickWindowSlot: undefined,
    closeWindow: undefined, dropItems: undefined, dropAll: undefined, depositSlot: undefined,
    disconnect: undefined, connect: undefined, worldAction: undefined
  }
  for (const [name, result] of Object.entries(methods)) manager[name] = record(name, result)
  manager.findWindowSlot = record('findWindowSlot', (id, select) => (select.slot != null ? select.slot : 2))
  manager.waitForWindow = record('waitForWindow', async () => ({ title: '{"text":"Chest"}' }))
  return manager
}

function spySetup({ edition = 'java', account = {}, bot = fakeBot(), timers } = {}) {
  const session = { sessionId: 's1', bot, ready: true, client: {}, account: { id: 'a', lockedInventorySlots: [], ...account }, inventory: [] }
  const manager = spyManager(session)
  const notifications = []
  const facade = createFacade({
    bots: { manager: () => manager },
    getEdition: () => edition,
    notify: (payload) => { notifications.push(payload) },
    ...(timers ? { timers } : {})
  })
  const ctx = (extra = {}) => ({ owner: OWNER, sessionId: 's1', ...extra })
  return { facade, manager, session, bot, ctx, notifications, calls: manager.calls }
}

// ---------------------------------------------------------------------------
// Contract and registry
// ---------------------------------------------------------------------------

test('the facade implements the contract and every facade step has an action entry', () => {
  const { facade } = spySetup()
  assert.equal(assertFacade(facade), facade)
  for (const type of Object.keys(STEP_TYPES)) {
    if (ENGINE_STEP_TYPES.includes(type)) continue
    assert.equal(typeof actions[type]?.run, 'function', type)
    assert.deepEqual(actions[type].editions, STEP_TYPES[type].editions, type)
  }
})

test('action validators accept good steps and name the problem in bad ones', () => {
  const valid = {
    chat: { message: 'hi' },
    move: { control: 'forward', distance: 3 },
    look: { mode: 'absolute', yaw: 1, pitch: 0 },
    control: { control: 'sneak', action: 'hold' },
    leftClick: { action: 'hold', only: 'entities' },
    selectHotbar: { slot: 8 },
    useGui: { select: { slot: 1 }, click: 'shift' },
    waitForWindow: { giveUpAfterMs: 1000 },
    drop: { select: { name: 'dirt' }, count: 1 },
    reconnect: { delayMs: 100, giveUpAfterMs: 5000 }
  }
  for (const [type, step] of Object.entries(valid)) assert.equal(actions[type].validateArgs(step), null, type)
  assert.match(actions.chat.validateArgs({ message: '' }), /message/)
  assert.match(actions.move.validateArgs({ control: 'up', durationMs: 5 }), /control/)
  assert.match(actions.selectHotbar.validateArgs({ slot: 9 }), /0\.\.8/)
  assert.match(actions.leftClick.validateArgs({ action: 'once', only: 'sky' }), /left click/)
  assert.match(actions.drop.validateArgs({ select: { slot: 9 }, count: 0 }), /count/)
  assert.match(actions.reconnect.validateArgs({ giveUpAfterMs: -1 }), /giveUpAfterMs/)
  assert.match(actions.chat.validateArgs(null), /object/)
})

// ---------------------------------------------------------------------------
// Happy paths: the exact BotManager call each facade method makes
// ---------------------------------------------------------------------------

const HAPPY_PATHS = [
  {
    name: 'chat', method: 'chat', step: { message: 'hi' },
    calls: [['sendChat', 'a', 'hi']]
  },
  {
    name: 'move for a duration', method: 'move', step: { control: 'forward', durationMs: 0 },
    calls: [['claimInput', 'a', 'forward', OWNER], ['releaseInput', 'a', 'forward', OWNER]]
  },
  {
    name: 'move a distance', method: 'move', step: { control: 'back', distance: 3 },
    calls: (ctx) => [['worldAction', 'a', 'walk', { control: 'back', distance: 3, owner: OWNER, signal: ctx.signal }]]
  },
  {
    name: 'look absolute', method: 'look', step: { mode: 'absolute', yaw: 1, pitch: 0.5 },
    calls: [['lookAbsolute', 'a', 1, 0.5]]
  },
  {
    name: 'look relative', method: 'look', step: { mode: 'relative', yaw: 0.2, pitch: -0.1 },
    calls: [['lookDelta', 'a', 0.2, -0.1]]
  },
  {
    name: 'look at a block', method: 'look', step: { mode: 'at', target: 'block', x: 1, y: 2, z: 3 },
    calls: [['worldAction', 'a', 'look-at', { x: 1, y: 2, z: 3 }]]
  },
  {
    name: 'look at an entity', method: 'look', step: { mode: 'at', target: 'entity', entity: 'Steve' },
    calls: [['lookAtEntity', 'a', 'Steve']]
  },
  {
    name: 'control hold', method: 'control', step: { control: 'sneak', action: 'hold' },
    calls: [['claimInput', 'a', 'sneak', OWNER]]
  },
  {
    name: 'control release', method: 'control', step: { control: 'sneak', action: 'release' },
    calls: [['releaseInput', 'a', 'sneak', OWNER]]
  },
  {
    name: 'left click once', method: 'leftClick', step: { action: 'once' },
    calls: [['worldAction', 'a', 'dig-crosshair']]
  },
  {
    name: 'left click once, blocks only', method: 'leftClick', step: { action: 'once', only: 'blocks' },
    calls: [['worldAction', 'a', 'dig-crosshair']]
  },
  {
    name: 'left click once, entities only', method: 'leftClick', step: { action: 'once', only: 'entities' },
    calls: [['worldAction', 'a', 'attack-nearest']]
  },
  {
    name: 'left click hold', method: 'leftClick', step: { action: 'hold' },
    calls: [['claimInput', 'a', 'leftClick', OWNER]]
  },
  {
    name: 'left click release', method: 'leftClick', step: { action: 'release' },
    calls: [['releaseInput', 'a', 'leftClick', OWNER]]
  },
  {
    name: 'right click once', method: 'rightClick', step: { action: 'once' },
    calls: [['worldAction', 'a', 'use-crosshair']]
  },
  {
    name: 'right click hold', method: 'rightClick', step: { action: 'hold' },
    calls: [['claimInput', 'a', 'rightClick', OWNER]]
  },
  {
    name: 'right click release', method: 'rightClick', step: { action: 'release' },
    calls: [['releaseInput', 'a', 'rightClick', OWNER]]
  },
  {
    name: 'selectHotbar', method: 'selectHotbar', step: { slot: 3 },
    calls: [['worldAction', 'a', 'select-hotbar', { slot: 3 }]]
  },
  {
    name: 'holdItem', method: 'holdItem', step: { name: 'stone' },
    calls: [['holdItemByName', 'a', 'stone']]
  },
  {
    name: 'useInventory right click', method: 'useInventory', step: { select: { name: 'dirt' }, click: 'right' },
    calls: [['clickInventorySlot', 'a', 20, { button: 1, mode: 0 }]]
  },
  {
    name: 'useInventory on a hotbar stack selects it first', method: 'useInventory', step: { select: { slot: 38 }, click: 'left' },
    calls: [['worldAction', 'a', 'select-hotbar', { slot: 2 }], ['clickInventorySlot', 'a', 38, { button: 0, mode: 0 }]]
  },
  {
    name: 'useGui by name', method: 'useGui', step: { select: { name: 'button' }, click: 'left' },
    calls: [['findWindowSlot', 'a', { name: 'button' }], ['clickWindowSlot', 'a', 2, { button: 0, mode: 0, allowInventory: true }]]
  },
  {
    name: 'useGui shift click by slot', method: 'useGui', step: { select: { slot: 1 }, click: 'shift' },
    calls: [['findWindowSlot', 'a', { slot: 1 }], ['clickWindowSlot', 'a', 1, { button: 0, mode: 1, allowInventory: true }]]
  },
  {
    name: 'closeGui', method: 'closeGui', step: {},
    calls: [['closeWindow', 'a']]
  },
  {
    name: 'waitForWindow', method: 'waitForWindow', step: { title: 'chest', giveUpAfterMs: 500 },
    calls: (ctx) => [['waitForWindow', 'a', { title: 'chest', giveUpAfterMs: 500, signal: ctx.signal }]],
    result: { title: 'Chest' }
  },
  {
    name: 'drop', method: 'drop', step: { select: { name: 'dirt' }, count: 2 },
    calls: [['dropItems', 'a', 20, 2]]
  },
  {
    name: 'dropAll', method: 'dropAll', step: { filter: 'dirt' },
    calls: (ctx) => [['dropAll', 'a', { filter: 'dirt', signal: ctx.signal }]]
  },
  {
    name: 'deposit', method: 'deposit', step: { select: { slot: 20 }, count: 3 },
    calls: [['depositSlot', 'a', 20, 3]]
  },
  {
    name: 'disconnect', method: 'disconnect', step: {},
    calls: [['disconnect', 'a']]
  }
]

function withInventoryAndWindow(bot) {
  bot.inventory.slots[20] = item(20, 'dirt')
  bot.inventory.slots[38] = item(38, 'sword')
  bot.currentWindow = { title: 'Menu', inventoryStart: 3, slots: [null, item(1, 'a'), item(2, 'button'), ...Array(36).fill(null)] }
}

for (const happy of HAPPY_PATHS) {
  test(`happy path: ${happy.name} makes exactly the expected BotManager calls`, async () => {
    const { facade, bot, ctx, calls } = spySetup()
    withInventoryAndWindow(bot)
    const context = ctx({ signal: new AbortController().signal })
    const result = await facade[happy.method]('a', happy.step, context)
    const expected = typeof happy.calls === 'function' ? happy.calls(context) : happy.calls
    assert.deepEqual(calls, expected)
    if (happy.result) assert.deepEqual(result, happy.result)
  })
}

test('happy path: notify forwards the step to the notifier', async () => {
  const { facade, ctx, notifications } = spySetup()
  await facade.notify('a', { message: 'note', desktop: true, webhook: false, macroId: 'm1' }, ctx())
  assert.deepEqual(notifications, [{ accountId: 'a', message: 'note', desktop: true, webhook: false, macroId: 'm1' }])
})

test('every async facade method has a happy path in this file', () => {
  const covered = new Set(HAPPY_PATHS.map((entry) => entry.method))
  covered.add('notify')
  covered.add('reconnect')
  assert.deepEqual(ASYNC_METHODS.filter((name) => !covered.has(name)), [])
})

test('left click once falls back from digging to attacking to swinging', async () => {
  const { facade, manager, ctx, calls } = spySetup()
  manager.worldAction = async (id, action) => {
    calls.push(['worldAction', id, action])
    throw new Error('nothing there')
  }
  await facade.leftClick('a', { action: 'once' }, ctx())
  assert.deepEqual(calls, [
    ['worldAction', 'a', 'dig-crosshair'],
    ['worldAction', 'a', 'attack-nearest'],
    ['swingArm', 'a']
  ])
})

test('cancelling a run stops a dig that is still in progress', async () => {
  const { facade, manager, ctx, calls } = spySetup()
  let finishDig
  manager.worldAction = (id, action) => {
    calls.push([action])
    return action === 'dig-crosshair' ? new Promise((resolve) => { finishDig = resolve }) : Promise.resolve()
  }
  const controller = new AbortController()
  const clicking = facade.leftClick('a', { action: 'once', only: 'blocks' }, ctx({ signal: controller.signal }))
  await settle()
  controller.abort()
  finishDig()
  await assert.rejects(clicking, (error) => error.code === 'ABORTED')
  assert.deepEqual(calls, [['dig-crosshair'], ['stop-dig']])
})

test('step handlers that need an input owner reject a context without one', async () => {
  const { facade, calls } = spySetup()
  await assert.rejects(facade.control('a', { control: 'sneak', action: 'hold' }, { sessionId: 's1' }), (error) => error.code === 'INVALID')
  await assert.rejects(facade.control('a', { control: 'fly', action: 'hold' }, { sessionId: 's1', owner: OWNER }), (error) => error.code === 'INVALID')
  assert.deepEqual(calls, [])
})

test('manager errors keep their contract code and others become INVALID', async () => {
  const { facade, manager, ctx } = spySetup()
  manager.holdItemByName = () => { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }) }
  manager.sendChat = () => { throw new Error('boom') }
  await assert.rejects(facade.holdItem('a', { name: 'x' }, ctx()), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(facade.chat('a', { message: 'x' }, ctx()), (error) => error.code === 'INVALID' && error.message === 'boom')
})

// ---------------------------------------------------------------------------
// Failure matrix: OFFLINE, ABORTED, SESSION_CHANGED for every async method
// ---------------------------------------------------------------------------

// A valid step for each method so a failure is never down to bad arguments.
const STEPS = {
  chat: { message: 'hi' },
  notify: { message: 'note' },
  move: { control: 'forward', durationMs: 0 },
  look: { mode: 'relative', yaw: 0, pitch: 0 },
  control: { control: 'sneak', action: 'hold' },
  leftClick: { action: 'once' },
  rightClick: { action: 'once' },
  selectHotbar: { slot: 0 },
  holdItem: { name: 'dirt' },
  useInventory: { select: { slot: 20 }, click: 'left' },
  useGui: { select: { slot: 1 }, click: 'left' },
  closeGui: {},
  waitForWindow: { giveUpAfterMs: 100 },
  drop: { select: { slot: 20 }, count: 1 },
  dropAll: {},
  deposit: { select: { slot: 20 }, count: 1 },
  disconnect: {},
  reconnect: { delayMs: 0 }
}

test('the failure matrix has a step for every async facade method', () => {
  assert.deepEqual(Object.keys(STEPS).sort(), [...ASYNC_METHODS].sort())
})

for (const method of ASYNC_METHODS) {
  test(`${method} rejects with ABORTED, without touching the manager, when the signal is already aborted`, async () => {
    const { facade, ctx, calls } = spySetup()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(facade[method]('a', STEPS[method], ctx({ signal: controller.signal })), (error) => error.code === 'ABORTED')
    assert.deepEqual(calls, [])
  })

  test(`${method} rejects with SESSION_CHANGED when the session id differs`, async () => {
    const { facade, ctx, calls } = spySetup()
    await assert.rejects(facade[method]('a', STEPS[method], ctx({ sessionId: 'older-session' })), (error) => error.code === 'SESSION_CHANGED')
    assert.deepEqual(calls, [])
  })

  if (!LIFECYCLE_METHODS.includes(method)) {
    test(`${method} rejects with OFFLINE when the account has no spawned bot`, async () => {
      const { facade, session, ctx, calls } = spySetup()
      session.bot.entity = null
      await assert.rejects(facade[method]('a', STEPS[method], ctx()), (error) => error.code === 'OFFLINE')
      assert.deepEqual(calls, [])
    })

    test(`${method} rejects with OFFLINE when there is no session at all`, async () => {
      const { facade, manager, calls } = spySetup()
      manager.sessions.clear()
      await assert.rejects(facade[method]('a', STEPS[method], { owner: OWNER }), (error) => error.code === 'OFFLINE')
      assert.deepEqual(calls, [])
    })
  }
}

// Table-driven from the contract: every step type that is not available on Bedrock.
const JAVA_ONLY_METHODS = ASYNC_METHODS.filter((name) => !STEP_TYPES[name].editions.includes('bedrock'))

test('the java-only list comes from the contract and is not empty', () => {
  assert.ok(JAVA_ONLY_METHODS.length > 10)
  assert.ok(!JAVA_ONLY_METHODS.includes('chat'))
})

for (const method of JAVA_ONLY_METHODS) {
  test(`${method} rejects with UNSUPPORTED for a Bedrock account`, async () => {
    const { facade, ctx, calls } = spySetup({ edition: 'bedrock' })
    await assert.rejects(facade[method]('a', STEPS[method], ctx()), (error) => error.code === 'UNSUPPORTED')
    assert.deepEqual(calls, [])
  })
}

test('chat and disconnect still work for a Bedrock account', async () => {
  const { facade, ctx, calls } = spySetup({ edition: 'bedrock' })
  await facade.chat('a', { message: 'hi' }, ctx())
  await facade.disconnect('a', {}, ctx())
  assert.deepEqual(calls, [['sendChat', 'a', 'hi'], ['disconnect', 'a']])
})

test('a run without a session id is not fenced', async () => {
  const { facade, calls } = spySetup()
  await facade.chat('a', { message: 'hi' }, {})
  assert.deepEqual(calls, [['sendChat', 'a', 'hi']])
})

// ---------------------------------------------------------------------------
// state and sessionId
// ---------------------------------------------------------------------------

test('state reports a stable session id, health, food, window and a full inventory', () => {
  const { facade, bot, manager } = spySetup()
  assert.equal(facade.sessionId('a'), 's1')
  bot.inventory.slots[9] = item(9, 'stone')
  let state = facade.state('a')
  assert.deepEqual({ online: state.online, sessionId: state.sessionId, edition: state.edition, health: state.health, food: state.food, windowOpen: state.windowOpen, inventoryFull: state.inventoryFull },
    { online: true, sessionId: 's1', edition: 'java', health: 20, food: 18, windowOpen: false, inventoryFull: false })
  assert.deepEqual(state.inventory, [{ name: 'stone', count: 4, slot: 9 }])

  for (let slot = 9; slot <= 44; slot += 1) bot.inventory.slots[slot] = item(slot, 'stone')
  bot.currentWindow = { title: 'x', slots: [] }
  state = facade.state('a')
  assert.equal(state.inventoryFull, true)
  assert.equal(state.windowOpen, true)

  manager.sessions.clear()
  assert.deepEqual({ online: facade.state('a').online, sessionId: facade.sessionId('a') }, { online: false, sessionId: null })
})

test('state reads a Bedrock session without a bot', () => {
  const { facade, session } = spySetup({ edition: 'bedrock' })
  delete session.bot
  delete session.sessionId
  session.health = 14
  session.food = 9
  session.inventory = [{ name: 'bedrock_item_1', count: 2, slot: 0, extra: 'dropped' }]
  const state = facade.state('a')
  assert.deepEqual({ online: state.online, edition: state.edition, health: state.health, food: state.food }, { online: true, edition: 'bedrock', health: 14, food: 9 })
  assert.deepEqual(state.inventory, [{ name: 'bedrock_item_1', count: 2, slot: 0 }])
  assert.match(facade.sessionId('a'), /^[0-9a-f-]{36}$/)
  assert.equal(facade.sessionId('a'), facade.sessionId('a'))
})

// ---------------------------------------------------------------------------
// Item locks
// ---------------------------------------------------------------------------

function lockedInventory(bot) {
  bot.inventory.slots[9] = item(9, 'stone')
  bot.inventory.slots[10] = item(10, 'dirt')
  bot.inventory.slots[12] = item(12, 'stone')
}

for (const method of ['drop', 'deposit', 'useInventory']) {
  test(`${method} rejects a locked source slot and never calls the manager`, async () => {
    const { facade, bot, ctx, calls } = spySetup({ account: { lockedInventorySlots: [9] } })
    lockedInventory(bot)
    const step = { ...STEPS[method], select: { slot: 9 } }
    await assert.rejects(facade[method]('a', step, ctx()), (error) => error.code === 'LOCKED_SLOT')
    assert.deepEqual(calls, [])
  })
}

test('selecting by name skips a locked stack and rejects only when every match is locked', async () => {
  const { facade, bot, ctx, calls } = spySetup({ account: { lockedInventorySlots: [9] } })
  lockedInventory(bot)
  await facade.drop('a', { select: { name: 'stone' }, count: 1 }, ctx())
  assert.deepEqual(calls, [['dropItems', 'a', 12, 1]])
  bot.inventory.slots[12] = null
  await assert.rejects(facade.drop('a', { select: { name: 'stone' }, count: 1 }, ctx()), (error) => error.code === 'LOCKED_SLOT')
  assert.equal(calls.length, 1)
})

test('dropAll rejects when every matching stack is locked, and otherwise delegates', async () => {
  const { facade, bot, ctx, calls } = spySetup({ account: { lockedInventorySlots: [9, 12] } })
  lockedInventory(bot)
  await assert.rejects(facade.dropAll('a', { filter: 'stone' }, ctx()), (error) => error.code === 'LOCKED_SLOT')
  assert.deepEqual(calls, [])
  await facade.dropAll('a', {}, ctx())
  await facade.dropAll('a', { filter: 'dirt' }, ctx())
  assert.deepEqual(calls.map((call) => [call[0], call[2].filter]), [['dropAll', undefined], ['dropAll', 'dirt']])
})

// A chest-sized window: slots 0..2 are the menu, 3.. are the player's main inventory.
function guiWindow() {
  const slots = Array(3 + 36).fill(null)
  slots[0] = item(0, 'menu_button')
  slots[3] = item(3, 'stone')
  slots[4] = item(4, 'dirt')
  return { title: 'Menu', inventoryStart: 3, slots }
}

for (const click of ['shift', 'drop', 'left', 'right']) {
  test(`useGui rejects a ${click} click on a window slot that maps to a locked inventory slot`, async () => {
    const { facade, bot, ctx, calls } = spySetup({ account: { lockedInventorySlots: [9] } })
    bot.currentWindow = guiWindow()
    await assert.rejects(facade.useGui('a', { select: { slot: 3 }, click }, ctx()), (error) => error.code === 'LOCKED_SLOT')
    assert.deepEqual(calls.map((call) => call[0]), ['findWindowSlot'])
  })
}

test('useGui allows a plain click on an unlocked inventory slot and on a menu slot', async () => {
  const { facade, bot, ctx, calls } = spySetup({ account: { lockedInventorySlots: [9] } })
  bot.currentWindow = guiWindow()
  await facade.useGui('a', { select: { slot: 4 }, click: 'left' }, ctx())
  await facade.useGui('a', { select: { slot: 0 }, click: 'shift' }, ctx())
  assert.deepEqual(calls.filter((call) => call[0] === 'clickWindowSlot'), [
    ['clickWindowSlot', 'a', 4, { button: 0, mode: 0, allowInventory: true }],
    ['clickWindowSlot', 'a', 0, { button: 0, mode: 1, allowInventory: true }]
  ])
})

test('useGui reports NOT_FOUND without a window, or when the selector matches nothing', async () => {
  const { facade, bot, manager, ctx } = spySetup()
  await assert.rejects(facade.useGui('a', { select: { slot: 1 }, click: 'left' }, ctx()), (error) => error.code === 'NOT_FOUND')
  bot.currentWindow = guiWindow()
  manager.findWindowSlot = () => -1
  await assert.rejects(facade.useGui('a', { select: { name: 'missing' }, click: 'left' }, ctx()), (error) => error.code === 'NOT_FOUND')
})

// ---------------------------------------------------------------------------
// BotManager helpers the facade relies on (real BotManager, fake bot)
// ---------------------------------------------------------------------------

test('findWindowSlot returns an in-range slot index even when that slot is empty', (t) => {
  const { manager, bot } = realSetup(t)
  bot.currentWindow = guiWindow()
  assert.equal(manager.findWindowSlot('a', { slot: 1 }), 1)
  assert.equal(manager.findWindowSlot('a', { slot: '2' }), 2)
  assert.equal(manager.findWindowSlot('a', { slot: 0 }), 0)
  assert.equal(manager.findWindowSlot('a', { slot: 38 }), 38)
  assert.equal(manager.findWindowSlot('a', { slot: 39 }), -1)
  assert.equal(manager.findWindowSlot('a', { slot: -1 }), -1)
  assert.equal(manager.findWindowSlot('a', { slot: 1.5 }), -1)
  assert.equal(manager.findWindowSlot('a', {}), -1)
})

test('findWindowSlot finds stacks by name, display name and lore, ignoring case', (t) => {
  const { manager, bot } = realSetup(t)
  const window = guiWindow()
  window.slots[1] = { ...item(1, 'paper'), displayName: 'Server Selector' }
  window.slots[2] = { ...item(2, 'book'), customLore: ['{"text":"Click to JOIN"}'] }
  bot.currentWindow = window
  assert.equal(manager.findWindowSlot('a', { name: 'MENU_BUTTON' }), 0)
  assert.equal(manager.findWindowSlot('a', { name: 'selector' }), 1)
  assert.equal(manager.findWindowSlot('a', { lore: 'click to join' }), 2)
  assert.equal(manager.findWindowSlot('a', { name: 'nothing' }), -1)
  bot.currentWindow = null
  assert.equal(manager.findWindowSlot('a', { slot: 1 }), -1)
})

test('the facade GUI click on an empty slot index is sent, not rejected', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  bot.currentWindow = guiWindow()
  await facade.useGui('a', { select: { slot: 1 }, click: 'left' }, ctx())
  assert.deepEqual(bot.calls.filter(([name]) => name === 'clickWindow'), [['clickWindow', 1, 0, 0]])
})

test('clickWindowSlot keeps its menu-only default and takes button and mode additively', async (t) => {
  const { manager, bot } = realSetup(t, { account: { lockedInventorySlots: [9] } })
  bot.currentWindow = guiWindow()
  await manager.clickWindowSlot('a', 1)
  await manager.clickWindowSlot('a', 0, { button: 1, mode: 0 })
  await assert.rejects(manager.clickWindowSlot('a', 4), /Only server-menu slots/)
  await manager.clickWindowSlot('a', 4, { allowInventory: true })
  await assert.rejects(manager.clickWindowSlot('a', 3, { allowInventory: true }), (error) => error.code === 'LOCKED_SLOT')
  await assert.rejects(manager.clickWindowSlot('a', 1, { mode: 9 }), /Invalid click type/)
  assert.deepEqual(bot.calls.filter(([name]) => name === 'clickWindow'), [
    ['clickWindow', 1, 0, 0], ['clickWindow', 0, 1, 0], ['clickWindow', 4, 0, 0]
  ])
})

test('useInventory waits for an inventory action already in flight', async (t) => {
  const { manager, bot, facade, ctx } = realSetup(t)
  bot.inventory.slots[20] = item(20, 'dirt')
  let openGate
  const gate = new Promise((resolve) => { openGate = resolve })
  const inFlight = manager.withInventoryAction('a', () => gate)
  const clicking = facade.useInventory('a', { select: { slot: 20 }, click: 'left' }, ctx())
  await settle()
  assert.deepEqual(bot.calls.filter(([name]) => name === 'clickWindow'), [])
  openGate()
  await inFlight
  await clicking
  assert.deepEqual(bot.calls.filter(([name]) => name === 'clickWindow'), [['clickWindow', 20, 0, 0]])
})

test('useInventory refuses a locked slot inside the manager as well', async (t) => {
  const { manager, bot } = realSetup(t, { account: { lockedInventorySlots: [20] } })
  bot.inventory.slots[20] = item(20, 'dirt')
  await assert.rejects(manager.clickInventorySlot('a', 20), /locked/)
  assert.deepEqual(bot.calls.filter(([name]) => name === 'clickWindow'), [])
})

test('dropAll drops unlocked matching stacks in order and reports the count', async (t) => {
  const { manager, facade, bot, ctx } = realSetup(t, { account: { lockedInventorySlots: [9] } })
  lockedInventory(bot)
  bot.inventory.slots[10].count = 7
  const result = await facade.dropAll('a', {}, ctx())
  assert.deepEqual(result, { dropped: 2 })
  assert.deepEqual(bot.calls.filter(([name]) => name === 'transfer'), [['transfer', 10, 7], ['transfer', 12, 4]])
  assert.deepEqual(await manager.dropAll('a', { filter: 'zzz' }), { dropped: 0 })
})

test('dropAll stops between stacks once the run is aborted', async (t) => {
  const { manager, bot } = realSetup(t)
  lockedInventory(bot)
  const controller = new AbortController()
  const realTransfer = bot.transfer
  bot.transfer = async (options) => {
    await realTransfer(options)
    controller.abort()
  }
  await assert.rejects(manager.dropAll('a', { signal: controller.signal }), (error) => error.code === 'ABORTED')
  assert.equal(bot.calls.filter(([name]) => name === 'transfer').length, 1)
})

test('dropAll refuses while a server menu is open', async (t) => {
  const { manager, bot } = realSetup(t)
  lockedInventory(bot)
  bot.currentWindow = guiWindow()
  await assert.rejects(manager.dropAll('a'), /Close the server menu/)
})

test('holdItemByName selects a hotbar stack in place, preferring it over main-inventory stacks', async (t) => {
  const { manager, bot } = realSetup(t)
  bot.inventory.slots[12] = item(12, 'diamond_sword')
  bot.inventory.slots[40] = item(40, 'diamond_sword')
  assert.deepEqual(await manager.holdItemByName('a', 'DIAMOND'), { slot: 40 })
  assert.equal(bot.quickBarSlot, 4)
  assert.deepEqual(bot.calls.filter(([name]) => name === 'moveSlotItem'), [])
})

test('holdItemByName swaps a main-inventory stack into the selected hotbar slot', async (t) => {
  const { manager, bot } = realSetup(t)
  bot.quickBarSlot = 2
  bot.inventory.slots[12] = item(12, 'torch')
  assert.deepEqual(await manager.holdItemByName('a', 'torch'), { slot: 38 })
  assert.deepEqual(bot.calls.filter(([name]) => name === 'moveSlotItem'), [['moveSlotItem', 12, 38]])
  assert.equal(bot.quickBarSlot, 2)
})

test('holdItemByName never moves a locked stack or displaces a locked hotbar slot', async (t) => {
  const { manager, bot } = realSetup(t, { account: { lockedInventorySlots: [12, 36] } })
  bot.inventory.slots[12] = item(12, 'torch')
  await assert.rejects(manager.holdItemByName('a', 'torch'), (error) => error.code === 'LOCKED_SLOT')
  bot.inventory.slots[13] = item(13, 'torch')
  await assert.rejects(manager.holdItemByName('a', 'torch'), (error) => error.code === 'LOCKED_SLOT' && /Hotbar slot 1/.test(error.message))
  await assert.rejects(manager.holdItemByName('a', 'missing'), (error) => error.code === 'NOT_FOUND')
  assert.deepEqual(bot.calls.filter(([name]) => name === 'moveSlotItem'), [])
})

test('lookAbsolute clamps pitch and rejects non-numbers; lookAtEntity finds by name and skips the bot', async (t) => {
  const { manager, bot } = realSetup(t)
  await manager.lookAbsolute('a', 1, 9)
  assert.deepEqual(bot.calls.at(-1), ['look', 1, 1.45, true])
  assert.throws(() => manager.lookAbsolute('a', 'x', 0), /numbers/)
  const position = { offset: (x, y, z) => ({ x, y, z }) }
  bot.entities = { 1: bot.entity, 2: { username: 'Steve', position, height: 2 } }
  bot.entity.username = 'Steve'
  await manager.lookAtEntity('a', 'steve')
  assert.deepEqual(bot.calls.at(-1), ['lookAt', { x: 0, y: 1, z: 0 }, true])
  assert.throws(() => manager.lookAtEntity('a', 'alex'), (error) => error.code === 'NOT_FOUND')
})

// ---------------------------------------------------------------------------
// waitForWindow
// ---------------------------------------------------------------------------

test('waitForWindow resolves on a matching window, matching the plain-text title in any case', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  const waiting = facade.waitForWindow('a', { title: 'chest', giveUpAfterMs: 1000 }, ctx())
  bot.emit('windowOpen', { title: '{"text":"Shop"}' })
  bot.emit('windowOpen', { title: '{"text":"Big CHEST"}' })
  assert.deepEqual(await waiting, { title: 'Big CHEST' })
})

test('waitForWindow without a title accepts any window and also an already open one', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  bot.currentWindow = { title: 'Already Open' }
  assert.deepEqual(await facade.waitForWindow('a', { giveUpAfterMs: 1000 }, ctx()), { title: 'Already Open' })
  bot.currentWindow = { title: { json: '{"text":"Json Title"}' } }
  assert.deepEqual(await facade.waitForWindow('a', { title: 'json t', giveUpAfterMs: 1000 }, ctx()), { title: 'Json Title' })
})

test('waitForWindow times out with TIMEOUT and stops listening', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  const before = bot.listenerCount('windowOpen')
  await assert.rejects(facade.waitForWindow('a', { title: 'x', giveUpAfterMs: 5 }, ctx()), (error) => error.code === 'TIMEOUT')
  assert.equal(bot.listenerCount('windowOpen'), before)
})

test('waitForWindow aborts promptly and stops listening', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  const before = bot.listenerCount('windowOpen')
  const controller = new AbortController()
  const waiting = facade.waitForWindow('a', { giveUpAfterMs: 60000 }, ctx({ signal: controller.signal }))
  await settle()
  controller.abort()
  await assert.rejects(waiting, (error) => error.code === 'ABORTED')
  assert.equal(bot.listenerCount('windowOpen'), before)
})

test('waitForWindow rejects when the connection ends while waiting', async (t) => {
  const { manager, bot } = realSetup(t)
  const waiting = manager.waitForWindow('a', { giveUpAfterMs: 60000 })
  bot.emit('end')
  await assert.rejects(waiting, (error) => error.code === 'SESSION_CHANGED')
})

// ---------------------------------------------------------------------------
// Holds: ownership, move cancellation, entity attack loop
// ---------------------------------------------------------------------------

test('move for a duration releases its claim when the run is aborted', async () => {
  const { facade, ctx, calls } = spySetup()
  const controller = new AbortController()
  const moving = facade.move('a', { control: 'forward', durationMs: 60000 }, ctx({ signal: controller.signal }))
  await settle()
  controller.abort()
  await assert.rejects(moving, (error) => error.code === 'ABORTED')
  assert.deepEqual(calls, [['claimInput', 'a', 'forward', OWNER], ['releaseInput', 'a', 'forward', OWNER]])
})

test('move for a duration holds the key for the whole duration, then releases it', async (t) => {
  const { facade, bot, ctx } = realSetup(t)
  const moving = facade.move('a', { control: 'forward', durationMs: 30 }, ctx())
  await settle()
  assert.deepEqual(bot.calls.filter(([name]) => name === 'setControlState'), [['setControlState', 'forward', true]])
  await moving
  assert.deepEqual(bot.calls.filter(([name]) => name === 'setControlState').at(-1), ['setControlState', 'forward', false])
})

test('control hold and release respect ownership', (t) => {
  const { manager, facade, bot } = realSetup(t)
  const holdAs = (owner) => facade.control('a', { control: 'sneak', action: 'hold' }, { owner, sessionId: facade.sessionId('a') })
  const releaseAs = (owner) => facade.control('a', { control: 'sneak', action: 'release' }, { owner, sessionId: facade.sessionId('a') })
  return (async () => {
    await holdAs('macro:one')
    await holdAs('macro:two')
    assert.deepEqual(manager.inputOwners('a', 'sneak'), ['macro:one', 'macro:two'])
    await releaseAs('macro:other')
    await releaseAs('macro:one')
    assert.deepEqual(manager.inputOwners('a', 'sneak'), ['macro:two'])
    assert.deepEqual(bot.calls.filter(([name]) => name === 'setControlState'), [['setControlState', 'sneak', true]])
    facade.releaseOwner('a', 'macro:two')
    assert.deepEqual(bot.calls.filter(([name]) => name === 'setControlState').at(-1), ['setControlState', 'sneak', false])
  })()
})

test('left click hold with only entities runs an attack loop that release stops', async () => {
  const timers = new ManualTimers()
  const { facade, ctx, calls } = spySetup({ timers })
  await facade.leftClick('a', { action: 'hold', only: 'entities' }, ctx())
  assert.deepEqual(calls, [], 'entity hold must not start the block-digging claim')
  timers.fire(200)
  await settle()
  assert.deepEqual(calls, [['worldAction', 'a', 'attack-nearest']])
  assert.equal(timers.active().length, 1, 'the loop reschedules itself')

  await facade.leftClick('a', { action: 'release' }, ctx())
  assert.equal(timers.active().length, 0)
})

test('releaseOwner stops that owner attack loop and releases the manager claims, nobody else', async () => {
  const timers = new ManualTimers()
  const { facade, ctx, calls } = spySetup({ timers })
  await facade.leftClick('a', { action: 'hold', only: 'entities' }, ctx())
  await facade.leftClick('a', { action: 'hold', only: 'entities' }, ctx({ owner: 'macro:r2' }))
  assert.equal(timers.active().length, 2)
  facade.releaseOwner('a', OWNER)
  assert.equal(timers.active().length, 1)
  assert.deepEqual(calls, [['releaseOwner', 'a', OWNER]])
  facade.releaseOwner('a', 'macro:r2')
  assert.equal(timers.active().length, 0)
})

test('an attack loop ends when the session it started on is gone', async () => {
  const timers = new ManualTimers()
  const { facade, manager, session, ctx } = spySetup({ timers })
  await facade.leftClick('a', { action: 'hold', only: 'entities' }, ctx())
  manager.sessions.set('a', { ...session })
  timers.fire(200)
  await settle()
  assert.equal(timers.active().length, 0)
})

test('left click hold without a filter claims the held click through the manager', async (t) => {
  const { manager, facade, ctx } = realSetup(t)
  manager.worldAction = async () => {}
  await facade.leftClick('a', { action: 'hold', only: 'blocks' }, ctx())
  assert.deepEqual(manager.inputOwners('a', 'leftClick'), [OWNER])
  facade.releaseOwner('a', OWNER)
  assert.deepEqual(manager.inputOwners('a', 'leftClick'), [])
})

// ---------------------------------------------------------------------------
// Disconnect and reconnect
// ---------------------------------------------------------------------------

// Spawns a new session some milliseconds after connect, like a real login.
function reconnectSetup({ spawnAfterMs = 20, edition = 'java' } = {}) {
  const setup = spySetup({ edition })
  const { manager, session } = setup
  const events = []
  setup.events = events
  manager.reconnects.set('a', { account: { id: 'a', host: 'saved-config' } })
  manager.disconnect = (id) => {
    events.push('disconnect')
    manager.sessions.delete(id)
  }
  manager.connect = (account) => {
    events.push(`connect:${account.host}`)
    if (spawnAfterMs == null) return
    setTimeout(() => {
      manager.sessions.set('a', { ...session, sessionId: 's2', bot: fakeBot() })
    }, spawnAfterMs)
  }
  return setup
}

test('reconnect disconnects, waits, connects and resolves only after the new session spawned', async () => {
  const { facade, ctx, events } = reconnectSetup({ spawnAfterMs: 60 })
  let settled = false
  const reconnecting = facade.reconnect('a', { delayMs: 20 }, ctx()).then(() => { settled = true })
  await sleepMs(5)
  assert.deepEqual(events, ['disconnect'], 'connect waits for the delay')
  await sleepMs(40)
  assert.deepEqual(events, ['disconnect', 'connect:saved-config'])
  assert.equal(settled, false, 'connect alone is not enough')
  await reconnecting
  assert.equal(facade.sessionId('a'), 's2')
  assert.equal(facade.state('a').online, true)
})

test('reconnect does not fail with SESSION_CHANGED for the session it replaced', async () => {
  const { facade, ctx } = reconnectSetup({ spawnAfterMs: 5 })
  await facade.reconnect('a', {}, ctx({ sessionId: 's1' }))
  assert.equal(facade.sessionId('a'), 's2')
})

test('reconnect rejects with TIMEOUT when the new session never spawns', async () => {
  const { facade, ctx, events } = reconnectSetup({ spawnAfterMs: null })
  await assert.rejects(facade.reconnect('a', { giveUpAfterMs: 60 }, ctx()), (error) => error.code === 'TIMEOUT')
  assert.deepEqual(events, ['disconnect', 'connect:saved-config'])
})

test('reconnect aborts during its delay without ever connecting', async () => {
  const { facade, ctx, events } = reconnectSetup()
  const controller = new AbortController()
  const reconnecting = facade.reconnect('a', { delayMs: 5000 }, ctx({ signal: controller.signal }))
  await sleepMs(10)
  controller.abort()
  await assert.rejects(reconnecting, (error) => error.code === 'ABORTED')
  assert.deepEqual(events, ['disconnect'])
})

test('reconnect aborts while waiting for the spawn and disconnects the half-open connection', async () => {
  const { facade, ctx, events } = reconnectSetup({ spawnAfterMs: null })
  const controller = new AbortController()
  const reconnecting = facade.reconnect('a', { delayMs: 0 }, ctx({ signal: controller.signal }))
  await sleepMs(30)
  assert.deepEqual(events, ['disconnect', 'connect:saved-config'])
  controller.abort()
  await assert.rejects(reconnecting, (error) => error.code === 'ABORTED')
  assert.deepEqual(events, ['disconnect', 'connect:saved-config', 'disconnect'])
})

test('reconnect does not connect again when the account came back during the delay', async () => {
  const { facade, manager, session, ctx, events } = reconnectSetup({ spawnAfterMs: null })
  const reconnecting = facade.reconnect('a', { delayMs: 30 }, ctx())
  await sleepMs(5)
  manager.sessions.set('a', { ...session, sessionId: 's9', bot: fakeBot() })
  await reconnecting
  assert.deepEqual(events, ['disconnect'])
})

test('reconnect works for a Bedrock account', async () => {
  const { facade, ctx } = reconnectSetup({ edition: 'bedrock', spawnAfterMs: 5 })
  await facade.reconnect('a', {}, ctx())
  assert.equal(facade.sessionId('a'), 's2')
})

test('reconnect needs an account configuration', async () => {
  const { facade, manager, session, ctx } = reconnectSetup()
  manager.reconnects.clear()
  delete session.account
  await assert.rejects(facade.reconnect('a', {}, ctx()), (error) => error.code === 'OFFLINE')
})

test('disconnect goes through the manager manual disconnect so auto-reconnect stays off', async (t) => {
  const { manager, facade, ctx } = realSetup(t, { account: { autoReconnect: true } })
  await facade.disconnect('a', {}, ctx())
  assert.equal(manager.sessions.has('a'), false)
  assert.equal(manager.reconnects.has('a'), false)
})
