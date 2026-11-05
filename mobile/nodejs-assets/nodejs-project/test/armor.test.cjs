'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { chooseArmor, installSafety } = require('../safety.cjs')
test('armor chooses healthy material, protection and durability, respecting locks', () => {
  const slots = []
  const piece = (slot, name, used = 0, level = 0) => slots[slot] = {slot, name, maxDurability: 100, durabilityUsed: used, enchants: [{name: 'protection', lvl: level}]}
  piece(5, 'diamond_helmet', 96, 4); piece(9, 'iron_helmet'); piece(10, 'diamond_helmet', 20, 1); piece(11, 'diamond_helmet', 10, 2)
  const bot = {inventory: {slots, items: () => slots.filter(Boolean)}}
  assert.equal(chooseArmor(bot, {}, 'head', 5, 'helmet').slot, 11)
  assert.equal(chooseArmor(bot, {lockedInventorySlots: [11]}, 'head', 5, 'helmet').slot, 11)
  assert.equal(chooseArmor(bot, {lockedInventorySlots: [5]}, 'head', 5, 'helmet'), null)
  assert.equal(chooseArmor(bot, {autoArmorThreshold: 0}, 'head', 5, 'helmet'), null)
  slots[5] = {name: 'elytra'}
  assert.equal(chooseArmor(bot, {}, 'head', 5, 'helmet'), null)
})
test('auto armor equips through inventory queue and rechecks settings', async () => {
  const bot = new EventEmitter(), inventory = new EventEmitter(), slots = []
  slots[9] = {slot: 9, name: 'iron_helmet', maxDurability: 100}
  Object.assign(inventory, {slots, items: () => slots.filter(Boolean)})
  let equipped = 0, run
  Object.assign(bot, {inventory, equip: async () => { equipped++ }})
  const account = {id: 'a', autoArmor: true}, session = {bot, account, ready: true}
  const manager = {sessions: new Map([['a', session]]), emit() {}, withInventoryAction(id, fn) { return new Promise(resolve => {run = async () => {await fn(); resolve()} }) }}
  installSafety(manager, account, session, {})
  inventory.emit('updateSlot'); account.autoArmor = false; await run(); await new Promise(resolve => setImmediate(resolve)); assert.equal(equipped, 0)
  account.autoArmor = true; inventory.emit('updateSlot'); await run(); await new Promise(resolve => setImmediate(resolve)); assert.equal(equipped, 1)
  clearInterval(session.safetyTimer)
})
