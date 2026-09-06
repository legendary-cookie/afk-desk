const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager } = require('../bot-manager.cjs')

function fixture(t) {
  const bots = []
  const events = []
  const options = []
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...args) => events.push(args), createBot: (config) => {
    options.push(config)
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot.inventory = new EventEmitter()
    bot.inventory.items = () => []
    bot.username = 'Player'
    bot.players = {}
    bot.quit = () => {}
    bot.chat = (message) => { bot.lastChat = message }
    bots.push(bot)
    return bot
  } })
  const account = { id: 'lifecycle', username: 'test@example.com', host: 'localhost', antiAfk: false, autoReconnect: false }
  t.after(() => manager.disconnect(account.id))
  return { manager, bots, events, account, options }
}

test('late end from a disconnected bot cannot remove its replacement', (t) => {
  const { manager, bots, account, events } = fixture(t)
  manager.connect(account)
  manager.disconnect(account.id)
  manager.connect(account)
  bots[1].entity = { position: { x: 0, y: 64, z: 0 } }
  const count = events.length
  bots[0].emit('end', 'late socket close')
  manager.sendChat(account.id, 'still online')
  assert.equal(bots[1].lastChat, 'still online')
  assert.equal(events.slice(count).filter(([kind]) => kind === 'status').length, 0)
})

test('unsafe profile identifiers are rejected before bot creation', (t) => {
  const { manager, bots, account } = fixture(t)
  for (const id of ['../escape', '..\\escape', '/absolute', 'C:\\escape', 'id:stream', 'CON', '', null]) {
    assert.throws(() => manager.connect({ ...account, id }), /Invalid account ID/)
  }
  assert.equal(bots.length, 0)
})

test('short-lived spawns retain backoff until a session stays online for 60 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots, account, events } = fixture(t)
  account.autoReconnect = true
  account.autoReconnectMaxAttempts = 2
  manager.connect(account)
  bots[0].emit('end', 'failed')
  t.mock.timers.tick(5000)
  bots[1].emit('spawn')
  bots[1].emit('end', 'brief spawn')
  assert.match(events.at(-1)[2].detail, /Retrying in 10s/)
  t.mock.timers.tick(10000)
  bots[2].emit('spawn')
  t.mock.timers.tick(60000)
  bots[2].emit('end', 'stable spawn')
  assert.match(events.at(-1)[2].detail, /Retrying in 5s/)
})

test('a stalled connection times out and retries even when quit does not emit end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots, account, events } = fixture(t)
  account.autoReconnect = true
  manager.connect(account)
  t.mock.timers.tick(120000)
  assert.match(events.at(-1)[2].detail, /timed out.*Retrying in 5s/i)
  t.mock.timers.tick(5000)
  assert.equal(bots.length, 2)
})

test('repeated brief spawns respect the reconnect attempt limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots, account, events } = fixture(t)
  account.autoReconnect = true
  account.autoReconnectMaxAttempts = 1
  manager.connect(account)
  bots[0].emit('end', 'failed')
  t.mock.timers.tick(5000)
  bots[1].emit('spawn')
  bots[1].emit('end', 'brief spawn')
  assert.match(events.at(-1)[2].detail, /stopped after 1 attempts/)
  t.mock.timers.tick(300000)
  assert.equal(bots.length, 2)
})

test('device login gets a bounded grace period and spawn cancels the watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots, account, events, options } = fixture(t)
  manager.connect(account)
  options[0].onMsaCode({ user_code: 'TEST' })
  t.mock.timers.tick(120000)
  assert.equal(events.some(([, , payload]) => payload.status === 'offline'), false)
  bots[0].emit('login')
  bots[0].emit('spawn')
  t.mock.timers.tick(15 * 60000)
  assert.equal(events.some(([, , payload]) => payload.status === 'offline'), false)
})

test('retired bots cannot publish messages or complete a resource pack after replacement', async (t) => {
  const { manager, bots, account, events } = fixture(t)
  let complete
  manager.resourcePackLoader = { load: () => new Promise((resolve) => { complete = resolve }) }
  manager.connect(account)
  bots[0].emit('resourcePack', 'https://example.com/pack.zip')
  manager.disconnect(account.id)
  manager.connect(account)
  const count = events.length
  bots[0].emit('messagestr', 'old chat')
  bots[0].emit('login')
  complete({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events.slice(count), [])
})
