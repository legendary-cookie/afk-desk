'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installSafety, consumeItem } = require('../electron/safety.cjs')
const { BotManager } = require('../electron/bot-manager.cjs')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const never = () => new Promise(() => {})

function setup(t, config = {}, options = {}) {
  const slots = []
  slots[37] = { name: 'ominous_bottle', slot: 37, type: 999, count: 39 }
  const bot = new EventEmitter(), inventory = new EventEmitter()
  Object.assign(inventory, { slots, inventoryStart: 9, items: () => slots.filter(item => item?.count !== 0 && item) })
  Object.assign(bot, {
    health: 20, food: 20, quickBarSlot: 0, inventory,
    entity: { effects: { 3: { amplifier: 1 }, 5: { amplifier: 1 } }, position: { x: 0, y: 64, z: 0 } },
    registry: { effectsByName: { BadOmen: { id: 31 } } },
    bossBars: [{ title: { text: 'mcMMO XP', extra: [{ text: ' Mining' }] } }],
    setQuickBarSlot(slot) { this.quickBarSlot = slot; this.selections.push(slot) }, selections: [],
    activateItem() {
      assert.equal(this.quickBarSlot, 1)
      this.drinks = (this.drinks || 0) + 1
      slots[37].count--
      this.entity.effects[31] = {}
      this.emit('heldItemChanged', { ...slots[37] })
    },
    deactivateItem() {},
    async moveSlotItem(a, b) { [slots[a], slots[b]] = [slots[b], slots[a]] },
    findBlock: () => ({ name: 'barrel', position: { x: 1.3, y: 64, z: 0 } }),
    canSeeBlock: () => true,
    closeWindow() { this.currentWindow = null },
  })
  const account = { id: 'a', autoOminousBottle: true, autoOminousOrder: 'lowest', autoOminousCooldown: 0, ...config }
  const session = { bot, account, ready: true, inventoryQueue: Promise.resolve(), inputClaims: new Map(), depositRevision: 0 }
  const events = []
  const manager = {
    sessions: new Map([['a', session]]), requireOnline: () => bot,
    emit: (...args) => events.push(args), emitTelemetry() {},
    withInventoryAction: BotManager.prototype.withInventoryAction,
    refreshChest: BotManager.prototype.refreshChest,
  }
  installSafety(manager, account, session, {}, options)
  t.after(() => clearInterval(session.safetyTimer))
  return { bot, slots, session, manager, events }
}

test('1.21.1 full hunger, Strength/Haste and mcMMO XP bar still drinks slot 37 before equips', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup(t, { autoArmor: true, autoTotem: true })
  x.slots[9] = { name: 'iron_helmet', slot: 9, count: 1 }
  x.slots[10] = { name: 'totem_of_undying', slot: 10, count: 1 }
  x.bot.equip = never
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  assert.equal(x.slots[37].count, 38)
  assert.deepEqual(x.bot.selections, [1, 0])
  // Drain both intentionally unacknowledged equipment actions.
  t.mock.timers.tick(8001); await flush()
  t.mock.timers.tick(8001); await flush()
  assert.equal(x.session.safetyBusy, false)
})

for (const kind of ['armor', 'totem']) test(`stuck ${kind} equip releases safetyBusy and the inventory queue; next tick drinks`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup(t, { autoOminousBottle: false, autoArmor: kind === 'armor', autoTotem: kind === 'totem' })
  x.slots[9] = { name: kind === 'armor' ? 'iron_helmet' : 'totem_of_undying', slot: 9, count: 1 }
  let calls = 0
  x.bot.equip = () => { calls++; return never() }
  x.bot.emit('health'); await flush()
  assert.equal(calls, 1); assert.equal(x.session.safetyBusy, true)
  x.session.account.autoOminousBottle = true
  t.mock.timers.tick(8001); await flush()
  assert.equal(x.session.safetyBusy, false)
  assert.equal(x.session.inventoryAction, false)
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  assert.ok(x.events.some(([, , p]) => /timed out/.test(p.message)))
  t.mock.timers.tick(8001); await flush()
})

test('stuck predecessor is bounded; an expired queued safety callback never selects a slot later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup(t)
  const prior = x.manager.withInventoryAction('a', never).catch(error => error)
  await flush()
  x.bot.emit('health'); await flush()
  t.mock.timers.tick(8001); await flush()
  assert.match((await prior).message, /timed out/)
  assert.equal(x.session.safetyBusy, false)
  assert.equal(x.bot.drinks, undefined)
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  assert.deepEqual(x.bot.selections, [1, 0])
})

