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
    assert.equal(pickFood(items, foods, [37]).name, 'bread')
    assert.equal(pickFood(items, foods, [36, 37]).slot, 9)
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
