const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, normalizeSkinUrl, buildTelemetry, describeNetworkError, reconnectDelaySeconds, inspectFluidCurrent, recordFluidCorrection, installMovementPacketCompatibility, installModernPlayerInputCompatibility } = require('../electron/bot-manager.cjs')
const { computeSignedChatChecksum } = require('../electron/protocol-fixes.cjs')
const { snapshotNearbyEntities } = require('../electron/movement-compatibility.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.uuid = '123456781234123412341234567890ab'
    this.players = {}
    this.health = 20
    this.food = 18
    this.game = { dimension: 'overworld' }
    this.inventory = new EventEmitter()
    this.inventory.items = () => []
    this.inventory.slots = []
    this.entity = null
    this.controls = []
    this.messages = []
    this.writes = []
    this.settings = { locale: 'en_us' }
    this.quickBarSlot = 0
    this._client = new EventEmitter()
    this._client.write = (name, payload) => this.writes.push([name, payload])
  }
  chat(message) { this.messages.push(message) }
  setSettings(settings) { this.writes.push(['settings', settings]) }
  setControlState(control, value) { this.controls.push([control, value]) }
  look() { return Promise.resolve() }
  tossStack(item) { this.tossed = item; return Promise.resolve() }
  clickWindow(slot, mouseButton, mode) { this.clickedWindow = [slot, mouseButton, mode]; return Promise.resolve() }
  moveSlotItem(sourceSlot, destinationSlot) { this.movedSlot = [sourceSlot, destinationSlot]; return Promise.resolve() }
  equip(item, destination) { this.equippedItem = [item, destination]; if (destination === 'hand') this.quickBarSlot = item.slot >= 36 && item.slot <= 44 ? item.slot - 36 : 2; return Promise.resolve() }
  setQuickBarSlot(slot) { this.quickBarSlot = slot }
  closeWindow(window) { this.closedWindow = window; this.currentWindow = null; this.emit('windowClose', window) }
  end(reason) { this.emit('end', reason) }
  quit() { this.emit('end', 'quit') }
  supportFeature(name) { return name === 'seperateSignedChatCommandPacket' }
}

test('normalizes Microsoft device codes', () => {
  assert.deepEqual(normalizeLoginCode({
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://microsoft.com/link',
    expires_in: 900
  }), {
    code: 'ABCD-EFGH',
    verificationUri: 'https://microsoft.com/link',
    expiresIn: 900
  })
})

test('connects, emits status, sends chat, and disconnects', () => {
  const events = []
  const bot = new FakeBot()
  let options
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: (...event) => events.push(event),
    createBot: (input) => { options = input; return bot }
  })
  const account = { id: 'one', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false }

  manager.connect(account)
  assert.equal(options.auth, 'microsoft')
  options.onMsaCode({ user_code: 'CODE', verification_uri: 'https://microsoft.com/link' })
  assert.equal(events.at(-1)[0], 'login-code')

  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  manager.sendChat('one', 'hello')
  assert.deepEqual(bot.messages, ['hello'])
  assert.equal(events.some(([type, id, payload]) => type === 'status' && id === 'one' && payload.status === 'online'), true)

  manager.disconnect('one')
  assert.equal(events.at(-1)[2].status, 'offline')
})

test('sends separate join and server-change messages', async (t) => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({
    id: 'messages', username: 'user@example.com', host: 'localhost', port: 25565,
    antiAfk: false, autoReconnect: false, joinMessage: 'joined', serverChangeMessage: '/server survival', messageDelay: 0
  })
  t.after(() => manager.disconnect('messages'))
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  bot.emit('health')
  await new Promise((resolve) => setTimeout(resolve, 5))
  bot.emit('respawn')
  bot.emit('health')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(bot.messages, ['joined', '/server survival'])
  assert.deepEqual(bot.writes, [])
})

test('auto version reuses the last successful protocol and reports the resolved version', () => {
  const events = []
  const bot = new FakeBot()
  bot.version = '1.21.1'
  let options
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: (...event) => events.push(event),
    createBot: (input) => { options = input; return bot }
  })
  manager.connect({
    id: 'auto-version', username: 'user@example.com', host: 'localhost', port: 25565,
    version: '', lastSuccessfulVersion: '1.21.1', antiAfk: false, autoReconnect: false
  })
  assert.equal(options.version, '1.21.1')
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  assert.deepEqual(events.find(([type]) => type === 'version'), ['version', 'auto-version', { version: '1.21.1', automatic: true, stable: false }])
  manager.disconnect('auto-version')
})

test('an auto-detected version is confirmed only after a stable minute online', () => {
  const events = []
  const bot = new FakeBot()
  bot.version = '1.21.1'
  let stableCallback
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: (...event) => events.push(event),
    createBot: () => bot,
    scheduleNetworkTimer: (callback, delay) => {
      if (delay === 60_000) stableCallback = callback
      return `network-${delay}`
    },
    clearNetworkTimer: () => {}
  })
  manager.connect({ id: 'stable-version', username: 'user@example.com', host: 'localhost', version: '', antiAfk: false, autoReconnect: false })
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  assert.equal(events.filter(([type]) => type === 'version').length, 1)
  stableCallback()
  assert.deepEqual(events.filter(([type]) => type === 'version').at(-1), ['version', 'stable-version', { version: '1.21.1', automatic: true, stable: true }])
  manager.disconnect('stable-version')
})

