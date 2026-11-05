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
  store.save({ overviewLayout: { version: layout.version, global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring }, globalMode: 'manual', overrideModes: { one: 'auto', two: 'manual' } } })
  assert.deepEqual(store.get().overviewLayout, { version: layout.version, global: layout.presets.Compact, overrides: { one: [], two: layout.presets.Monitoring }, globalMode: 'manual', overrideModes: { one: 'auto', two: 'manual' } })
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


test('migration retains module selection and custom positions per scope, and is idempotent', () => {
  for (const version of [undefined, 1, 2]) {
    const custom = [{ id: 'console', x: 2, y: 0, w: 6, h: 5 }, { id: 'scoreboard', x: 8, y: 0, w: 4, h: 3 }]
    const migrated = layout.normalizeSettings({ version, global: custom, overrides: { old: [], custom } })
    assert.equal(migrated.version, layout.version)
    assert.equal(migrated.globalMode, 'manual')
    assert.deepEqual(migrated.overrideModes, { old: 'manual', custom: 'manual' })
    assert.deepEqual(migrated.overrides.old, [])
    assert.deepEqual(migrated.global, [{ id: 'console', x: 2, y: 0, w: 6, h: 1000 }, { id: 'scoreboard', x: 8, y: 0, w: 4, h: 600 }])
    assert.deepEqual(layout.normalizeSettings(migrated), migrated)
  }
  const oldDefault = [{ id: 'console', x: 0, y: 0, w: 8, h: 6 }, { id: 'details', x: 8, y: 0, w: 4, h: 6 }, { id: 'movement', x: 8, y: 6, w: 4, h: 6 }, { id: 'macro', x: 0, y: 6, w: 8, h: 1 }, { id: 'inventory', x: 0, y: 7, w: 8, h: 5 }]
  const migrated = layout.normalizeSettings({ version: 2, global: oldDefault, overrides: { default: oldDefault } })
  assert.equal(migrated.globalMode, 'auto')
  assert.equal(migrated.overrideModes.default, 'auto')
  const sized = layout.normalizeSettings({ version: 2, global: oldDefault, overrides: { default: oldDefault }, inventoryHeight: 280 })
  assert.equal(sized.globalMode, 'manual')
  assert.equal(sized.overrideModes.default, 'manual')
  assert.equal(sized.global.find(item => item.id === 'inventory').h, 467)
  assert.deepEqual(sized.global, sized.overrides.default)
  assert.deepEqual(layout.normalizeSettings(sized), sized)
  assert.equal(layout.normalizeSettings().globalMode, 'auto')
  assert.deepEqual(layout.normalizeSettings({ version: layout.version, global: [], overrides: { fresh: [] }, globalMode: 'invalid', overrideModes: { fresh: 'manual', missing: 'manual' } }), { version: layout.version, global: [], overrides: { fresh: [] }, globalMode: 'auto', overrideModes: { fresh: 'manual' } })
})

test('row pitch uses the displayed tracks and horizontal gaps', () => {
  assert.equal(layout.rowCount(layout.presets.Default), layout.rows)
  for (const height of [460, 720, 800]) {
    const pitch = layout.gridMetrics(1200, height, layout.rows)
    assert.equal(pitch.y * layout.rows, height)
    assert.equal(pitch.x * 12 - 8, 1200)
  }
})

