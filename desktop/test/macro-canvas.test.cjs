'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const contract = require('../electron/macro/contract.cjs')
const { NODE_KINDS } = require('../electron/macro/graph-contract.cjs')
const model = require('../electron/macro/graph-model.cjs')
const plain = value => JSON.parse(JSON.stringify(value))

// A small DOM with bubbling, hit-testing, selectors and form events. The tests
// execute the actual browser scripts, never a reimplementation of the editor.
function dom() {
  let document
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null
      this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {}; this.className = ''; this.value = ''; this._text = ''; this.hidden = false
      this.ownerDocument = document
      this.classList = {
        contains: token => this.className.split(/\s+/).includes(token),
        add: (...tokens) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...tokens])].join(' ') },
        remove: token => { this.className = this.className.split(/\s+/).filter(value => value !== token).join(' ') },
        toggle: (token, force) => { const add = force ?? !this.classList.contains(token); add ? this.classList.add(token) : this.classList.remove(token); return add }
      }
    }
    set innerHTML(_) { throw Error('Untrusted HTML is forbidden') }
    get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
    set textContent(value) { this._text = String(value); this.replaceChildren() }
    append(...items) { for (const item of items) { if (item.parentElement) item.parentElement.children = item.parentElement.children.filter(child => child !== item); this.children.push(item); item.parentElement = this } }
    prepend(...items) { this.append(...items); this.children = [...items, ...this.children.filter(item => !items.includes(item))] }
    replaceChildren(...items) { for (const item of this.children) item.parentElement = null; this.children = []; this.append(...items) }
    setAttribute(key, value) {
      this.attrs[key] = String(value)
      if (key === 'class') this.className = value
      else if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
      else if (['hidden', 'disabled', 'checked'].includes(key)) this[key] = true
      else if (['id', 'type', 'value'].includes(key)) this[key] = String(value)
    }
    getAttribute(key) { return this.attrs[key] }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim()
        const chain = part.split(/\s+/)
        if (chain.length > 1) { if (!this.matches(chain.pop())) return false; let parent = this.parentElement; while (parent) { if (parent.matches(chain.join(' '))) return true; parent = parent.parentElement } return false }
        const tag = part.match(/^[a-z][\w-]*/i)?.[0]
        if (tag && this.tagName !== tag.toUpperCase()) return false
        for (const [, cls] of part.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(cls)) return false
        for (const [, key, quoted, bare] of part.matchAll(/\[([\w-]+)(?:="([^"]*)"|=([^\]]+))?\]/g)) {
          const value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this[key] ?? this.attrs[key]
          if (value === undefined || ((quoted ?? bare) !== undefined && String(value) !== (quoted ?? bare))) return false
        }
        return true
      })
    }
    closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentElement } return null }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    get options() { return this.querySelectorAll('option') }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500 } }
    focus() { document.activeElement = this }
    showModal() { this.open = true }
    close() { this.open = false }
    setPointerCapture() {}
    hasPointerCapture() { return false }
    select() {}
    setCustomValidity(message) { this.validationMessage = message }
    reportValidity() {}
    fire(type, init = {}) {
      const event = { type, target: this, button: 0, clientX: 0, clientY: 0, pointerId: 1, key: '', preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...init }
      const route = []; for (let node = this; node; node = node.parentElement) route.push(node)
      for (const node of route) { for (const fn of node.listeners[type] || []) fn(event); if (event.stopped) break }
      return event
    }
  }
  document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), elementFromPoint: () => document.hit }
  document.body = document.createElement('body')
  return document
}
function scripts(document, api) {
  const window = { afkDesk: api }
  const context = vm.createContext({ window, document, structuredClone, setTimeout, clearTimeout, console, requestAnimationFrame: fn => fn() })
  for (const file of ['streamer-mask.js', 'macro-graph-edit.js', 'macro-graph-live.js', 'macro-canvas.js', 'macro-editor.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context, { filename: file })
  return window
}
function graph() {
  return { id: 'm', name: 'Graph', version: 3, targets: { mode: 'all' }, stopWhen: [], vars: [], nodes: [
    { id: 'start', kind: 'trigger.manual', params: {}, position: { x: 0, y: 0 } },
    { id: 'chat', kind: 'chat', params: { message: '<Steve>' }, position: { x: 400, y: 0 } },
    { id: 'health', kind: 'health', params: {}, position: { x: 0, y: 240 } }
  ], edges: [{ id: 'flow', from: { node: 'start', port: 'out' }, to: { node: 'chat', port: 'in' } }] }
}
function canvasHarness(input = graph(), overrides = {}) {
  const document = dom(), window = scripts(document), container = document.createElement('section')
  document.body.append(container)
  const changes = [], canvas = window.afkMacroCanvas.create(container, { graph: input, kinds: NODE_KINDS, createSchemaFields: window.afkMacroEditor.createSchemaFields, onChange: graph => changes.push(plain(graph)), ...overrides })
  const find = selector => container.querySelector(selector)
  const card = id => find(`.macro-canvas-node[data-node-id="${id}"]`)
  const port = (id, name, direction) => find(`.macro-canvas-port[data-node-id="${id}"][data-port="${name}"][data-direction="${direction}"]`)
  const viewport = find('.macro-canvas-viewport')
  const dragPort = (a, b) => { a.fire('pointerdown'); document.hit = b; viewport.fire('pointermove', { clientX: 250, clientY: 100 }); viewport.fire('pointerup'); document.hit = null }
  const tool = text => container.querySelectorAll('.macro-canvas-toolbar button').find(button => button.textContent === text)
  return { document, window, container, canvas, changes, find, card, port, viewport, dragPort, tool }
}

test('browser canvas renders real cards and Bezier edges, type-checks port gestures in either direction and records undo/redo', () => {
  const h = canvasHarness()
  assert.equal(h.container.querySelectorAll('.macro-canvas-node').length, 3)
  assert.equal(h.container.querySelectorAll('.macro-canvas-wire').length, 1)
  assert.match(h.find('.macro-canvas-wire').getAttribute('d'), /^M .* C /)
  assert.ok(h.card('chat').querySelector('header').style.backgroundColor)
  assert.match(h.card('chat').textContent, /<Steve>/)
  const from = h.port('health', 'value', 'output')
  from.fire('pointerdown')
  assert.equal(h.port('chat', 'in', 'input').classList.contains('incompatible'), true)
  assert.equal(h.port('chat', 'message', 'input').classList.contains('incompatible'), true)
  h.document.hit = h.port('chat', 'in', 'input'); h.viewport.fire('pointerup')
  assert.equal(h.canvas.getGraph().edges.length, 1)
  assert.match(h.find('.macro-canvas-message').textContent, /Incompatible/)
  // A numeric health output can feed a number parameter, but not chat text.
  const next = h.canvas.getGraph(); next.nodes.push({ id: 'slot', kind: 'selectHotbar', params: {}, position: { x: 400, y: 240 } }); h.canvas.setGraph(next)
  h.dragPort(h.port('slot', 'slot', 'input'), h.port('health', 'value', 'output'))
  assert.equal(h.canvas.getGraph().edges.length, 2)
  assert.equal(h.changes.at(-1).edges[1].from.node, 'health')
  h.tool('↶ Undo').fire('click'); assert.equal(h.canvas.getGraph().edges.length, 1)
  h.tool('↷ Redo').fire('click'); assert.equal(h.canvas.getGraph().edges.length, 2)
  h.dragPort(h.port('health', 'value', 'output'), h.port('slot', 'slot', 'input'))
  assert.match(h.find('.macro-canvas-message').textContent, /already connected/)
  assert.equal(h.canvas.getGraph().edges.length, 2)
})

test('pan, pointer-anchored zoom, snapping and node drag form one undo transaction; cancellation restores position', () => {
  const h = canvasHarness(), surface = h.find('.macro-canvas-surface')
  h.viewport.fire('pointerdown', { clientX: 50, clientY: 50 }); h.viewport.fire('pointermove', { clientX: 100, clientY: 80 }); h.viewport.fire('pointerup')
  assert.equal(surface.style.transform, 'translate(80px, 80px) scale(1)')
  h.viewport.fire('wheel', { clientX: 100, clientY: 100, deltaY: -200 })
  assert.match(surface.style.transform, /scale\(1\.22/)
  h.tool('Fit').fire('click')
  h.card('chat').fire('pointerdown', { clientX: 450, clientY: 90 })
  h.viewport.fire('pointermove', { clientX: 487, clientY: 111 }); h.viewport.fire('pointerup', { clientX: 487, clientY: 111 })
  assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), { x: 440, y: 20 })
  h.canvas.undo(); assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), { x: 400, y: 0 })
  h.find('input[type="checkbox"]').checked = false; h.find('input[type="checkbox"]').fire('change')
  h.card('chat').fire('pointerdown', { clientX: 450, clientY: 90 }); h.viewport.fire('pointermove', { clientX: 463, clientY: 103 }); h.viewport.fire('pointerup', { clientX: 463, clientY: 103 })
  assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), { x: 413, y: 13 })
  h.card('chat').fire('pointerdown'); h.viewport.fire('pointermove', { clientX: 100, clientY: 100 }); h.viewport.fire('pointercancel')
  assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), { x: 413, y: 13 })
  const before = surface.style.transform
  h.card('chat').fire('pointerdown', { button: 1 }); h.viewport.fire('pointermove', { clientX: 40 }); h.viewport.fire('pointerup')
  assert.notEqual(surface.style.transform, before)
})

