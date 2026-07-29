const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, normalizeSkinUrl } = require('../electron/bot-manager.cjs')
const { computeSignedChatChecksum } = require('../electron/protocol-fixes.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.uuid = '123456781234123412341234567890ab'
    this.players = {}
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
    viewDistance: 10,
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
