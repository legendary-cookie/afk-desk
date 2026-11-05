'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { BotManager } = require('../bot-manager.cjs')
const { createFacade } = require('../macro/facade.cjs')
const { FACADE_METHODS, assertFacade } = require('../macro/contract.cjs')

const { clock, fakeBot, flush, position } = require('./macro-fixture.cjs')
function fixture(t) {
  const bots = [], events = [], time = clock()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...args) => events.push(args), createBot: () => { const b = fakeBot(); bots.push(b); return b } })
  const account = { id: 'a', username: 'fake', host: 'localhost', antiAfk: false, autoReconnect: false, lockedInventorySlots: [9] }
  manager.connect(account); bots[0].emit('spawn')
  const facade = createFacade(manager, time), bot = bots[0]
  const controller = new AbortController()
  const ctx = { owner: 'macro:test', sessionId: facade.sessionId('a'), signal: controller.signal }
  const put = (slot, name = 'stone', count = 8) => (bot.inventory.slots[slot] = { slot, name, displayName: name, type: 1, metadata: 0, count })
  t.after(() => { controller.abort(); facade.releaseOwner('a', ctx.owner); manager.disconnect('a') })
  return { bots, bot, manager, facade, ctx, controller, events, time, put }
}

test('mobile facade implements the entire contract, sends chat and emits notifications as data', async t => {
  const { facade, ctx, bot, events } = fixture(t)
  assert.equal(assertFacade(facade), facade)
  assert.deepEqual(Object.keys(facade).sort(), [...FACADE_METHODS].sort())
  await facade.chat('a', { message: ' <img> hello ' }, ctx)
  await facade.notify('a', { message: '<script>Fake</script>', desktop: true, macroId: 'm' }, ctx)
  assert.deepEqual(bot.calls[0], ['chat', '<img> hello'])
  assert.ok(events.some(([type, id, value]) => type === 'macro-notify' && id === 'a' && value.message === '<script>Fake</script>'))
})

test('movement runs for its duration or distance, and abort releases owned controls', async t => {
  const { facade, ctx, bot, time, controller } = fixture(t)
  const moving = facade.move('a', { control: 'forward', durationMs: 100 }, ctx)
  await time.tick(100); await moving
  assert.deepEqual(bot.calls.slice(0, 2), [['setControlState', 'forward', true], ['setControlState', 'forward', false]])
  const walking = facade.move('a', { control: 'left', distance: 2 }, ctx)
  bot.entity.position = position(2)
  await time.tick(25); await walking
  const waiting = facade.move('a', { control: 'back', durationMs: 10000 }, ctx)
  const rejected = assert.rejects(waiting, { code: 'ABORTED' })
  controller.abort(); await rejected
  assert.deepEqual(bot.calls.at(-1), ['setControlState', 'back', false])
  assert.equal(time.size(), 0)
})

test('input holds release per owner and run cleanup releases all holds', async t => {
  const { facade, ctx, bot } = fixture(t)
  const second = { ...ctx, owner: 'macro:second' }
  await facade.control('a', { control: 'sneak', action: 'hold' }, ctx)
  await facade.control('a', { control: 'sneak', action: 'hold' }, second)
  await facade.control('a', { control: 'sneak', action: 'release' }, ctx)
  assert.equal(bot.calls.some(c => c[0] === 'setControlState' && c[2] === false), false)
  await facade.rightClick('a', { action: 'hold' }, second)
  facade.releaseOwner('a', second.owner)
  assert.deepEqual(bot.calls.slice(-2), [['setControlState', 'sneak', false], ['deactivateItem']])
  await assert.rejects(facade.control('a', { control: 'fly', action: 'hold' }, ctx), { code: 'INVALID' })
})

test('look supports absolute and relative rotation, coordinates and named entities', async t => {
  const { facade, ctx, bot } = fixture(t)
  bot.entities[7] = { id: 7, username: 'Alex', type: 'player', position: position(2) }
  await facade.look('a', { mode: 'absolute', yaw: 0.5, pitch: 0.2 }, ctx)
  await facade.look('a', { mode: 'relative', yaw: 0.5, pitch: 0.2 }, ctx)
  await facade.look('a', { mode: 'at', x: 3, y: 65, z: 4 }, ctx)
  await facade.look('a', { mode: 'at', target: 'entity', entity: 'Alex' }, ctx)
  assert.deepEqual(bot.calls[0], ['look', 0.5, 0.2, true])
  assert.deepEqual(bot.calls[1], ['look', 1.5, 0.30000000000000004, true])
  assert.equal(bot.calls[2][1].x, 3); assert.equal(bot.calls[3][1].x, 2)
  await assert.rejects(facade.look('a', { mode: 'at', target: 'entity', entity: 'missing' }, ctx), { code: 'NOT_FOUND' })
})