test('a remembered auto version falls back to fresh detection if it fails before the world loads', () => {
  const bots = [new FakeBot(), new FakeBot()]
  const versions = []
  let scheduled
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: () => {},
    createBot: (input) => { versions.push(input.version); return bots[versions.length - 1] },
    scheduleReconnectTimer: (callback) => { scheduled = callback; return 'retry' }
  })
  manager.connect({
    id: 'stale-version', username: 'user@example.com', host: 'localhost', port: 25565,
    version: '', lastSuccessfulVersion: '1.21.1', antiAfk: false, autoReconnect: true
  })
  bots[0].emit('end', 'unsupported protocol')
  scheduled()
  assert.deepEqual(versions, ['1.21.1', false])
  manager.disconnect('stale-version')
})

test('nearby entity diagnostics are bounded and contain no account credentials', () => {
  const self = { id: 1, position: new Vec3(0, 64, 0) }
  const bot = {
    entity: self,
    entities: {
      1: self,
      2: { id: 2, type: 'mob', name: 'zombie', position: new Vec3(1, 64, 0), velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.95 },
      3: { id: 3, type: 'player', username: 'NearbyPlayer', position: new Vec3(2, 64, 0), velocity: new Vec3(0.1, 0, 0), width: 0.6, height: 1.8 },
      4: { id: 4, type: 'mob', name: 'far-away', position: new Vec3(20, 64, 0) }
    }
  }

  const result = snapshotNearbyEntities(bot, self.position)
  assert.deepEqual(result.map((entity) => entity.name), ['zombie', 'NearbyPlayer'])
  assert.equal(result[0].distance, 1)
  assert.equal(JSON.stringify(result).includes('accessToken'), false)
})

test('does not resend the same automatic server switch after its resulting respawn', async (t) => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({
    id: 'one-switch', username: 'user@example.com', host: 'localhost', port: 25565,
    antiAfk: false, autoReconnect: false, joinMessage: '/server towny', serverChangeMessage: '/server towny', messageDelay: 0
  })
  t.after(() => manager.disconnect('one-switch'))
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  bot.emit('health')
  await new Promise((resolve) => setTimeout(resolve, 5))
  bot.emit('respawn')
  bot.emit('health')
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.deepEqual(bot.messages, ['/server towny'])
  assert.deepEqual(bot.writes, [])
})

test('automatic server switches wait until the world reports ready', async (t) => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({
    id: 'wait-for-world', username: 'user@example.com', host: 'localhost', port: 25565,
    antiAfk: false, autoReconnect: false, joinMessage: '/server towny', messageDelay: 0
  })
  t.after(() => manager.disconnect('wait-for-world'))
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(bot.writes, [])

  bot.emit('health')
  await new Promise((resolve) => setTimeout(resolve, 550))
  assert.deepEqual(bot.messages, ['/server towny'])
  assert.deepEqual(bot.writes, [])
})

test('live chat marks a session online and a late login event cannot downgrade it', () => {
  const events = []
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'ordering', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('messagestr', 'Welcome')
  bot.emit('login')
  const statuses = events.filter(([type]) => type === 'status').map(([, , payload]) => payload.status)
  assert.equal(statuses.at(-1), 'online')
  manager.sendChat('ordering', 'works')
  manager.control('ordering', 'jump', 100)
  assert.deepEqual(bot.messages, ['works'])
  assert.deepEqual(bot.controls[0], ['jump', true])
  manager.disconnect('ordering')
})

test('uses the protocol chat path so modern proxy commands include required session fields', () => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'proxy', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })
  bot.entity = { yaw: 0, pitch: 0 }
  manager.sendChat('proxy', '/server towny')
  assert.deepEqual(bot.writes, [])
  assert.deepEqual(bot.messages, ['/server towny'])
  manager.sendChat('proxy', '/home')
  assert.deepEqual(bot.messages, ['/server towny', '/home'])
  manager.disconnect('proxy')
})

test('converts 1.21.11 checksums to signed i8 and formats component kick reasons', () => {
  assert.equal(computeSignedChatChecksum([{ signature: Buffer.from([255, 255]) }]), -64)
  assert.equal(extractText({ type: 'compound', value: { color: { type: 'string', value: 'red' }, text: { type: 'string', value: 'An internal error occurred.' } } }), 'An internal error occurred.')
})

test('converts Minecraft chat formatting into safe styled text segments', () => {
  assert.deepEqual(parseMinecraftFormatting('§aGreen §lBold§r plain §#123456Hex'), [
    { text: 'Green ', color: '#55ff55' },
    { text: 'Bold', color: '#55ff55', bold: true },
    { text: ' plain ' },
    { text: 'Hex', color: '#123456' }
  ])
  assert.equal(normalizeSkinUrl('https://textures.minecraft.net/texture/abcdef123'), 'https://textures.minecraft.net/texture/abcdef123')
  assert.equal(normalizeSkinUrl('http://textures.minecraft.net/texture/abcdef123'), 'https://textures.minecraft.net/texture/abcdef123')
  assert.equal(normalizeSkinUrl('https://example.com/texture/abcdef123'), '')
})

test('emits the authenticated Minecraft identity and official skin texture', () => {
  const events = []
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'skin', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })
  bot.player = {
    username: 'Player',
    uuid: bot.uuid,
    skinData: { url: 'https://textures.minecraft.net/texture/abcdef123' }
  }
  bot.emit('playerUpdated', bot.player)
  assert.deepEqual(events.find(([type]) => type === 'identity'), ['identity', 'skin', {
    username: 'Player',
    uuid: bot.uuid,
    skinUrl: 'https://textures.minecraft.net/texture/abcdef123'
  }])
  manager.disconnect('skin')
})

