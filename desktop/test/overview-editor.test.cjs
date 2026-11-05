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
  getBoundingClientRect() { return { width: 1200, height: Number.parseFloat(this.style.height) || 600 } }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    const data = selector.match(/^\[data-(module|handle)="([^"]+)"\]$/)
    return data ? this.dataset[data[1]] === data[2] : false
  }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found } return null }
  focus() { this.focused = true }
}
function fixture(global = model.presets.Default) {
  const dashboard = new Element(), original = new Element(), consolePanel = new Element()
  dashboard.dataset.view = 'overview'; dashboard.append(original)
  const selectors = {
    '#console-panel': consolePanel, '#macro-section': new Element(), '#details-panel': new Element(), '#movement-panel': new Element(),
    '.inventory-panel': new Element(), '#scoreboard-panel': new Element(), '#effects-panel': new Element(), '#boss-bars-panel': new Element(),
    '#next-runs-panel': new Element(), '#minimap-panel': new Element(), '#inventory-resizer': new Element()
  }
  for (const [selector, node] of Object.entries(selectors)) (selector === '#macro-section' ? consolePanel : original).append(node)
  const document = { querySelector: selector => selectors[selector], createElement: tag => new Element(tag), createComment: () => new Element('comment') }
  const settings = { overviewLayout: { version: model.version, global, overrides: {} } }, saved = []
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
  return { dashboard, original, selectors, settings, saved, editor, grid, window, toolbar, button, account: id => { account = id; editor.refresh() } }
}

test('default keeps content-sized columns and inventory splitter, and nests the map exactly once', () => {
  const f = fixture()
  assert.equal(f.grid.classList.contains('overview-fitted'), true)
  const primary = f.grid.querySelector('.overview-primary')
  assert.deepEqual(primary.children.map(node => node.dataset.module || 'splitter'), ['console', 'macro', 'splitter', 'inventory'])
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
  assert.equal(f.grid.classList.contains('overview-fitted'), true)
})

test('every module can move and resize by keyboard and pointer using the displayed row pitch', async () => {
  for (const id of Object.keys(model.names)) {
    const item = { ...model.moduleDefaults[id], x: 0, y: 0, w: 4, h: 4 }
    const f = fixture([item]); f.button('Edit layout').dispatch('click')
    const handle = () => f.grid.querySelector('[data-handle="' + id + '"]')
    const resize = () => f.grid.querySelector('.overview-module-resize')
    assert.equal(resize().hidden, false, id + ': resize target is visible')
    handle().dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(f.settings.overviewLayout.global[0].x, 1, id + ': keyboard move')
    handle().dispatch('keydown', { key: 'ArrowDown', shiftKey: true })
    assert.equal(f.settings.overviewLayout.global[0].h, 5, id + ': keyboard resize through handle')
    resize().dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(f.settings.overviewLayout.global[0].w, 5, id + ': keyboard resize through corner')
    const pitch = model.gridMetrics(1200, 600, 5)
    handle().dispatch('pointerdown', { clientX: 0, clientY: 0 })
    f.window.dispatch('pointerup', { clientX: pitch.x, clientY: pitch.y })
    assert.equal(f.settings.overviewLayout.global[0].x, 2, id + ': pointer move x')
    assert.equal(f.settings.overviewLayout.global[0].y, 1, id + ': pointer move y')
    const nextPitch = model.gridMetrics(1200, 600, 6)
    resize().dispatch('pointerdown', { clientX: 0, clientY: 0 })
    f.window.dispatch('pointerup', { clientX: nextPitch.x, clientY: nextPitch.y })
    assert.equal(f.settings.overviewLayout.global[0].w, 6, id + ': pointer resize w')
    assert.equal(f.settings.overviewLayout.global[0].h, 6, id + ': pointer resize h')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.saved.length, 5)
  }
})

test('Add module offers optional panels; standalone Minimap reparents its shared canvas', () => {
  const f = fixture(); f.button('Edit layout').dispatch('click')
  const picker = f.toolbar.children[1].children.find(node => node.attributes['aria-label'] === 'Add module')
  assert.deepEqual(picker.options.map(node => node.value), ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap'])
  for (const id of ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap']) {
    picker.value = id; f.button('Add module').dispatch('click')
    assert.ok(f.settings.overviewLayout.global.some(item => item.id === id))
    assert.ok(f.grid.querySelector('[data-handle="' + id + '"]'))
  }
  assert.equal(f.selectors['#minimap-panel'].parentNode.dataset.module, 'minimap')
  const wrapper = f.grid.querySelector('[data-module="minimap"]')
  wrapper.children[0].children[1].dispatch('click')
  assert.equal(f.selectors['#minimap-panel'].parentNode, f.selectors['#movement-panel'])
  f.button('Reset layout').dispatch('click'); f.button('Done editing').dispatch('click')
  assert.equal(f.grid.classList.contains('overview-fitted'), true)
  assert.deepEqual(f.settings.overviewLayout.global, model.presets.Default)
})

test('inventory starts at natural height, persists resizing, and Reset layout restores natural height', () => {
  const f = fixture(), inventory = () => f.grid.querySelector('[data-module="inventory"]')
  assert.equal(inventory().style.height, undefined)
  assert.equal(f.editor.resizeInventory(280), true)
  assert.equal(inventory().style.height, '280px')
  assert.equal(f.settings.overviewLayout.inventoryHeight, 280)
  assert.equal(f.editor.inventoryHeight(), 280)
  f.editor.refresh(true)
  assert.equal(inventory().style.height, '280px')
  f.button('Edit layout').dispatch('click')
  assert.equal(f.editor.resizeInventory(400), false)
  f.button('Reset layout').dispatch('click'); f.button('Done editing').dispatch('click')
  assert.equal(inventory().style.height, undefined)
})

test('new account overrides survive switching accounts, and reset stays scoped', () => {
  const f = fixture()
  f.button('Edit layout').dispatch('click')
  const checkbox = f.toolbar.children[1].children[0].children[0]
  checkbox.checked = true; checkbox.dispatch('change')
  f.grid.querySelector('[data-handle="console"]').dispatch('keydown', { key: 'ArrowDown' })
  const one = f.settings.overviewLayout.overrides.one
  assert.ok(one); assert.notDeepEqual(one, model.presets.Default)
  f.account('two')
  assert.equal(checkbox.checked, false)
  f.account('one')
  assert.equal(checkbox.checked, true)
  assert.deepEqual(f.settings.overviewLayout.overrides.one, one)
  f.button('Reset layout').dispatch('click')
  assert.deepEqual(f.settings.overviewLayout.overrides.one, model.presets.Default)
  assert.deepEqual(f.settings.overviewLayout.global, model.presets.Default)
})
