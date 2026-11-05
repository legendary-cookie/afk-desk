const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const layout = require('../src/overview-layout.js')
const { SettingsStore } = require('../electron/store.cjs')
test('normalizes bounds, removes invalid and duplicate modules, and resolves collisions', () => {
  const result = layout.normalize([{ id: 'console', x: -4, y: -1, w: 99, h: 2 }, { id: 'macro', x: 0, y: 0, w: 4, h: 2 }, { id: 'console' }, { id: 'unknown' }])
  assert.deepEqual(result, [{ id: 'console', x: 0, y: 0, w: 12, h: 2 }, { id: 'macro', x: 0, y: 2, w: 4, h: 2 }])
  assert.deepEqual(layout.normalize([]), [])
})
test('presets have no collisions or duplicate modules and are independent', () => {
  for (const preset of Object.values(layout.presets)) { assert.deepEqual(layout.normalize(preset), preset); assert.equal(new Set(preset.map(item => item.id)).size, preset.length) }
  assert.notDeepEqual(layout.presets.Default, layout.presets.Compact)
  assert.notDeepEqual(layout.presets.Default, layout.presets.Monitoring)
})
test('global and per-account layouts persist, including an empty layout', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new SettingsStore(dir)
  store.save({ overviewLayout: { version: layout.version, global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring } } })
  assert.deepEqual(store.get().overviewLayout, { version: layout.version, global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring } })
})
test('default includes only five core modules; optional modules have independent picker sizes', () => {
  const modules = ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap']
  for (const id of modules) {
    assert.equal(typeof layout.names[id], 'string')
    assert.equal(layout.moduleDefaults[id].id, id)
    assert.ok(!layout.presets.Default.some(item => item.id === id), `${id} must be opt-in`)
    assert.equal(layout.normalize([{ id, x: 1, y: 2, w: 3, h: 4 }])[0].id, id)
  }
  assert.deepEqual(layout.presets.Default.map(item => item.id), ['console', 'details', 'movement', 'macro', 'inventory'])
  assert.deepEqual(layout.normalize([{ id: 'movement' }]).map(item => item.id), ['movement'])
})
test('editor maps every registered module to its own existing panel', () => {
  const editor = fs.readFileSync(path.join(__dirname, '../src/overview-editor.js'), 'utf8')
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')
  for (const [id, panel] of Object.entries({ scoreboard: 'scoreboard-panel', effects: 'effects-panel', bossBars: 'boss-bars-panel', nextRuns: 'next-runs-panel', minimap: 'minimap-panel' })) {
    assert.match(editor, new RegExp(`${id}: document\\.querySelector\\('#${panel}'\\)`))
    assert.match(html, new RegExp(`id="${panel}"`))
  }
})
test('HUD renders separate panels using text nodes and masks streamer content', () => {
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  class Node {
    constructor() { this.childNodes = []; this.style = { setProperty() {} }; this.classList = { add() {}, toggle(name, value) { this[name] = value } }; this.textContent = '' }
    get children() { return this.childNodes }
    closest() { return this }
    append(...nodes) { this.childNodes.push(...nodes) }
    replaceChildren(...nodes) { this.childNodes = nodes; this.textContent = '' }
  }
  const panels = Object.fromEntries(['hud-scoreboard', 'hud-effects', 'hud-boss-bars'].map(id => [id, new Node()]))
  const context = { document: { getElementById: id => panels[id], createElement: () => new Node() }, state: { settings: { streamerMode: true } }, maskText: text => text.replaceAll('Alice', 'Masked') }
  vm.runInNewContext(source.slice(source.indexOf('function hudText('), source.indexOf('function drawGameHud(')) + '\nthis.render = renderGameHud', context)
  context.render({ scoreboard: { title: [{ text: 'Alice', color: 'red' }], lines: [] }, bossBars: [{ title: [{ text: 'Alice' }], health: 0.5 }], effects: [{ label: 'Alice', countdown: '0:05' }] })
  assert.equal(panels['hud-scoreboard'].childNodes[0].childNodes[0].textContent, 'Masked')
  assert.equal(panels['hud-boss-bars'].childNodes[0].childNodes[0].textContent, 'Masked')
  assert.equal(panels['hud-effects'].childNodes[0].textContent, 'Masked 0:05')
  context.render({ scoreboard: { title: [], lines: [{ text: [{ text: '   ' }] }] } })
  assert.equal(panels['hud-scoreboard'].childNodes.length, 0, 'empty sidebar never paints a black scoreboard')
  assert.equal(panels['hud-scoreboard'].classList['module-empty'], true)
  context.render(null)
  assert.equal(panels['hud-scoreboard'].textContent, 'No scoreboard on this server')
  assert.equal(panels['hud-effects'].textContent, 'No active effects.')
  assert.equal(panels['hud-boss-bars'].textContent, 'No active boss bars.')
})
test('next runs uses the selected account and masks labels', async () => {
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  const list = { getClientRects: () => [], replaceChildren(...items) { this.items = items }, textContent: '', classList: { toggle(name, value) { this[name] = value } }, closest() { return this } }
  const details = { getClientRects: () => [1], textContent: '' }
  let requested, streaming = true
  const context = { document: { getElementById: id => id === 'detail-next-runs' ? details : list, createElement: () => ({ textContent: '' }) }, state: { selectedId: 'account-1' }, api: { getUpcomingRuns: async id => { requested = id; return [{ label: 'Alice', at: Date.now() + 30000 }] } }, maskText: text => streaming ? text.replace('Alice', 'Masked') : text, Date }
  const start = source.indexOf("  const runsList = document.getElementById('overview-next-runs')")
  const end = source.indexOf('  setInterval(refreshOverviewRuns, 5000)', start)
  vm.runInNewContext(source.slice(start, end) + '\nthis.refresh = refreshOverviewRuns', context)
  await context.refresh()
  assert.equal(requested, 'account-1')
  assert.match(list.items[0].textContent, /^Masked · in \d+s$/)
  assert.equal(details.textContent, list.items[0].textContent)
  assert.equal(details.title, details.textContent)
  assert.equal(list.classList['overview-empty'], false)
  streaming = false
  context.renderOverviewRuns()
  assert.match(details.textContent, /^Alice/)
  streaming = true
  context.renderOverviewRuns()
  assert.match(details.textContent, /^Masked/)
  assert.doesNotMatch(details.title, /Alice/)
  assert.doesNotMatch(list.items[0].textContent, /Alice/)
  context.api.getUpcomingRuns = async () => []
  await context.refresh()
  assert.equal(list.textContent, 'No scheduled runs')
  assert.equal(details.textContent, 'No scheduled runs')
  assert.equal(details.title, 'No scheduled runs')
  assert.equal(list.classList['overview-empty'], true)
  context.state.selectedId = null
  await context.refresh()
  assert.equal(list.textContent, 'Select an account to view scheduled runs.')
})


