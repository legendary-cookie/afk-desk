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

test('account rail shows bounded online health and food and updates just the affected meters', () => {
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
  assert.deepEqual(vitals.children.map(meter => meter.value), [12, 19])
  assert.equal(vitals.children[0].attributes['aria-label'], 'Health: 12 of 20')
  assert.equal(rows[1].querySelector('.account-vitals').hidden, true)
  assert.match(rows[1].querySelector('.account-item').className, /offline/)
  h.state.telemetry.set('one', { health: -2, food: 500 })
  h.context.updateAccountVitals('one')
  assert.deepEqual(vitals.children.map(meter => meter.value), [0, 20])
  assert.equal(h.el['account-list'].querySelectorAll('.account-row')[0], rows[0], 'telemetry must retain account buttons and focus')
  h.state.telemetry.set('one', { health: NaN, food: Infinity })
  h.context.updateAccountVitals('one')
  assert.deepEqual(vitals.children.map(meter => meter.value), [0, 0])
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