test('box-select, copy/paste with internal edges, Delete, keyboard history and input isolation', () => {
  const h = canvasHarness()
  h.viewport.fire('pointerdown', { shiftKey: true, clientX: 10, clientY: 20 })
  h.viewport.fire('pointermove', { clientX: 700, clientY: 230 }); h.viewport.fire('pointerup')
  assert.equal(h.container.querySelectorAll('.macro-canvas-node.selected').length, 2)
  h.viewport.fire('keydown', { key: 'c', ctrlKey: true }); h.viewport.fire('keydown', { key: 'v', ctrlKey: true })
  assert.equal(h.canvas.getGraph().nodes.length, 5); assert.equal(h.canvas.getGraph().edges.length, 2)
  h.viewport.fire('keydown', { key: 'Delete' }); assert.equal(h.canvas.getGraph().nodes.length, 3); assert.equal(h.canvas.getGraph().edges.length, 1)
  h.viewport.fire('keydown', { key: 'z', ctrlKey: true }); assert.equal(h.canvas.getGraph().nodes.length, 5)
  h.viewport.fire('keydown', { key: 'z', ctrlKey: true, shiftKey: true }); assert.equal(h.canvas.getGraph().nodes.length, 3)
  h.card('chat').fire('pointerdown'); h.viewport.fire('pointerup')
  const input = h.find('.macro-canvas-inspector input')
  input.value = 'edited <script>'; input.fire('change')
  assert.equal(h.canvas.getGraph().nodes[1].params.message, 'edited <script>')
  const current = h.find('.macro-canvas-inspector input')
  current.fire('keydown', { key: 'Delete' }); assert.equal(h.canvas.getGraph().nodes.length, 3)
  h.find('.macro-canvas-wire-hit').fire('pointerdown'); h.viewport.fire('keydown', { key: 'Delete' }); assert.equal(h.canvas.getGraph().edges.length, 0)
})

