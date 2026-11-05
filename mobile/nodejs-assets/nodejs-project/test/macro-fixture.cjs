'use strict'
const { EventEmitter } = require('node:events')
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function clock() {
  let time = 1000, serial = 0
  const jobs = new Map()
  return { now: () => time, timers: {
    setTimeout(fn, ms) { const id = ++serial; jobs.set(id, { fn, at: time + ms }); return id },
    clearTimeout(id) { jobs.delete(id) }
  }, async tick(ms) {
    const end = time + ms
    await flush()
    for (;;) {
      const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      jobs.delete(due[0]); time = due[1].at; due[1].fn(); await flush()
    }
    time = end; await flush()
  }, size: () => jobs.size }
}
const position = (x = 0, y = 64, z = 0) => ({ x, y, z, offset(dx, dy, dz) { return position(x + dx, y + dy, z + dz) } })
function fakeBot() {
  const bot = new EventEmitter(), calls = []
  bot.calls = calls
  bot._client = new EventEmitter()
  bot.username = 'Fake'
  bot.entity = { position: position(), yaw: 1, pitch: 0.1 }
  bot.entities = {}; bot.health = 20; bot.food = 20
  bot.inventory = new EventEmitter()
  bot.inventory.inventoryStart = 9
  bot.inventory.slots = Array(46).fill(null)
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  for (const name of ['chat', 'setControlState', 'look', 'lookAt', 'attack', 'swingArm', 'dig', 'stopDigging', 'activateBlock', 'activateEntity', 'activateItem', 'deactivateItem', 'setQuickBarSlot', 'equip', 'clickWindow', 'transfer', 'tossStack']) {
    bot[name] = (...args) => { calls.push([name, ...args]); return Promise.resolve() }
  }
  bot.closeWindow = window => { calls.push(['closeWindow', window]); bot.currentWindow = null; bot.emit('windowClose') }
  bot.quit = () => { calls.push(['quit']); bot.emit('end', 'quit') }
  return bot
}

module.exports = { clock, fakeBot, flush, position }
