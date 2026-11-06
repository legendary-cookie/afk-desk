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
  bot.lookAt = async () => {}
  bot.look = async (yaw, pitch) => Object.assign(bot.entity, { yaw, pitch })
  t.after(() => manager.disconnect('pov'))
  const canvas = { width: 960, height: 540, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), dataset: { accountId: 'pov' }, closest: () => true, focus() {}, requestPointerLock: lock }
  let rebuilds = 0
  const frames = []
  const statusTimeouts = []
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pov-input-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const core = new AppCore({ userDataPath, botManager: manager })
  const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8')
  const route = main.split('\n').find(line => line.includes("handle('bot:look-delta',"))
  const handlers = new Map()
  vm.runInNewContext(route, { core, handle(channel, fn) { handlers.set(channel, fn) } })
  vm.runInNewContext(main.split('\n').find(line => line.includes("handle('bot:control-state',")), { core, handle(channel, fn) { handlers.set(channel, fn) } })
  vm.runInNewContext(main.split('\n').find(line => line.includes("handle('bot:world-action',")), { core, handle(channel, fn) { handlers.set(channel, fn) } })
  const actions = []
  const worldAction = manager.worldAction.bind(manager)
  manager.worldAction = (...args) => { actions.push(args); return worldAction(...args) }
  let api
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8'), {
    require() { return { contextBridge: { exposeInMainWorld(name, value) { api = value } }, ipcRenderer: {
      invoke(channel, input) { assert.ok(handlers.has(channel)); return Promise.resolve(handlers.get(channel)(null, input)) }
    } } }
  })
  const context = vm.createContext({
    povMath: require('../assets/pov-math.js'), povPaused: false, povFocusId: 'pov', povDrag: null,
    povSuppressClick: false, povStatusTimer: null, povHeldActions: new Set(),
    clearTimeout() {}, setTimeout(fn) { statusTimeouts.push(fn); return statusTimeouts.length }, maskText: text => text,
    povLookAnimationFrame: null, povLookDelta: { accountId: null, yaw: 0, pitch: 0 },
    povSnapshots: new Map([['pov', { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }]]), povDisplaySnapshots: new Map(), povCanvasRenderers: new WeakMap(),
    state: { selectedId: 'pov' }, document: { pointerLockElement: null, exitPointerLock() {} },
    el: { 'pov-view-mode': { value: 'perspective' }, 'pov-dialog': { open: true }, 'pov-detail': {}, 'pov-action-status': {}, 'pov-grid': { querySelectorAll: () => [canvas] } },
    render() {}, renderPovGrid() { rebuilds++ }, startPovPolling() {}, releaseAllManualInputs() {},
    releasePovActions() {}, toast() {}, cleanError: error => String(error?.message || error),
    requestAnimationFrame(fn) { frames.push(fn); return frames.length },
    api
  })
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function selectPovTarget('), source.indexOf('function drawPerspectivePov(')), context)
  vm.runInContext(source.slice(source.indexOf('function showPovStatus('), source.indexOf('function releasePovActions(')), context)
  vm.runInContext(source.slice(source.indexOf('function releasePovActions('), source.indexOf('function povInputAllowed(')), context)
  return { context, canvas, bot, manager, frames, source, actions, statusTimeouts, rebuilds: () => rebuilds }
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
    h.context.selectPovTarget({ type: 'click', currentTarget: h.canvas })
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


test('unlocked hold starts digging, click release cancels, and drag past four pixels cancels before looking', async t => {
  const h = harness(t, () => { throw new Error('capture denied') })
  const block = { name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3 }
  h.bot.world = { raycast: () => block }
  let finishDig, digs = 0, stops = 0
  h.bot.dig = () => { digs++; return new Promise(resolve => { finishDig = resolve }) }
  h.bot.stopDigging = () => { stops++; finishDig?.() }
  const down = () => h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 480, clientY: 270, preventDefault() {} })
  const up = () => h.context.releasePovMouse({ target: h.canvas, button: 0, clientX: 480, clientY: 270 })
  down()
  assert.equal(h.actions[0][1], 'dig-crosshair', 'start is sent on mousedown')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(digs, 1)
  assert.equal(h.context.el['pov-action-status'].textContent, 'Breaking…')
  h.context.handlePovMouseMove({ buttons: 1, clientX: 484, clientY: 270 })
  assert.equal(h.frames.length, 0)
  assert.equal(stops, 0, 'four pixels still holds the dig')
  up()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.actions.map(a => a[1]), ['dig-crosshair', 'stop-dig'])
  assert.equal(h.context.el['pov-action-status'].textContent, 'Dig cancelled', 'a click cannot complete a survival dig')
  down()
  await new Promise(resolve => setImmediate(resolve))
  h.context.handlePovMouseMove({ buttons: 1, clientX: 485, clientY: 270 })
  assert.equal(stops, 2)
  assert.equal(h.frames.length, 1)
  up()
  assert.deepEqual(h.actions.map(a => a[1]), ['dig-crosshair', 'stop-dig', 'dig-crosshair', 'stop-dig'])
  h.context.selectPovTarget({ type: 'click', currentTarget: h.canvas })
  assert.equal(h.context.povSuppressClick, false, 'drag click is consumed')
})