test('builds a bounded player health, position, and inventory snapshot', () => {
  const bot = new FakeBot()
  bot.health = 17.5
  bot.entity = { position: { x: 12.34, y: 64, z: -8.76 } }
  bot.inventory.items = () => [{ slot: 36, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1, nbt: { secret: true } }]
  const snapshot = buildTelemetry(bot)
  assert.equal(typeof snapshot.at, 'number')
  delete snapshot.at
  assert.deepEqual(snapshot, {
    health: 17.5,
    food: 18,
    position: { x: 12.3, y: 64, z: -8.8 },
    dimension: 'overworld',
    nearestChest: null,
    inventory: [{ slot: 36, slotType: 'inventory', name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 }],
    selectedHotbarSlot: 0
  })
})

test('includes armor slots and remaining durability for equipment and inventory tools', () => {
  const bot = new FakeBot()
  const helmet = { slot: 5, name: 'diamond_helmet', displayName: 'Diamond Helmet', count: 1, maxDurability: 363, durabilityUsed: 13 }
  const sword = { slot: 36, name: 'diamond_sword', displayName: 'Diamond Sword', customName: 'Town Blade', customLore: ['Bound to town'], enchants: [{ name: 'sharpness', lvl: 5 }], count: 1, maxDurability: 1561, durabilityUsed: 61 }
  bot.inventory.slots[5] = helmet
  bot.inventory.slots[36] = sword
  bot.inventory.items = () => [sword]

  const snapshot = buildTelemetry(bot)

  assert.deepEqual(snapshot.inventory, [
    { slot: 5, slotType: 'helmet', name: 'diamond_helmet', displayName: 'Diamond Helmet', count: 1, durability: { remaining: 350, maximum: 363, percent: 96 } },
    { slot: 36, slotType: 'inventory', name: 'diamond_sword', displayName: 'Diamond Sword', count: 1, durability: { remaining: 1500, maximum: 1561, percent: 96 }, customName: 'Town Blade', lore: ['Bound to town'], enchants: [{ name: 'sharpness', level: 5 }] }
  ])
})

test('drops only the inventory stack selected by slot', async () => {
  const events = []
  const bot = new FakeBot()
  const selected = { slot: 37, type: 264, metadata: 0, name: 'diamond', displayName: 'Diamond', count: 3 }
  bot.inventory.items = () => [selected]
  bot.inventory.slots[37] = selected
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'drop', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  await manager.dropStack('drop', 37)

  assert.equal(bot.tossed, selected)
  assert.match(events.find(([type]) => type === 'log')?.[2].message, /Dropped 3 × Diamond/)
  await assert.rejects(manager.dropStack('drop', 38), /no longer available/i)
  manager.disconnect('drop')
})

test('locked inventory stacks cannot be dropped', async () => {
  const bot = new FakeBot()
  const selected = { slot: 37, type: 264, metadata: 0, name: 'diamond', displayName: 'Diamond', count: 3 }
  bot.inventory.items = () => [selected]
  bot.inventory.slots[37] = selected
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'locked-drop', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, lockedInventorySlots: [37] })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  await assert.rejects(manager.dropStack('locked-drop', 37), /locked/i)
  assert.equal(bot.tossed, undefined)
  manager.disconnect('locked-drop')
})

test('moves or swaps player inventory slots and blocks changes while a server window is open', async () => {
  const bot = new FakeBot()
  const item = { slot: 9, type: 1, name: 'stone', displayName: 'Stone', count: 1 }
  bot.inventory.slots[9] = item
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'move', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  await manager.moveInventorySlot('move', 9, 36)
  assert.deepEqual(bot.movedSlot, [9, 36])
  await assert.rejects(manager.moveInventorySlot('move', 9, 9), /different destination/i)
  bot.currentWindow = { id: 2 }
  await assert.rejects(manager.moveInventorySlot('move', 9, 37), /close the server menu/i)
  manager.disconnect('move')
})

test('equips selected gear and can hold an inventory or hotbar item', async () => {
  const bot = new FakeBot()
  const helmet = { slot: 9, type: 310, name: 'diamond_helmet', displayName: 'Diamond Helmet', count: 1 }
  const sword = { slot: 40, type: 276, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 }
  bot.inventory.slots[9] = helmet
  bot.inventory.slots[40] = sword
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'equip', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }

  assert.deepEqual(await manager.equipInventoryItem('equip', 9, 'auto'), { sourceSlot: 9, targetSlot: 5, destination: 'head' })
  assert.deepEqual(bot.equippedItem, [helmet, 'head'])
  assert.deepEqual(await manager.equipInventoryItem('equip', 40, 'hand'), { sourceSlot: 40, targetSlot: 40, destination: 'hand' })
  assert.equal(bot.quickBarSlot, 4)
  await assert.rejects(manager.equipInventoryItem('equip', 9, 'invalid'), /equipment destination/i)
  manager.disconnect('equip')
})