test('palette search and dropping a node onto a wire insert it; isolated existing nodes can be inserted by pointer drag', () => {
  const h = canvasHarness()
  const search = h.find('input[type="search"]'); search.value = 'wait'; search.fire('input')
  assert.ok(h.container.querySelectorAll('.macro-canvas-palette button').every(button => /wait/i.test(button.textContent)))
  h.find('.macro-canvas-wire-hit').fire('drop', { clientX: 340, clientY: 120, dataTransfer: { getData: () => 'wait' } })
  assert.equal(h.canvas.getGraph().nodes.length, 4); assert.equal(h.canvas.getGraph().edges.length, 2)
  const node = h.canvas.getGraph().nodes.at(-1)
  assert.equal(node.kind, 'wait'); assert.deepEqual(plain(node.position), { x: 320, y: 80 })
  assert.equal(h.canvas.getGraph().edges[0].to.node, node.id)
  h.canvas.undo()
  // Click-to-add also works without dragging.
  h.container.querySelectorAll('.macro-canvas-palette button').find(button => button.dataset.kind === 'wait').fire('click')
  const added = h.canvas.getGraph().nodes.at(-1)
  h.card(added.id).fire('pointerdown', { clientX: 100, clientY: 200 })
  h.viewport.fire('pointermove', { clientX: 340, clientY: 120 }); h.viewport.fire('pointerup', { clientX: 340, clientY: 120 })
  assert.equal(h.canvas.getGraph().edges.length, 2)
  assert.equal(h.canvas.getGraph().edges[0].to.node, added.id)
  h.canvas.undo(); assert.equal(h.canvas.getGraph().edges.length, 1)
})

test('validation and live overlays mask text without changing the graph or history', () => {
  let masked = false
  const h = canvasHarness(graph(), { mask: value => value.replaceAll('Steve', 'Acc•••'), isMasked: () => masked })
  const original = plain(h.canvas.getGraph())
  h.canvas.setErrors([{ path: '/nodes/chat/message', message: 'Steve needs a message' }])
  h.canvas.setLive({ status: 'started', nodeId: 'chat', values: { flow: '<Steve>' }, errors: { chat: '<Steve> failed' } })
  assert.ok(h.card('chat').classList.contains('live-running')); assert.ok(h.card('chat').classList.contains('live-failed'))
  assert.match(h.card('chat').textContent, /Acc••• needs a message/)
  assert.match(h.find('.macro-graph-wire-label').textContent, /<Acc•••>/)
  assert.ok(!h.container.textContent.includes('Steve'))
  h.card('chat').fire('pointerdown'); h.viewport.fire('pointerup')
  masked = true; h.canvas.refresh()
  const input = h.find('.macro-canvas-inspector input'); assert.equal(input.disabled, true); assert.equal(input.value, '')
  assert.deepEqual(plain(h.canvas.getGraph()), original)
  assert.equal(h.tool('↶ Undo').disabled, true)
})