test('holding until completion reports the broken block, including instant breaks', async t => {
  const h = harness(t)
  h.bot.world = { raycast: () => ({ name: 'short_grass', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3 }) }
  h.bot.dig = async () => {}
  h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 480, clientY: 270, preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.context.el['pov-action-status'].textContent, 'Broke short grass')
  h.context.releasePovMouse({ button: 0 })
})

test('unlocked right click sends the cursor ray and reports server feedback and errors', async t => {
  const h = harness(t)
  const block = { name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3 }
  h.bot.world = { raycast: () => block }
  h.bot.registry = { blocksByName: { dirt: { id: 3 } } }
  h.bot.heldItem = { name: 'dirt' }
  h.bot.supportFeature = feature => feature === 'blockPlaceHasInsideBlock'
  h.bot._client.write = () => h.bot.emit('blockUpdate', null, { name: 'dirt', position: block.position.offset(0, 0, 1) })
  h.bot.deactivateItem = () => {}
  const down = () => h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 2, clientX: 700, clientY: 270, preventDefault() {} })
  down()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.context.el['pov-action-status'].textContent, 'Placed dirt')
  assert.ok(h.actions[0][2].ray.direction.x > 0, 'right of centre selects a different ray')
  h.context.releasePovMouse({ button: 2 })
  assert.deepEqual(h.actions.map(a => a[1]), ['use-crosshair', 'stop-use'])
  h.bot.world.raycast = () => null
  down()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.context.el['pov-action-status'].textContent, "Can't place: nothing in reach")
  h.statusTimeouts.at(-1)()
  assert.equal(h.context.el['pov-action-status'].textContent, '')
})

test('captured drag cancels digging after four pixels and mouseup remains safe', async t => {
  const h = harness(t)
  h.context.document.pointerLockElement = h.canvas
  const block = { name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3 }
  h.bot.world = { raycast: () => block }
  let finish, stopped = 0
  h.bot.dig = () => new Promise(resolve => { finish = resolve })
  h.bot.stopDigging = () => { stopped++; finish() }
  h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, preventDefault() {} })
  assert.equal(h.actions[0][2].ray, undefined, 'pointer lock uses the live centre crosshair')
  h.context.handlePovMouseMove({ buttons: 1, movementX: 4, movementY: 0 })
  assert.equal(stopped, 0)
  h.context.handlePovMouseMove({ buttons: 1, movementX: 1, movementY: 0 })
  assert.equal(stopped, 1)
  h.context.releasePovMouse({ button: 0 })
  assert.equal(stopped, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.context.el['pov-action-status'].textContent, 'Dig cancelled')
})

test('captured buttons still start and stop dig/use and capture is requested once on click', t => {
  let requests = 0
  const h = harness(t, () => { requests++ })
  h.bot.world = { raycast: () => null }; h.bot.activateItem = () => {}; h.bot.stopDigging = () => {}; h.bot.deactivateItem = () => {}
  h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 0, clientY: 0, preventDefault() {} })
  assert.equal(requests, 0, 'mousedown waits to distinguish a click from a drag')
  h.context.releasePovMouse({ button: 0, target: h.canvas, clientX: 0, clientY: 0 })
  h.context.selectPovTarget({ type: 'click', currentTarget: h.canvas })
  assert.equal(requests, 1)
  h.context.document.pointerLockElement = h.canvas
  for (const button of [0, 2]) {
    h.context.handlePovMouseDown({ currentTarget: h.canvas, button, preventDefault() {} })
    h.context.releasePovMouse({ button })
  }
  assert.deepEqual(h.actions.slice(-4).map(a => a[1]), ['dig-crosshair', 'stop-dig', 'use-crosshair', 'stop-use'])
})