test('clicks attack, dig, swing, activate blocks/entities/items and stop held attacks', async t => {
  const { facade, ctx, bot, time } = fixture(t)
  await facade.leftClick('a', { action: 'once' }, ctx)
  const block = { name: 'stone' }, target = { id: 7, position: position(1) }
  bot.blockAtCursor = () => block
  await facade.leftClick('a', { action: 'once', only: 'blocks' }, ctx)
  bot.entities[7] = target
  await facade.leftClick('a', { action: 'hold', only: 'entities' }, ctx)
  await time.tick(400)
  await facade.leftClick('a', { action: 'release' }, ctx)
  const count = bot.calls.filter(c => c[0] === 'attack').length
  await time.tick(400)
  assert.equal(bot.calls.filter(c => c[0] === 'attack').length, count)
  assert.equal(count, 3)
  await facade.rightClick('a', { action: 'once' }, ctx)
  bot.entityAtCursor = () => target
  await facade.rightClick('a', { action: 'once' }, ctx)
  bot.entityAtCursor = () => null; bot.blockAtCursor = () => null
  await facade.rightClick('a', { action: 'once' }, ctx)
  for (const name of ['swingArm', 'dig', 'stopDigging', 'activateBlock', 'activateEntity', 'activateItem', 'deactivateItem']) assert.ok(bot.calls.some(c => c[0] === name), name)
})

test('autoclick respects duration, stop conditions and cancellation', async t => {
  const { facade, ctx, bot, time, controller } = fixture(t)
  const click = facade.autoclick('a', { button: 'left', cps: 10, durationSec: 0.3 }, ctx)
  await time.tick(300); await click
  assert.equal(bot.calls.filter(c => c[0] === 'swingArm').length, 3)
  await assert.rejects(facade.autoclick('a', { button: 'right', cps: 10 }, { ...ctx, checkStop: () => true }), { code: 'ABORTED' })
  const pending = facade.autoclick('a', { button: 'right', cps: 10 }, ctx)
  const rejected = assert.rejects(pending, { code: 'ABORTED' })
  await flush(); controller.abort(); await rejected
  assert.equal(time.size(), 0)
})

test('hotbar, hold item, inventory clicks and lore use unlocked selected stacks', async t => {
  const { facade, ctx, bot, put } = fixture(t)
  put(9); const item = put(10); item.customLore = ['{"text":"Special stone"}']; put(36, 'dirt')
  await facade.selectHotbar('a', { slot: 2 }, ctx)
  await facade.holdItem('a', { name: 'stone' }, ctx)
  assert.deepEqual(bot.calls.find(c => c[0] === 'equip'), ['equip', item, 'hand'])
  await facade.holdItem('a', { name: 'dirt' }, ctx)
  for (const [click, button, mode] of [['left', 0, 0], ['right', 1, 0], ['shift', 0, 1], ['drop', 0, 4]]) {
    await facade.useInventory('a', { select: { lore: 'special' }, click }, ctx)
    assert.deepEqual(bot.calls.at(-1), ['clickWindow', 10, button, mode])
  }
  assert.equal(await facade.readLore('a', { select: { name: 'stone' } }, ctx), 'Special stone')
  await assert.rejects(facade.useInventory('a', { select: { slot: 9 }, click: 'left' }, ctx), { code: 'LOCKED_SLOT' })
  await assert.rejects(facade.selectHotbar('a', { slot: 9 }, ctx), { code: 'INVALID' })
  await assert.rejects(facade.holdItem('a', { name: 'missing' }, ctx), { code: 'NOT_FOUND' })
})

test('GUI selection supports empty slots, names and lore, and protects mapped player slots', async t => {
  const { facade, ctx, bot } = fixture(t)
  const menu = { title: '{"text":"Server menu"}', inventoryStart: 27, slots: Array(63).fill(null) }
  menu.slots[0] = { name: 'compass', customLore: ['Travel'] }
  menu.slots[27] = { name: 'locked' }
  bot.currentWindow = menu
  await facade.useGui('a', { select: { slot: 2 }, click: 'right' }, ctx)
  await facade.useGui('a', { select: { name: 'compass' }, click: 'left' }, ctx)
  await facade.useGui('a', { select: { lore: 'travel' }, click: 'shift' }, ctx)
  assert.deepEqual(bot.calls.filter(c => c[0] === 'clickWindow'), [['clickWindow', 2, 1, 0], ['clickWindow', 0, 0, 0], ['clickWindow', 0, 0, 1]])
  await assert.rejects(facade.useGui('a', { select: { slot: 27 }, click: 'drop' }, ctx), { code: 'LOCKED_SLOT' })
  await facade.closeGui('a', {}, ctx)
  assert.equal(bot.currentWindow, null)
  await assert.rejects(facade.useGui('a', { select: { slot: 0 }, click: 'left' }, ctx), { code: 'NOT_FOUND' })
})

