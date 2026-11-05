;(function (root, factory) {
  const value = factory()
  if (typeof module === 'object' && module.exports) module.exports = value
  else root.afkOverviewLayout = value
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const names = { console: 'Console and chat', macro: 'Macro pad', details: 'Connection and telemetry', movement: 'Movement', inventory: 'Inventory', scoreboard: 'Scoreboard', effects: 'Effects', bossBars: 'Boss bars', nextRuns: 'Next runs', minimap: 'Minimap' }
  const presets = {
    Default: [{ id: 'console', x: 0, y: 0, w: 8, h: 8 }, { id: 'details', x: 8, y: 0, w: 4, h: 5 }, { id: 'movement', x: 8, y: 5, w: 4, h: 5 }, { id: 'macro', x: 0, y: 8, w: 8, h: 3 }, { id: 'inventory', x: 0, y: 11, w: 12, h: 4 }],
    Compact: [{ id: 'console', x: 0, y: 0, w: 8, h: 6 }, { id: 'details', x: 8, y: 0, w: 4, h: 4 }, { id: 'movement', x: 8, y: 4, w: 4, h: 4 }, { id: 'macro', x: 0, y: 6, w: 8, h: 2 }, { id: 'inventory', x: 0, y: 8, w: 12, h: 3 }],
    Monitoring: [{ id: 'details', x: 0, y: 0, w: 4, h: 5 }, { id: 'movement', x: 4, y: 0, w: 4, h: 5 }, { id: 'console', x: 8, y: 0, w: 4, h: 8 }, { id: 'inventory', x: 0, y: 5, w: 8, h: 4 }, { id: 'macro', x: 8, y: 8, w: 4, h: 3 }]
  }
  const extras = [{ id: 'scoreboard', x: 0, y: 15, w: 4, h: 4 }, { id: 'effects', x: 4, y: 15, w: 4, h: 4 }, { id: 'bossBars', x: 8, y: 15, w: 4, h: 4 }, { id: 'nextRuns', x: 0, y: 19, w: 6, h: 4 }, { id: 'minimap', x: 6, y: 19, w: 6, h: 6 }]
  for (const preset of Object.values(presets)) preset.push(...extras.map(item => ({ ...item })))
  const integer = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.round(Number(n)))) : fallback
  function normalize(input) {
    if (!Array.isArray(input)) input = presets.Default
    const seen = new Set(), result = []
    for (const item of input.slice(0, 100)) {
      if (!item || !Object.hasOwn(names, item.id) || seen.has(item.id)) continue
      seen.add(item.id)
      const w = integer(item.w, 4, 1, 12), h = integer(item.h, 4, 1, 30)
      const entry = { id: item.id, x: integer(item.x, 0, 0, 12 - w), y: integer(item.y, 0, 0, 1000), w, h }
      while (result.some(other => entry.x < other.x + other.w && entry.x + entry.w > other.x && entry.y < other.y + other.h && entry.y + entry.h > other.y)) entry.y++
      result.push(entry)
    }
    return result
  }
  function normalizeSettings(value) {
    const overrides = Object.create(null)
    if (value && typeof value.overrides === 'object' && value.overrides !== null && !Array.isArray(value.overrides)) {
      for (const [id, layout] of Object.entries(value.overrides).slice(0, 500)) if (id.length && id.length <= 200 && Array.isArray(layout)) overrides[id] = normalize(layout)
    }
    return { global: normalize(value?.global), overrides: { ...overrides } }
  }
  return { names, presets, normalize, normalizeSettings }
})