test('finds the closest chest and deposits all inventory stacks only when enabled', async () => {
  const events = []
  const bot = new FakeBot()
  const items = [
    { slot: 36, type: 4, metadata: 0, nbt: null, name: 'cobblestone', displayName: 'Cobblestone', count: 64 },
    { slot: 37, type: 264, metadata: 0, nbt: null, name: 'diamond', displayName: 'Diamond', count: 2 }
  ]
  bot.inventory.items = () => items
  bot.entity = { position: { x: 10, y: 64, z: 10 } }
  bot.findBlock = ({ matching, maxDistance }) => {
    assert.equal(maxDistance, 5)
    const block = { name: 'chest', position: { x: 11, y: 64, z: 10 } }
    return matching(block) ? block : null
  }
  const deposits = []
  let closed = false
  bot.openChest = async () => ({
    deposit: async (...args) => deposits.push(args),
    close: () => { closed = true }
  })
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'chest', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, autoDepositToChest: false })

  await manager.refreshChest('chest')
  assert.deepEqual(deposits, [])
  assert.deepEqual(events.filter(([type]) => type === 'telemetry').at(-1)[2].nearestChest, { type: 'chest', x: 11, y: 64, z: 10, distance: 1 })

  await manager.setAutoDeposit('chest', true)
  assert.deepEqual(deposits, [[4, 0, 64, null], [264, 0, 2, null]])
  assert.equal(closed, true)
  assert.match(events.filter(([type]) => type === 'log').at(-1)[2].message, /Deposited 66 items into chest at 11, 64, 10/)
  manager.disconnect('chest')
})

test('auto-deposit supports barrels and leaves locked stacks in inventory', async (t) => {
  const events = []
  const bot = new FakeBot()
  const locked = { slot: 36, type: 276, metadata: 0, nbt: null, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 }
  const unlocked = { slot: 37, type: 4, metadata: 0, nbt: null, name: 'cobblestone', displayName: 'Cobblestone', count: 12 }
  bot.inventory.items = () => [locked, unlocked]
  bot.entity = { position: { x: 10, y: 64, z: 10 } }
  bot.findBlock = ({ matching }) => {
    const block = { name: 'barrel', position: { x: 10, y: 64, z: 11 } }
    return matching(block) ? block : null
  }
  const deposits = []
  bot.openContainer = async () => {
    const container = {
      inventoryStart: 27,
      slots: [],
      deposit: async (...args) => deposits.push(args),
      close: () => bot.emit('windowClose', container)
    }
    bot.emit('windowOpen', container)
    return container
  }
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  t.after(() => manager.disconnect('barrel'))
  manager.connect({
    id: 'barrel', username: 'user@example.com', host: 'localhost', antiAfk: false,
    autoReconnect: false, autoDepositToChest: true, lockedInventorySlots: [36]
  })
  await manager.refreshChest('barrel')

  assert.deepEqual(deposits, [[4, 0, 12, null]])
  assert.equal(events.filter(([type]) => type === 'telemetry').at(-1)[2].nearestChest.type, 'barrel')
  assert.match(events.filter(([type]) => type === 'log').at(-1)[2].message, /Deposited 12 items into barrel/i)
  assert.equal(events.some(([type]) => type === 'window'), false)
})

test('emits server container menus and supports safe left-click interaction', async () => {
  const events = []
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'menu', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.emit('spawn')
  const menu = {
    id: 4,
    title: 'Town Menu',
    inventoryStart: 9,
    slots: [{ slot: 0, name: 'emerald', displayName: 'Join Town', count: 1 }, null]
  }
  bot.currentWindow = menu

  bot.emit('windowOpen', menu)
  assert.deepEqual(events.filter(([type]) => type === 'window').at(-1)[2], {
    open: true,
    title: 'Town Menu',
    size: 9,
    slots: [{ slot: 0, name: 'emerald', displayName: 'Join Town', count: 1 }]
  })

  await manager.clickWindowSlot('menu', 0)
  assert.deepEqual(bot.clickedWindow, [0, 0, 0])
  await assert.rejects(manager.clickWindowSlot('menu', 'not-a-slot'), /invalid server-menu slot/i)
  await assert.rejects(manager.clickWindowSlot('menu', 9), /only server-menu slots/i)
  manager.closeWindow('menu')
  assert.equal(bot.closedWindow, menu)
  assert.deepEqual(events.filter(([type]) => type === 'window').at(-1)[2], { open: false })
  manager.disconnect('menu')
})

test('resends client settings after Velocity enters configuration', async () => {
  const events = []
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'velocity', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })

  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  bot.emit('health')
  bot._client.on('start_configuration', () => bot._client.write('configuration_acknowledged', {}))
  bot._client.emit('start_configuration')
  await new Promise((resolve) => queueMicrotask(resolve))

  assert.deepEqual(bot.writes.map(([name]) => name), ['configuration_acknowledged', 'settings'])
  assert.equal(events.at(-1)[2].detail, 'Switching servers…')
  bot._client.emit('finish_configuration')
  assert.equal(events.filter(([type]) => type === 'status').at(-1)[2].detail, 'Joining world…')
  bot.emit('login')
  assert.equal(events.filter(([type]) => type === 'status').at(-1)[2].status, 'online')
  bot.emit('messagestr', 'Towny is ready')
  assert.equal(events.filter(([type]) => type === 'status').at(-1)[2].status, 'online')
  manager.disconnect('velocity')
})

test('automatically reconnects after a kick and manual disconnect cancels retries', () => {
  const events = []
  const bots = [new FakeBot(), new FakeBot()]
  let created = 0
  let scheduled
  const cleared = []
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: (...event) => events.push(event),
    createBot: () => bots[created++],
    scheduleReconnectTimer: (callback, delay) => { scheduled = { callback, delay }; return 'retry-timer' },
    clearReconnectTimer: (timer) => cleared.push(timer)
  })
  const account = {
    id: 'retry', username: 'user@example.com', host: 'localhost', port: 25565,
    antiAfk: false, autoReconnect: true, autoReconnectDelay: 5, autoReconnectMaxAttempts: 3
  }

  manager.connect(account)
  bots[0].emit('kicked', 'Temporary failure')
  bots[0].emit('end', 'socketClosed')
  assert.equal(scheduled.delay, 5000)
  assert.equal(events.at(-1)[2].status, 'reconnecting')

  scheduled.callback()
  assert.equal(created, 2)
  assert.equal(events.at(-1)[2].detail, 'Reconnect attempt 1…')
  manager.disconnect('retry')
  assert.equal(events.at(-1)[2].status, 'offline')
  assert.deepEqual(cleared, [])
})