test('Shift from a keyboard-focused canvas targets its account without pointer lock or prior click', async t => {
  const h = harness(t)
  const events = new Map(), controls = []
  h.bot.setControlState = (control, active) => controls.push([control, active])
  h.context.activeManualInputs = new Map()
  h.context.getStatus = () => ({ status: 'online' })
  h.context.handlePovKey = () => {}
  h.context.window = { addEventListener: (name, fn) => events.set(name, fn) }
  h.context.document.addEventListener = (name, fn) => { if (!events.has(name)) events.set(name, fn) }
  h.context.document.querySelectorAll = () => []
  h.context.document.querySelector = selector => selector === 'dialog[open]' ? h.context.el['pov-dialog'] : null
  h.context.povFocusId = null
  h.context.state.selectedId = 'different-account'
  vm.runInContext(h.source.slice(h.source.indexOf('const KEY_CONTROLS'), h.source.indexOf('const activeManualInputs')), h.context)
  vm.runInContext(h.source.slice(h.source.indexOf('function bindManualMovement('), h.source.indexOf('async function sendChatMessage(')), h.context)
  h.context.bindManualMovement()
  const event = code => ({ code, target: { dataset: { accountId: 'pov' }, closest: selector => selector === '#pov-grid canvas' ? h.canvas : null }, preventDefault() {} })
  events.get('keydown')(event('ShiftLeft'))
  events.get('keydown')(event('ShiftRight'))
  await Promise.resolve()
  assert.deepEqual(controls, [['sneak', true]])
  assert.equal(h.context.el['pov-action-status'].textContent, 'Sneaking')
  events.get('keyup')(event('ShiftLeft'))
  assert.equal(controls.length, 1, 'other Shift is still down')
  events.get('keyup')(event('ShiftRight'))
  assert.deepEqual(controls.at(-1), ['sneak', false])
})

test('selecting a different feed keeps the gesture canvas connected and requests capture on that surface', t => {
  let captured
  const h = harness(t, function () { captured = this })
  h.context.povFocusId = null
  const ownCard = { hidden: false, querySelector: () => h.canvas }
  const otherCard = { hidden: false, querySelector: () => ({}) }
  const classes = new Set()
  h.context.el['pov-back-grid'] = { hidden: true }
  Object.assign(h.context.el['pov-grid'], { children: [ownCard, otherCard], classList: { add: name => classes.add(name) } })
  h.context.selectPovTarget({ currentTarget: h.canvas, type: 'click' })
  assert.equal(h.rebuilds(), 0, 'no node replacement during the browser gesture')
  assert.equal(captured, h.canvas)
  assert.equal(classes.has('focused'), true)
  assert.equal(ownCard.hidden, false)
  assert.equal(otherCard.hidden, true)
  assert.equal(h.context.el['pov-back-grid'].hidden, false)
})

test('POV status masks literal untrusted errors and ignores other feeds and closed dialogs', t => {
  const h = harness(t)
  h.context.maskText = value => require('../src/streamer-mask.js').maskText(value, [{ id: 'a', minecraftName: 'PrivatePlayer' }], true)
  const status = h.context.el['pov-action-status']
  Object.defineProperty(status, 'innerHTML', { set() { assert.fail('untrusted errors must use textContent') } })
  h.context.showPovStatus('<PrivatePlayer> denied', 'pov')
  assert.match(status.textContent, /^<Acc•••.+> denied$/)
  const original = status.textContent
  h.context.showPovStatus('different account', 'other')
  assert.equal(status.textContent, original)
  h.context.el['pov-dialog'].open = false
  h.context.showPovStatus('closed')
  assert.equal(status.textContent, original)
})

test('fallback mouseup outside the canvas or after pause always stops digging', t => {
  const h = harness(t)
  const down = () => h.context.handlePovMouseDown({ currentTarget: h.canvas, button: 0, clientX: 10, clientY: 10, preventDefault() {} })
  down()
  h.context.releasePovMouse({ button: 0, target: {}, clientX: 10, clientY: 10 })
  down()
  h.context.povPaused = true
  h.context.releasePovMouse({ button: 0, target: h.canvas, clientX: 10, clientY: 10 })
  assert.deepEqual(h.actions.map(a => a[1]), ['dig-crosshair', 'stop-dig', 'dig-crosshair', 'stop-dig'])
})


test('cursor targeting uses the last drawn interpolated camera, including its aspect, before focusing', t => {
  const h = harness(t)
  const drawn = { position: { x: .25, y: 64, z: 0 }, yaw: .4, pitch: -.2, sneaking: true }
  h.context.povCanvasRenderers.set(h.canvas, { snapshot: drawn, aspect: 128 / 72 })
  const actual = h.context.povMouseTarget({ currentTarget: h.canvas, clientX: 720, clientY: 135 })
  const expected = require('../assets/pov-math.js').cameraRay(drawn, .75, .25, 128 / 72)
  assert.deepEqual(JSON.parse(JSON.stringify(actual.ray)), expected)
})