for (const phase of ['opening', 'transfer']) test(`stuck deposit ${phase} times out, yields to safety, and cannot resume transfers`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup(t, { autoDepositToChest: true })
  let resolveOpen, resolveTransfer, transfers = 0, closed = 0
  const container = { inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null), close() { closed++; x.bot.currentWindow = null }, deposit() { transfers++; return new Promise(resolve => { resolveTransfer = resolve }) } }
  container.slots[55] = x.slots[37]
  x.bot.transfer = () => { transfers++; return new Promise(resolve => { resolveTransfer = resolve }) }
  x.bot.openContainer = () => {
    x.bot.currentWindow = container
    return phase === 'opening' ? new Promise(resolve => { resolveOpen = resolve }) : Promise.resolve(container)
  }
  const deposit = x.manager.refreshChest('a'); await flush()
  assert.equal(x.session.depositing, true, JSON.stringify(x.events))
  if (phase === 'transfer') assert.equal(transfers, 1)
  x.bot.emit('health'); await flush()
  assert.match(x.session.safetyStatus, /deposit in progress/)
  assert.equal(x.session.safetyPending, true)
  assert.equal(x.bot.drinks, undefined)
  t.mock.timers.tick(8001); await deposit; await flush()
  assert.equal(x.session.depositing, false)
  // Repeated deposit polls cannot take the reserved turn.
  await x.manager.refreshChest('a')
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  const before = transfers
  if (resolveOpen) resolveOpen(container)
  if (resolveTransfer) resolveTransfer()
  await flush()
  assert.equal(transfers, before)
  assert.ok(closed >= 1)
  assert.equal(x.bot.currentWindow, null)
})

for (const gate of ['ready', 'switching', 'rightClick', 'window']) test(`${gate} gate reports its reason and drinks once released`, async t => {
  const x = setup(t)
  if (gate === 'ready') x.session.ready = false
  if (gate === 'switching') x.session.switching = true
  if (gate === 'rightClick') x.session.inputClaims.set('rightClick', new Set(['macro:1']))
  if (gate === 'window') x.bot.currentWindow = {}
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, undefined)
  assert.match(x.session.safetyStatus, /waiting: (server not ready|right click owned|server menu open)/)
  x.session.ready = true; x.session.switching = false; x.session.inputClaims.clear(); x.bot.currentWindow = null
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  assert.equal(x.session.safetyStatus, 'Ominous Bottle: consumed')
})

test('wait logs are limited to once per 60 seconds for each reason', async t => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const x = setup(t); x.session.depositing = true
  for (let i = 0; i < 5; i++) x.bot.emit('health')
  assert.equal(x.events.length, 1)
  now += 59999; x.bot.emit('health'); assert.equal(x.events.length, 1)
  now++; x.bot.emit('health'); assert.equal(x.events.length, 2)
  x.session.depositing = false; x.session.ready = false; x.bot.emit('health'); assert.equal(x.events.length, 3)
  assert.match(x.events[0][2].message, /^Ominous Bottle waiting: deposit in progress$/)
})

test('hung move, consume and GUI restoration all release safety input and busy state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const phase of ['move', 'consume', 'restore', 'restoreMove']) {
    const x = setup(t)
    if (phase !== 'consume') { x.slots[9] = { ...x.slots[37], slot: 9 }; delete x.slots[37] }
    x.bot.moveSlotItem = async (a, b) => {
      if (phase === 'move' || phase === 'restoreMove' && a === 36) return never()
      ;[x.slots[a], x.slots[b]] = [x.slots[b], x.slots[a]]
    }
    x.bot.activateItem = () => {
      if (phase === 'consume') return
      x.bot.entity.effects[31] = {}
      x.bot.emit('heldItemChanged', null)
      if (phase === 'restore') x.bot.currentWindow = {}
    }
    x.bot.emit('health'); await flush()
    t.mock.timers.tick(8001); await flush()
    assert.equal(x.session.safetyBusy, false, phase)
    assert.equal(x.session.inventoryAction, false, phase)
    assert.equal(x.session.safetyInputDone, null, phase)
    assert.equal(x.bot.listenerCount('heldItemChanged'), 0, phase)
    // Once the failed operation / server menu clears, a hotbar bottle works.
    x.bot.currentWindow = null; x.bot.entity.effects = {}; x.session.account.autoOminousBottle = true
    x.slots[37] = { name: 'ominous_bottle', type: 999, count: 39, slot: 37 }; delete x.slots[9]; delete x.slots[36]
    x.bot.activateItem = () => { x.bot.drinks = 1; x.bot.entity.effects[31] = {}; x.bot.emit('heldItemChanged', null) }
    x.bot.emit('health'); await flush()
    assert.equal(x.bot.drinks, 1, phase)
    clearInterval(x.session.safetyTimer)
  }
})

