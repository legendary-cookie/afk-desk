const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const model = require('../src/overview-layout.js')

// Exercise the real editor's listeners and panel reparenting without a browser dependency.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.childNodes = []; this.dataset = {}; this.attributes = {}; this.events = new Map()
    this.style = { setProperty(name, value) { this[name] = value } }
    this.className = ''; this.hidden = false; this.clientHeight = 600
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, value) => {
        const classes = new Set(this.className.split(' ').filter(Boolean))
        const enabled = value === undefined ? !classes.has(name) : value
        if (enabled) classes.add(name); else classes.delete(name)
        this.className = [...classes].join(' ')
        return enabled
      },
      remove: name => this.classList.toggle(name, false)
    }
  }
  get children() { return this.childNodes.filter(node => node instanceof Element) }
  get options() { return this.children }
  append(...nodes) { for (const node of nodes) { node?.remove?.(); this.childNodes.push(node); if (node instanceof Element) node.parentNode = this } }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null } }
  before(node) { const parent = this.parentNode, index = parent.childNodes.indexOf(this); node.remove(); parent.childNodes.splice(index, 0, node); node.parentNode = parent }
  after(node) { const parent = this.parentNode; node.remove(); parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node); node.parentNode = parent }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.childNodes = []; this.append(...nodes) }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, handler) { const handlers = this.events.get(name) || []; handlers.push(handler); this.events.set(name, handlers) }
  removeEventListener(name, handler) { this.events.set(name, (this.events.get(name) || []).filter(fn => fn !== handler)) }
  dispatch(name, event = {}) { for (const handler of [...(this.events.get(name) || [])]) handler({ button: 0, preventDefault() {}, ...event }) }
  getBoundingClientRect() { return { width: this.width || 1200, height: this.height || 600 } }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    const data = selector.match(/^\[data-(module|handle)="([^"]+)"\]$/)
    return data ? this.dataset[data[1]] === data[2] : false
  }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found } return null }
  focus() { this.focused = true }
}
function fixture(global = model.presets.Default, globalMode = 'auto', prepare = () => {}) {
  const dashboard = new Element(), original = new Element(), consolePanel = new Element()
  dashboard.dataset.view = 'overview'; dashboard.append(original)
  const selectors = {
    '#console-panel': consolePanel, '#macro-section': new Element(), '#details-panel': new Element(), '#movement-panel': new Element(),
    '.inventory-panel': new Element(), '#scoreboard-panel': new Element(), '#effects-panel': new Element(), '#boss-bars-panel': new Element(),
    '#next-runs-panel': new Element(), '#minimap-panel': new Element(), '#inventory-resizer': new Element()
  }
  for (const [selector, node] of Object.entries(selectors)) (selector === '#macro-section' ? consolePanel : original).append(node)
  const document = { querySelector: selector => selectors[selector], createElement: tag => new Element(tag), createComment: () => new Element('comment') }
  const settings = { overviewLayout: { version: model.version, global, overrides: {}, globalMode, overrideModes: {} } }, saved = []
  const arrangements = []
  const window = new Element(); window.afkOverviewLayout = { ...model, autoArrange(...args) { arrangements.push(args); return model.autoArrange(...args) } }
  const frames = [], observations = [], reparented = []
  let contentChanged
  window.requestAnimationFrame = fn => frames.push(fn)
  class MutationObserver {
    constructor(fn) { contentChanged = fn }
    observe(node, options) { observations.push({ node, options }) }
    disconnect() { observations.length = 0 }
  }
  prepare(selectors, dashboard)
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/overview-editor.js'), 'utf8'), { window, document, MutationObserver })
  let account = 'one'
  const editor = window.createOverviewEditor({ dashboard, settings: () => settings, accountId: () => account, save: async data => saved.push(data), report: error => { throw error }, onReparent: () => reparented.push(true) })
  editor.refresh()
  const grid = dashboard.querySelector('.overview-modules'), toolbar = dashboard.querySelector('.overview-toolbar')
  const button = text => {
    const find = node => node.children.find(child => child.textContent === text) || node.children.map(find).find(Boolean)
    return find(toolbar)
  }
  return { frames, observations, arrangements, reparented, mutate: () => contentChanged(), flush: () => { while (frames.length) frames.shift()() }, dashboard, original, selectors, settings, saved, editor, grid, window, toolbar, button, controls: toolbar.querySelector('.overview-controls'), account: id => { account = id; editor.refresh() } }
}

