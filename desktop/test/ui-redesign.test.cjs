const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const mask = require('../src/streamer-mask.js')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')

// Execute renderer functions with a small DOM, retaining text safety and events.
class Element {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.events = {}
    this.style = {}
    this.className = ''
    this._text = ''
  }
  set innerHTML(_) { throw new Error('Untrusted HTML is forbidden') }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child) } }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null }); this.children = []; this.append(...children) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(type, listener) { this.events[type] = listener }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.className.split(' ').includes(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] }
}
function harness() {
  const state = { accounts: [], settings: { streamerMode: false }, telemetry: new Map(), selectedId: 'one' }
  const el = { 'account-list': new Element('nav'), 'account-count': new Element('span'), 'toast-region': new Element('div') }
  const statuses = new Map()
  const timers = []
  const context = vm.createContext({
    state, el, document: { createElement: tag => new Element(tag) },
    getStatus: id => ({ status: statuses.get(id) || 'offline' }),
    displayAccount: account => mask.displayAccount(account, state.settings.streamerMode),
    maskText: value => mask.maskText(value, state.accounts, state.settings.streamerMode),
    createPlayerHead: () => new Element('span'), createOrderButton: () => new Element('button'),
    clearDragStyles() {}, render() {}, releaseAllManualInputs() {}, hideItemTooltip() {},
    setTimeout: (callback, delay) => timers.push({ callback, delay })
  })
  vm.runInContext(source.slice(source.indexOf('function renderAccountList('), source.indexOf('function createOrderButton(')), context)
  vm.runInContext(source.slice(source.indexOf('function toast('), source.indexOf('\ninit().catch')), context)
  return { context, state, el, statuses, timers }
}

test('account rail shows bounded online health and food and updates just the affected bars', () => {
  const h = harness()
  h.state.accounts = [{ id: 'one', label: 'One', host: 'local' }, { id: 'two', label: 'Two', host: 'local' }]
  h.statuses.set('one', 'online')
  h.state.telemetry.set('one', { health: 12, food: 19 })
  h.context.renderAccountList()
  const rows = h.el['account-list'].querySelectorAll('.account-row')
  const first = rows[0].querySelector('.account-item')
  assert.match(first.className, /online/)
  const vitals = first.querySelector('.account-vitals')
  assert.equal(vitals.hidden, false)
  const values = () => vitals.children.map(meter => Number(meter.attributes['aria-valuenow']))
  assert.deepEqual(values(), [12, 19])
  assert.equal(vitals.title, 'Health 12/20 · Food 19/20')
  assert.equal(vitals.children[0].attributes['aria-label'], 'Health')
  assert.equal(vitals.children[1].attributes['aria-label'], 'Food')
  assert.equal(vitals.children[0].attributes.role, 'meter')
  assert.equal(vitals.children[0].attributes['aria-valuemin'], '0')
  assert.equal(vitals.children[0].attributes['aria-valuemax'], '20')
  assert.deepEqual(vitals.children.map(meter => meter.children[0].style.width), ['60%', '95%'])
  assert.deepEqual(vitals.children.map(meter => meter.className), ['account-vital warn', 'account-vital ok'])
  assert.equal(rows[1].querySelector('.account-vitals').hidden, true)
  assert.match(rows[1].querySelector('.account-item').className, /offline/)
  h.state.telemetry.set('one', { health: -2, food: 500 })
  h.context.updateAccountVitals('one')
  assert.deepEqual(values(), [0, 20])
  assert.equal(vitals.title, 'Health 0/20 · Food 20/20')
  assert.deepEqual(vitals.children.map(meter => meter.children[0].style.width), ['0%', '100%'])
  assert.deepEqual(vitals.children.map(meter => meter.className), ['account-vital danger', 'account-vital ok'])
  assert.equal(h.el['account-list'].querySelectorAll('.account-row')[0], rows[0], 'telemetry must retain account buttons and focus')
  h.state.telemetry.set('one', { health: NaN, food: Infinity })
  h.context.updateAccountVitals('one')
  assert.deepEqual(values(), [0, 0])
  for (const [value, color] of [[6, 'danger'], [7, 'warn'], [14, 'warn'], [15, 'ok']]) {
    h.state.telemetry.set('one', { health: value, food: value })
    h.context.updateAccountVitals('one')
    assert.ok(vitals.children.every(meter => meter.className === `account-vital ${color}`))
  }
  h.context.updateAccountVitals('unknown')
  assert.match(source, /state\.telemetry\.set\(id, payload\)\s+updateAccountVitals\(id\)/)
})

