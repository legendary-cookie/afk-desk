const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, normalizeSkinUrl, buildTelemetry, describeNetworkError, applyEntityCollisionPush } = require('../electron/bot-manager.cjs')
const { computeSignedChatChecksum } = require('../electron/protocol-fixes.cjs')

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
    this._client = new EventEmitter()
    this._client.write = (name, payload) => this.writes.push([name, payload])
  }
  chat(message) { this.messages.push(message) }
  setControlState(control, value) { this.controls.push([control, value]) }
  look() { return Promise.resolve() }
  tossStack(item) { this.tossed = item; return Promise.resolve() }
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

test('sends separate join and server-change messages', async () => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({
    id: 'messages', username: 'user@example.com', host: 'localhost', port: 25565,
    antiAfk: false, autoReconnect: false, joinMessage: 'joined', serverChangeMessage: '/server survival', messageDelay: 0
  })
  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  await new Promise((resolve) => setTimeout(resolve, 5))
  bot.emit('respawn')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(bot.messages, ['joined'])
  assert.deepEqual(bot.writes, [['chat_command', { command: 'server survival' }]])
  manager.disconnect('messages')
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

test('uses the unsigned command packet for modern proxy-switch commands', () => {
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: () => {}, createBot: () => bot })
  manager.connect({ id: 'proxy', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })
  bot.entity = { yaw: 0, pitch: 0 }
  manager.sendChat('proxy', '/server towny')
  assert.deepEqual(bot.writes, [['chat_command', { command: 'server towny' }]])
  assert.deepEqual(bot.messages, [])
  manager.sendChat('proxy', '/home')
  assert.deepEqual(bot.messages, ['/home'])
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
    inventory: [{ slot: 36, name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 }]
  })
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
  assert.deepEqual(events.filter(([type]) => type === 'telemetry').at(-1)[2].nearestChest, { x: 11, y: 64, z: 10, distance: 1 })

  await manager.setAutoDeposit('chest', true)
  assert.deepEqual(deposits, [[4, 0, 64, null], [264, 0, 2, null]])
  assert.equal(closed, true)
  assert.match(events.filter(([type]) => type === 'log').at(-1)[2].message, /Deposited 66 items into chest at 11, 64, 10/)
  manager.disconnect('chest')
})

test('resends client settings when Velocity switches backend servers', () => {
  const events = []
  const bot = new FakeBot()
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'velocity', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false, autoReconnect: false })

  bot.entity = { yaw: 0, pitch: 0 }
  bot.emit('spawn')
  bot._client.emit('start_configuration')

  assert.deepEqual(bot.writes.at(-1), ['settings', {
    locale: 'en_us',
    viewDistance: 3,
    chatFlags: 0,
    chatColors: true,
    skinParts: 127,
    mainHand: 1,
    enableTextFiltering: false,
    enableServerListing: true,
    particleStatus: 'all'
  }])
  assert.equal(events.at(-1)[2].detail, 'Switching servers…')
  bot._client.emit('finish_configuration')
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
  const restore = timers.find(({ delay }) => delay === 550)
  assert.ok(restore)
  restore.callback()
  assert.equal(bot.physicsEnabled, false)
  manager.disconnect('physics')
})

test('nearby players and mobs apply horizontal collision push', () => {
  const bot = new FakeBot()
  bot.entity = { id: 1, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, height: 1.8 }
  bot.entities = {
    1: bot.entity,
    2: { id: 2, type: 'mob', position: { x: 0.3, y: 64, z: 0 }, height: 1.8, isValid: true }
  }
  assert.equal(applyEntityCollisionPush(bot), 1)
  assert.ok(bot.entity.velocity.x < 0)
  assert.equal(bot.entity.velocity.z, 0)
})
