'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { validateAccount } = require('../core/app-core.cjs')

test('account normalization defaults and bounds deposit and server-message retry settings', () => {
  const base = { id: 'settings', username: 'fixture@example.com', host: 'localhost' }
  const defaults = validateAccount(base, null, null)
  assert.equal(defaults.autoDepositMode, 'immediate')
  assert.equal(defaults.autoDepositInterval, 300)
  assert.equal(defaults.autoDepositFullThreshold, 0)
  assert.equal(defaults.serverChangeRetryMinutes, 30)
  const bounded = validateAccount({ ...base, autoDepositMode: 'broken', autoDepositInterval: 999999, autoDepositFullThreshold: 36, serverChangeRetryMinutes: -5 }, null, null)
  assert.equal(bounded.autoDepositMode, 'immediate')
  assert.equal(bounded.autoDepositInterval, 86400)
  assert.equal(bounded.autoDepositFullThreshold, 35)
  assert.equal(bounded.serverChangeRetryMinutes, 0)
  assert.equal(validateAccount({ ...base, autoDepositInterval: 0 }, null, null).autoDepositInterval, 1)
  assert.equal(validateAccount({ ...base, autoDepositMode: undefined }, { autoDepositMode: 'interval' }, null).autoDepositMode, 'interval')
})

test('anti-AFK chat settings have defaults, bounds and survive partial updates', () => {
  const base = { id: 'settings', username: 'fixture@example.com', host: 'localhost' }
  const defaults = validateAccount(base, null, null)
  assert.equal(defaults.antiAfkChatEnabled, false)
  assert.equal(defaults.antiAfkChatMessage, '')
  assert.equal(defaults.antiAfkChatIntervalSec, 300)
  const saved = validateAccount({ ...base, antiAfkChatEnabled: true, antiAfkChatMessage: 'x'.repeat(300), antiAfkChatIntervalSec: 1 }, null, null)
  assert.equal(saved.antiAfkChatMessage.length, 256)
  assert.equal(saved.antiAfkChatIntervalSec, 10)
  const restored = validateAccount(base, saved, null)
  assert.equal(restored.antiAfkChatEnabled, true)
  assert.equal(restored.antiAfkChatMessage, saved.antiAfkChatMessage)
  assert.equal(validateAccount({ ...base, antiAfkChatIntervalSec: 999999 }, null, null).antiAfkChatIntervalSec, 86400)
})

const ORIGINAL_IPC_CHANNELS = Object.freeze([
  'share:export',
  'share:preview',
  'accounts:bulk-appearance',
  'accounts:list',
  'accounts:save',
  'accounts:delete',
  'accounts:duplicate-profile',
  'accounts:reorder',
  'bot:minimap-snapshot',
  'bot:upcoming-runs',
  'bot:connect',
  'bot:disconnect',
  'bot:chat',
  'bot:complete-chat',
  'bot:control',
  'bot:control-state',
  'bot:look',
  'bot:look-delta',
  'bot:drop-stack',
  'bot:drop-items',
  'bot:deposit-slot',
  'bot:item-lock',
  'bot:inventory-move',
  'bot:equip-item',
  'bot:window-click',
  'bot:window-close',
  'bot:form-respond',
  'bot:world-snapshot',
  'bot:world-action',
  'logs:list',
  'logs:export',
  'updates:check',
  'updates:open',
  'logs:clear',
  'macros:contract',
  'macros:list',
  'macros:save',
  'macros:save-custom',
  'macros:delete-custom',
  'macros:delete',
  'macros:set-enabled',
  'macros:run',
  'macros:stop',
  'macros:runs',
  'macros:import',
  'macros:export',
  'notify:list',
  'notify:save',
  'notify:delete',
  'notify:test',
  'proxy:health',
  'bot:auto-deposit',
  'auth:open-isolated',
  'system:open-external',
  'settings:get',
  'app:version',
  'app:supported-versions',
  'settings:save'
])