test('linked account sections retain native collapse state, row hooks and safe masked text', () => {
  const h = harness()
  const group = { id: 'group', name: 'One <linked>' }
  h.state.accounts = [{ id: 'one', label: 'One', host: 'local', linkGroup: group }, { id: 'two', label: '<Two>', host: 'local', linkGroup: group }, { id: 'three', label: 'Three', host: 'local' }]
  h.context.renderAccountList()
  let section = h.el['account-list'].children[0]
  assert.equal(section.tagName, 'details')
  assert.equal(section.open, true)
  assert.equal(section.children[0].textContent, 'One <linked>')
  assert.deepEqual(section.querySelectorAll('.account-row').map(row => row.dataset.accountId), ['one', 'two'])
  assert.equal(section.querySelectorAll('.account-copy')[1].children[0].textContent, '<Two>')
  section.open = false
  h.state.settings.streamerMode = true
  h.context.renderAccountList()
  section = h.el['account-list'].children[0]
  assert.equal(section.open, false)
  assert.equal(section.children[0].textContent, `${mask.label(h.state.accounts[0])} <linked>`)
  assert.equal(section.querySelector('.account-copy').children[0].textContent, mask.label(h.state.accounts[0]))
  assert.equal(h.el['account-list'].children[1].dataset.accountId, 'three')
  assert.equal(typeof section.querySelector('.account-item').events.click, 'function')
})

test('toasts mask literal text, ordinary notices expire after four seconds, and errors require dismissal', () => {
  const h = harness()
  h.state.accounts = [{ id: 'one', label: 'PrivateName' }]
  h.state.settings.streamerMode = true
  h.context.toast('<PrivateName> joined')
  const normal = h.el['toast-region'].children[0]
  assert.equal(normal.querySelector('.toast-message').textContent, `<${mask.label(h.state.accounts[0])}> joined`)
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].delay, 4000)
  h.context.toast('PrivateName failed <script>', 'error')
  const error = h.el['toast-region'].children[1]
  assert.equal(h.timers.length, 1, 'errors remain until explicitly dismissed')
  assert.equal(error.querySelector('.toast-message').textContent, `${mask.label(h.state.accounts[0])} failed <script>`)
  const dismiss = error.querySelector('.toast-dismiss')
  assert.equal(dismiss.attributes['aria-label'], 'Dismiss notification')
  dismiss.events.click()
  assert.deepEqual(h.el['toast-region'].children, [normal])
  h.timers[0].callback()
  assert.equal(h.el['toast-region'].children.length, 0)
})

test('header presence uses short sentence-case labels and preserves connection and chat actions', () => {
  const h = harness()
  h.state.accounts = [{ id: 'one', label: 'PrivateName' }]
  h.state.settings.streamerMode = true
  const send = new Element('button')
  for (const id of ['status-banner', 'status-name', 'status-detail', 'connection-button', 'chat-message']) h.el[id] = new Element('span')
  h.el['chat-form'] = { querySelector: () => send }
  h.context.document.querySelectorAll = () => []
  h.context.renderMacroPad = () => {}
  h.context.updateInventoryActions = () => {}
  h.context.closeChatSuggestions = () => {}
  vm.runInContext(source.slice(source.indexOf('function renderStatus('), source.indexOf('function renderConsole(')), h.context)
  for (const [status, word, action, disabled] of [
    ['online', 'Online', 'Disconnect', false],
    ['connecting', 'Connecting', 'Disconnect', true],
    ['connected', 'Connecting', 'Disconnect', false],
    ['reconnecting', 'Connecting', 'Cancel reconnect', true],
    ['offline', 'Offline', 'Connect', true],
    ['error', 'Offline', 'Connect', true]
  ]) {
    h.context.renderStatus({ status, detail: 'PrivateName <status>' })
    assert.equal(h.el['status-name'].textContent, word)
    assert.equal(h.el['connection-button'].textContent, action)
    assert.equal(h.el['chat-message'].disabled, disabled)
    assert.equal(send.disabled, disabled)
    assert.equal(h.el['status-banner'].title, `${mask.label(h.state.accounts[0])} <status>`)
    assert.equal(h.el['status-detail'].textContent, `${mask.label(h.state.accounts[0])} <status>`)
  }
})

test('truncated details keep literal tooltips and refresh them when streamer mode changes', () => {
  const h = harness()
  h.state.accounts = [{ id: 'one', username: 'private@example.com', label: 'PrivateName' }]
  h.el['detail-username'] = new Element('dd')
  h.el['detail-chest'] = new Element('dd')
  vm.runInContext(source.slice(source.indexOf('function setDetailValue('), source.indexOf('function renderTelemetry(')), h.context)
  for (const streaming of [false, true, false]) {
    h.state.settings.streamerMode = streaming
    h.context.setDetailValue('detail-username', 'private@example.com')
    h.context.setDetailValue('detail-chest', '<PrivateName> chest at 368, -48, 10214 (1.5 blocks)')
    for (const [id, raw] of [['detail-username', 'private@example.com'], ['detail-chest', '<PrivateName> chest at 368, -48, 10214 (1.5 blocks)']]) {
      const expected = mask.maskText(raw, h.state.accounts, streaming)
      assert.equal(h.el[id].textContent, expected)
      assert.equal(h.el[id].title, expected)
    }
  }
  assert.match(source, /setDetailValue\('detail-username', state\.settings\.streamerMode \? displayAccount\(account\) : account\.username\)/)
  assert.match(source, /setDetailValue\('detail-chest', telemetry\?\.nearestChest/)
})

const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
const rules = selector => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].trim().split(',').map(value => value.trim()).includes(selector)).map(match => match[2]).join('\n')