async function editorHarness(input, validation = {}, services = {}) {
  const document = dom(), el = {}, stack = [document.body]
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
    const [whole, tag, attrs] = match
    if (whole.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    const node = document.createElement(tag)
    for (const [, key, value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(key, value ?? '')
    stack.at(-1).append(node); if (node.id) el[node.id] = node
    if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag.toLowerCase()) && !whole.endsWith('/>')) stack.push(node)
  }
  let stored = plain(input), failure = null
  const saves = [], toasts = [], customSaves = [], customRemoves = []
  let customNodes = services.customNodes || []
  const api = { macros: {
    contract: async () => ({ triggers: contract.TRIGGER_TYPES, steps: contract.STEP_TYPES, conditions: contract.CONDITION_METADATA, graphKinds: NODE_KINDS }),
    list: async () => ({ macros: [stored], validation, customNodes }),
    saveCustom: async value => { customSaves.push(plain(value)); customNodes = [...customNodes.filter(item => item.id !== value.id), plain(value)]; return plain(value) },
    removeCustom: async id => { customRemoves.push(id); customNodes = customNodes.filter(item => item.id !== id) },
    save: async value => { if (failure) throw failure; saves.push(plain(value)); stored = plain(value); return stored }
  } }
  Object.assign(api, services)
  const window = scripts(document, api), state = { selectedId: 'a', settings: { streamerMode: false }, accounts: [{ id: 'a', username: 'Steve', edition: 'java' }] }
  const editor = window.afkMacroEditor.createMacroEditor({ api, state, el, toast: (...args) => toasts.push(args), cleanError: error => error.message })
  await editor.open()
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { document, window, state, el, editor, saves, customSaves, customRemoves, toasts, settle, fail(error) { failure = error } }
}

test('full editor vm/DOM integration renders nodes/edges, connects ports and saves an equivalent v3 graph', async () => {
  const h = await editorHarness(graph())
  const host = h.el['macro-canvas'], viewport = host.querySelector('.macro-canvas-viewport')
  assert.equal(host.hidden, false); assert.equal(h.el['macro-steps-card'].hidden, true)
  assert.equal(host.querySelectorAll('.macro-canvas-node').length, 3); assert.equal(host.querySelectorAll('.macro-canvas-wire').length, 1)
  // Add a number action using the palette and connect its value port in the UI.
  host.querySelector('[data-kind="selectHotbar"]').fire('click')
  const output = host.querySelector('.macro-canvas-port[data-node-id="health"][data-port="value"]')
  const target = host.querySelectorAll('.macro-canvas-port').find(port => port.dataset.port === 'slot')
  output.fire('pointerdown'); h.document.hit = target; viewport.fire('pointerup'); h.document.hit = null
  h.el['macro-json-toggle'].fire('click')
  const expected = JSON.parse(h.el['macro-draft-json'].value)
  assert.equal(expected.edges.length, 2)
  assert.equal(expected.edges[1].from.node, 'health')
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.deepEqual(h.saves[0], expected); assert.equal(h.saves[0].version, 3)
  assert.equal(model.validateGraph(h.saves[0]).length, 0)
  h.el['macro-json-toggle'].fire('click')
  h.editor.handleMacroRunEvent({ macroId: 'm', accountId: 'a', runId: 'r', status: 'started' })
  h.editor.handleMacroRunEvent({ macroId: 'm', accountId: 'a', runId: 'r', status: 'graphNode', nodeId: 'chat' })
  h.editor.handleMacroRunEvent({ macroId: 'm', accountId: 'a', runId: 'r', status: 'graphValue', edgeId: 'flow', value: '<Steve>' })
  assert.equal(host.querySelector('.macro-canvas-node.live-running').dataset.nodeId, 'chat')
  assert.match(host.querySelector('.macro-graph-wire-label').textContent, /<Steve>/)
  h.state.settings.streamerMode = true; h.editor.refreshDisplay()
  assert.ok(!host.textContent.includes('Steve'))
})

