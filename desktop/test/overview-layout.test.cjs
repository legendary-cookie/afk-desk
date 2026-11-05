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
test('presets contain each module without collisions and are independent', () => {
  for (const preset of Object.values(layout.presets)) { assert.deepEqual(layout.normalize(preset), preset); assert.equal(new Set(preset.map(item => item.id)).size, Object.keys(layout.names).length) }
  assert.notDeepEqual(layout.presets.Default, layout.presets.Compact)
  assert.notDeepEqual(layout.presets.Default, layout.presets.Monitoring)
})
test('global and per-account layouts persist, including an empty layout', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new SettingsStore(dir)
  store.save({ overviewLayout: { global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring } } })
  assert.deepEqual(store.get().overviewLayout, { global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring } })
})
test('registers each additional overview module and includes scoreboard in Monitoring', () => {
  const modules = ['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap']
  for (const id of modules) {
    assert.equal(typeof layout.names[id], 'string')
    assert.ok(layout.presets.Default.some(item => item.id === id), `${id} needs a picker size`)
    assert.equal(layout.normalize([{ id, x: 1, y: 2, w: 3, h: 4 }])[0].id, id)
  }
  assert.ok(layout.presets.Monitoring.some(item => item.id === 'scoreboard'))
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
    constructor() { this.childNodes = []; this.style = { setProperty() {} }; this.classList = { add() {} }; this.textContent = '' }
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
  context.render(null)
  assert.equal(panels['hud-scoreboard'].textContent, 'No active scoreboard.')
  assert.equal(panels['hud-effects'].textContent, 'No active effects.')
  assert.equal(panels['hud-boss-bars'].textContent, 'No active boss bars.')
})
test('next runs uses the selected account and masks labels', async () => {
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  const list = { getClientRects: () => [1], replaceChildren(...items) { this.items = items }, textContent: '' }
  let requested
  const context = { document: { getElementById: () => list, createElement: () => ({ textContent: '' }) }, state: { selectedId: 'account-1' }, api: { getUpcomingRuns: async id => { requested = id; return [{ label: 'Alice', at: Date.now() + 30000 }] } }, maskText: text => text.replace('Alice', 'Masked'), Date }
  const start = source.indexOf("  const runsList = document.getElementById('overview-next-runs')")
  const end = source.indexOf('  setInterval(refreshOverviewRuns, 5000)', start)
  vm.runInNewContext(source.slice(start, end) + '\nthis.refresh = refreshOverviewRuns', context)
  await context.refresh()
  assert.equal(requested, 'account-1')
  assert.match(list.items[0].textContent, /^Masked · in \d+s$/)
  context.state.selectedId = null
  await context.refresh()
  assert.equal(list.textContent, 'Select an account to view scheduled runs.')
})