test('layout version migrates old global and account layouts once, retaining new edits', () => {
  for (const version of [undefined, 1]) {
    const migrated = layout.normalizeSettings({ version, global: [], overrides: { old: layout.presets.Compact } })
    assert.deepEqual(migrated, { version: 2, global: layout.presets.Default, overrides: {} })
    assert.deepEqual(layout.normalizeSettings(migrated), migrated)
  }
  const edited = { version: 2, global: [], overrides: { fresh: layout.presets.Compact, empty: [] } }
  assert.deepEqual(layout.normalizeSettings(edited), edited)
  assert.equal(layout.isDefault([...layout.presets.Default].reverse()), true)
  assert.equal(layout.isDefault(layout.presets.Compact), false)
})

test('row pitch follows available viewport height and includes grid gaps', () => {
  const rows = layout.rowCount(layout.presets.Default)
  assert.equal(rows, 12)
  for (const height of [460, 720, 800]) {
    const pitch = layout.gridMetrics(1200, height, rows)
    assert.equal(pitch.y * rows - 8, height)
    assert.equal(pitch.x * 12 - 8, 1200)
  }
})

test('overview CSS bounds the grid and gives content its natural height', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8')
  const overview = css.slice(css.indexOf('/* The overview uses'), css.indexOf('\n.game-hud '))
  assert.match(overview, /height: 100%; min-height: 0/)
  assert.match(overview, /grid-template-rows: repeat\(var\(--overview-rows, 12\), minmax\(0, 1fr\)\)/)
  assert.doesNotMatch(overview, /grid-auto-rows: 52px|overflow: auto/)
  assert.match(overview, /\[data-module="macro"\] \{ flex: 0 0 auto/)
  assert.match(overview, /\.inventory-panel \{ height: auto/)
  assert.match(overview, /\.overview-module\.overview-empty \{ align-self: start/)
  assert.match(overview, /\.movement-panel > \.minimap canvas \{[^}]*height: auto/)
})


test('an unavailable minimap hides its canvas and collapses only its standalone wrapper', () => {
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  const classes = () => ({ toggle(name, value) { this[name] = value } })
  const wrapper = { dataset: { module: 'minimap' }, classList: classes() }
  const panel = { parentElement: wrapper, classList: classes() }
  const canvas = { closest: () => panel }
  const context = {}
  vm.runInNewContext(source.slice(source.indexOf('function setMinimapAvailable('), source.indexOf('function startMinimap(')) + '\nthis.update = setMinimapAvailable', context)
  context.update(canvas, false)
  assert.equal(canvas.hidden, true)
  assert.equal(panel.classList['map-empty'], true)
  assert.equal(wrapper.classList['overview-empty'], true)
  context.update(canvas, true)
  assert.equal(canvas.hidden, false)
  assert.equal(wrapper.classList['overview-empty'], false)
  wrapper.dataset.module = 'movement'
  context.update(canvas, false)
  assert.equal(wrapper.classList['overview-empty'], false, 'movement buttons remain usable without map data')
})