test('waitForWindow waits for a matching title, times out and cancels', async t => {
  const { facade, ctx, bot, time, controller } = fixture(t)
  const pending = facade.waitForWindow('a', { title: 'Travel', giveUpAfterMs: 100 }, ctx)
  bot.currentWindow = { title: { text: 'Travel menu' } }
  await time.tick(25)
  assert.deepEqual(await pending, { title: 'Travel menu' })
  bot.currentWindow = null
  const timedOut = assert.rejects(facade.waitForWindow('a', { giveUpAfterMs: 50 }, ctx), { code: 'TIMEOUT' })
  await time.tick(50); await timedOut
  const cancelled = assert.rejects(facade.waitForWindow('a', {}, ctx), { code: 'ABORTED' })
  controller.abort(); await cancelled
})

test('drop and deposit transfer only the selected slot, preserving locked duplicate stacks', async t => {
  const { facade, ctx, bot, put } = fixture(t)
  put(9); const item = put(10)
  await facade.drop('a', { select: { name: 'stone' }, count: 2 }, ctx)
  assert.deepEqual(bot.calls.at(-1), ['transfer', { window: bot.inventory, itemType: 1, metadata: 0, nbt: undefined, count: 2, sourceStart: 10, sourceEnd: 11, destStart: -999, destEnd: -999 }])
  await facade.dropAll('a', { filter: 'stone' }, ctx)
  assert.deepEqual(bot.calls.at(-1), ['tossStack', item])
  const block = { name: 'chest', position: position(1) }
  bot.findBlock = () => block
  let closed = 0
  const container = { inventoryStart: 27, inventoryEnd: 63, slots: { 28: item }, close() { closed++; bot.currentWindow = null } }
  bot.openContainer = async () => { bot.currentWindow = container; return container }
  await facade.deposit('a', { select: { slot: 10 }, count: 3 }, ctx)
  const transfer = bot.calls.at(-1)[1]
  assert.equal(transfer.sourceStart, 28); assert.equal(transfer.sourceEnd, 29)
  assert.equal(transfer.count, 3); assert.equal(transfer.destEnd, 27); assert.equal(closed, 1)
  await assert.rejects(facade.deposit('a', { select: { slot: 9 }, count: 3 }, ctx), { code: 'LOCKED_SLOT' })
  bot.findBlock = () => null
  await assert.rejects(facade.deposit('a', { select: { slot: 10 }, count: 3 }, ctx), { code: 'NOT_FOUND' })
})

test('deposit closes its container on failure and cancellation', async t => {
  const { facade, ctx, bot, put, controller } = fixture(t)
  const item = put(10)
  bot.findBlock = () => ({ name: 'barrel', position: position(1) })
  let closed = 0
  bot.openContainer = async () => ({ inventoryStart: 27, inventoryEnd: 63, slots: { 28: item }, close() { closed++ } })
  bot.transfer = async () => { throw new Error('full') }
  await assert.rejects(facade.deposit('a', { select: { slot: 10 } }, ctx), /full/)
  assert.equal(closed, 1)
  bot.openContainer = async () => ({ inventoryStart: 27, inventoryEnd: 63, slots: { 28: { ...item, type: 2 } }, close() { closed++ } })
  await assert.rejects(facade.deposit('a', { select: { slot: 10 } }, ctx), { code: 'NOT_FOUND' })
  assert.equal(closed, 2)
  bot.openContainer = async () => { controller.abort(); return { inventoryStart: 27, close() { closed++ } } }
  await assert.rejects(facade.deposit('a', { select: { slot: 10 } }, ctx), { code: 'ABORTED' })
  assert.equal(closed, 3)
})

test('reconnect waits for a new ready session and disconnect suppresses automatic reconnect', async t => {
  const { facade, ctx, bots, manager, time } = fixture(t)
  const previous = facade.sessionId('a')
  let completed = false
  const reconnect = facade.reconnect('a', { delayMs: 100, giveUpAfterMs: 200 }, ctx).then(() => { completed = true })
  await time.tick(100)
  assert.equal(bots.length, 2); assert.equal(completed, false)
  bots[1].emit('spawn'); await time.tick(25); await reconnect
  assert.notEqual(facade.sessionId('a'), previous)
  await facade.disconnect('a', {}, { ...ctx, sessionId: facade.sessionId('a') })
  assert.equal(manager.sessions.size, 0); assert.equal(manager.reconnects.size, 0)
})