function assertArranged(ids, options = {}) {
  const arranged = layout.autoArrange(ids, options), items = arranged.layout
  assert.equal(items.length, new Set(ids.map(item => typeof item === 'string' ? item : item.id)).size)
  assert.deepEqual(layout.normalize(items), items, 'arrangement needs no collision repair')
  assert.equal(Math.min(...items.map(item => item.x)), 0)
  assert.equal(Math.max(...items.map(item => item.x + item.w)), options.columns || 12)
  for (const item of items) {
    assert.ok(item.x >= 0 && item.x + item.w <= (options.columns || 12), item.id + ': horizontal bounds')
    assert.ok(item.y >= 0 && item.h > 0 && item.y + item.h <= arranged.rows, item.id + ': vertical bounds')
    const pixels = item.h * arranged.height / arranged.rows - 8, hint = layout.registry[item.id]
    assert.ok(pixels >= hint.minHeight - arranged.height / arranged.rows, item.id + ': minimum content height')
    assert.ok(pixels <= hint.maxHeight + arranged.height / arranged.rows, item.id + ': maximum content height')
    for (const other of items) if (other !== item) assert.ok(item.x >= other.x + other.w || item.x + item.w <= other.x || item.y >= other.y + other.h || item.y + item.h <= other.y, item.id + ' overlaps ' + other.id)
  }
  return arranged
}

test('every module has complete and consistent size hints', () => {
  assert.deepEqual(Object.keys(layout.registry).sort(), Object.keys(layout.names).sort())
  for (const hint of Object.values(layout.registry)) {
    for (const key of ['minWidth', 'minHeight', 'preferredWidth', 'preferredHeight', 'maxHeight']) assert.ok(Number.isFinite(hint[key]) && hint[key] > 0)
    assert.ok(hint.minWidth <= hint.preferredWidth)
    assert.ok(hint.minHeight <= hint.preferredHeight && hint.preferredHeight <= hint.maxHeight)
    assert.ok(['main', 'side'].includes(hint.group))
  }
  for (const id of ['macro', 'scoreboard', 'effects', 'bossBars', 'nextRuns']) assert.equal(layout.registry[id].grow, 0)
  assert.ok(layout.registry.console.grow > layout.registry.details.grow)
  assert.ok(layout.registry.inventory.grow > layout.registry.minimap.grow)
})

test('default, extended, all, and single module arrangements fit the grid without overlaps', () => {
  const defaults = layout.presets.Default.map(item => item.id)
  const sets = [defaults, [...defaults, 'scoreboard', 'effects', 'bossBars'], Object.keys(layout.names), ...Object.keys(layout.names).map(id => [id])]
  for (const ids of sets) for (const width of [480, 899, 900, 1060, 1610]) for (const height of [460, 580, 880]) {
    const result = assertArranged(ids, { width, height })
    assert.ok(result.height >= result.minHeight)
    assert.equal(result.height, Math.max(height, result.minHeight))
    assert.deepEqual(layout.autoArrange([...ids].reverse(), { width, height }), result, 'input order does not affect placement')
  }
  assert.deepEqual(layout.autoArrange([]).layout, [])
  assert.deepEqual(layout.autoArrange(['unknown', 'console', 'console']).layout, layout.autoArrange(['console']).layout)
  assert.deepEqual(layout.autoArrange(['console'], { width: Infinity, height: NaN }), layout.autoArrange(['console']))
})

test('all side modules span the full side column, including compact panels', () => {
  const result = assertArranged(Object.keys(layout.names), { width: 1200, height: 900 })
  const byId = Object.fromEntries(result.layout.map(item => [item.id, item]))
  for (const id of ['console', 'macro', 'inventory']) assert.equal(byId[id].x, 0)
  for (const id of ['details', 'movement', 'minimap', 'scoreboard', 'effects', 'bossBars', 'nextRuns']) assert.ok(byId[id].x >= 8)
  for (const id of ['details', 'movement', 'minimap', 'scoreboard', 'effects', 'bossBars', 'nextRuns']) {
    assert.equal(byId[id].x, 8); assert.equal(byId[id].w, 4)
  }
  assert.ok(byId.effects.y >= byId.scoreboard.y + byId.scoreboard.h)
  assert.ok(byId.nextRuns.y >= byId.bossBars.y + byId.bossBars.h)
  const small = assertArranged([...layout.presets.Default, { id: 'scoreboard' }, { id: 'effects' }], { width: 900, height: 700 })
  for (const id of ['scoreboard', 'effects']) assert.equal(small.layout.find(item => item.id === id).w, 4)
  const narrow = assertArranged(layout.presets.Default, { width: 700, height: 700 })
  for (const item of narrow.layout) { assert.equal(item.x, 0); assert.equal(item.w, 12) }
  assertArranged(Object.keys(layout.names), { columns: 6, width: 700, height: 900 })
})