test('opening v2 migrates, Simple view preserves unchanged graph identity, edits save v3, and unsafe projections stay on canvas', async () => {
  const v2 = { id: 'm', name: 'Legacy', version: 2, targets: { mode: 'all' }, trigger: { type: 'join' }, steps: [{ type: 'chat', message: '/afk' }] }
  const h = await editorHarness(v2)
  assert.equal(h.el['macro-canvas'].querySelectorAll('.macro-canvas-node').length, 2)
  h.el['macro-simple-toggle'].fire('click'); assert.equal(h.el['macro-steps-card'].hidden, false)
  assert.equal(h.el['macro-step-list'].querySelectorAll('.macro-step-card').length, 1)
  h.el['macro-simple-toggle'].fire('click'); assert.equal(h.el['macro-canvas'].hidden, false)
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.deepEqual(model.toV2(h.saves[0]), v2)
  h.el['macro-simple-toggle'].fire('click')
  const input = h.el['macro-step-list'].querySelector('input[aria-label="Message"]') || h.el['macro-step-list'].querySelector('input')
  input.value = '/spawn'; input.fire('change')
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.equal(h.saves[1].version, 3); assert.equal(model.toV2(h.saves[1]).steps[0].message, '/spawn')
  const unsafe = await editorHarness(graph())
  unsafe.el['macro-simple-toggle'].fire('click'); assert.equal(unsafe.el['macro-canvas'].hidden, false)
  assert.match(unsafe.toasts.at(-1)[0], /needs Canvas/)
})

test('editor JSON errors, validation nodes, metadata history and new macro save paths remain usable', async () => {
  const h = await editorHarness(graph(), { m: [{ path: '/nodes/chat/message', message: 'Required message' }] })
  assert.match(h.el['macro-canvas'].querySelector('.macro-graph-error').textContent, /Required message/)
  h.el['macro-json-toggle'].fire('click'); h.el['macro-draft-json'].value = '{broken'
  h.el['macro-save-btn'].fire('click'); await h.settle(); assert.equal(h.saves.length, 0)
  assert.equal(h.el['macro-draft-json-error'].hidden, false)
  h.el['macro-draft-json'].value = JSON.stringify({ version: 3, nodes: null }); h.el['macro-json-toggle'].fire('click')
  assert.equal(h.el['macro-draft-json-error'].hidden, false)
  const modified = graph(); modified.nodes[1].params.message = 'from JSON'
  h.el['macro-draft-json'].value = JSON.stringify(modified); h.el['macro-json-toggle'].fire('click')
  assert.match(h.el['macro-canvas'].textContent, /from JSON/)
  h.el['macro-on-error'].value = 'stop'; h.el['macro-on-error'].fire('change')
  h.el['macro-undo-btn'].fire('click'); h.el['macro-json-toggle'].fire('click')
  assert.notEqual(JSON.parse(h.el['macro-draft-json'].value).onError, 'stop')
  h.el['macro-json-toggle'].fire('click')
  h.el['macro-new-btn'].fire('click')
  assert.equal(h.el['macro-canvas'].querySelectorAll('.macro-canvas-node').length, 2)
  h.el['macro-save-btn'].fire('click'); await h.settle(); assert.equal(h.saves.at(-1).version, 3)
})

test('Simple projection retains branch/loop structure and refuses unsupported paths without mutating the source', () => {
  const edit = require('../src/macro-graph-edit.js')
  for (const make of Object.values(require('../src/macro-editor.js').TEMPLATES)) {
    const original = make(), migrated = edit.migrateV2(original), before = structuredClone(migrated)
    const simple = edit.toSimple(migrated, contract.STEP_TYPES)
    assert.deepEqual(model.validateGraph(edit.migrateV2(simple)), [])
    assert.deepEqual(migrated, before)
  }
  const linear = model.migrateV2({ trigger: { type: 'manual' }, steps: [{ type: 'wait', ms: 1 }] })
  for (const change of [
    g => { g.nodes[1].disabled = true },
    g => { g.edges.push({ ...g.edges[0], id: 'fan-out' }) },
    g => { g.edges.push({ id: 'cycle', from: { node: g.nodes[1].id, port: 'out' }, to: { node: g.nodes[1].id, port: 'in' } }) },
    g => { g.vars = [{ name: 'x' }] },
    g => { g.nodes.push({ id: 'extra', kind: 'trigger.join', params: {} }) },
    g => { g.edges[0].to.port = 'ms' }
  ]) { const candidate = plain(linear); change(candidate); assert.throws(() => edit.toSimple(candidate, contract.STEP_TYPES), /needs Canvas/) }
})