test('reconnect retries timeouts and abort disconnects the unfinished session', async t => {
  const { facade, ctx, bots, manager, time, controller } = fixture(t)
  const pending = assert.rejects(facade.reconnect('a', { maxAttempts: 2, giveUpAfterMs: 50 }, ctx), { code: 'TIMEOUT' })
  await time.tick(100); await pending
  assert.equal(bots.length, 3); assert.equal(manager.sessions.size, 0)
  manager.connect({ id: 'a', username: 'fake', host: 'localhost', antiAfk: false }); bots.at(-1).emit('spawn')
  const cancelled = assert.rejects(facade.reconnect('a', {}, { ...ctx, sessionId: facade.sessionId('a') }), { code: 'ABORTED' })
  await time.tick(0); controller.abort(); await cancelled
  assert.equal(manager.sessions.size, 0)
})

test('all actions reject aborted, offline and stale sessions before sending packets', async t => {
  const { facade, ctx, bot, manager, controller } = fixture(t)
  controller.abort()
  for (const method of FACADE_METHODS.filter(name => !['sessionId', 'state', 'releaseOwner'].includes(name))) {
    await assert.rejects(facade[method]('a', {}, ctx), { code: 'ABORTED' }, method)
  }
  assert.equal(bot.calls.length, 0)
  const fresh = { ...ctx, signal: new AbortController().signal }
  manager.clearSession('a')
  manager.sessions.set('a', { ready: true, bot })
  await assert.rejects(facade.chat('a', { message: 'stale' }, fresh), { code: 'SESSION_CHANGED' })
  manager.sessions.get('a').ready = false
  await assert.rejects(facade.chat('a', { message: 'offline' }, { ...fresh, sessionId: null }), { code: 'OFFLINE' })
})

test('state exposes inventory, open windows, position and nearby entities to graph values and conditions', t => {
  const { facade, bot, put } = fixture(t)
  for (let slot = 9; slot <= 44; slot++) put(slot)
  bot.currentWindow = { title: 'Menu' }
  bot.entities = { self: bot.entity, other: { id: 2, username: 'Alex', type: 'player', position: position(3, 64, 4) } }
  const state = facade.state('a')
  assert.equal(state.online, true); assert.equal(state.edition, 'java')
  assert.equal(state.inventoryFull, true); assert.equal(state.windowOpen, true)
  assert.equal(state.inventory.length, 36); assert.equal(state.position.y, 64)
  assert.equal(state.entities[0].distance, 5); assert.equal(state.entities[0].type, 'player')
  bot.inventory.slots[10] = null
  assert.equal(facade.state('a').inventoryFull, false)
  assert.equal(facade.state('missing').online, false)
})

test('queued inventory work checks cancellation before sending and in-flight operations fence replacement sessions', async t => {
  const { facade, ctx, bot, manager, put, controller } = fixture(t)
  put(10)
  let release
  manager.sessions.get('a').inventoryQueue = new Promise(resolve => { release = resolve })
  const queued = assert.rejects(facade.drop('a', { select: { slot: 10 }, count: 1 }, ctx), { code: 'ABORTED' })
  controller.abort(); release(); await queued
  assert.equal(bot.calls.length, 0)
  const fresh = { ...ctx, signal: new AbortController().signal }
  let finish
  bot.look = () => new Promise(resolve => { finish = resolve })
  const looking = assert.rejects(facade.look('a', { mode: 'absolute', yaw: 1, pitch: 0 }, fresh), { code: 'SESSION_CHANGED' })
  manager.clearSession('a'); manager.sessions.set('a', { ready: true, bot })
  finish(); await looking
})


test('macro holds share ownership with safety and manual input and wait for safety consumption', async t => {
  const { facade, ctx, bot, manager } = fixture(t)
  const session = manager.sessions.get('a')
  let finish
  session.safetyInputDone = new Promise(resolve => { finish = resolve })
  const hold = facade.rightClick('a', { action: 'hold' }, ctx)
  await Promise.resolve()
  assert.equal(session.inputClaims.get('rightClick')?.size || 0, 0)
  session.safetyInputDone = null; finish(); await hold
  assert.equal(session.inputClaims.get('rightClick').size, 1)
  await facade.rightClick('a', { action: 'release' }, ctx)
  assert.equal(session.inputClaims.has('rightClick'), false)
  manager.control('a', 'sneak', 100)
  await facade.control('a', { control: 'sneak', action: 'hold' }, ctx)
  await facade.control('a', { control: 'sneak', action: 'release' }, ctx)
  assert.equal(bot.calls.filter(c => c[0] === 'setControlState' && c[1] === 'sneak' && c[2] === false).length, 0)
})