test('loading app-core.cjs with Module._load patched to throw on electron succeeds', (t) => {
  const originalLoad = Module._load
  const desktopRoot = path.resolve(__dirname, '..')
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(desktopRoot, 'core')) || key.startsWith(path.join(desktopRoot, 'electron'))) {
      delete require.cache[key]
    }
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') throw new Error('electron is forbidden in AppCore')
    return originalLoad.call(this, request, parent, isMain)
  }
  t.after(() => { Module._load = originalLoad })
  const loaded = require('../core/app-core.cjs')
  assert.equal(typeof loaded.AppCore, 'function')
})

test('main.cjs registers the exact same IPC channel set as the original main.cjs and delegates each in one line to core', async (t) => {
  const filename = path.join(__dirname, '../electron/main.cjs')
  const source = fs.readFileSync(filename, 'utf8')
  const MACRO_IPC = require('../electron/macro/contract.cjs').IPC
  const literalChannels = [...source.matchAll(/handle\('([^']+)'/g)].map((m) => m[1])
  const macroRefChannels = [...source.matchAll(/handle\(MACRO_IPC\.([a-zA-Z0-9_]+)/g)].map((m) => MACRO_IPC[m[1]])
  const onChannels = [...source.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1])
  assert.equal(onChannels.length, 0)
  assert.deepEqual([...literalChannels, ...macroRefChannels].sort(), [...ORIGINAL_IPC_CHANNELS].sort())

  // Also verify runtime registration via ipcMain.handle and one-line delegation into core
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-core-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const registered = []
  const app = new EventEmitter()
  Object.assign(app, {
    whenReady: () => Promise.resolve(),
    getPath: () => directory,
    getVersion: () => '1.0.0-test',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    quit() {},
    setPath() {}
  })
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, {
        mainFrame: { url: '' },
        send() {},
        setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
      })
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
  }
  const realRequire = Module.createRequire(filename)
  const electron = {
    app,
    BrowserWindow,
    ipcMain: {
      handle: (name) => registered.push(name),
      on: (name) => registered.push(name)
    },
    dialog: { showErrorBox() {} },
    Notification: { isSupported: () => false },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} }
  }
  const sandbox = {
    require: (name) => name === 'electron' ? electron : realRequire(name),
    __dirname: path.dirname(filename),
    process,
    console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(source, sandbox, { filename })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(registered.sort(), [...ORIGINAL_IPC_CHANNELS].sort())
})

test('AppCore start and shutdown with fake managers disconnects bots, flushes notifier, and wires commands with redacted audit', async (t) => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-core-lifecycle-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))

  const connected = []
  const disconnected = []
  let flushed = 0
  const sessions = new Map()
  const fakeBots = {
    sessions,
    java: { sessions, reconnects: new Map() },
    bedrock: { sessions: new Map(), reconnects: new Map() },
    connect(account) {
      connected.push(account.id)
      sessions.set(account.id, { sessionId: 'sess-1', account })
      return { id: account.id }
    },
    disconnect(id) {
      disconnected.push(id)
      sessions.delete(id)
    },
    sendChat() {},
    setAutoDeposit() {},
    setEnvironmentalMovement() {},
    setAntiAfk() {},
    updateAccountConfig() {}
  }

  const uiEvents = []
  const core = new AppCore({
    userDataPath,
    secretBox: { available: () => true, encrypt: (s) => `enc:${s}`, decrypt: (s) => String(s).replace(/^enc:/, '') },
    bots: fakeBots,
    notifier: async () => ({
      notify() {},
      flush: async () => { flushed += 1 },
      test: async (id) => ({ ok: true, id })
    }),
    emitToUi: (channel, payload) => uiEvents.push({ channel, payload }),
    now: () => 1700000000000
  })

  await core.start()
  assert.equal(core.started, true)
  assert.ok(core.commands)

  const overview = core.settings.get().overviewLayout
  assert.deepEqual(Object.keys(overview).sort(), ['global', 'globalMode', 'overrideModes', 'overrides', 'version'])
  assert.equal(overview.globalMode, 'auto')
  const customized = { ...overview, globalMode: 'manual', overrides: { 'acc-1': [] }, overrideModes: { 'acc-1': 'auto' } }
  core.settings.save({ ...core.settings.get(), overviewLayout: customized })
  assert.deepEqual(core.settings.get().overviewLayout, customized)

  const saved = core.accounts.save({
    id: 'acc-1',
    host: 'play.example.com',
    username: 'secret.user@example.com',
    profileName: 'Builder',
    antiAfk: false
  })
  assert.equal(saved.id, 'acc-1')
  assert.deepEqual(core.accounts.list().map((a) => a.id), ['acc-1'])

  await core.bots.connect('acc-1')
  assert.deepEqual(connected, ['acc-1'])

  // Execute a command via core.commands and verify redacted audit persistence
  const cmdRes = await core.commands.execute(
    { kind: 'discord', id: 'admin@example.com', scope: 'admin', ip: '127.0.0.1' },
    'status',
    {}
  )
  assert.equal(cmdRes.ok, true)
  const audits = core.audit.recent(10)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].command, 'status')
  assert.equal(JSON.stringify(audits).includes('admin@example.com'), false)
  assert.equal(JSON.stringify(audits).includes('secret.user@example.com'), false)

  await core.shutdown()
  assert.equal(core.started, false)
  assert.deepEqual(disconnected, ['acc-1'])
  assert.equal(flushed, 1)
})

