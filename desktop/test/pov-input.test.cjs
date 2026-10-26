const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { BotManager } = require('../electron/bot-manager.cjs')
const { AppCore } = require('../core/app-core.cjs')

function harness(t, lock) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter(); bot.inventory = new EventEmitter()
  bot.inventory.items = () => []; bot.inventory.slots = []; bot.setControlState = () => {}
  bot.quit = () => bot.emit('end')
  const manager = new BotManager({ profilesPath: 'profiles', emit() {}, createBot: () => bot })
  manager.connect({ id: 'pov', username: 'test', host: 'localhost', antiAfk: false, autoReconnect: false })
  bot.entity = { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 }
  bot.look = async (yaw, pitch) => Object.assign(bot.entity, { yaw, pitch })
  t.after(() => manager.disconnect('pov'))
  const canvas = { dataset: { accountId: 'pov' }, closest: () => true, focus() {}, requestPointerLock: lock }
  let rebuilds = 0
  const frames = []
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pov-input-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const core = new AppCore({ userDataPath, botManager: manager })
  const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8')
  const route = main.split('\n').find(line => line.includes("handle('bot:look-delta',"))
  const handlers = new Map()
  vm.runInNewContext(route, { core, handle(channel, fn) { handlers.set(channel, fn) } })
  vm.runInNewContext(main.split('\n').find(line => line.includes("handle('bot:control-state',")), { core, handle(channel, fn) { handlers.set(channel, fn) } })
  let api
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8'), {
    require() { return { contextBridge: { exposeInMainWorld(name, value) { api = value } }, ipcRenderer: {
      invoke(channel, input) { assert.ok(handlers.has(channel)); return Promise.resolve(handlers.get(channel)(null, input)) }
    } } }
  })
  const context = vm.createContext({
    povMath: require('../assets/pov-math.js'), povPaused: false, povFocusId: 'pov', povDrag: null,
    povLookAnimationFrame: null, povLookDelta: { accountId: null, yaw: 0, pitch: 0 },
    povSnapshots: new Map([['pov', { yaw: 0, pitch: 0 }]]), povDisplaySnapshots: new Map(),
    state: { selectedId: 'pov' }, document: { pointerLockElement: null, exitPointerLock() {} },
    el: { 'pov-view-mode': { value: 'perspective' }, 'pov-dialog': { open: true }, 'pov-detail': {}, 'pov-grid': { querySelectorAll: () => [canvas] } },
    render() {}, renderPovGrid() { rebuilds++ }, startPovPolling() {}, releaseAllManualInputs() {},
    releasePovActions() {}, toast() {}, cleanError: String,
    requestAnimationFrame(fn) { frames.push(fn); return frames.length },
    api
  })
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function selectPovTarget('), source.indexOf('function drawPerspectivePov(')), context)
  vm.runInContext(source.slice(source.indexOf('function handlePovMouseDown('), source.indexOf('function releasePovActions(')), context)
  return { context, canvas, bot, manager, frames, source, rebuilds: () => rebuilds }
}

test('click retains an already focused canvas and requests pointer lock', t => {
  let requests = 0
  const h = harness(t, () => { requests++ })
  h.context.selectPovTarget({ currentTarget: h.canvas })
  assert.equal(requests, 1)
  assert.equal(h.rebuilds(), 0, 'replacing the input surface can release capture and focus')
})

test('left drag works without pointer lock and releases on mouseup', t => {
  const h = harness(t)
  h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 20, clientY: 30, preventDefault() {} })
  h.context.handlePovMouseMove({ buttons: 1, clientX: 120, clientY: -70 })
  assert.equal(h.frames.length, 1, 'unlocked drag must schedule look IPC')
  h.frames.shift()()
  assert.equal(h.bot.entity.yaw, -.25)
  assert.equal(h.bot.entity.pitch, .25)
  h.context.releasePovMouse({ button: 0 })
  h.context.handlePovMouseMove({ buttons: 0, clientX: 200, clientY: 100 })
  assert.equal(h.frames.length, 0)
})

test('pointer lock deltas use radians and prediction agrees with backend clamps', t => {
  const h = harness(t)
  h.context.document.pointerLockElement = h.canvas
  h.context.handlePovMouseMove({ movementX: 1000, movementY: -1000 })
  h.frames.shift()()
  const predicted = h.context.povSnapshots.get('pov')
  assert.equal(predicted.yaw, h.bot.entity.yaw)
  assert.equal(predicted.pitch, h.bot.entity.pitch)
  while (h.frames.length) h.frames.shift()()
  assert.equal(h.bot.entity.yaw, -2.5, 'large mouse motion is split rather than discarded')
  assert.equal(h.bot.entity.pitch, 1.45)
  h.bot.entity.yaw = 1.2
  assert.equal(h.manager.worldSnapshot('pov').yaw, 1.2, 'fresh snapshots use live bot orientation')
})

test('synchronous and asynchronous pointer lock failures leave drag look usable', async t => {
  for (const lock of [() => { throw new Error('not supported') }, () => Promise.reject(new Error('denied'))]) {
    const h = harness(t, lock)
    h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 0, clientY: 0, preventDefault() {} })
    await Promise.resolve()
    h.context.handlePovMouseMove({ buttons: 1, clientX: 40, clientY: 0 })
    h.frames.shift()()
    assert.equal(h.bot.entity.yaw, -.1)
  }
})

test('focused POV keyboard movement reaches the bot and releases on keyup or blur', t => {
  const h = harness(t)
  const events = new Map()
  const controls = []
  h.bot.setControlState = (control, active) => controls.push([control, active])
  h.context.activeManualInputs = new Map()
  h.context.getStatus = () => ({ status: 'online' })
  h.context.handlePovKey = () => {}
  h.context.window = { addEventListener: (name, fn) => events.set(name, fn) }
  h.context.document.addEventListener = (name, fn) => { if (!events.has(name)) events.set(name, fn) }
  h.context.document.querySelectorAll = () => []
  h.context.document.querySelector = selector => selector === 'dialog[open]' ? h.context.el['pov-dialog'] : null
  vm.runInContext(h.source.slice(h.source.indexOf('const KEY_CONTROLS'), h.source.indexOf('const activeManualInputs')), h.context)
  vm.runInContext(h.source.slice(h.source.indexOf('function bindManualMovement('), h.source.indexOf('async function sendChatMessage(')), h.context)
  h.context.bindManualMovement()
  const event = { code: 'KeyW', target: { closest: () => null }, preventDefault() {} }
  events.get('keydown')(event)
  assert.deepEqual(controls.at(-1), ['forward', true])
  events.get('keyup')(event)
  assert.deepEqual(controls.at(-1), ['forward', false])
  events.get('keydown')(event)
  events.get('blur')()
  assert.deepEqual(controls.at(-1), ['forward', false])
  h.context.povPaused = true
  const count = controls.length
  events.get('keydown')(event)
  assert.equal(controls.length, count)
})
