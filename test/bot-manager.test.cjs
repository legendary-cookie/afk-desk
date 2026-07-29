const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, normalizeLoginCode, extractText } = require('../electron/bot-manager.cjs')
const { computeSignedChatChecksum } = require('../electron/protocol-fixes.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.entity = null
    this.controls = []
    this.messages = []
    this.writes = []
    this._client = { write: (name, payload) => this.writes.push([name, payload]) }
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
  const account = { id: 'one', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false }

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
    antiAfk: false, joinMessage: 'joined', serverChangeMessage: '/server survival', messageDelay: 0
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
  manager.connect({ id: 'ordering', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false })
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
  manager.connect({ id: 'proxy', username: 'user@example.com', host: 'localhost', port: 25565, antiAfk: false })
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