test('bottle timeout removes listeners even if deactivation throws', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bot = new EventEmitter()
  bot.activateItem = () => {}; bot.deactivateItem = () => { throw new Error('closed connection') }
  const pending = consumeItem(bot, { name: 'ominous_bottle', type: 1, count: 39 }).catch(error => error)
  t.mock.timers.tick(5001)
  assert.match((await pending).message, /Bottle consumption timed out/)
  assert.equal(bot.listenerCount('heldItemChanged'), 0)
})

test('failed hotbar restoration still releases safety input ownership', async t => {
  const x = setup(t)
  const select = x.bot.setQuickBarSlot
  x.bot.setQuickBarSlot = function (slot) { if (slot === 0) throw new Error('connection lost'); select.call(this, slot) }
  x.bot.emit('health'); await flush()
  assert.equal(x.bot.drinks, 1)
  assert.equal(x.session.safetyInputDone, null)
  assert.equal(x.session.safetyBusy, false)
  assert.match(x.session.safetyStatus, /connection lost/)
})

test('safety status is carried in telemetry and wait logs distinguish omen, raid, locks and cooldown', async t => {
  const x = setup(t, { autoOminousCooldown: 60 })
  x.bot.emit('health'); await flush()
  x.bot.entity.effects = {}
  x.bot.emit('health'); await flush()
  assert.match(x.session.safetyStatus, /cooldown/)
  x.session.account.autoOminousCooldown = 0
  x.bot.entity.effects[31] = {}; x.bot.emit('health'); await flush()
  assert.match(x.session.safetyStatus, /omen effect active/)
  x.bot.entity.effects = {}; x.bot.bossBars = [{ title: { translate: 'event.minecraft.raid' } }]
  x.bot.emit('health'); await flush(); assert.match(x.session.safetyStatus, /raid active/)
  x.bot.bossBars = []; x.session.account.lockedInventorySlots = [37]
  x.bot.emit('health'); await flush(); assert.match(x.session.safetyStatus, /consumed/)
  BotManager.prototype.emitTelemetry.call(x.manager, 'a')
  assert.equal(x.events.filter(([type]) => type === 'telemetry').at(-1)[2].safetyStatus, x.session.safetyStatus)
})

test('a wanted totem also reserves the next turn from auto-deposit', async t => {
  const x = setup(t, { autoOminousBottle: false, autoTotem: true, autoDepositToChest: true })
  x.slots[9] = { name: 'totem_of_undying', slot: 9, count: 1 }
  x.session.depositing = true
  x.bot.emit('health'); await flush()
  assert.equal(x.session.safetyPending, true)
  x.session.depositing = false
  x.bot.openContainer = () => assert.fail('Deposit must yield to wanted equipment')
  await x.manager.refreshChest('a')
  x.bot.equip = async item => { x.slots[45] = item; delete x.slots[9] }
  x.bot.emit('health'); await flush()
  assert.equal(x.slots[45].name, 'totem_of_undying')
  assert.equal(x.session.safetyPending, false)
})

test('a timed-out move resolving late cannot select or consume a bottle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup(t)
  x.slots[9] = { ...x.slots[37], slot: 9 }; delete x.slots[37]
  let resolveMove
  x.bot.moveSlotItem = () => new Promise(resolve => { resolveMove = resolve })
  x.bot.emit('health'); await flush()
  const inputDone = x.session.safetyInputDone
  t.mock.timers.tick(8001); await flush(); await inputDone
  assert.equal(x.session.safetyBusy, false)
  resolveMove(); await flush()
  assert.equal(x.bot.drinks, undefined)
  assert.ok(x.bot.selections.every(slot => slot === 0))
})

test('already cancelled restoration never starts an inventory mutation', async () => {
  const { boundedAction } = require('../electron/inventory-action.cjs')
  const controller = new AbortController()
  controller.abort(new Error('Safety action expired'))
  await assert.rejects(boundedAction(() => assert.fail('Cancelled operation started'), 8000, 'Restoration', controller.signal), /Safety action expired/)
})
