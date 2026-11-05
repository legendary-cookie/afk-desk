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
function fixture(global = model.presets.Default, globalMode = 'auto') {
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
  const window = new Element(); window.afkOverviewLayout = model
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/overview-editor.js'), 'utf8'), { window, document })
  let account = 'one'
  const editor = window.createOverviewEditor({ dashboard, settings: () => settings, accountId: () => account, save: async data => saved.push(data), report: error => { throw error } })
  editor.refresh()
  const grid = dashboard.querySelector('.overview-modules'), toolbar = dashboard.querySelector('.overview-toolbar')
  const button = text => {
    const find = node => node.children.find(child => child.textContent === text) || node.children.map(find).find(Boolean)
    return find(toolbar)
  }
  return { dashboard, original, selectors, settings, saved, editor, grid, window, toolbar, button, controls: toolbar.querySelector('.overview-controls'), account: id => { account = id; editor.refresh() } }
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
    assert.deepEqual(f.settings.overviewLayout.global, model.autoArrange(f.settings.overviewLayout.global, { width: 1200, height: 600 }).layout)
  }
  assert.equal(f.selectors['#minimap-panel'].parentNode.dataset.module, 'minimap')
  const wrapper = f.grid.querySelector('[data-module="minimap"]')
  wrapper.children[0].children[1].dispatch('click')
  assert.equal(f.selectors['#minimap-panel'].parentNode, f.selectors['#movement-panel'])
  assert.deepEqual(f.settings.overviewLayout.global, model.autoArrange(f.settings.overviewLayout.global).layout)
  f.button('Reset layout').dispatch('click'); f.button('Done editing').dispatch('click')
  assert.equal(f.grid.classList.contains('overview-auto'), true)
  assert.deepEqual(f.settings.overviewLayout.global, model.autoArrange(model.presets.Default).layout)
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