test('AppCore bots.respondForm validates formId and response payloads and delegates to Bedrock manager', (t) => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-core-form-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))

  const formCalls = []
  const core = new AppCore({
    userDataPath,
    secretBox: { available: () => true, encrypt: (s) => s, decrypt: (s) => s },
    managers: {
      java: { sessions: new Map(), reconnects: new Map() },
      bedrock: {
        sessions: new Map(),
        reconnects: new Map(),
        respondForm: (id, formId, response) => { formCalls.push({ id, formId, response }); return { ok: true } }
      }
    }
  })

  assert.deepEqual(core.bots.respondForm({ id: 'acc-1', formId: '42', response: 0 }), { ok: true })
  assert.deepEqual(core.bots.respondForm({ id: 'acc-1', formId: 7, response: null }), { ok: true })
  assert.deepEqual(core.bots.respondForm('acc-1', '99', [null, true, 12.5, 'hello']), { ok: true })
  assert.deepEqual(formCalls, [
    { id: 'acc-1', formId: '42', response: 0 },
    { id: 'acc-1', formId: '7', response: null },
    { id: 'acc-1', formId: '99', response: [null, true, 12.5, 'hello'] }
  ])

  for (const bad of [
    { id: '', formId: '1', response: 0 },
    { id: '../bad', formId: '1', response: 0 },
    { id: 'acc-1', formId: '', response: 0 },
    { id: 'acc-1', formId: '1'.repeat(65), response: 0 },
    { id: 'acc-1', formId: {}, response: 0 },
    { id: 'acc-1', formId: '1', response: -1 },
    { id: 'acc-1', formId: '1', response: 1.5 },
    { id: 'acc-1', formId: '1', response: NaN },
    { id: 'acc-1', formId: '1', response: undefined },
    { id: 'acc-1', formId: '1', response: 'not-an-array-or-int' },
    { id: 'acc-1', formId: '1', response: { nested: true } },
    { id: 'acc-1', formId: '1', response: [{ bad: 1 }] },
    { id: 'acc-1', formId: '1', response: [[1]] },
    { id: 'acc-1', formId: '1', response: new Array(65).fill(0) }
  ]) {
    assert.throws(() => core.bots.respondForm(bad), /Invalid|profile/i, JSON.stringify(bad))
  }
  assert.equal(formCalls.length, 3)
})

test('macro variables survive app restarts and stay separate by account', async (t) => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-variables-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const bots = { sessions: new Map(), disconnect() {} }
  const first = new AppCore({ userDataPath, bots })
  await first.start()
  first.macroEngine.savePersistentVariables('a', { count: 42 })
  first.macroEngine.savePersistentVariables('b', { count: 7 })
  await first.shutdown()
  const second = new AppCore({ userDataPath, bots })
  await second.start()
  assert.deepEqual(second.macroEngine.getPersistentVariables('a'), { count: 42 })
  assert.deepEqual(second.macroEngine.getPersistentVariables('b'), { count: 7 })
  second.macroEngine.savePersistentVariables('a', {})
  assert.deepEqual(second.macroEngine.getPersistentVariables('b'), { count: 7 })
  await second.shutdown()
})

