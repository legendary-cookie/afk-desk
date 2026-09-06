const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')

async function launch(t, accounts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  if (accounts !== undefined) fs.writeFileSync(path.join(directory, 'accounts.json'), accounts)
  const handlers = new Map(), windows = [], errors = [], loginChanges = []
  let quits = 0
  const app = new EventEmitter()
  Object.assign(app, { whenReady: () => Promise.resolve(), getPath: () => directory,
    quit: () => { quits++; app.emit('before-quit') }, getVersion: () => 'test',
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: (settings) => loginChanges.push(settings) })
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, { mainFrame: { url: '' }, send: () => {}, setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } })
      windows.push(this)
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
  }
  const filename = path.join(__dirname, '../electron/main.cjs')
  const realRequire = createRequire(filename)
  const electron = { app, BrowserWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showErrorBox: (...args) => errors.push(args) }, Notification: { isSupported: () => false } }
  const sandbox = {
    require: (name) => name === 'electron' ? electron : realRequire(name),
    __dirname: path.dirname(filename), process, console, Buffer, URL, setTimeout, clearTimeout
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  await new Promise(resolve => setImmediate(resolve))
  return { handlers, windows, errors, quits, directory, loginChanges, emitBotEvent: sandbox.emitBotEvent, getRuntime: sandbox.getRuntime }
}

test('every registered desktop IPC channel rejects a foreign sender', async (t) => {
  const { handlers, windows } = await launch(t)
  assert.ok(handlers.size >= 30)
  for (const [name, handler] of handlers) {
    assert.throws(() => handler({ sender: {}, senderFrame: {} }, {}), /Untrusted/, name)
  }
  const window = windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  assert.deepEqual(handlers.get('accounts:list')(event), [])
})

test('corrupt accounts produce a recovery error and remain untouched on startup', async (t) => {
  const app = await launch(t, '{broken')
  assert.equal(app.quits, 1)
  assert.equal(app.errors.length, 1)
  assert.match(app.errors[0][1], /preserved|unchanged/i)
  assert.equal(fs.readFileSync(path.join(app.directory, 'accounts.json'), 'utf8'), '{broken')
  assert.equal(app.windows.length, 0)
})

test('runtime account corruption cannot crash status processing or overwrite data', async (t) => {
  const instance = await launch(t)
  fs.writeFileSync(path.join(instance.directory, 'accounts.json'), '{broken')
  assert.doesNotThrow(() => instance.emitBotEvent('status', 'fixture', { status: 'offline', detail: 'Disconnected' }))
  assert.doesNotThrow(() => instance.emitBotEvent('identity', 'fixture', { username: 'Player' }))
  assert.equal(instance.getRuntime('fixture').status, 'offline')
  assert.equal(instance.errors.length, 1)
  assert.match(instance.errors[0][1], /preserved/)
  assert.equal(fs.readFileSync(path.join(instance.directory, 'accounts.json'), 'utf8'), '{broken')
})

test('unreadable settings block Windows startup changes as well as file writes', async (t) => {
  const instance = await launch(t)
  fs.writeFileSync(path.join(instance.directory, 'settings.json'), '{broken')
  const window = instance.windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  assert.throws(() => instance.handlers.get('settings:save')(event, { startWithWindows: true }), /preserved/)
  assert.equal(instance.loginChanges.length, 0)
  assert.equal(fs.readFileSync(path.join(instance.directory, 'settings.json'), 'utf8'), '{broken')
})
