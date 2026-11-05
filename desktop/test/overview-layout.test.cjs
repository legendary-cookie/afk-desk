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
