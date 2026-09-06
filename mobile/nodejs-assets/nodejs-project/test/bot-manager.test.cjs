const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, findNearestChest, parseInteractiveChat, installConfigurationPacketGuard } = require('../bot-manager.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.inventory = new EventEmitter()
    this.inventory.items = () => []
    this.inventory.slots = []
    this.entity = null
    this.players = {}
    this._client = new EventEmitter()
  }
  quit() { this.emit('end', 'quit') }
  async tossStack(item) { this.tossed = item }
  async clickWindow(...args) { this.clickedWindow = args }
  tabComplete() { return Promise.resolve([{ match: 'server', tooltip: 'Switch server' }]) }
  closeWindow(window) { this.closedWindow = window; this.currentWindow = null; this.emit('windowClose') }
}

test('mobile completes commands and player names and preserves clickable chat actions', async (t) => {
  const bot = new FakeBot()
  bot.players = { StarrySea: { username: 'StarrySea' } }
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  t.after(() => manager.disconnect('chat'))
  manager.connect({ id: 'chat', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  assert.equal((await manager.completeChat('chat', '/ser'))[0].value, '/server')
  assert.equal((await manager.completeChat('chat', 'Sta'))[0].value, 'StarrySea')
  const segments = parseInteractiveChat({ text: '[Spawn]', clickEvent: { action: 'run_command', value: '/spawn' } }, '[Spawn]')
  assert.deepEqual(segments[0].click, { action: 'run_command', value: '/spawn' })
  assert.deepEqual(parseInteractiveChat(null, 'https://example.com').at(-1).click, { action: 'open_url', value: 'https://example.com' })
})

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

test('mobile routes modern proxy commands through protocol chat instead of incomplete raw packets', (t) => {
  const bot = new FakeBot()
  const messages = []
  const writes = []
  bot.chat = (message) => messages.push(message)
  bot._client.write = (...args) => writes.push(args)
  bot.supportFeature = (feature) => feature === 'seperateSignedChatCommandPacket'
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  t.after(() => manager.disconnect('proxy'))
  manager.connect({ id: 'proxy', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  for (const message of ['/server towny', '/hub', '/lobby', '/switch survival', '/home', 'hello']) {
    manager.sendChat('proxy', message)
  }

  assert.deepEqual(messages, ['/server towny', '/hub', '/lobby', '/switch survival', '/home', 'hello'])
  assert.deepEqual(writes, [])
})

test('mobile drops exactly the inventory stack selected by slot', async (t) => {
  const events = []
  const bot = new FakeBot()
  const selected = { slot: 37, type: 264, metadata: 0, name: 'diamond', displayName: 'Dungeon Key', count: 3 }
  bot.inventory.items = () => [selected]
  bot.inventory.slots[37] = selected
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  t.after(() => manager.disconnect('drop'))
  manager.connect({ id: 'drop', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  await manager.dropStack('drop', 37)

  assert.equal(bot.tossed, selected)
  assert.match(events.find(([type]) => type === 'log')?.[2].message, /Dropped 3 × Dungeon Key/)
  await assert.rejects(manager.dropStack('drop', 38), /no longer available/i)
})

test('mobile quiesces gameplay packets during modern server configuration', () => {
  const bot = new FakeBot()
  const writes = []
  bot._client.write = (name, payload) => writes.push([name, payload])
  installConfigurationPacketGuard(bot)

  bot._client.state = 'configuration'
  bot._client.write('tick_end', {})
  bot._client.write('player_input', { inputs: { forward: true } })
  bot._client.write('position', { x: 1, y: 64, z: 2 })
  bot._client.write('settings', { locale: 'en_us' })
  assert.deepEqual(writes, [['settings', { locale: 'en_us' }]])

  bot._client.state = 'play'
  bot._client.write('position', { x: 1, y: 64, z: 2 })
  assert.deepEqual(writes.at(-1), ['position', { x: 1, y: 64, z: 2 }])
})

test('mobile loads resource-pack art and exposes clickable server menus', async (t) => {
  const events = []
  const bot = new FakeBot()
  let accepted = 0
  let loaded
  bot.acceptResourcePack = () => { accepted++ }
  const resourcePack = {
    source: 'https://packs.example/menu.zip',
    sha1: 'abc',
    itemAppearance: (item) => item.name === 'gold_nugget' ? { resourceIcon: 'data:image/png;base64,custom', resourceModel: 'veridian:item/mission' } : {},
    titleAppearance: () => ({ text: '\ue001', glyphs: [{ character: '\ue001', image: 'data:image/png;base64,custom', advance: 16 }] })
  }
  const manager = new BotManager({
    profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot,
    resourcePackLoader: { load: async (...args) => { loaded = args; return resourcePack } }
  })
  t.after(() => manager.disconnect('pack'))
  manager.connect({ id: 'pack', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const menu = { title: '\ue001', inventoryStart: 9, slots: [{ name: 'gold_nugget', displayName: 'Mission', count: 1 }] }
  bot.currentWindow = menu
  bot.emit('windowOpen', menu)
  bot.emit('resourcePack', '0123456789012345678901234567890123456789', 'https://packs.example/menu.zip?token=private')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(loaded, ['https://packs.example/menu.zip?token=private', '0123456789012345678901234567890123456789'])
  assert.equal(accepted, 1)
  const snapshot = events.filter(([type]) => type === 'window').at(-1)[2]
  assert.equal(snapshot.title, 'Custom server menu')
  assert.equal(snapshot.resourceTitle.text, '\ue001')
  assert.equal(snapshot.slots[0].resourceModel, 'veridian:item/mission')
  await manager.clickWindowSlot('pack', 0)
  assert.deepEqual(bot.clickedWindow, [0, 0, 0])
  manager.closeWindow('pack')
  assert.equal(bot.closedWindow, menu)
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