test('auto layout uses the existing panels and restores their homes outside overview', () => {
  const f = fixture()
  assert.equal(f.grid.classList.contains('overview-auto'), true)
  assert.equal(f.grid.querySelector('[data-module="console"]').style.gridColumn, '1 / span 8')
  assert.equal(f.grid.querySelector('[data-module="details"]').style.gridColumn, '9 / span 4')
  assert.equal(f.selectors['#minimap-panel'].parentNode, f.selectors['#movement-panel'])
  assert.equal(f.selectors['#minimap-panel'].hidden, false)
  assert.equal(f.selectors['#scoreboard-panel'].hidden, true)
  f.editor.refresh(true)
  assert.equal(f.selectors['#minimap-panel'].parentNode, f.selectors['#movement-panel'])
  f.dashboard.dataset.view = 'chat'; f.editor.refresh()
  assert.equal(f.selectors['#macro-section'].parentNode, f.selectors['#console-panel'])
  assert.equal(f.selectors['#inventory-resizer'].parentNode, f.original)
  assert.equal(f.grid.hidden, true)
  f.dashboard.dataset.view = 'overview'; f.editor.refresh()
  assert.equal(f.grid.classList.contains('overview-auto'), true)
})

test('every module can move and resize by keyboard and pointer using the displayed row pitch', async () => {
  for (const id of Object.keys(model.names)) {
    const item = { id, x: 0, y: 0, w: 4, h: 400 }
    const f = fixture([item], 'manual'); f.button('Edit layout').dispatch('click')
    const handle = () => f.grid.querySelector('[data-handle="' + id + '"]')
    const resize = () => f.grid.querySelector('.overview-module-resize')
    assert.equal(resize().hidden, false, id + ': resize target is visible')
    handle().dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(f.settings.overviewLayout.global[0].x, 1, id + ': keyboard move')
    handle().dispatch('keydown', { key: 'ArrowDown', shiftKey: true })
    assert.equal(f.settings.overviewLayout.global[0].h, 425, id + ': keyboard resize through handle')
    resize().dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(f.settings.overviewLayout.global[0].w, 5, id + ': keyboard resize through corner')
    const pitch = model.gridMetrics(1200, 600, model.rows)
    handle().dispatch('pointerdown', { clientX: 0, clientY: 0 })
    f.window.dispatch('pointerup', { clientX: pitch.x, clientY: pitch.y * 25 })
    assert.equal(f.settings.overviewLayout.global[0].x, 2, id + ': pointer move x')
    assert.equal(f.settings.overviewLayout.global[0].y, 25, id + ': pointer move y')
    resize().dispatch('pointerdown', { clientX: 0, clientY: 0 })
    f.window.dispatch('pointerup', { clientX: pitch.x, clientY: pitch.y * 25 })
    assert.equal(f.settings.overviewLayout.global[0].w, 6, id + ': pointer resize w')
    assert.equal(f.settings.overviewLayout.global[0].h, 450, id + ': pointer resize h')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.saved.length, 5)
  }
})