test('only resets reconnect backoff after a stable minute online', () => {
  const bot = new FakeBot()
  const networkTimers = []
  let reconnectTimer
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleNetworkTimer: (callback, delay) => { networkTimers.push({ callback, delay }); return `network-${networkTimers.length}` },
    clearNetworkTimer: () => {},
    scheduleReconnectTimer: (callback, delay) => { reconnectTimer = { callback, delay }; return 'reconnect' }
  })
  const account = { id: 'stable', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: true, autoReconnectDelay: 5 }
  manager.reconnects.set(account.id, { attempts: 1, timer: null, manual: false, account })
  manager.connect(account, { reconnecting: true })
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  bot.emit('kicked', 'Backend switch failed')
  bot.emit('end', 'socketClosed')

  assert.equal(networkTimers.some(({ delay }) => delay === 60_000), true)
  assert.equal(reconnectTimer.delay, 10_000)
})

test('rate-limit reconnects wait at least thirty seconds', () => {
  assert.equal(reconnectDelaySeconds({ autoReconnectDelay: 5 }, 'You are logging in too fast, try again later.', 1), 30)
  assert.equal(reconnectDelaySeconds({ autoReconnectDelay: 5 }, 'socketClosed', 2), 10)
})

test('classifies common network failures with useful retry details', () => {
  assert.deepEqual(describeNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND play.invalid'), { code: 'ENOTFOUND' })), {
    code: 'ENOTFOUND',
    message: 'Could not resolve the server address. Check DNS and the server name.',
    retryable: true
  })
  assert.deepEqual(describeNetworkError(new Error('client timed out after 45000 milliseconds')), {
    code: 'ETIMEDOUT',
    message: 'The server stopped responding before the connection completed.',
    retryable: true
  })
})

test('ends a stuck network session so auto-reconnect can recover it', () => {
  const events = []
  const bot = new FakeBot()
  const networkTimers = []
  let reconnectTimer
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: (...event) => events.push(event),
    createBot: () => bot,
    scheduleNetworkTimer: (callback, delay) => { networkTimers.push({ callback, delay }); return `network-${networkTimers.length}` },
    clearNetworkTimer: () => {},
    scheduleReconnectTimer: (callback, delay) => { reconnectTimer = { callback, delay }; return 'reconnect' }
  })
  manager.connect({ id: 'network', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: true, autoReconnectDelay: 5 })
  const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  bot.emit('error', error)

  assert.equal(networkTimers[0].delay, 60_000)
  assert.equal(networkTimers[1].delay, 1_000)
  assert.match(events.find(([type]) => type === 'log')?.[2].message, /Connection was reset/)
  networkTimers[1].callback()
  assert.equal(reconnectTimer.delay, 5000)
  assert.equal(events.filter(([type]) => type === 'status').at(-1)[2].status, 'reconnecting')
})

test('schedules one randomly selected anti-AFK action within the chosen delay range', () => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot, random: () => 0.5,
    scheduleAntiAfkTimer: (callback, delay) => { timers.push({ callback, delay }); return `afk-${timers.length}` },
    clearAntiAfkTimer: () => {}
  })
  manager.connect({
    id: 'custom-afk', username: 'user@example.com', host: 'localhost', autoReconnect: false,
    antiAfk: true, antiAfkMinDelay: 20, antiAfkMaxDelay: 40, antiAfkActionDuration: 0.5,
    antiAfkJump: true, antiAfkLook: false, antiAfkSneak: true, antiAfkSwing: true, antiAfkWalk: false
  })
  bot.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }
  bot.swingArm = (hand) => { bot.swung = hand }
  bot.emit('spawn')

  assert.equal(timers[0].delay, 30_000)
  timers[0].callback()
  assert.deepEqual(bot.controls.slice(0, 1), [['sneak', true]])
  assert.equal(bot.swung, undefined)
  assert.equal(timers.some(({ delay }) => delay === 500), true)
  assert.equal(timers.filter(({ delay }) => delay === 30_000).length, 2)
  manager.disconnect('custom-afk')
})

test('environmental movement defaults on and can be disabled without breaking manual controls', () => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: (callback, delay) => { timers.push({ callback, delay }); return `physics-${timers.length}` },
    clearAntiAfkTimer: () => {}
  })
  manager.connect({ id: 'physics', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: false })
  bot.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }
  assert.equal(bot.physicsEnabled, false)
  manager.control('physics', 'forward', 350)
  assert.equal(bot.physicsEnabled, true)
  const release = timers.find(({ delay }) => delay === 350)
  assert.ok(release)
  release.callback()
  const restore = timers.find(({ delay }) => delay === 200)
  assert.ok(restore)
  restore.callback()
  assert.equal(bot.physicsEnabled, false)
  manager.disconnect('physics')
})

test('manual movement stays active until release and repeated presses cannot release a newer hold', (t) => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearAntiAfkTimer: (timer) => { timer.cleared = true }
  })
  manager.connect({ id: 'held-controls', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false })
  t.after(() => manager.disconnect('held-controls'))
  bot.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }

  manager.setControlState('held-controls', 'forward', true)
  assert.deepEqual(bot.controls.at(-1), ['forward', true])
  assert.equal(timers.length, 0)

  manager.control('held-controls', 'forward', 350)
  const oldRelease = timers.at(-1)
  manager.setControlState('held-controls', 'forward', true)
  assert.equal(oldRelease.cleared, true)
  oldRelease.callback()
  assert.notDeepEqual(bot.controls.at(-1), ['forward', false])

  manager.setControlState('held-controls', 'forward', false)
  assert.deepEqual(bot.controls.at(-1), ['forward', false])
})

