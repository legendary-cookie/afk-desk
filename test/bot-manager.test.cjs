const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager, normalizeLoginCode } = require('../electron/bot-manager.cjs')

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Player'
    this.entity = null
    this.controls = []
    this.messages = []
  }
  chat(message) { this.messages.push(message) }
  setControlState(control, value) { this.controls.push([control, value]) }
  look() { return Promise.resolve() }
  quit() { this.emit('end', 'quit') }
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