test('adding and removing modules re-arranges; a standalone map reparents its shared canvas', () => {
  const f = fixture(); f.button('Edit layout').dispatch('click')
  const picker = f.controls.children.find(node => node.attributes['aria-label'] === 'Add module')
  assert.deepEqual(picker.options.map(node => node.value), ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap'])
  for (const id of ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap']) {
    picker.value = id; f.button('Add module').dispatch('click')
    assert.deepEqual(f.settings.overviewLayout.global, model.autoArrange(f.settings.overviewLayout.global, { width: 1200, height: 600, editing: true }).layout)
  }
  assert.equal(f.selectors['#minimap-panel'].parentNode.dataset.module, 'minimap')
  const wrapper = f.grid.querySelector('[data-module="minimap"]')
  wrapper.children[0].children[1].dispatch('click')
  assert.equal(f.selectors['#minimap-panel'].parentNode, f.selectors['#movement-panel'])
  assert.deepEqual(f.settings.overviewLayout.global, model.autoArrange(f.settings.overviewLayout.global, { editing: true }).layout)
  f.button('Reset layout').dispatch('click'); f.button('Done editing').dispatch('click')
  assert.equal(f.grid.classList.contains('overview-auto'), true)
  const expected = model.autoArrange(model.presets.Default).layout
  for (const item of expected) assert.equal(f.grid.querySelector(`[data-module="${item.id}"]`).style.gridRow, `${item.y + 1} / span ${item.h}`)
})

test('a drag switches to Manual and both Auto-arrange controls restore automatic layout', () => {
  for (const sizing of [false, true]) {
    const f = fixture(); f.button('Edit layout').dispatch('click')
    const notice = f.toolbar.querySelector('.overview-layout-notice')
    const auto = f.controls.children[1].children[0]
    assert.equal(notice.hidden, true); assert.equal(auto.checked, true)
    const target = f.grid.querySelector(sizing ? '.overview-module-resize' : '[data-handle="console"]')
    target.dispatch('pointerdown', { clientX: 0, clientY: 0 })
    f.window.dispatch('pointerup', { clientX: 0, clientY: 15 })
    assert.equal(f.settings.overviewLayout.globalMode, 'manual')
    assert.equal(notice.hidden, false); assert.equal(auto.checked, false)
    assert.equal(f.grid.classList.contains('overview-auto'), false)
    const manual = structuredClone(f.settings.overviewLayout.global)
    f.grid.height = 900; f.editor.fit()
    assert.deepEqual(f.settings.overviewLayout.global, manual)
    notice.children[0].dispatch('click')
    assert.equal(f.settings.overviewLayout.globalMode, 'auto'); assert.equal(notice.hidden, true)
    auto.checked = false; auto.dispatch('change')
    assert.equal(f.settings.overviewLayout.globalMode, 'manual')
    f.controls.children[2].dispatch('click')
    assert.equal(f.settings.overviewLayout.globalMode, 'auto')
    auto.checked = false; auto.dispatch('change'); auto.checked = true; auto.dispatch('change')
    assert.equal(f.settings.overviewLayout.globalMode, 'auto')
  }
})

test('a pointer click without movement keeps automatic mode', () => {
  const f = fixture(); f.button('Edit layout').dispatch('click')
  f.grid.querySelector('[data-handle="console"]').dispatch('pointerdown', { clientX: 0, clientY: 0 })
  f.window.dispatch('pointerup', { clientX: 0, clientY: 0 })
  assert.equal(f.grid.classList.contains('overview-auto'), true)
  assert.equal(f.saved.length, 0)
})

test('viewport changes re-arrange automatic layouts and preserve panel content', () => {
  const f = fixture(), panel = f.selectors['#console-panel']
  panel.textContent = '<Player> hello'
  f.grid.width = 700; f.grid.height = 800; f.editor.fit()
  assert.equal(f.grid.querySelector('[data-module="console"]').style.gridColumn, '1 / span 12')
  assert.equal(panel.textContent, '<Player> hello')
  f.grid.width = 1500; f.grid.height = 900; f.editor.fit()
  const expected = model.autoArrange(model.presets.Default, { width: 1500, height: 900 }).layout
  const consoleItem = expected.find(item => item.id === 'console')
  assert.equal(f.grid.querySelector('[data-module="console"]').style.gridRow, `1 / span ${consoleItem.h}`)
  f.dashboard.dataset.view = 'chat'; f.editor.refresh(); f.editor.fit()
  assert.equal(f.grid.children.length, 0)
})

test('global and account modes persist independently and reset stays scoped', async () => {
  const f = fixture(); f.button('Edit layout').dispatch('click')
  const checkbox = f.controls.children[0].children[0]
  checkbox.checked = true; checkbox.dispatch('change')
  f.grid.querySelector('[data-handle="console"]').dispatch('keydown', { key: 'ArrowDown' })
  const one = structuredClone(f.settings.overviewLayout.overrides.one)
  assert.equal(f.settings.overviewLayout.overrideModes.one, 'manual')
  assert.equal(f.settings.overviewLayout.globalMode, 'auto')
  f.account('two'); assert.equal(checkbox.checked, false)
  assert.equal(f.grid.classList.contains('overview-auto'), true)
  f.account('one'); assert.equal(checkbox.checked, true)
  assert.equal(f.grid.classList.contains('overview-auto'), false)
  assert.deepEqual(f.settings.overviewLayout.overrides.one, one)
  f.button('Reset layout').dispatch('click')
  assert.equal(f.settings.overviewLayout.overrideModes.one, 'auto')
  assert.deepEqual(f.settings.overviewLayout.global, model.presets.Default)
  checkbox.checked = false; checkbox.dispatch('change')
  assert.equal(Object.hasOwn(f.settings.overviewLayout.overrides, 'one'), false)
  assert.equal(Object.hasOwn(f.settings.overviewLayout.overrideModes, 'one'), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.saved.at(-1).globalMode, 'auto')
})

test('applying a preset makes its positions manual and preserves the selected module set', () => {
  const f = fixture(); f.button('Edit layout').dispatch('click')
  const preset = f.controls.children.find(node => node.attributes['aria-label'] === 'Layout preset')
  preset.value = 'Monitoring'; f.button('Apply preset').dispatch('click')
  assert.deepEqual(f.settings.overviewLayout.global, model.presets.Monitoring)
  assert.equal(f.settings.overviewLayout.globalMode, 'manual')
  f.controls.children[2].dispatch('click')
  assert.equal(f.settings.overviewLayout.globalMode, 'auto')
  assert.deepEqual(f.settings.overviewLayout.global.map(item => item.id).sort(), model.presets.Monitoring.map(item => item.id).sort())
})

test('renderer observes overview geometry and routes window changes through the arranger', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  const header = {}, grid = {}, dashboard = { hidden: false, querySelector: () => grid }
  const observed = [], listeners = new Map()
  let callback, fits = 0, panelFits = 0
  const context = {
    document: { querySelector: () => header }, el: { dashboard }, state: { settings: {} },
    overviewEditor: { fit() { fits++ } }, applyPanelLayout() { panelFits++ },
    ResizeObserver: class { constructor(fn) { callback = fn } observe(node) { observed.push(node) } },
    requestAnimationFrame: fn => fn(), window: { addEventListener: (name, fn) => listeners.set(name, fn) }
  }
  vm.runInNewContext(source.slice(source.indexOf('function observePanelFit()'), source.indexOf('function bindSplitter(')) + '\nobservePanelFit()', context)
  assert.deepEqual(observed, [header, dashboard, grid])
  callback(); listeners.get('resize')()
  assert.equal(fits, 2); assert.equal(panelFits, 3)
  dashboard.hidden = true; callback()
  assert.equal(fits, 2)
})


