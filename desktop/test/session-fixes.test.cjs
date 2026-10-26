const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const { MultiEditionBotManager } = require('../electron/multi-edition-manager.cjs')
const { BedrockBotManager } = require('../electron/bedrock-bot-manager.cjs')
const { PersistentEventStore } = require('../electron/beta-core.cjs')
const { AccountStore } = require('../electron/store.cjs')

const FAKE_CODE = 'ZXQ-FAKE-4821'

async function launch(t, accounts = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-session-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify(accounts))
  const handlers = new Map(), windows = [], sent = []
  const app = new EventEmitter()
  Object.assign(app, { whenReady: () => Promise.resolve(), getPath: () => directory, quit: () => {}, getVersion: () => 'test',
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} })
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, { mainFrame: { url: '' }, send: (channel, payload) => sent.push({ channel, payload }), setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } })
      windows.push(this)
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
  }
  const filename = path.join(__dirname, '../electron/main.cjs')
  const realRequire = createRequire(filename)
  const electron = { app, BrowserWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showErrorBox: () => {} }, Notification: { isSupported: () => false } }
  const sandbox = { require: (name) => name === 'electron' ? electron : realRequire(name), __dirname: path.dirname(filename), process, console, Buffer, URL, setTimeout, clearTimeout }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  await new Promise((resolve) => setImmediate(resolve))
  const window = windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const call = (channel, input) => handlers.get(channel)(event, input)
  const readAccounts = () => JSON.parse(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8'))
  return { call, directory, sent, readAccounts, emitBotEvent: sandbox.emitBotEvent }
}

function patchPrototype(t, patches) {
  for (const [name, value] of Object.entries(patches)) {
    const original = MultiEditionBotManager.prototype[name]
    MultiEditionBotManager.prototype[name] = value
    t.after(() => { if (original) MultiEditionBotManager.prototype[name] = original; else delete MultiEditionBotManager.prototype[name] })
  }
}

const account = (extra = {}) => ({ id: 'acct-one', identityId: 'acct-one', edition: 'java', host: 'old.example', username: 'a@b.co', profileName: 'Original', lockedInventorySlots: [1], ...extra })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('D1: inventory move keeps a profile edit made while the server operation was in flight', async (t) => {
  const app = await launch(t, [account()])
  const gate = deferred()
  patchPrototype(t, { moveInventorySlot: () => gate.promise, setItemLocks: () => {} })
  const pending = app.call('bot:inventory-move', { id: 'acct-one', sourceSlot: 1, destinationSlot: 2 })
  await app.call('accounts:save', { id: 'acct-one', host: 'new.example', username: 'a@b.co', profileName: 'Renamed' })
  gate.resolve({ sourceSlot: 1, targetSlot: 2 })
  const result = await pending
  const [stored] = app.readAccounts()
  assert.equal(stored.profileName, 'Renamed')
  assert.equal(stored.host, 'new.example')
  assert.deepEqual(stored.lockedInventorySlots, [2])
  assert.equal(result.account.profileName, 'Renamed')
})

test('D1: equip does not recreate a profile deleted during the operation', async (t) => {
  const app = await launch(t, [account()])
  const gate = deferred()
  patchPrototype(t, { equipInventoryItem: () => gate.promise, setItemLocks: () => assert.fail('locks must not be applied to a deleted profile') })
  const pending = app.call('bot:equip-item', { id: 'acct-one', slot: 1, destination: 'hand' })
  await app.call('accounts:delete', 'acct-one')
  gate.resolve({ sourceSlot: 1, targetSlot: 2 })
  await assert.rejects(pending, /not found/i)
  assert.deepEqual(app.readAccounts(), [])
})

test('D1: store.updateAccount mutates the current record and skips missing ones', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AccountStore(directory)
  store.save({ id: 'a', n: 1 })
  assert.equal(store.updateAccount('missing', (x) => x), null)
  assert.deepEqual(store.updateAccount('a', (x) => ({ ...x, n: 2 })), { id: 'a', n: 2 })
  assert.deepEqual(store.list(), [{ id: 'a', n: 2 }])
})

test('D2: saving an existing profile pushes the new config to the managers', async (t) => {
  const app = await launch(t, [account({ autoReconnect: true })])
  const configs = []
  patchPrototype(t, { updateAccountConfig: (config) => configs.push(config) })
  await app.call('accounts:save', { id: 'acct-one', host: 'moved.example', username: 'a@b.co', autoReconnect: false })
  assert.equal(configs.length, 1)
  assert.equal(configs[0].host, 'moved.example')
  assert.equal(configs[0].autoReconnect, false)
  assert.equal(app.readAccounts()[0].host, 'moved.example')
})

test('D2: multi-edition routes config updates by edition and tolerates managers without support', () => {
  const calls = []
  const java = { updateAccountConfig: (a) => calls.push(['java', a.id]) }
  const bedrock = { updateAccountConfig: (a) => calls.push(['bedrock', a.id]) }
  const bots = new MultiEditionBotManager({ java, bedrock })
  bots.updateAccountConfig({ id: 'x', edition: 'bedrock' })
  bots.updateAccountConfig({ id: 'y', edition: 'java' })
  assert.deepEqual(calls, [['bedrock', 'x'], ['java', 'y']])
  assert.doesNotThrow(() => new MultiEditionBotManager({ java: {}, bedrock: {} }).updateAccountConfig({ id: 'z', edition: 'java' }))
})