test('initial fit reveals distant nodes, box-select tool works without Shift, and Escape cancels wiring', () => {
  const input = graph(); input.nodes[1].position.x = 1500
  const h = canvasHarness(input)
  assert.match(h.find('.macro-canvas-surface').style.transform, /scale\(0\./)
  h.port('start', 'out', 'output').fire('pointerdown')
  assert.ok(h.find('.macro-canvas-preview') === null) // preview appears on pointer move
  h.viewport.fire('pointermove', { clientX: 100, clientY: 100 }); assert.ok(h.find('.macro-canvas-preview'))
  h.viewport.fire('keydown', { key: 'Escape' }); assert.equal(h.find('.macro-canvas-preview'), null)
  assert.equal(h.canvas.getGraph().edges.length, 1)
  h.tool('Box select').fire('click'); h.viewport.fire('pointerdown'); h.viewport.fire('pointermove', { clientX: 800, clientY: 500 }); h.viewport.fire('pointerup')
  assert.equal(h.container.querySelectorAll('.macro-canvas-node.selected').length, 3)
})

test('global and canvas history stay in sync with macro identity/options, JSON masking preserves unsaved edits, and validation failures stay on nodes', async () => {
  const h = await editorHarness(graph())
  h.el['macro-name-input'].value = 'Renamed'; h.el['macro-name-input'].fire('input'); h.el['macro-name-input'].fire('change')
  h.el['macro-canvas'].querySelector('.macro-canvas-viewport').fire('keydown', { key: 'z', ctrlKey: true })
  assert.equal(h.el['macro-name-input'].value, 'Graph')
  h.el['macro-redo-btn'].fire('click'); assert.equal(h.el['macro-name-input'].value, 'Renamed')
  h.el['macro-on-error'].value = 'stop'; h.el['macro-on-error'].fire('change')
  h.el['macro-canvas'].querySelector('[data-kind="wait"]').fire('click')
  h.el['macro-json-toggle'].fire('click'); assert.equal(JSON.parse(h.el['macro-draft-json'].value).onError, 'stop')
  const edited = JSON.parse(h.el['macro-draft-json'].value); edited.name = 'JSON pending'
  h.el['macro-draft-json'].value = JSON.stringify(edited)
  h.state.settings.streamerMode = true; h.editor.refreshDisplay(); assert.equal(h.el['macro-draft-json-panel'].hidden, true)
  h.state.settings.streamerMode = false; h.editor.refreshDisplay(); assert.equal(h.el['macro-draft-json-panel'].hidden, false)
  assert.equal(JSON.parse(h.el['macro-draft-json'].value).name, 'JSON pending')
  h.el['macro-json-toggle'].fire('click')
  h.fail({ message: 'Invalid graph', validation: [{ path: '/nodes/chat/message', message: 'Fix message' }] })
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.match(h.el['macro-canvas'].querySelector('.macro-graph-error').textContent, /Fix message/)
})

test('live events during a drag keep the preview position and commit the moved node on release', () => {
  const h = canvasHarness(), original = h.canvas.getGraph()
  h.card('chat').fire('pointerdown', { clientX: 450, clientY: 90 })
  h.viewport.fire('pointermove', { clientX: 490, clientY: 110 })
  h.canvas.setGraph(original)
  h.canvas.setLive({ status: 'started', nodeId: 'chat', values: {}, errors: {} })
  assert.equal(h.card('chat').style.left, '440px')
  h.viewport.fire('pointerup', { clientX: 490, clientY: 110 })
  assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), { x: 440, y: 20 })
  h.canvas.undo(); assert.deepEqual(plain(h.canvas.getGraph().nodes[1].position), plain(original.nodes[1].position))
})

test('Simple view metadata edits keep v3 ids, labels, layout and wire ids', async () => {
  const original = graph(); original.nodes.pop(); original.nodes[1].label = 'Custom title'
  const h = await editorHarness(original)
  h.el['macro-simple-toggle'].fire('click')
  h.el['macro-name-input'].value = 'Renamed in Simple view'; h.el['macro-name-input'].fire('input')
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.deepEqual(h.saves[0].nodes, original.nodes)
  assert.deepEqual(h.saves[0].edges, original.edges)
  assert.equal(h.saves[0].name, 'Renamed in Simple view')
})