test('viewport measurement accounts for UI zoom and available height instead of overflowing grid height', () => {
  const f = fixture()
  f.grid.clientWidth = 1000
  f.grid.getBoundingClientRect = () => ({ width: 700, height: 1000, top: 140 })
  f.dashboard.getBoundingClientRect = () => ({ bottom: 700 })
  f.editor.fit()
  const expected = model.autoArrange(model.presets.Default, { width: 1000, height: 800 }).layout
  for (const item of expected) assert.equal(f.grid.querySelector(`[data-module="${item.id}"]`).style.gridRow, `${item.y + 1} / span ${item.h}`)
  const wrapper = f.grid.querySelector('[data-module="console"]')
  f.editor.fit()
  assert.equal(f.grid.querySelector('[data-module="console"]'), wrapper, 'unchanged geometry does not rebuild panels')
})

function measuredPanel(node, headerHeight, naturalHeight, headerClass = 'panel-header') {
  const header = new Element('header'); header.className = headerClass; header.height = headerHeight
  node.height = naturalHeight; node.append(header)
  return header
}
function displayedHeight(f, id) {
  const wrapper = f.grid.querySelector(`[data-module="${id}"]`)
  const tracks = Number(wrapper.style.gridRow.split('span ')[1])
  return tracks * Math.max(f.grid.height || 600, parseFloat(f.grid.style.minHeight)) / model.rows - 8
}

