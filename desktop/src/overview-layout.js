;(function (root, factory) {
  const value = factory()
  if (typeof module === 'object' && module.exports) module.exports = value
  else root.afkOverviewLayout = value
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const names = { console: 'Console and chat', macro: 'Macro pad', details: 'Connection and telemetry', movement: 'Movement', inventory: 'Inventory', scoreboard: 'Scoreboard', effects: 'Effects', bossBars: 'Boss bars', nextRuns: 'Next runs', minimap: 'Minimap' }
  // Version 2 marks layouts edited with the viewport-sized overview. Legacy
  // overrides have no such marker, so they migrate along with the global layout.
  const version = 2
  const presets = {
    Default: [{ id: 'console', x: 0, y: 0, w: 8, h: 6 }, { id: 'details', x: 8, y: 0, w: 4, h: 6 }, { id: 'movement', x: 8, y: 6, w: 4, h: 6 }, { id: 'macro', x: 0, y: 6, w: 8, h: 1 }, { id: 'inventory', x: 0, y: 7, w: 8, h: 5 }],
    Compact: [{ id: 'console', x: 0, y: 0, w: 8, h: 7 }, { id: 'details', x: 8, y: 0, w: 4, h: 7 }, { id: 'movement', x: 8, y: 7, w: 4, h: 5 }, { id: 'macro', x: 0, y: 7, w: 8, h: 1 }, { id: 'inventory', x: 0, y: 8, w: 8, h: 4 }],
    Monitoring: [{ id: 'details', x: 0, y: 0, w: 4, h: 7 }, { id: 'movement', x: 0, y: 7, w: 4, h: 5 }, { id: 'console', x: 4, y: 0, w: 8, h: 7 }, { id: 'inventory', x: 4, y: 7, w: 8, h: 5 }]
  }
  const moduleDefaults = Object.fromEntries([
    ...presets.Default,
    { id: 'scoreboard', x: 0, y: 0, w: 4, h: 3 }, { id: 'effects', x: 0, y: 0, w: 4, h: 2 },
    { id: 'bossBars', x: 0, y: 0, w: 4, h: 2 }, { id: 'nextRuns', x: 0, y: 0, w: 4, h: 2 },
    { id: 'minimap', x: 0, y: 0, w: 4, h: 5 }
  ].map(item => [item.id, item]))
  function isDefault(layout) { return layout.length === presets.Default.length && presets.Default.every(item => layout.some(other => ['id', 'x', 'y', 'w', 'h'].every(key => item[key] === other[key]))) }
  function rowCount(layout) { return Math.max(1, ...layout.map(item => item.y + item.h)) }
  // Grid track pitches include the gap. Pointer movement must use the same
  // geometry as CSS, including when the window or editor toolbar changes size.
  function gridMetrics(width, height, rows, gap = 8) { return { x: (width + gap) / 12, y: (height + gap) / rows } }
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
    if (value?.version !== version) return { version, global: normalize(presets.Default), overrides: {} }
    const overrides = Object.create(null)
    if (value && typeof value.overrides === 'object' && value.overrides !== null && !Array.isArray(value.overrides)) {
      for (const [id, layout] of Object.entries(value.overrides).slice(0, 500)) if (id.length && id.length <= 200 && Array.isArray(layout)) overrides[id] = normalize(layout)
    }
    const size = Number.isFinite(value.inventoryHeight) ? { inventoryHeight: integer(value.inventoryHeight, 335, 120, 600) } : {}
    return { version, global: normalize(value?.global), overrides: { ...overrides }, ...size }
  }
  return { version, names, presets, moduleDefaults, isDefault, rowCount, gridMetrics, normalize, normalizeSettings }
})