test('details retain two dense columns and ellipsis even at narrow container sizes', () => {
  assert.match(rules(':root[data-workspace] .details-list'), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(rules(':root[data-workspace] .details-list div'), /display: block/)
  assert.match(rules(':root[data-workspace] .details-list dt'), /color: var\(--muted\); font-size: 12px/)
  assert.match(rules(':root[data-workspace] .details-list dd'), /text-overflow: ellipsis; white-space: nowrap; font: 400 13px/)
  assert.match(rules(':root[data-workspace] .details-list dd'), /font-variant-numeric: tabular-nums/)
  assert.match(rules('.overview-auto .details-list'), /flex: 0 0 auto; overflow: visible/)
  assert.match(rules('.overview-measuring .details-list'), /flex: 0 0 auto; overflow: visible/)
})

test('inventory chrome follows the theme while counts remain white and the held slot uses lapis', () => {
  assert.match(rules('.minecraft-inventory'), /border: 1px solid var\(--line\); border-radius: 10px; background: var\(--surface\)/)
  assert.match(rules('.minecraft-inventory .minecraft-slot'), /border: 0; background: var\(--raised\); box-shadow: inset 0 0 0 1px var\(--line\)/)
  assert.match(rules('.minecraft-inventory .minecraft-slot.held'), /outline: 2px solid var\(--accent\)/)
  assert.match(rules('.minecraft-inventory .minecraft-slot.selected'), /outline: 2px solid var\(--accent\)/)
  assert.match(rules('.minecraft-inventory .minecraft-slot:focus-visible'), /outline: 2px solid var\(--accent\); outline-offset: 2px/)
  assert.match(rules('.minecraft-item-count'), /color: var\(--item-ink\); text-shadow: 0 1px 2px var\(--item-shadow\)/)
  assert.match(css, /--item-ink: #FFFFFF/)
  assert.match(rules('.minecraft-section-label'), /color: var\(--muted\); font: 12px/)
  for (const label of ['Gear', 'Inventory', 'Hotbar']) assert.ok(source.includes(`createInventorySection('${label}'`))
})

test('rail bars are rounded and reorder arrows appear on hover and keyboard focus', () => {
  assert.match(rules('.account-vitals'), /width: 24px/)
  assert.match(rules('.account-vitals[hidden]'), /display: none/)
  assert.match(rules('.account-vital'), /width: 24px; height: 2px; border-radius: 999px/)
  assert.match(rules('.account-vital.warn > span'), /var\(--warn\)/)
  assert.match(rules('.account-vital.danger > span'), /var\(--danger\)/)
  assert.match(rules('.account-order-controls'), /opacity: 0/)
  for (const selector of ['.account-row:hover .account-order-controls', '.account-row:focus-within .account-order-controls']) assert.match(rules(selector), /opacity: 1/)
})

test('panel icons, header search and compact empty states share consistent chrome', () => {
  for (const selector of ['.section-toggle', '.panel-header .icon-menu-trigger', '.macro-header .icon-menu-trigger']) {
    assert.match(rules(selector), /width: 28px; height: 28px; min-height: 28px; padding: 0; border: 0/)
  }
  assert.match(html, /id="open-command-center"[^>]*><span>Search or run a command<\/span><kbd>Ctrl K<\/kbd>/)
  assert.match(rules('.topbar-actions #open-command-center'), /border: 1px solid var\(--line\); background: var\(--raised\)/)
  assert.match(rules(':root[data-workspace] .topbar-actions .button'), /min-height: 32px; height: 32px/)
  assert.match(rules('.topbar-actions > .icon-menu-trigger'), /width: 32px; height: 32px/)
  for (const selector of ['.game-hud.module-empty', '#overview-next-runs.module-empty']) assert.match(rules(selector), /padding: 12px; color: var\(--muted\); font: 12px\/1.45/)
})

test('light tokens and both collapsed rails keep content inside the available width', () => {
  for (const [token, value] of [['surface', '#FFFFFF'], ['raised', '#F0F1F4'], ['line', '#E3E5EA']]) assert.ok(rules(':root[data-theme="arctic"]').includes(`--${token}: ${value}`))
  assert.match(css, /@media \(max-width: 1099px\)/)
  for (const rail of ['.app-shell', '.app-shell.sidebar-collapsed']) {
    assert.match(rules(`:root ${rail} .sidebar`), /width: 56px;[^}]*overflow: hidden/)
    assert.match(rules(`:root ${rail} .account-list`), /min-height: 0;[^}]*overflow-x: hidden; overflow-y: auto/)
    assert.match(rules(`:root ${rail} .account-row`), /width: 40px; min-width: 0/)
    for (const part of ['account-copy', 'account-order-controls', 'account-vitals']) assert.match(rules(`:root ${rail} .${part}`), /display: none !important/)
  }
  assert.match(rules('.command-center-trigger > span'), /overflow: hidden; text-overflow: ellipsis/)
})