test('content and collapse changes reflow retained panels at full column width without saving', () => {
  const ids = [...model.presets.Default, { id: 'scoreboard' }, { id: 'effects' }, { id: 'bossBars' }, { id: 'nextRuns' }]
  const f = fixture(ids, 'auto', nodes => {
    measuredPanel(nodes['#movement-panel'], 46, 240)
    measuredPanel(nodes['.inventory-panel'], 58, 390)
    for (const id of ['scoreboard', 'effects', 'boss-bars', 'next-runs']) {
      const panel = nodes[`#${id}-panel`]
      measuredPanel(panel, 42, 73)
      const empty = new Element(); empty.className = 'module-empty'; panel.append(empty)
    }
  })
  f.grid.height = 900; f.editor.fit()
  const movement = f.selectors['#movement-panel'], wrapper = movement.parentNode
  const expanded = displayedHeight(f, 'movement')
  movement.classList.toggle('collapsed', true); f.mutate(); f.mutate()
  assert.equal(f.frames.length, 1, 'content updates coalesce per frame')
  f.flush()
  assert.equal(movement.parentNode, wrapper, 'content changes preserve wrappers, focus and panels')
  assert.equal(wrapper.style.gridColumn, '9 / span 4')
  assert.ok(displayedHeight(f, 'movement') < expanded)
  assert.ok(Math.abs(displayedHeight(f, 'movement') - 49) < 1)
  for (const id of ['scoreboard', 'effects', 'bossBars', 'nextRuns']) assert.ok(Math.abs(displayedHeight(f, id) - 74) < 1, id)
  movement.classList.remove('collapsed'); f.mutate(); f.flush()
  assert.ok(displayedHeight(f, 'movement') >= expanded - 1)
  const board = f.selectors['#scoreboard-panel']
  board.querySelector('.module-empty').remove(); board.height = 155; f.mutate(); f.flush()
  assert.ok(Math.abs(displayedHeight(f, 'scoreboard') - 156) < 1)
  assert.equal(board.parentNode.classList.contains('overview-empty'), false)
  assert.equal(f.saved.length, 0, 'transient content sizing is never persisted')
  f.dashboard.classList.toggle('inventory-collapsed', true); f.mutate(); f.flush()
  assert.ok(Math.abs(displayedHeight(f, 'inventory') - 61) < 1)
})

test('natural inventory and wrapping macro content fit with overlay handles and at UI zoom', () => {
  const f = fixture(model.presets.Default, 'auto', nodes => {
    measuredPanel(nodes['.inventory-panel'], 58, 390)
    measuredPanel(nodes['#macro-section'], 38, 90, 'macro-header')
  })
  f.grid.height = 720; f.button('Edit layout').dispatch('click')
  assert.ok(displayedHeight(f, 'inventory') >= 390)
  assert.ok(displayedHeight(f, 'macro') >= 90)
  const inventory = f.selectors['.inventory-panel'], header = inventory.querySelector('.panel-header')
  f.grid.clientWidth = 1200
  f.grid.getBoundingClientRect = () => ({ width: 840, height: 504, top: 0 })
  f.dashboard.getBoundingClientRect = () => ({ bottom: 504 })
  inventory.getBoundingClientRect = () => {
    assert.equal(f.grid.classList.contains('overview-measuring'), true)
    assert.equal(inventory.parentNode.style.gridColumn, '1 / span 8')
    return { height: 390 * .7 }
  }
  header.height = 58 * .7
  f.selectors['#macro-section'].height = 90 * .7
  f.selectors['#macro-section'].querySelector('.macro-header').height = 38 * .7
  f.editor.fit(true)
  assert.ok(displayedHeight(f, 'inventory') >= 390)
  assert.equal(f.grid.classList.contains('overview-measuring'), false)
})

