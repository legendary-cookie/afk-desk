'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installSafety } = require('../safety.cjs')
function setup(config, slots = []) {
  const bot = new EventEmitter(), client = new EventEmitter(), inventory = new EventEmitter()
  Object.assign(inventory, { slots, items: () => slots.filter(Boolean) })
  Object.assign(bot, { _client: client, entity: { id: 7 }, inventory, health: 20, end(reason) { this.ended = reason } })
  const account = { id: 'a', ...config }, session = { bot, account, ready: true }, state = {}, events = []
  const manager = { sessions: new Map([['a', session]]), emit: (...args) => events.push(args), withInventoryAction: async (_, fn) => fn() }
  installSafety(manager, account, session, state)
  return { bot, client, inventory, session, state, events }
}
test('health and equipped armor thresholds disconnect with cooldown and optional notice', async () => {
  const slots = []; slots[5] = { maxDurability: 100, durabilityUsed: 90 }
  const x = setup({ armorDisconnect: true, armorDisconnectThreshold: 10, lowHealthCooldownMinutes: 2, safetyDisconnectNotify: true }, slots)
  x.bot.emit('health'); assert.match(x.bot.ended, /low armor/); assert.equal(x.events[0][2].notify, true); assert.ok(x.state.cooldownUntil >= Date.now() + 119000)
  clearInterval(x.session.safetyTimer)
  const y = setup({ lowHealthDisconnect: true, lowHealthThreshold: 6 }); y.bot.health = 6; y.bot.emit('health'); assert.match(y.bot.ended, /low health/); assert.equal(y.events[0][2].notify, false); clearInterval(y.session.safetyTimer)
  const z = setup({ armorDisconnect: false }, slots); z.bot.emit('health'); assert.equal(z.bot.ended, undefined); clearInterval(z.session.safetyTimer)
})
test('only own totem pop with no remaining totems disconnects', async () => {
  const slots = []; slots[45] = {name: 'totem_of_undying'}
  const x = setup({totemDisconnect: true}, slots)
  x.client.emit('entity_status', {entityId: 8, entityStatus: 35}); await new Promise(r => setTimeout(r, 550)); assert.equal(x.bot.ended, undefined)
  x.client.emit('entity_status', {entityId: 7, entityStatus: 35}); await new Promise(r => setTimeout(r, 550)); assert.equal(x.bot.ended, undefined)
  x.client.emit('entity_status', {entityId: 7, entityStatus: 35}); slots[45] = null; await new Promise(r => setTimeout(r, 550)); assert.match(x.bot.ended, /totems exhausted/); clearInterval(x.session.safetyTimer)
})