test('adding a side module leaves the main column unchanged and keeps side order', () => {
  const defaults = layout.presets.Default.map(item => item.id), options = { width: 1200, height: 900 }
  const before = layout.autoArrange(defaults, options).layout
  const after = layout.autoArrange([...defaults, 'scoreboard'], options).layout
  for (const id of ['console', 'macro', 'inventory', 'details', 'movement']) assert.deepEqual(after.find(item => item.id === id), before.find(item => item.id === id), id + ' is stable')
  const paired = layout.autoArrange([...defaults, 'scoreboard', 'effects'], options).layout
  for (const id of defaults) assert.deepEqual(paired.find(item => item.id === id), after.find(item => item.id === id))
})

test('viewport scaling respects compact heights and gives growing modules the spare height', () => {
  let previous
  for (const [width, height] of [[1060, 500], [1300, 650], [1610, 850]]) {
    const result = assertArranged(layout.presets.Default, { width, height })
    assert.equal(result.height, height, 'fitting content never adds page height')
    const heights = Object.fromEntries(result.layout.map(item => [item.id, item.h * height / result.rows - 8]))
    if (previous) { assert.ok(heights.console > previous.console); assert.ok(heights.inventory > previous.inventory) }
    assert.ok(heights.macro <= layout.registry.macro.preferredHeight + 1)
    previous = heights
  }
  const a = assertArranged(['console', 'inventory'], { width: 1200, height: 850 })
  const b = assertArranged(['console', 'inventory'], { width: 1200, height: 940 })
  const growth = id => b.layout.find(item => item.id === id).h * b.height / b.rows - a.layout.find(item => item.id === id).h * a.height / a.rows
  assert.ok(Math.abs(growth('console') / growth('inventory') - 5 / 4) < .05)
})