test('manual mode ignores content mutations and resize without changing its module geometry', () => {
  const f = fixture(model.presets.Default, 'manual')
  const wrapper = f.selectors['#movement-panel'].parentNode
  const before = [wrapper.style.gridColumn, wrapper.style.gridRow]
  f.selectors['#movement-panel'].classList.toggle('collapsed', true); f.mutate(); f.flush()
  f.grid.width = 700; f.grid.height = 900; f.editor.fit(true)
  assert.equal(f.selectors['#movement-panel'].parentNode, wrapper)
  assert.deepEqual([wrapper.style.gridColumn, wrapper.style.gridRow], before)
  assert.equal(f.saved.length, 0)
  f.dashboard.dataset.view = 'inventory'; f.editor.refresh()
  assert.equal(f.observations.length, 0, 'observers disconnect outside overview')
})


test('moving a retained handle uses the latest content and viewport arrangement', () => {
  const f = fixture()
  const wrapper = f.selectors['#movement-panel'].parentNode
  const handle = wrapper.querySelector('[data-handle="movement"]')
  f.grid.width = 700; f.grid.height = 900; f.editor.fit()
  const before = Number(wrapper.style.gridRow.split(' /')[0]) - 1
  assert.equal(wrapper.style.gridColumn, '1 / span 12')
  handle.dispatch('keydown', { key: 'ArrowDown' })
  const saved = f.settings.overviewLayout.global.find(item => item.id === 'movement')
  assert.equal(saved.y, before + 25)
  assert.equal(saved.w, 12)
  assert.equal(f.settings.overviewLayout.globalMode, 'manual')
})


function moduleGeometry(f) {
  return f.grid.children.filter(node => node.dataset.module).map(node => [node.dataset.module, node.style.gridColumn, node.style.gridRow])
}

test('arrange observer echoes and unchanged content do not arrange again', () => {
  const f = fixture(model.presets.Default, 'auto', nodes => {
    measuredPanel(nodes['.inventory-panel'], 58, 390)
    measuredPanel(nodes['#macro-section'], 38, 90, 'macro-header')
  })
  f.button('Edit layout').dispatch('click')
  const before = moduleGeometry(f), calls = f.arrangements.length
  for (let frame = 0; frame < 20; frame++) {
    f.editor.fit() // ResizeObserver notification after assigning rows.
    f.mutate(); f.mutate(); f.flush() // HUD/chat redraw without new size inputs.
    assert.deepEqual(moduleGeometry(f), before)
  }
  assert.equal(f.arrangements.length, calls, 'observer echoes never invoke the arranger')
  assert.equal(f.saved.length, 0)
})

test('content heights must change by more than 8px from the last applied measurement', () => {
  const f = fixture(model.presets.Default, 'auto', nodes => measuredPanel(nodes['#macro-section'], 38, 90, 'macro-header'))
  const macro = f.selectors['#macro-section'], before = moduleGeometry(f), calls = f.arrangements.length
  for (const height of [94, 98, 86, 90, 98]) {
    macro.height = height; f.mutate(); f.flush()
    assert.deepEqual(moduleGeometry(f), before)
    assert.equal(f.arrangements.length, calls)
  }
  macro.height = 99; f.mutate(); f.mutate()
  assert.equal(f.frames.length, 1)
  f.flush()
  assert.equal(f.arrangements.length, calls + 1)
  assert.notDeepEqual(moduleGeometry(f), before)
  f.mutate(); f.flush()
  assert.equal(f.arrangements.length, calls + 1)
})