test('account safety settings default off, clamp values and survive partial updates', () => {
  const base = { id: 'safety', username: 'fixture@example.com', host: 'localhost' }
  const defaults = validateAccount(base, null, null)
  assert.equal(defaults.autoEat, false)
  assert.equal(defaults.autoEatThreshold, 14)
  assert.equal(defaults.autoTotem, false)
  assert.equal(defaults.autoEatPriority, 'hotbar')
  assert.equal(defaults.autoEatAllowGoldenApples, false)
  assert.equal(defaults.lowHealthThreshold, 6)
  assert.equal(defaults.lowHealthCooldownMinutes, 10)
  assert.equal(defaults.armorDisconnect, false)
  assert.equal(defaults.armorDisconnectThreshold, 5)
  assert.equal(defaults.totemDisconnect, false)
  assert.equal(defaults.safetyDisconnectNotify, false)
  const protection = validateAccount({ ...base, armorDisconnect: true, armorDisconnectThreshold: 200, totemDisconnect: true, safetyDisconnectNotify: true }, null, null)
  const protectionRestored = validateAccount(base, protection, null)
  assert.equal(protectionRestored.armorDisconnectThreshold, 100)
  assert.equal(protectionRestored.armorDisconnect, true)
  assert.equal(protectionRestored.totemDisconnect, true)
  assert.equal(protectionRestored.safetyDisconnectNotify, true)
  assert.equal(defaults.scheduleEnabled, false)
  const saved = validateAccount({ ...base, autoEat: true, autoEatThreshold: 99, autoTotem: true, autoEatPriority: 'nutrition', autoEatAllowGoldenApples: true, scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '02:00', scheduleDays: [1, 1, 8] }, null, null)
  assert.equal(saved.autoEatThreshold, 20)
  assert.deepEqual(saved.scheduleDays, [1])
  const restored = validateAccount(base, saved, null)
  assert.equal(restored.autoEat, true)
  assert.equal(restored.autoTotem, true)
  assert.equal(restored.autoEatPriority, 'nutrition')
  assert.equal(restored.autoEatAllowGoldenApples, true)
  assert.equal(restored.scheduleStart, '22:00')
})

test('auto armor account settings default, persist and clamp', () => {
  const base = { username: 'user', host: 'localhost' }
  const defaults = validateAccount(base, null, null)
  assert.equal(defaults.autoArmor, false)
  assert.equal(defaults.autoArmorThreshold, 5)
  const saved = validateAccount({ ...base, autoArmor: true, autoArmorThreshold: 150 }, null, null)
  assert.equal(saved.autoArmorThreshold, 100)
  const restored = validateAccount(base, saved, null)
  assert.equal(restored.autoArmor, true)
  assert.equal(restored.autoArmorThreshold, 100)
})

test('consumable settings default off, clamp and survive updates', () => {
  const base = { username: 'user', host: 'localhost' }
  const defaults = validateAccount(base, null, null)
  assert.equal(defaults.autoOminousBottle, false)
  assert.equal(defaults.autoGoldenApple, false)
  const saved = validateAccount({...base, autoOminousBottle: true, autoOminousAmplifier: 9, autoOminousCooldown: -1, autoGoldenApple: true, autoGoldenAppleHealth: 99, autoGoldenApplePreference: 'enchanted'}, null, null)
  assert.equal(defaults.autoOminousOrder, 'highest')
  assert.equal(saved.autoOminousOrder, 'highest')
  assert.equal(validateAccount({...base, autoOminousAmplifier: 3}, null, null).autoOminousOrder, 'lowest')
  assert.equal(validateAccount(base, {autoOminousAmplifier: 4}, null).autoOminousOrder, 'highest')
  assert.equal(validateAccount({...base, autoOminousOrder: 'lowest', autoOminousAmplifier: 4}, null, null).autoOminousOrder, 'lowest')
  assert.equal(saved.autoOminousCooldown, 0)
  assert.equal(saved.autoGoldenAppleHealth, 20)
  const restored = validateAccount(base, saved, null)
  assert.equal(restored.autoOminousBottle, true)
  assert.equal(restored.autoGoldenApplePreference, 'enchanted')
})

