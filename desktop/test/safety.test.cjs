'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule } = require(file)
  test(`${file}: safety decisions`, () => {
    assert.equal(shouldEat({ autoEat: true }, { food: 14 }), true)
    assert.equal(shouldEat({ autoEat: true }, { food: 14, currentWindow: {} }), false)
    assert.equal(shouldEat({}, { food: 1 }), false)
    const items = [{ name: 'steak', slot: 9 }, { name: 'bread', slot: 36 }, { name: 'steak', slot: 37 }]
    const foods = { steak: { foodPoints: 8, saturation: 12 }, bread: { foodPoints: 5, saturation: 6 } }
    assert.equal(pickFood(items, foods, [37]).name, 'steak')
    assert.equal(pickFood(items, foods, [36, 37]).slot, 37)
    assert.equal(shouldLowHealthAct({ lowHealthTotem: true }, 6), true)
    assert.equal(shouldLowHealthAct({ lowHealthDisconnect: true }, 7), false)
    assert.equal(shouldLowHealthAct({}, 1), false)
    const schedule = { scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '02:00', scheduleDays: [1] }
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 2, 23)), true)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 1)), true)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 2)), false)
    assert.equal(isWithinSchedule(schedule, new Date(2026, 10, 3, 23)), false)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { installSafety, deferSafety } = require(file)
  const { EventEmitter } = require('node:events')
  test(`${file}: waits are active and disabled health retries do not connect`, () => {
    let callback, status, connected = false
    const state = { safetyPause: 'health', account: { id: 'a', autoReconnect: true } }
    const manager = { reconnects: new Map(), status: (id, value) => { status = value }, scheduleReconnectTimer: fn => { callback = fn; return {} }, clearReconnectTimer() {}, connect() { connected = true } }
    deferSafety(manager, state.account, state)
    assert.equal(status, 'reconnecting')
    state.account.autoReconnect = false
    callback()
    assert.equal(connected, false)
    assert.equal(status, 'offline')
  })
  test(`${file}: eating uses queue, respects ownership and restores displaced stack`, async () => {
    const bot = new EventEmitter(); const slots = []
    slots[9] = { name: 'bread', slot: 9 }; slots[37] = { name: 'tool', slot: 37 }
    Object.assign(bot, { food: 1, health: 20, quickBarSlot: 0, inventory: { slots, items: () => slots.filter(Boolean) }, registry: { foodsByName: { bread: {} } }, setQuickBarSlot(n) { this.quickBarSlot = n }, async moveSlotItem(a, b) { [slots[a], slots[b]] = [slots[b], slots[a]]; if (slots[a]) slots[a].slot = a; if (slots[b]) slots[b].slot = b }, async consume() { assert.equal(this.quickBarSlot, 1) } })
    const account = { id: 'a', autoEat: true, lockedInventorySlots: [36] }
    const session = { bot, account, ready: true, inputClaims: new Map([['rightClick', new Set(['macro:1'])]]) }
    let queued = 0
    const manager = { sessions: new Map([['a', session]]), emit() {}, async withInventoryAction(id, fn) { queued++; return fn() } }
    installSafety(manager, account, session, {})
    bot.emit('health'); await new Promise(resolve => setImmediate(resolve)); assert.equal(queued, 0)
    session.inputClaims.clear(); bot.emit('health'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(queued, 1); assert.equal(slots[9].name, 'bread'); assert.equal(slots[37].name, 'tool'); assert.equal(bot.quickBarSlot, 0)
    clearInterval(session.safetyTimer)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { installSafety } = require(file)
  const { EventEmitter } = require('node:events')
  test(`${file}: totem transfer joins inventory queue and rechecks window`, async () => {
    const bot = new EventEmitter()
    let equipped = 0, run
    Object.assign(bot, { health: 5, inventory: { slots: [], items: () => [{ name: 'totem_of_undying', slot: 9 }] }, equip: async () => { equipped++ } })
    const account = { id: 'a', lowHealthTotem: true }
    const session = { bot, account, ready: true }
    const manager = { sessions: new Map([['a', session]]), emit() {}, withInventoryAction(id, fn) { return new Promise(resolve => { run = async () => { await fn(); resolve() } }) } }
    installSafety(manager, account, session, {})
    bot.emit('health'); assert.ok(run)
    bot.currentWindow = {}; await run(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(equipped, 0)
    clearInterval(session.safetyTimer)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { pickFood, installSafety } = require(file)
  test(`${file}: food preference and golden apple opt-in`, () => {
    const foods = { bread: { foodPoints: 5 }, steak: { foodPoints: 8 }, golden_apple: { foodPoints: 20 } }
    const items = [{ name: 'bread', slot: 36 }, { name: 'steak', slot: 9 }, { name: 'golden_apple', slot: 10 }]
    assert.equal(pickFood(items, foods, [], 'nutrition').name, 'steak')
    assert.equal(pickFood(items, foods, [], 'hotbar').name, 'bread')
    assert.equal(pickFood(items, foods, [], 'nutrition', true).name, 'golden_apple')
  })
  test(`${file}: auto totem re-equips on inventory change`, async () => {
    const { EventEmitter } = require('node:events')
    const bot = new EventEmitter(), inventory = new EventEmitter(), slots = []
    slots[9] = { name: 'totem_of_undying', slot: 9 }
    Object.assign(inventory, { slots, items: () => slots.filter(Boolean) })
    let equipped = 0
    Object.assign(bot, { health: 20, inventory, async equip(item) { equipped++; slots[45] = item; slots[9] = null } })
    const account = { id: 'a', autoTotem: true }, session = { bot, account, ready: true }
    const manager = { sessions: new Map([['a', session]]), emit() {}, async withInventoryAction(id, fn) { await fn() } }
    installSafety(manager, account, session, {})
    inventory.emit('updateSlot'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(equipped, 1)
    slots[45] = null; slots[9] = { name: 'totem_of_undying', slot: 9 }
    inventory.emit('updateSlot'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(equipped, 2)
    clearInterval(session.safetyTimer)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { pickConsumable } = require(file)
  test(`${file}: consumables honor effects, damage, preference, locks and cooldown`, () => {
    const items = [{name: 'ominous_bottle', slot: 9, components: [{type: 'ominous_bottle_amplifier', data: 2}]}, {name: 'golden_apple', slot: 10}, {name: 'enchanted_golden_apple', slot: 11}]
    const bot = {health: 20, entity: {effects: {}}, registry: {effectsByName: {BadOmen: {id: 30}, RaidOmen: {id: 34}, Absorption: {id: 21}, Regeneration: {id: 9}}}, inventory: {items: () => items}}
    const config = {autoOminousBottle: true, autoOminousOrder: 'lowest', autoOminousCooldown: 30}
    assert.equal(pickConsumable(config, bot, null, null, 50000), items[0])
    assert.equal(pickConsumable({...config, autoOminousOrder: 'highest'}, bot, null, null, 50000), items[0])
    assert.equal(pickConsumable(config, bot, null, 40000, 50000), null)
    bot.entity.effects[34] = {}; assert.equal(pickConsumable(config, bot, null, null, 50000), null)
    delete bot.entity.effects[34]; bot.entity.effects[30] = {}; assert.equal(pickConsumable(config, bot, null, null, 50000), null)
    delete bot.entity.effects[30]; assert.equal(pickConsumable({...config, lockedInventorySlots: [9]}, bot, null, null, 50000), items[0])
    const apple = {autoGoldenApple: true, autoGoldenAppleHealth: 10, autoGoldenApplePreference: 'enchanted'}
    assert.equal(pickConsumable(apple, bot, null, null, 50000), null)
    assert.equal(pickConsumable(apple, bot, 45000, null, 50000), items[2])
    bot.entity.effects[21] = {}; bot.entity.effects[9] = {}
    assert.equal(pickConsumable(apple, bot, 45000, null, 50000), null)
    bot.health = 10; assert.equal(pickConsumable({...apple, lockedInventorySlots: [11]}, bot, null, null, 50000), items[2])
    bot.currentWindow = {}; assert.equal(pickConsumable(apple, bot, null, null, 50000), null)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  test(`${file}: bottle use works at full hunger and waits for held item change`, async () => {
    const {consumeItem} = require(file), {EventEmitter} = require('node:events')
    const bot = new EventEmitter(), item = {name: 'ominous_bottle', type: 7, count: 1}
    let activated = 0, deactivated = 0
    bot.activateItem = () => { activated++ }; bot.deactivateItem = () => { deactivated++ }
    const pending = consumeItem(bot, item)
    assert.equal(activated, 1)
    bot.emit('heldItemChanged', {type: 8, count: 1})
    await pending
    assert.equal(deactivated, 1)
    assert.equal(bot.listenerCount('heldItemChanged'), 0)
  })
}
for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  test(`${file}: damaged health event triggers preferred apple through inventory queue`, async () => {
    const {installSafety} = require(file), {EventEmitter} = require('node:events')
    const bot = new EventEmitter(), slots = []
    slots[36] = {name: 'enchanted_golden_apple', slot: 36}
    Object.assign(bot, {health: 20, quickBarSlot: 1, entity: {effects: {}}, inventory: {slots, items: () => slots.filter(Boolean)}, setQuickBarSlot(n) { this.quickBarSlot = n }, async consume() { assert.equal(this.quickBarSlot, 0); this.eaten = true }})
    const account = {id: 'a', autoGoldenApple: true, autoGoldenApplePreference: 'enchanted', autoGoldenAppleHealth: 5}
    const session = {bot, account, ready: true}, manager = {sessions: new Map([['a', session]]), emit() {}, async withInventoryAction(id, fn) { await fn() }}
    installSafety(manager, account, session, {})
    bot.health = 19; bot.emit('health'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(bot.eaten, true); assert.equal(bot.quickBarSlot, 1)
    clearInterval(session.safetyTimer)
  })
}

for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  test(`${file}: raid, omen effects and bottle ordering`, () => {
    const {pickConsumable} = require(file)
    const bottle = (slot, level) => ({name: 'ominous_bottle', slot, components: [{type: 'minecraft:ominous_bottle_amplifier', data: level}]})
    const items = [bottle(9, 2), bottle(10, 4), bottle(11, 0)]
    const bot = Object.assign(new (require('node:events').EventEmitter)(), {health: 20, entity: {effects: {}}, registry: {effectsByName: {BadOmen: {id: 1}, RaidOmen: {id: 2}, TrialOmen: {id: 3}}}, inventory: {items: () => items}, bossBars: []})
    const config = {autoOminousBottle: true}
    assert.equal(pickConsumable(config, bot), items[1])
    assert.equal(pickConsumable({...config, autoOminousOrder: 'lowest'}, bot), items[2])
    assert.equal(pickConsumable({...config, lockedInventorySlots: [10]}, bot), items[1])
    assert.equal(pickConsumable({...config, autoOminousOrder: 'lowest', lockedInventorySlots: [11]}, bot), items[2])
    for (const id of [1, 2, 3]) { bot.entity.effects[id] = {}; assert.equal(pickConsumable(config, bot), null); delete bot.entity.effects[id] }
    for (const title of [{translate: 'event.minecraft.raid'}, {translate: 'event.minecraft.raid.victory'}, JSON.stringify({translate: 'event.minecraft.raid.defeat'}), 'Raid - Raiders Remaining: 2']) {
      bot.emit('bossBarCreated', {entityUUID: 'raid', title}); assert.equal(pickConsumable(config, bot), null); bot.emit('bossBarDeleted', 'raid')
    }
    bot.emit('bossBarCreated', {entityUUID: 'dragon', title: 'Dragon'}); assert.equal(pickConsumable(config, bot), items[1])
  })
}

for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  const { installSafety } = require(file), { EventEmitter } = require('node:events')
  for (const bottle of [true, false]) test(`${file}: uses locked ${bottle ? 'hotbar bottle' : 'inventory food'} safely`, async t => {
    const bot = new EventEmitter(), slots = []
    const source = bottle ? 37 : 9
    slots[source] = { name: bottle ? 'ominous_bottle' : 'bread', slot: source, type: 7, count: 2 }
    if (!bottle) { for (let slot = 37; slot <= 44; slot++) slots[slot] = { name: 'tool', slot } }
    const moves = []
    Object.assign(bot, { health: 20, food: 1, quickBarSlot: 2, entity: { effects: {} }, registry: { foodsByName: { bread: {} } }, inventory: { slots, items: () => slots.filter(Boolean) },
      setQuickBarSlot(n) { this.quickBarSlot = n },
      async moveSlotItem(a, b) { moves.push([a, b]); if (b === source) assert.equal(slots[a]?.name, 'bread'); [slots[a], slots[b]] = [slots[b], slots[a]]; if (slots[a]) slots[a].slot = a; if (slots[b]) slots[b].slot = b },
      async consume() { assert.equal(this.quickBarSlot, 1); slots[37].count-- },
      activateItem() { assert.equal(this.quickBarSlot, 1); this.emit('heldItemChanged', { type: 7, count: 1 }) }, deactivateItem() {} })
    const account = { id: 'a', autoEat: !bottle, autoOminousBottle: bottle, lockedInventorySlots: bottle ? [37] : [9, 36] }
    const session = { bot, account, ready: true }, manager = { sessions: new Map([['a', session]]), emit() {}, async withInventoryAction(id, fn) { await fn() } }
    installSafety(manager, account, session, {}); t.after(() => clearInterval(session.safetyTimer))
    bot.emit('health'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(bot.quickBarSlot, 2)
    assert.equal(slots[source].name, bottle ? 'ominous_bottle' : 'bread')
    if (!bottle) { assert.equal(slots[37].name, 'tool'); assert.ok(moves.length >= 3); assert.ok(moves.every(([a,b]) => a !== 36 && b !== 36)) }
    else assert.deepEqual(moves, [])
  })
}

for (const file of ['../electron/safety.cjs', '../../mobile/nodejs-assets/nodejs-project/safety.cjs']) {
  for (const armor of [false, true]) test(`${file}: equips locked ${armor ? 'armor' : 'totem'} without displacing equipment into its slot`, async t => {
    const { installSafety } = require(file), { EventEmitter } = require('node:events')
    const bot = new EventEmitter(), slots = [], destination = armor ? 5 : 45
    slots[9] = { slot: 9, name: armor ? 'diamond_helmet' : 'totem_of_undying' }
    slots[destination] = { slot: destination, name: armor ? 'iron_helmet' : 'shield' }
    Object.assign(bot, { health: 20, inventory: { slots, items: () => slots.filter(Boolean) },
      async moveSlotItem(a, b) { assert.notEqual(b, 9); [slots[a], slots[b]] = [slots[b], slots[a]]; if (slots[b]) slots[b].slot = b },
      async equip(item) { assert.equal(slots[destination], undefined); slots[destination] = item; slots[9] = undefined } })
    const account = { id: 'a', autoArmor: armor, autoTotem: !armor, lockedInventorySlots: [9] }, session = { bot, account, ready: true }
    const manager = { sessions: new Map([['a', session]]), emit() {}, async withInventoryAction(id, fn) { await fn() } }
    installSafety(manager, account, session, {}); t.after(() => clearInterval(session.safetyTimer))
    bot.emit('health'); await new Promise(resolve => setImmediate(resolve))
    assert.equal(slots[destination].name, armor ? 'diamond_helmet' : 'totem_of_undying')
    assert.equal(slots[9], undefined)
    assert.equal(slots[10].name, armor ? 'iron_helmet' : 'shield')
  })
}
