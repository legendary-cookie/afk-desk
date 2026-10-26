'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBotEventAdapter } = require('../electron/macro/bot-events.cjs')
const { MacroEngine } = require('../electron/macro/engine.cjs')
const { TriggerMatcher } = require('../electron/macro/triggers.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')

test('bot event adapter maps real BotManager payloads and deduplicates first spawn by session', () => {
  let sid = 'java-session-1'
  const adapt = createBotEventAdapter({ sessionId: () => sid, now: () => 10 })
  const online = adapt('status', 'a', { status: 'online', detail: 'Online as Steve', at: 1 })
  assert.deepEqual(online.map((e) => e.type), ['connected', 'spawn'])
  assert.equal(online[1].sessionId, sid)
  assert.deepEqual(adapt('spawn', 'a', {}), [])
  assert.equal(adapt('log', 'a', { kind: 'chat', message: '§aHello' })[0].payload.text, 'Hello')
  assert.equal(adapt('log', 'a', { kind: 'sent', message: 'hi' })[0].type, 'sentChat')
  const telemetry = adapt('telemetry', 'a', { health: 5, food: 18, dimension: 'overworld', inventory: [{ slot: 9, name: 'stone', count: 64 }] })[0]
  assert.equal(telemetry.payload.inventorySignature, '9:stone:64')
  assert.equal(telemetry.payload.inventoryFull, false)
  assert.equal(adapt('window', 'a', { title: '§bChest' })[0].payload.title, 'Chest')
  assert.equal(adapt('status', 'a', { status: 'offline', detail: 'Disconnected: kicked' })[0].payload.reason, 'Disconnected: kicked')
  sid = 'java-session-2'
  assert.deepEqual(adapt('status', 'a', { status: 'online' }).map((e) => e.type), ['connected', 'spawn'])
})

test('macro engine run and stop round trip with fake bot manager and forwards RunEvents', async () => {
  const events = [], calls = [], session = { sessionId: 'fake', bot: { entity: {} }, account: { lockedInventorySlots: [] }, inputClaims: new Map() }
  const manager = { sessions: new Map([['a', session]]), sendChat: async (_id, text) => calls.push(text), releaseOwner() {} }
  const facade = { sessionId: () => 'fake', state: () => ({ online: true, sessionId: 'fake', edition: 'java' }), chat: (id, step, ctx) => manager.sendChat(id, step.message, ctx), releaseOwner() {} }
  for (const method of ['notify','move','look','control','leftClick','rightClick','selectHotbar','holdItem','useInventory','useGui','closeGui','waitForWindow','drop','dropAll','deposit','disconnect','reconnect']) facade[method] = async () => {}
  const engine = new MacroEngine({ facade, matcher: new TriggerMatcher({ now: () => Date.now() }), emit: (event) => events.push(event), resolveTargets: () => ['a'], now: Date.now })
  engine.setLibrary([{ id: 'm', name: 'Chat', enabled: true, targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'hello' }], defaultDelayMs: 0, onError: 'continue', concurrency: 'skip' }])
  const result = await engine.run('a', 'm')
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls, ['hello'])
  assert.ok(events.some((event) => event.status === 'started'))
  assert.ok(events.some((event) => event.status === 'completed'))
  await engine.stop('a')
})

test('registered macro IPC enforces payload limits and validation and runs through the fake manager', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-ipc-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const handlers = new Map(), windows = [], sentEvents = []
  const app = new EventEmitter(); Object.assign(app, { whenReady: () => Promise.resolve(), getPath: () => directory, getVersion: () => 'test', getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {}, quit() {}, setPath() {} })
  class BrowserWindow {
    constructor() { this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: { url: '' }, send: (channel, data) => sentEvents.push({ channel, data }), setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }); windows.push(this) }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
  }
  class Manager { constructor(options) { this.emit = options?.emit; this.sessions = new Map(); this.reconnects = new Map(); this.sent = []; if (!Manager.java) Manager.java = this } connect(account) { this.sessions.set(account.id, { sessionId: 'fixture-session', account, bot: { entity: { health: 20, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }, inventory: { items: () => [] }, players: {} } }) } sendChat(_id, text) { this.sent.push(text) } releaseOwner() {} disconnect(id) { this.sessions.delete(id) } setAutoDeposit() {} setEnvironmentalMovement() {} setAntiAfk() {} updateAccountConfig() {} }
  class Multi { constructor({ java, bedrock }) { this.java = java; this.bedrock = bedrock; this.editions = new Map() } manager(id) { return this[this.editions.get(id) || 'java'] } connect(account) { this.editions.set(account.id, account.edition || 'java'); return this.manager(account.id).connect(account) } disconnect(id) { this.manager(id).disconnect(id) } }
  const filename = path.join(__dirname, '../electron/main.cjs'), realRequire = createRequire(filename)
  const electron = { app, BrowserWindow, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showErrorBox() {} }, Notification: { isSupported: () => false }, safeStorage: { isEncryptionAvailable: () => false } }
  const sandbox = { require: (name) => name === 'electron' ? electron : name === './bot-manager.cjs' ? { BotManager: Manager, normalizeSkinUrl: (x) => x } : name === './bedrock-bot-manager.cjs' ? { BedrockBotManager: Manager } : name === './multi-edition-manager.cjs' ? { MultiEditionBotManager: Multi } : realRequire(name), __dirname: path.dirname(filename), process, console, Buffer, URL, setTimeout, clearTimeout }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  await new Promise((resolve) => setImmediate(resolve))
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }
  const invoke = (channel, payload) => handlers.get(channel)(event, payload)
  invoke('accounts:save', { id: 'a', host: 'localhost', username: 'a@example.com', antiAfk: false })
  assert.throws(() => invoke('macros:save', { name: 'x'.repeat(300000) }), /256 KB/)
  assert.throws(() => invoke('macros:save', { id: 'bad', name: 'Bad', targets: { mode: 'all' }, trigger: { type: 'manual' }, steps: [] }), /validation|step/i)
  invoke('macros:save', { id: 'chat', name: 'Chat', targets: { mode: 'all' }, trigger: { type: 'manual' }, defaultDelayMs: 0, steps: [{ type: 'chat', message: 'ipc works' }] })
  invoke('bot:connect', 'a')
  const result = await invoke('macros:run', { accountId: 'a', macroId: 'chat' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(Manager.java.sent, ['ipc works'])
  assert.ok(sentEvents.some((event) => event.channel === 'macro-run' && event.data.status === 'completed'))
  invoke('macros:save', { id: 'wait', name: 'Wait', targets: { mode: 'all' }, trigger: { type: 'manual' }, defaultDelayMs: 0, steps: [{ type: 'wait', ms: 30000 }, { type: 'chat', message: 'must not send' }] })
  const pending = invoke('macros:run', { accountId: 'a', macroId: 'wait' })
  await invoke('macros:stop', { accountId: 'a' })
  assert.equal((await pending).status, 'cancelled')
  assert.deepEqual(Manager.java.sent, ['ipc works'])
  assert.ok(handlers.has('macros:stop'))
})