test('overview CSS bounds content and uses tracks without multiplying the row gap', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8')
  const overview = css.slice(css.indexOf('/* The overview uses'), css.indexOf('\n.game-hud '))
  assert.match(overview, /height: 100%; min-height: 0/)
  assert.match(overview, /grid-template-rows: repeat\(var\(--overview-rows, 1000\), minmax\(0, 1fr\)\)/)
  assert.match(overview, /column-gap: 8px; row-gap: 0/)
  assert.match(overview, /\.overview-module \{ padding-bottom: 8px/)
  assert.match(overview, /\.game-hud, \.overview-module \.details-list,[^}]*flex: 1 1 auto; min-height: 0; overflow: auto/)
  assert.match(overview, /\.inventory-panel \{ height: auto/)
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

const moduleHeight = (result, id) => result.layout.find(item => item.id === id).h * result.height / result.rows - 8

test('collapsed modules use only their header height, including inventory and console', () => {
  for (const id of Object.keys(layout.names)) {
    const result = layout.autoArrange(Object.keys(layout.names), { width: 1200, height: 1100,
      measurements: { [id]: { collapsed: true, headerHeight: 49, naturalHeight: 350 } } })
    assert.ok(Math.abs(moduleHeight(result, id) - 49) <= result.height / result.rows, id)
  }
})

test('empty modules and compact content stay at natural height in a tall viewport', () => {
  const measurements = Object.fromEntries(['scoreboard', 'effects', 'bossBars', 'nextRuns', 'minimap'].map(id => [id, { empty: true, naturalHeight: 73 }]))
  measurements.macro = { naturalHeight: 83 }
  const result = layout.autoArrange(Object.keys(layout.names), { width: 1200, height: 1600, measurements })
  for (const id of Object.keys(measurements)) assert.ok(Math.abs(moduleHeight(result, id) - measurements[id].naturalHeight) <= result.height / result.rows, id)
  assert.ok(moduleHeight(result, 'console') > layout.registry.console.preferredHeight)
  assert.ok(moduleHeight(result, 'inventory') > layout.registry.inventory.preferredHeight)
})

test('natural inventory height takes priority over console preferences when the full grid fits', () => {
  const measurements = { macro: { naturalHeight: 80 }, inventory: { naturalHeight: 390 } }
  // Enough room for the grid and the console minimum, but not both preferred sizes.
  const result = layout.autoArrange(['console', 'macro', 'inventory'], { width: 1200, height: 650, measurements })
  assert.ok(moduleHeight(result, 'inventory') >= 389)
  assert.ok(moduleHeight(result, 'console') >= layout.registry.console.minHeight - 1)
  const small = layout.autoArrange(['console', 'macro', 'inventory'], { width: 1200, height: 480, measurements })
  assert.ok(moduleHeight(small, 'inventory') < 390, 'only scroll when the full grid cannot fit')
})

test('edit bars overlay every module without changing content allocation', () => {
  const measurements = { macro: { naturalHeight: 90 }, inventory: { naturalHeight: 390 }, movement: { collapsed: true, headerHeight: 48 }, scoreboard: { empty: true, naturalHeight: 73 } }
  const result = layout.autoArrange([...layout.presets.Default, { id: 'scoreboard' }], { width: 1200, height: 720, measurements, editing: true })
  for (const [id, expected] of [['macro', 90], ['inventory', 390], ['movement', 48], ['scoreboard', 73]]) {
    assert.ok(moduleHeight(result, id) >= expected - 1, id + ': content survives editing')
  }
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8')
  assert.match(css, new RegExp('\\.overview-module-bar \\{ position: absolute;[^}]*height: ' + layout.editBarHeight + 'px'))
  assert.match(css, /\.overview-measuring > \.overview-module \{ height: max-content; align-self: start/)
  assert.match(css, /\.overview-module > \.collapsed \{[^}]*align-self: stretch; width: 100%/)
  assert.match(css, /\.overview-module > \.movement-panel\.collapsed \{ display: block/)
})


test('arranging its own output repeatedly is idempotent for unchanged inputs', () => {
  const measurements = { macro: { naturalHeight: 90 }, inventory: { naturalHeight: 390 },
    movement: { collapsed: true, headerHeight: 48 }, scoreboard: { empty: true, naturalHeight: 73 } }
  for (const width of [600, 1200]) for (const height of [480, 720, 1600]) for (const editing of [false, true]) {
    const options = { width, height, measurements, editing }
    const expected = layout.autoArrange(Object.keys(layout.names), options)
    let result = expected
    for (let frame = 0; frame < 20; frame++) {
      result = layout.autoArrange(result.layout, options)
      assert.deepEqual(result, expected)
    }
  }
})

test('editing preserves normal module rows, heights and the console grow share', () => {
  const measurements = { macro: { naturalHeight: 90 }, inventory: { naturalHeight: 390 },
    movement: { collapsed: true, headerHeight: 48 }, scoreboard: { empty: true, naturalHeight: 73 } }
  for (const width of [600, 1200]) for (const height of [480, 720, 1600]) {
    const options = { width, height, measurements }
    const normal = layout.autoArrange(Object.keys(layout.names), options)
    assert.deepEqual(layout.autoArrange(normal.layout, { ...options, editing: true }), normal)
  }
  const growth = editing => {
    const small = layout.autoArrange(layout.presets.Default, { height: 900, measurements, editing })
    const large = layout.autoArrange(small.layout, { height: 1100, measurements, editing })
    return moduleHeight(large, 'console') - moduleHeight(small, 'console')
  }
  assert.ok(growth(true) > 0)
  assert.equal(growth(true), growth(false))
})