test('environment diagnostics do not add a second movement simulation after Mineflayer physics', (t) => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'native-physics', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('native-physics'))
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0.0112, 0, 0), height: 1.8 }
  bot.entities = {
    1: bot.entity,
    2: { id: 2, type: 'mob', position: new Vec3(0.8, 64, 0.5), height: 1.8, isValid: true }
  }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const metadata = x === 1 && y === 64 && z === 0 ? 2 : 1
    return { name: 'water', metadata, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }

  bot.emit('physicsTick')

  assert.deepEqual(bot.entity.velocity, new Vec3(0.0112, 0, 0))
})

test('flowing water inspection reports current without changing velocity', () => {
  const bot = new FakeBot()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
    const metadata = key === '1,64,0' ? 2 : 1
    return { name: 'water', metadata, position: new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)), boundingBox: 'empty' }
  }

  assert.equal(inspectFluidCurrent(bot), true)
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))

  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.blockAt = (position) => ({ name: 'stone', metadata: 0, position })
  assert.equal(inspectFluidCurrent(bot), false)
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))
})

test('fluid diagnostics do not report current through a solid wall', () => {
  const bot = new FakeBot()
  const motion = {}
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8 }
  bot.blockAt = (position) => {
    const point = position.floored()
    if (point.equals(new Vec3(0, 64, 0))) return { name: 'water', metadata: 0, position: point, boundingBox: 'empty' }
    if (point.equals(new Vec3(1, 64, 0))) return { name: 'water', metadata: 1, position: point, boundingBox: 'empty' }
    if (point.equals(new Vec3(0, 64, 1))) return { name: 'stone', metadata: 0, position: point, boundingBox: 'block' }
    if (point.equals(new Vec3(0, 63, 1))) return { name: 'water', metadata: 1, position: point, boundingBox: 'empty' }
    return { name: point.y < 64 ? 'stone' : 'air', metadata: 0, position: point, boundingBox: point.y < 64 ? 'block' : 'empty' }
  }

  assert.equal(inspectFluidCurrent(bot, motion), true)
  assert.ok(Math.abs(motion.currentX - 1) < 1e-9)
  assert.ok(Math.abs(motion.currentZ) < 1e-9, `solid wall leaked Z current: ${motion.currentZ}`)
})

test('fluid diagnostics do not report current through a dry wall sign', () => {
  const bot = new FakeBot()
  const motion = {}
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8 }
  bot.blockAt = (position) => {
    const point = position.floored()
    if (point.equals(new Vec3(0, 64, 0))) return { name: 'water', metadata: 0, position: point, boundingBox: 'empty', material: 'default' }
    if (point.equals(new Vec3(1, 64, 0))) return { name: 'water', metadata: 1, position: point, boundingBox: 'empty', material: 'default' }
    if (point.equals(new Vec3(0, 64, 1))) return { name: 'spruce_wall_sign', metadata: 1, position: point, boundingBox: 'empty', material: 'mineable/axe', isWaterlogged: false }
    if (point.equals(new Vec3(0, 63, 1))) return { name: 'water', metadata: 1, position: point, boundingBox: 'empty', material: 'default' }
    return { name: point.y < 64 ? 'stone' : 'air', metadata: 0, position: point, boundingBox: point.y < 64 ? 'block' : 'empty', material: point.y < 64 ? 'mineable/pickaxe' : 'default' }
  }

  assert.equal(inspectFluidCurrent(bot, motion), true)
  assert.ok(Math.abs(motion.currentX - 1) < 1e-9)
  assert.ok(Math.abs(motion.currentZ) < 1e-9, `wall sign leaked Z current: ${motion.currentZ}`)
})

test('flowing water intersecting the player bounding box is detected without changing velocity', () => {
  const bot = new FakeBot()
  bot.entity = { position: new Vec3(0.8, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if ((x !== 1 && x !== 2) || y !== 64 || z !== 0) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    return { name: 'water', metadata: x === 1 ? 1 : 2, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }

  assert.equal(inspectFluidCurrent(bot), true)
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))
})

test('surface water flicker preserves diagnostics briefly but genuine dry movement resets it', () => {
  const bot = new FakeBot()
  bot.entity = { position: new Vec3(0.8, 64, 0.5), velocity: new Vec3(0, 0, 0), isInWater: true }
  let waterVisible = true
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (!waterVisible || (x !== 1 && x !== 2) || y !== 64 || z !== 0) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    return { name: 'water', metadata: x === 1 ? 1 : 2, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  const motion = { serverCorrections: 12, stalledCorrections: 12 }

  assert.equal(inspectFluidCurrent(bot, motion), true)
  waterVisible = false
  bot.entity.isInWater = false
  assert.equal(inspectFluidCurrent(bot, motion), true)
  assert.equal(motion.stalledCorrections, 12)

  motion.lastFluidAt = Date.now() - 1000
  assert.equal(inspectFluidCurrent(bot, motion), false)
  assert.equal(motion.stalledCorrections, 0)
  assert.equal(motion.status, 'dry')
})

test('repeated water diagnostics never force client coordinates or velocity', () => {
  const bot = new FakeBot()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const metadata = x === 1 && y === 64 && z === 0 ? 2 : 1
    return { name: 'water', metadata, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  const motionState = {}

  for (let tick = 0; tick < 5; tick++) inspectFluidCurrent(bot, motionState)

  assert.deepEqual(bot.entity.position, new Vec3(0.5, 64, 0.5))
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))
})