test('empty state changes arrange even when content height stays the same', () => {
  const f = fixture([...model.presets.Default, { id: 'scoreboard' }], 'auto', nodes => {
    const board = nodes['#scoreboard-panel']
    measuredPanel(board, 42, 73)
    const empty = new Element(); empty.className = 'module-empty'; board.append(empty)
  })
  const board = f.selectors['#scoreboard-panel'], calls = f.arrangements.length
  assert.equal(board.parentNode.classList.contains('overview-empty'), true)
  board.querySelector('.module-empty').remove(); f.mutate(); f.flush()
  assert.equal(f.arrangements.length, calls + 1)
  assert.equal(board.parentNode.classList.contains('overview-empty'), false)
})

test('editing uses natural content rather than assigned heights and preserves every module row', () => {
  const f = fixture(model.presets.Default, 'auto', nodes => {
    measuredPanel(nodes['.inventory-panel'], 58, 390)
    measuredPanel(nodes['#macro-section'], 38, 90, 'macro-header')
  })
  f.grid.height = 900; f.editor.fit()
  for (const [selector, naturalHeight] of [['#macro-section', 90], ['.inventory-panel', 390]]) {
    const node = f.selectors[selector]
    node.getBoundingClientRect = () => {
      assert.equal(f.grid.classList.contains('overview-measuring'), true, 'read intrinsic size with grid allocation removed')
      return { height: naturalHeight }
    }
  }
  const normal = moduleGeometry(f), consoleHeight = displayedHeight(f, 'console')
  for (let i = 0; i < 3; i++) {
    f.button('Edit layout').dispatch('click')
    assert.deepEqual(moduleGeometry(f), normal)
    assert.equal(displayedHeight(f, 'console'), consoleHeight)
    assert.equal(f.grid.querySelector('.overview-module-bar').hidden, false)
    f.mutate(); f.flush()
    assert.deepEqual(moduleGeometry(f), normal)
    f.button('Done editing').dispatch('click')
    assert.deepEqual(moduleGeometry(f), normal)
  }
})

test('renderer coalesces resize callbacks and an arrange-caused resize does not arrange again', () => {
  const f = fixture(), source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  const observed = []
  let resize, panelFits = 0
  const context = {
    document: { querySelector: () => f.selectors['.inventory-panel'] }, el: { dashboard: f.dashboard }, state: { settings: {} },
    overviewEditor: f.editor, applyPanelLayout() { panelFits++ },
    ResizeObserver: class { constructor(fn) { resize = fn } observe(node) { observed.push(node) } },
    requestAnimationFrame: f.window.requestAnimationFrame, window: f.window
  }
  vm.runInNewContext(source.slice(source.indexOf('function observePanelFit()'), source.indexOf('function bindSplitter(')) + '\nobservePanelFit()', context)
  f.flush()
  assert.deepEqual(observed, [f.selectors['.inventory-panel'], f.dashboard, f.grid])
  f.grid.height = 900
  resize(); resize(); f.window.dispatch('resize')
  assert.equal(f.frames.length, 1, 'viewport changes coalesce in one frame')
  f.flush()
  const arranged = moduleGeometry(f), calls = f.arrangements.length
  resize(); f.flush()
  assert.equal(f.arrangements.length, calls, 'grid resize caused by arrange is ignored')
  assert.deepEqual(moduleGeometry(f), arranged)
  assert.equal(panelFits, 3)
})

test('overview reparenting requests restoring the newest log position', () => {
  const f = fixture()
  assert.equal(f.reparented.length, 1)
  f.dashboard.dataset.view = 'chat'
  f.editor.refresh()
  assert.equal(f.reparented.length, 2)
  f.dashboard.dataset.view = 'overview'
  f.editor.refresh()
  assert.equal(f.reparented.length, 3)
})
