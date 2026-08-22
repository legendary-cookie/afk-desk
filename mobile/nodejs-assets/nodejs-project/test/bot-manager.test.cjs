const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, findNearestChest } = require('../bot-manager.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.inventory = new EventEmitter()
    this.inventory.items = () => []
    this.entity = null
    this._client = new EventEmitter()
  }
  quit() { this.emit('end', 'quit') }
}

test('mobile auto-deposit search enforces range and line of sight', () => {
  const bot = new FakeBot()
  bot.entity = { position: { x: 10, y: 64, z: 10 } }
  const hidden = { name: 'chest', position: { x: 11, y: 64, z: 10 } }
  const visible = { name: 'barrel', position: { x: 17, y: 64, z: 10 } }
  let expectedRange = 9
  bot.canSeeBlock = (block) => block === visible
  bot.findBlock = ({ matching, maxDistance, useExtraInfo }) => {
    assert.equal(maxDistance, expectedRange)
    assert.equal(matching(hidden), true)
    assert.equal(useExtraInfo(hidden), false)
    assert.equal(useExtraInfo(visible), true)
    return visible
  }

  assert.equal(findNearestChest(bot, 9), visible)
  expectedRange = 16
  assert.equal(findNearestChest(bot, 100), visible)
  expectedRange = 1
  assert.equal(findNearestChest(bot, 0), visible)
})

test('mobile auto-deposit stops queued stacks immediately when toggled off', async (t) => {
  const bot = new FakeBot()
  const firstStarted = Promise.withResolvers()
  const releaseFirst = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const deposits = []
  bot.inventory.items = () => [
    { slot: 36, type: 4, metadata: 0, nbt: null, count: 64 },
    { slot: 37, type: 264, metadata: 0, nbt: null, count: 2 }
  ]
  bot.entity = { position: { x: 10, y: 64, z: 10 } }
  bot.canSeeBlock = () => true
  bot.findBlock = ({ useExtraInfo }) => {
    const block = { name: 'chest', position: { x: 11, y: 64, z: 10 } }
    return useExtraInfo(block) ? block : null
  }
  bot.openChest = async () => ({
    deposit: async (...args) => {
      deposits.push(args)
      if (deposits.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
    },
    close: () => closed.resolve()
  })
  const events = []
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  t.after(() => manager.disconnect('mobile-deposit'))
  manager.connect({ id: 'mobile-deposit', username: 'user@example.com', host: 'localhost', autoReconnect: false, autoDepositToChest: false })

  manager.setAutoDeposit('mobile-deposit', true, 5)
  await firstStarted.promise
  manager.setAutoDeposit('mobile-deposit', false, 5)
  assert.equal(manager.reconnects.get('mobile-deposit').account.autoDepositToChest, false)
  assert.equal(manager.reconnects.get('mobile-deposit').account.autoDepositRange, 5)
  releaseFirst.resolve()
  await closed.promise
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(deposits, [[4, 0, 64, null]])
  assert.equal(events.some(([type, , payload]) => type === 'log' && /Auto-deposit failed/.test(payload.message)), false)
})