test('water correction diagnostics distinguish jitter from accepted movement', () => {
  const motion = { stalledCorrections: 0, serverCorrections: 0 }

  recordFluidCorrection(motion, { x: 10, y: 64, z: 20 })
  recordFluidCorrection(motion, { x: 10.04, y: 64.04, z: 20 })

  assert.equal(motion.stalledCorrections, 2)

  recordFluidCorrection(motion, { x: 10.3, y: 64.04, z: 20 })

  assert.equal(motion.stalledCorrections, 1)
})

test('historical water corrections keep environmental movement passive', (t) => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'progressed-water', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('progressed-water'))
  bot.entity = { yaw: 0, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), isInWater: true }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (y !== 64) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    return { name: 'water', metadata: x === 1 && z === 0 ? 2 : 1, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  Object.assign(manager.sessions.get('progressed-water').fluidMotion, { serverCorrections: 40, stalledCorrections: 0 })

  bot.emit('physicsTick')

  assert.deepEqual(bot.controls, [])
})

test('passive environmental water movement never injects player controls', (t) => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: (callback, delay) => { timers.push({ callback, delay }); return `fluid-${timers.length}` },
    clearAntiAfkTimer: () => {}
  })
  manager.connect({ id: 'fluid-assist', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('fluid-assist'))
  bot.entity = { yaw: 0, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (y !== 64) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    const metadata = x === 1 && y === 64 && z === 0 ? 2 : 1
    return { name: 'water', metadata, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  Object.assign(manager.sessions.get('fluid-assist').fluidMotion, { serverCorrections: 3, stalledCorrections: 3 })

  bot.emit('physicsTick')

  assert.deepEqual(bot.controls, [])
  assert.deepEqual(timers, [])
})

test('a single shallow-water correction does not synthesize movement input', (t) => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: (callback, delay) => { timers.push({ callback, delay }); return `blocked-water-${timers.length}` },
    clearAntiAfkTimer: () => {}
  })
  manager.connect({ id: 'blocked-water', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('blocked-water'))
  bot.entity = { yaw: 0, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), isInWater: true, isCollidedHorizontally: true }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (y !== 64) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    return { name: 'water', metadata: x === 1 && z === 0 ? 2 : 1, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  Object.assign(manager.sessions.get('blocked-water').fluidMotion, { serverCorrections: 1, stalledCorrections: 1 })

  bot.emit('physicsTick')

  assert.deepEqual(bot.controls, [])
  assert.deepEqual(timers, [])
})

test('rising head-level water remains passive and input-free', (t) => {
  const bot = new FakeBot()
  const timers = []
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: (callback, delay) => { timers.push({ callback, delay }); return `rising-water-${timers.length}` },
    clearAntiAfkTimer: () => {}
  })
  manager.connect({ id: 'rising-water', username: 'user@example.com', host: 'localhost', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('rising-water'))
  bot.entity = { yaw: 0, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), isInWater: true, isCollidedHorizontally: true }
  let upperLayerWater = false
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    if (y === 65 && !upperLayerWater) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    if (![64, 65].includes(y) || z !== 0 || ![0, 1].includes(x)) return { name: 'stone', metadata: 0, position: new Vec3(x, y, z), boundingBox: 'block' }
    return { name: 'water', metadata: x === 1 ? 2 : 1, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }
  Object.assign(manager.sessions.get('rising-water').fluidMotion, { serverCorrections: 1, stalledCorrections: 1 })

  bot.emit('physicsTick')
  assert.deepEqual(bot.controls, [])

  upperLayerWater = true
  bot.emit('physicsTick')

  assert.deepEqual(bot.controls, [])
  assert.deepEqual(timers, [])
})

test('modern movement packets report the collision state calculated by physics', () => {
  const bot = new FakeBot()
  bot.entity = { isCollidedHorizontally: true }
  installMovementPacketCompatibility(bot)

  bot._client.write('position', {
    x: 1,
    y: 64,
    z: 2,
    flags: { onGround: false, hasHorizontalCollision: undefined }
  })

  assert.deepEqual(bot.writes, [['position', {
    x: 1,
    y: 64,
    z: 2,
    flags: { onGround: false, hasHorizontalCollision: true }
  }]])
})

test('legacy movement packets are left unchanged', () => {
  const bot = new FakeBot()
  bot.entity = { isCollidedHorizontally: true }
  installMovementPacketCompatibility(bot)

  bot._client.write('position', { x: 1, y: 64, z: 2, onGround: false })

  assert.deepEqual(bot.writes, [['position', { x: 1, y: 64, z: 2, onGround: false }]])
})

test('modern prediction servers receive complete initial and changed player input', () => {
  const bot = new FakeBot()
  const diagnostics = []
  bot.supportFeature = (name) => name === 'newPlayerInputPacket'
  bot.__afkDeskPacketDiagnostic = (entry) => diagnostics.push(entry)
  const states = new Map()
  bot.getControlState = (control) => states.get(control) === true
  bot.setControlState = (control, state) => states.set(control, state)
  installMovementPacketCompatibility(bot)
  installModernPlayerInputCompatibility(bot)

  bot.emit('spawn')
  bot.setControlState('forward', true)

  assert.deepEqual(bot.writes, [
    ['player_input', { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } }],
    ['player_input', { inputs: { forward: true, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } }]
  ])
  assert.deepEqual(diagnostics.map((entry) => entry.inputs), bot.writes.map(([, payload]) => payload.inputs))
})