class Timers {
  constructor({ leaky = false } = {}) { this.handles = new Map(); this.next = 0; this.leaky = leaky }
  setTimeout(callback, delay) { const id = ++this.next; this.handles.set(id, { callback, delay }); return id }
  clearTimeout(id) { if (!this.leaky) this.handles.delete(id) }
  fire(delay) { for (const [id, timer] of [...this.handles]) if (timer.delay === delay) { this.handles.delete(id); timer.callback() } }
}
function bedrockFixture(options = {}) {
  const clients = [], timers = new Timers(options), events = []
  const manager = new BedrockBotManager({
    profilesPath: path.join(os.tmpdir(), 'afk-bedrock-profiles'),
    emit: (...args) => events.push(args),
    timers,
    createClient: (config) => {
      const client = new EventEmitter()
      Object.assign(client, { config, queued: [], queue: (...args) => client.queued.push(args), close: () => client.emit('close'), username: 'Bot' })
      clients.push(client)
      return client
    }
  })
  return { manager, clients, timers, events }
}
const bedrockAccount = (extra = {}) => ({ id: 'bed-one', identityId: 'bed-one', edition: 'bedrock', host: 'a.example', port: 19132, username: 'a@b.co', label: 'Bot', autoReconnect: true, autoReconnectDelay: 5, ...extra })

test('D2: bedrock retry uses the latest saved config and honours disabled reconnect', () => {
  const { manager, clients, timers } = bedrockFixture()
  manager.connect(bedrockAccount())
  clients[0].emit('close')
  assert.equal(timers.handles.size, 1)
  manager.updateAccountConfig(bedrockAccount({ host: 'b.example' }))
  timers.fire(5000)
  assert.equal(clients.length, 2)
  assert.equal(clients[1].config.host, 'b.example')

  clients[1].emit('close')
  assert.equal(timers.handles.size, 1)
  manager.updateAccountConfig(bedrockAccount({ autoReconnect: false }))
  assert.equal(timers.handles.size, 0)
  assert.equal(manager.reconnects.get('bed-one').timer, null)
  assert.equal(clients.length, 2)
})

test('D2: bedrock config saved while online applies to the next disconnect', () => {
  const { manager, clients, timers } = bedrockFixture()
  manager.connect(bedrockAccount())
  manager.updateAccountConfig(bedrockAccount({ autoReconnect: false }))
  clients[0].emit('close')
  assert.equal(timers.handles.size, 0)
})

test('D3: a join-message timer cannot chat on a replacement session', () => {
  for (const leaky of [false, true]) {
    const { manager, clients, timers } = bedrockFixture({ leaky })
    manager.connect(bedrockAccount({ joinMessage: 'hello', messageDelay: 5 }))
    clients[0].emit('spawn')
    manager.disconnect('bed-one')
    manager.connect(bedrockAccount({ joinMessage: '' }))
    clients[1].emit('spawn')
    timers.fire(5000)
    assert.equal(clients[0].queued.length, 0, `old client (leaky=${leaky})`)
    assert.equal(clients[1].queued.length, 0, `replacement client (leaky=${leaky})`)
  }
})

test('D3: the join message still sends on the live session', () => {
  const { manager, clients, timers } = bedrockFixture()
  manager.connect(bedrockAccount({ joinMessage: 'hello', messageDelay: 5 }))
  clients[0].emit('spawn')
  timers.fire(5000)
  assert.equal(clients[0].queued.length, 1)
})

test('D4: a failing event store cannot break event delivery and warns once per code', async (t) => {
  const app = await launch(t)
  fs.writeFileSync(path.join(app.directory, 'events'), 'not a directory')
  for (let index = 0; index < 3; index++) {
    assert.doesNotThrow(() => app.emitBotEvent('log', 'acct-one', { kind: 'chat', message: `m${index}`, at: index + 1 }))
  }
  const delivered = app.sent.filter((item) => item.payload.type === 'log')
  assert.equal(delivered.length, 3)
  const warnings = app.sent.filter((item) => item.payload.type === 'storage-warning')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].payload.payload.code)
  assert.ok(JSON.stringify(warnings[0]).length < 500)
})

test('D6: login-code events are delivered live but never persisted', async (t) => {
  const app = await launch(t)
  app.emitBotEvent('login-code', 'acct-one', { code: FAKE_CODE, verificationUri: 'https://microsoft.com/link', expiresIn: 900 })
  app.emitBotEvent('log', 'acct-one', { kind: 'chat', message: 'after', at: 5 })
  const live = app.sent.find((item) => item.payload.type === 'login-code')
  assert.equal(live.payload.payload.code, FAKE_CODE)
  const eventsDirectory = path.join(app.directory, 'events')
  const persisted = fs.readdirSync(eventsDirectory).map((file) => fs.readFileSync(path.join(eventsDirectory, file), 'utf8')).join('\n')
  assert.ok(persisted.includes('after'))
  assert.ok(!persisted.includes(FAKE_CODE))
  assert.ok(!persisted.includes('login-code'))
})

test('D6: device-code style keys are redacted from any persisted event', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-events-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new PersistentEventStore(directory)
  store.append('p', { type: 'login-code', code: FAKE_CODE })
  store.append('p', { type: 'other', code: FAKE_CODE, user_code: FAKE_CODE, userCode: FAKE_CODE, device_code: FAKE_CODE, deviceCode: FAKE_CODE, nested: { code: FAKE_CODE }, keep: 'visible' })
  const raw = fs.readFileSync(store.fileFor('p'), 'utf8')
  assert.ok(!raw.includes(FAKE_CODE))
  assert.ok(!raw.includes('login-code'))
  assert.ok(raw.includes('visible'))
})
