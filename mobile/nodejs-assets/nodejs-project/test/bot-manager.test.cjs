const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, shouldAutoDeposit, findNearestChest, parseInteractiveChat, extractText, installConfigurationPacketGuard } = require('../bot-manager.cjs')
const { withResolvers } = require('./compat.cjs')

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

test('mobile auto-deposit modes count unlocked main-inventory slots only', () => {
  const slots = Array(46).fill(null)
  const session = { bot: { inventory: { slots } }, account: { autoDepositMode: 'inventoryFull', autoDepositFullThreshold: 0, lockedInventorySlots: [9] }, joinedAt: 1000 }
  assert.equal(shouldAutoDeposit(session, 1000), false)
  for (let slot = 10; slot <= 44; slot += 1) slots[slot] = { name: 'stone' }
  assert.equal(shouldAutoDeposit(session, 1000), true)
  session.account.autoDepositMode = 'interval'
  session.account.autoDepositInterval = 10
  assert.equal(shouldAutoDeposit(session, 10999), false)
  assert.equal(shouldAutoDeposit(session, 11000), true)
})

test('mobile cancels a pending automatic-message retry when a world change confirms it', async (t) => {
  const bot = new FakeBot()
  bot.chat = message => { bot.sent = [...(bot.sent || []), message] }
  const logs = []
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => logs.push(event), createBot: () => bot })
  manager.connect({ id: 'mobile-message-retry', username: 'fixture', host: 'localhost', antiAfk: false, autoReconnect: false, joinMessage: '/server towny', messageDelay: 0, serverChangeRetryMinutes: 30 })
  t.after(() => manager.disconnect('mobile-message-retry'))
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.emit('spawn')
  await new Promise(resolve => setTimeout(resolve, 5))
  bot.emit('messagestr', 'Unable to connect')
  const session = manager.sessions.get('mobile-message-retry')
  assert.ok(session.serverChangeRetryTimer)
  assert.ok(logs.some(([type, , entry]) => type === 'log' && entry.kind === 'info' && /retrying \/server towny in 15s/.test(entry.message)))
  bot.emit('respawn')
  assert.equal(session.serverChangeRetryTimer, null)
})

test('chat component walkers cap deeply nested and wide server trees', () => {
  let deep = { text: 'tail' }
  for (let i = 0; i < 12000; i++) deep = { extra: [deep] }
  deep.text = 'kept'
  assert.equal(extractText(deep), 'kept')
  assert.equal(parseInteractiveChat(deep).length, 1)
  const wide = { extra: Array.from({ length: 100000 }, (_, index) => ({ text: index === 0 ? 'first' : 'x' })) }
  assert.equal(extractText(wide).startsWith('firstx'), true)
  const parsed = parseInteractiveChat(wide)
  assert.ok(parsed.length <= 256)
})

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

test('turning mobile auto-deposit off during reconnect keeps it off on the next connection', (t) => {
  const bots = []
  let retry
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {},
    createBot: () => { const bot = new FakeBot(); bots.push(bot); return bot },
    scheduleReconnectTimer: (callback) => { retry = callback; return 1 }, clearReconnectTimer: () => {} })
  t.after(() => manager.disconnect('retry-deposit'))
  manager.connect({ id: 'retry-deposit', username: 'fixture', host: 'localhost', antiAfk: false,
    autoReconnect: true, autoDepositToChest: true })
  bots[0].emit('end', 'network loss')
  manager.setAutoDeposit('retry-deposit', false, 5)
  retry()
  assert.equal(manager.sessions.get('retry-deposit').account.autoDepositToChest, false)
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

test('mobile accepts a policy-blocked pack or download failure without loading it', async (t) => {
  const { PACK_POLICY_ERROR } = require('../resource-pack.cjs')
  const run = async (id, loadError) => {
    const bot = new FakeBot()
    const writes = []
    const events = []
    const diagnostics = []
    bot._client.write = (name, payload) => writes.push([name, payload])
    bot.acceptResourcePack = () => { bot.accepted = true }
    const manager = new BotManager({
      profilesPath: 'profiles', emit: (...event) => events.push(event), diagnose: (entry) => diagnostics.push(entry), createBot: () => bot,
      resourcePackLoader: { load: async () => { throw loadError } }
    })
    t.after(() => manager.disconnect(id))
    manager.connect({ id, username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
    bot.emit('resourcePack', '0123456789012345678901234567890123456789', 'http://10.0.0.5/a.zip')
    await new Promise((resolve) => setImmediate(resolve))
    return { accepted: bot.accepted === true, declined: writes.some(([name]) => name === 'resource_pack_receive'), events, diagnostics }
  }
  const policy = Object.assign(new Error('Resource pack host resolves to a private or non-routable address.'), { code: PACK_POLICY_ERROR })
  const blocked = await run('policy', policy)
  assert.equal(blocked.accepted, true)
  assert.equal(blocked.declined, false)
  for (const [id, error, reasonPart] of [
    ['broken', new Error('Resource pack download failed with HTTP 500.'), 'HTTP 500'],
    ['timeout', new Error('Resource pack request timed out.'), 'timed out']
  ]) {
    const failed = await run(id, error)
    assert.equal(failed.accepted, true)
    assert.equal(failed.declined, false)
    assert.equal(failed.diagnostics.some((entry) => entry.event === 'resource_pack_unavailable' && entry.host === '10.0.0.5' && entry.reason.includes(reasonPart)), true)
    assert.match(failed.events.filter(([type]) => type === 'log').at(-1)[2].message, /accepted without custom menu art so the server will not kick/)
  }
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
  const firstStarted = withResolvers()
  const releaseFirst = withResolvers()
  const closed = withResolvers()
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