test('installed Mineflayer closes modern client ticks and sends complete input state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mineflayer', 'lib', 'plugins', 'physics.js'), 'utf8')
  assert.match(source, /finally \{\s*if \(supportsClientTickEnd\) bot\._client\.write\('tick_end'/)
  assert.match(source, /backward: controlState\.back/)
  assert.match(source, /sprint: controlState\.sprint/)
})

test('installed Mineflayer samples time more often than a physics tick on Windows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mineflayer', 'lib', 'plugins', 'physics.js'), 'utf8')
  assert.match(source, /const PHYSICS_SCHEDULER_INTERVAL_MS = 10/)
  assert.match(source, /setInterval\(doPhysics, PHYSICS_SCHEDULER_INTERVAL_MS\)/)
})

test('movement corrections emit structured packet diagnostics without account credentials', (t) => {
  const diagnostics = []
  const bot = new FakeBot()
  bot.version = '1.21.1'
  const manager = new BotManager({
    profilesPath: 'profiles',
    emit: () => {},
    diagnose: (entry) => diagnostics.push(entry),
    createBot: () => bot
  })
  manager.connect({ id: 'trace-account', username: 'user@example.com', host: 'private.example', antiAfk: false, autoReconnect: false, environmentalMovement: true })
  t.after(() => manager.disconnect('trace-account'))
  bot.entity = {
    position: new Vec3(10.12, 64, 20.25),
    velocity: new Vec3(0.0112, -0.02, 0.003),
    onGround: false,
    isCollidedHorizontally: true,
    isInWater: true
  }
  bot.emit('spawn')
  bot._client.write('position', { x: 10.12, y: 64, z: 20.25, onGround: false })
  bot._client.emit('position', { x: 10, y: 64, z: 20, flags: 0, teleportId: 7 })
  bot.entity.position = new Vec3(10, 64, 20)
  bot.emit('forcedMove')

  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].event, 'movement_correction')
  assert.equal(diagnostics[0].accountId, 'trace-account')
  assert.equal(diagnostics[0].version, '1.21.1')
  assert.deepEqual(diagnostics[0].clientPosition, { x: 10.12, y: 64, z: 20.25 })
  assert.deepEqual(diagnostics[0].serverPosition, { x: 10, y: 64, z: 20 })
  assert.deepEqual(diagnostics[0].delta, { x: -0.12, y: 0, z: -0.25 })
  assert.deepEqual(diagnostics[0].velocity, { x: 0.0112, y: -0.02, z: 0.003 })
  assert.deepEqual(diagnostics[0].lastSent.position, { x: 10.12, y: 64, z: 20.25 })
  assert.equal(diagnostics[0].recentMovementPackets.length, 1)
  assert.deepEqual(diagnostics[0].recentMovementPackets[0].position, { x: 10.12, y: 64, z: 20.25 })
  assert.equal(JSON.stringify(diagnostics[0]).includes('user@example.com'), false)
  assert.equal(JSON.stringify(diagnostics[0]).includes('private.example'), false)
})

test('flowing-water blocks override a stale dry-player flag', () => {
  const bot = new FakeBot()
  let blockReads = 0
  bot.entity = { isInWater: false, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    blockReads++
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const metadata = x === 1 && y === 64 && z === 0 ? 2 : 1
    return { name: 'water', metadata, position: new Vec3(x, y, z), boundingBox: 'empty' }
  }

  assert.equal(inspectFluidCurrent(bot, {}), true)
  assert.ok(blockReads > 0)
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))
})

test('modern water block-state level is used when metadata is unavailable', () => {
  const bot = new FakeBot()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const level = x === 1 && y === 64 && z === 0 ? '2' : '1'
    return { name: 'water', metadata: undefined, getProperties: () => ({ level }), position: new Vec3(x, y, z), boundingBox: 'empty' }
  }

  assert.equal(inspectFluidCurrent(bot, {}), true)
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0))
})

test('modern water block-state level takes priority over stale legacy metadata', () => {
  const bot = new FakeBot()
  bot.entity = { isInWater: false, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }
  bot.blockAt = (position) => {
    const point = position.floored()
    if (point.x === 0 && point.y === 64 && point.z === 0) {
      return { name: 'water', metadata: 3, getProperties: () => ({ level: '4' }), position: point, boundingBox: 'empty' }
    }
    if (point.x === 1 && point.y === 64 && point.z === 0) {
      return { name: 'water', metadata: 0, getProperties: () => ({ level: '0' }), position: point, boundingBox: 'empty' }
    }
    return { name: 'stone', metadata: 0, position: point, boundingBox: 'block' }
  }
  const motion = {}

  assert.equal(inspectFluidCurrent(bot, motion), true)
  assert.equal(motion.currentX, -1)
  assert.equal(motion.currentZ, 0)
})

test('environment diagnostics expose detected current without synthetic fallback', () => {
  const bot = new FakeBot()
  bot.physicsEnabled = true
  bot.entity = { position: new Vec3(1.25, 64, -2.5) }
  const snapshot = buildTelemetry(bot, null, true, {
    status: 'flowing', waterBlocks: 2, currentX: 1, currentZ: 0, mineflayerInWater: false
  })

  assert.deepEqual(snapshot.environment, {
    enabled: true,
    physicsEnabled: true,
    waterStatus: 'flowing',
    waterBlocks: 2,
    current: { x: 1, z: 0 },
    fallbackActive: false,
    mineflayerInWater: false,
    serverCorrections: 0,
    stalledCorrections: 0
  })
})