test('custom-node API persists the library and shares standalone definitions without changing placed macros', async t => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'core-custom-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const core = new AppCore({ userDataPath, bots: { connect() {}, disconnect() {}, sessions: new Map() } })
  await core.start(); t.after(() => core.shutdown())
  const definition = { id: 'delay', name: 'Private label', version: 3, nodes: [{ id: 'private-id', kind: 'wait', params: { ms: 1 } }], edges: [], inputs: { in1: { type: 'control', node: 'private-id', port: 'in' } }, outputs: { out1: { type: 'control', node: 'private-id', port: 'out' } } }
  assert.deepEqual(core.macros.saveCustom(definition), definition)
  assert.equal(core.macros.list().customNodes.length, 1)
  const preview = core.share.preview(core.share.export({ kind: 'custom', id: 'delay' }))
  assert.equal(preview.kind, 'custom'); assert.deepEqual(preview.errors, [])
  assert.doesNotMatch(JSON.stringify(preview), /private-id|Private label/)
  core.macros.saveCustom({ ...preview.data, id: 'imported' })
  assert.equal(core.macros.list().customNodes.length, 2)
  core.macros.removeCustom('delay')
  assert.throws(() => core.share.export({ kind: 'custom', id: 'delay' }), /not found/)
  const reopened = new (require('../electron/macro/library-store.cjs').MacroLibraryStore)(userDataPath)
  assert.equal(reopened.load().customNodes[0].id, 'imported')
})

test('recipe graph services persist live safety settings and deliver captured images before resolving', async t => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'core-graph-actions-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const events = [], updates = [], sessions = new Map(), images = [{ name: 'pov.png', data: Buffer.from('image') }]
  let completeCapture, captureArgs
  const bots = { connect() {}, disconnect() {}, sessions, inventory: () => [], updateAccountConfig: value => updates.push(value) }
  const core = new AppCore({ userDataPath, bots,
    notifier: async () => ({ notify: value => events.push(value), flush() {} }),
    platform: { captureAlertImages: async (...args) => { captureArgs = args; await new Promise(resolve => { completeCapture = resolve }); return images } }
  })
  await core.start(); t.after(() => core.shutdown())
  core.accounts.save({ id: 'a', username: 'local', host: 'localhost' })
  await core.facade.graphAction('a', { type: 'safetySettings', autoEat: true, autoEatThreshold: 99, autoTotem: true, totemDisconnect: true })
  const account = core.store.list()[0]
  assert.equal(account.autoEat, true); assert.equal(account.autoEatThreshold, 20)
  assert.equal(account.autoTotem, true); assert.equal(account.totemDisconnect, true)
  assert.equal(updates.at(-1).autoEat, true)
  sessions.set('a', { sessionId: 'session', bot: { entity: {} } })
  const pending = core.facade.graphAction('a', { type: 'screenshot', message: 'nearby' })
  assert.equal(events.length, 0)
  assert.equal(captureArgs[1].notifyAttachPov, true); assert.equal(captureArgs[1].notifyPovOffscreen, true)
  completeCapture(); await pending
  assert.equal(events.at(-1).message, 'nearby'); assert.deepEqual(events.at(-1).images, images)
  core.platform.captureAlertImages = async () => []
  await assert.rejects(core.facade.graphAction('a', { type: 'screenshot' }), /stays connected/)
})

test('Bedrock deposit target is per-account, validated and preserved on partial edits', () => {
  const target = { x: -4, y: 65, z: 12 }
  const base = { label: 'test', username: 'test', host: 'localhost', edition: 'bedrock' }
  const saved = validateAccount({ ...base, bedrockDepositTarget: target }, null, null)
  assert.deepEqual(saved.bedrockDepositTarget, target)
  assert.deepEqual(validateAccount(base, saved, null).bedrockDepositTarget, target)
  assert.equal(validateAccount({ ...base, bedrockDepositTarget: null }, saved, null).bedrockDepositTarget, null)
  assert.throws(() => validateAccount({ ...base, bedrockDepositTarget: { ...target, y: 1.5 } }, null, null), /integer/)
})