const tick = () => new Promise(resolve => setImmediate(resolve))
test('canvas custom-node flow: boundary ports, undo, palette placement, nested editing, rename, delete and share', async () => {
  const saves = [], deletes = [], shares = []
  const input = graph()
  input.nodes.push({ id: 'wait', kind: 'wait', params: { ms: 10 }, position: { x: 700, y: 0 } })
  input.edges.push({ id: 'after', from: { node: 'chat', port: 'out' }, to: { node: 'wait', port: 'in' } })
  const h = canvasHarness(input, {
    async saveCustom(value) { saves.push(plain(value)); return value },
    async removeCustom(id) { deletes.push(id) }, async shareCustom(id) { shares.push(id) }
  })
  h.card('chat').fire('pointerdown'); h.viewport.fire('pointerup')
  h.tool('Make custom node').fire('click'); await tick()
  assert.equal(saves.length, 1)
  const custom = h.canvas.getGraph().nodes.find(node => node.kind === 'group')
  assert.ok(h.port(custom.id, 'in1', 'input')); assert.ok(h.port(custom.id, 'out1', 'output'))
  assert.deepEqual(model.validateGraph(h.canvas.getGraph()), [])
  h.canvas.undo(); assert.ok(h.canvas.getGraph().nodes.some(node => node.id === 'chat'))
  h.canvas.redo(); assert.ok(h.canvas.getGraph().nodes.some(node => node.kind === 'group'))
  assert.ok(h.container.querySelector('.macro-custom-entry'))
  const entryButton = label => h.container.querySelector('.macro-custom-entry').querySelectorAll('button').find(button => button.textContent === label)
  entryButton('Share').fire('click'); await tick(); assert.deepEqual(shares, [custom.params.definition.id])
  entryButton('Open').fire('click')
  const overlay = h.find('.macro-custom-editor')
  assert.ok(overlay)
  assert.equal(overlay.querySelectorAll('.macro-canvas-node').length, 3) // chat + input/output proxies
  overlay.querySelector('.macro-canvas-node[data-node-id="chat"]').fire('pointerdown')
  overlay.querySelector('.macro-canvas-viewport').fire('pointerup')
  const text = overlay.querySelector('.macro-canvas-inspector input'); text.value = 'Edited <Steve>'; text.fire('change')
  overlay.querySelectorAll('button').find(button => button.textContent === 'Save custom node').fire('click'); await tick()
  assert.equal(h.find('.macro-custom-editor'), null)
  assert.equal(saves.at(-1).nodes[0].params.message, 'Edited <Steve>')
  assert.equal(saves.at(-1).nodes.some(node => node.kind.startsWith('boundary.')), false)
  assert.equal(h.canvas.getGraph().nodes.find(node => node.id === custom.id).params.definition.nodes[0].params.message, 'Edited <Steve>')
  const rename = h.container.querySelector('.macro-custom-entry input'); rename.value = '<Steve> helper'
  entryButton('Rename').fire('click'); await tick()
  assert.equal(saves.at(-1).name, '<Steve> helper')
  h.container.querySelector('.macro-custom-entry [data-custom-id]').fire('click')
  assert.equal(h.canvas.getGraph().nodes.filter(node => node.kind === 'group').length, 2)
  const groups = h.canvas.getGraph().nodes.filter(node => node.kind === 'group')
  assert.notEqual(groups[0].id, groups[1].id)
  entryButton('Delete custom node').fire('click'); await tick()
  assert.deepEqual(deletes, [custom.params.definition.id])
  assert.equal(h.find('.macro-custom-entry'), null)
  assert.equal(h.canvas.getGraph().nodes.filter(node => node.kind === 'group').length, 2)
})

test('custom-node controls handle selection errors and persistence failures, and mask names and inner text', async () => {
  let masked = false
  const h = canvasHarness(graph(), { mask: value => value.replaceAll('Steve', 'Acc•••'), isMasked: () => masked, async saveCustom() { throw new Error('disk full') } })
  h.tool('Make custom node').fire('click'); await tick()
  assert.match(h.find('.macro-canvas-message').textContent, /Select/)
  h.card('start').fire('pointerdown'); h.viewport.fire('pointerup')
  h.tool('Make custom node').fire('click'); await tick()
  assert.match(h.find('.macro-canvas-message').textContent, /Triggers/)
  h.card('chat').fire('pointerdown'); h.viewport.fire('pointerup')
  h.tool('Make custom node').fire('click'); await tick()
  assert.match(h.find('.macro-canvas-message').textContent, /disk full/)
  assert.deepEqual(plain(h.canvas.getGraph()), graph())
  const definition = { id: 'c', name: 'Steve helper', version: 3, nodes: [graph().nodes[1]], edges: [], inputs: { in1: { type: 'control', node: 'chat', port: 'in' } }, outputs: {} }
  h.canvas.setCustomNodes([definition]); masked = true; h.canvas.refresh()
  assert.ok(!h.container.textContent.includes('Steve'))
  assert.equal(h.container.querySelector('.macro-custom-entry input').value, '')
  assert.equal(h.container.querySelector('.macro-custom-entry input').disabled, true)
})

