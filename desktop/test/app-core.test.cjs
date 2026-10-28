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

const ORIGINAL_IPC_CHANNELS = Object.freeze([
  'accounts:list',
  'accounts:save',
  'accounts:delete',
  'accounts:duplicate-profile',
  'accounts:reorder',
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
  'logs:clear',
  'macros:list',
  'macros:save',
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