test('editor passes persistent custom definitions to the canvas, saves placements and imports shared custom nodes', async () => {
  const definition = { id: 'helper', name: 'Steve helper', version: 3, nodes: [{ id: 'delay', kind: 'wait', params: { ms: 20 } }], edges: [], inputs: { in1: { type: 'control', node: 'delay', port: 'in' } }, outputs: { out1: { type: 'control', node: 'delay', port: 'out' } } }
  const h = await editorHarness(graph(), {}, { customNodes: [definition], sharePreview: async () => ({ kind: 'custom', data: definition, errors: [] }) })
  h.el['macro-canvas'].querySelector('[data-custom-id="helper"]').fire('click')
  h.el['macro-save-btn'].fire('click'); await h.settle()
  assert.equal(h.saves[0].nodes.at(-1).kind, 'group')
  assert.deepEqual(h.saves[0].nodes.at(-1).params.definition, definition)
  h.window.askShareLink = async () => 'afkdesk://share/custom/example'
  h.el['macro-share-import'].fire('click'); await h.settle()
  assert.equal(h.customSaves.length, 1); assert.notEqual(h.customSaves[0].id, definition.id)
  assert.equal(h.el['macro-canvas'].querySelectorAll('.macro-custom-entry').length, 2)
})

test('custom group drops onto a wire with typed ports, and streamer refresh covers an open custom editor', async () => {
  let masked = false
  const definition = { id: 'helper', name: 'Steve helper', version: 3, nodes: [{ id: 'say', kind: 'chat', params: { message: 'Steve hello' } }], edges: [], inputs: { in1: { type: 'control', node: 'say', port: 'in' } }, outputs: { out1: { type: 'control', node: 'say', port: 'out' } } }
  const h = canvasHarness(graph(), { customNodes: [definition], mask: value => masked ? value.replaceAll('Steve', 'Acc•••') : value, isMasked: () => masked })
  h.find('.macro-canvas-wire-hit').fire('drop', { clientX: 340, clientY: 120, dataTransfer: { getData: () => 'custom:helper' } })
  assert.equal(h.canvas.getGraph().edges.length, 2)
  assert.equal(h.canvas.getGraph().nodes.at(-1).kind, 'group')
  h.container.querySelectorAll('.macro-custom-entry button').find(button => button.textContent === 'Open').fire('click')
  const overlay = h.find('.macro-custom-editor')
  overlay.querySelector('.macro-canvas-node[data-node-id="say"]').fire('pointerdown'); overlay.querySelector('.macro-canvas-viewport').fire('pointerup')
  assert.equal(overlay.querySelector('.macro-canvas-inspector input').value, 'Steve hello')
  masked = true; h.canvas.refresh()
  assert.equal(overlay.querySelector('.macro-canvas-inspector input').value, '')
  assert.equal(overlay.querySelector('.macro-canvas-inspector input').disabled, true)
  assert.ok(!h.container.textContent.includes('Steve'))
})

test('wait and repeat canvas nodes default to one mode and switch modes on edits', () => {
  const h = canvasHarness(graph(), { conditionEditor: () => h.document.createElement('div') })
  const add = kind => { h.container.querySelectorAll('.macro-canvas-palette button').find(b => b.dataset.kind === kind).fire('click'); return h.canvas.getGraph().nodes.at(-1) }
  const wait = add('wait')
  assert.deepEqual(plain(wait.params), { ms: 500, jitterMs: 0 })
  const change = (label, value) => { const input = h.container.querySelectorAll('input').find(e => e.getAttribute('aria-label') === label); assert.ok(input, label); input.value = value; input.fire('change') }
  change('Minimum (ms)', '100')
  let params = h.canvas.getGraph().nodes.find(n => n.id === wait.id).params
  assert.equal(params.minMs, 100); assert.equal('ms' in params, false); assert.equal('jitterMs' in params, false)
  change('Duration (ms)', '10000')
  params = h.canvas.getGraph().nodes.find(n => n.id === wait.id).params
  assert.equal(params.ms, 10000); assert.equal('minMs' in params, false)
  const repeat = add('repeat')
  assert.deepEqual(plain(repeat.params), { times: 1 })
  const condition = h.container.querySelectorAll('button').find(b => b.textContent === 'Add condition')
  assert.ok(condition); condition.fire('click')
  params = h.canvas.getGraph().nodes.find(n => n.id === repeat.id).params
  assert.equal('times' in params, false); assert.equal(params.while.type, 'always')
  change('Repeat count', '3')
  params = h.canvas.getGraph().nodes.find(n => n.id === repeat.id).params
  assert.equal(params.times, 3); assert.equal('while' in params, false)
})
