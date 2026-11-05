;(function (root, factory) {
  const value = factory()
  if (typeof module === 'object' && module.exports) module.exports = value
  else root.afkOverviewLayout = value
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const names = { console: 'Console and chat', macro: 'Macro pad', details: 'Connection and telemetry', movement: 'Movement', inventory: 'Inventory', scoreboard: 'Scoreboard', effects: 'Effects', bossBars: 'Boss bars', nextRuns: 'Next runs', minimap: 'Minimap' }
  // Version 3 uses 1000 vertical tracks with gaps inside each module.
  const version = 3
  const rows = 1000
  const editBarHeight = 24
  const integer = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.round(Number(n)))) : fallback
  const legacyPresets = {
    Default: [{ id: 'console', x: 0, y: 0, w: 8, h: 6 }, { id: 'details', x: 8, y: 0, w: 4, h: 6 }, { id: 'movement', x: 8, y: 6, w: 4, h: 6 }, { id: 'macro', x: 0, y: 6, w: 8, h: 1 }, { id: 'inventory', x: 0, y: 7, w: 8, h: 5 }],
    Compact: [{ id: 'console', x: 0, y: 0, w: 8, h: 7 }, { id: 'details', x: 8, y: 0, w: 4, h: 7 }, { id: 'movement', x: 8, y: 7, w: 4, h: 5 }, { id: 'macro', x: 0, y: 7, w: 8, h: 1 }, { id: 'inventory', x: 0, y: 8, w: 8, h: 4 }],
    Monitoring: [{ id: 'details', x: 0, y: 0, w: 4, h: 7 }, { id: 'movement', x: 0, y: 7, w: 4, h: 5 }, { id: 'console', x: 4, y: 0, w: 8, h: 7 }, { id: 'inventory', x: 4, y: 7, w: 8, h: 5 }]
  }
  function migrateLayout(input) {
    const old = normalize(input), count = Math.max(1, ...old.map(item => item.y + item.h))
    return old.map(item => ({ ...item, y: Math.round(item.y * rows / count), h: Math.max(1, Math.round((item.y + item.h) * rows / count) - Math.round(item.y * rows / count)) }))
  }
  const presets = Object.fromEntries(Object.entries(legacyPresets).map(([name, items]) => [name, migrateLayout(items)]))
  // Dimensions are CSS pixels. Registry order is also the stable placement order.
  const registry = {
    console: { minWidth: 400, minHeight: 140, preferredWidth: 720, preferredHeight: 300, maxHeight: 1600, grow: 5, group: 'main' },
    macro: { minWidth: 240, minHeight: 64, preferredWidth: 640, preferredHeight: 80, maxHeight: 100, grow: 0, group: 'main', compact: true },
    inventory: { minWidth: 400, minHeight: 200, preferredWidth: 720, preferredHeight: 300, maxHeight: 700, grow: 4, group: 'main' },
    details: { minWidth: 280, minHeight: 250, preferredWidth: 360, preferredHeight: 310, maxHeight: 360, grow: 1, group: 'side' },
    movement: { minWidth: 280, minHeight: 180, preferredWidth: 360, preferredHeight: 230, maxHeight: 280, grow: 1, group: 'side' },
    minimap: { minWidth: 240, minHeight: 160, preferredWidth: 360, preferredHeight: 240, maxHeight: 400, grow: 2, group: 'side' },
    scoreboard: { minWidth: 130, minHeight: 90, preferredWidth: 160, preferredHeight: 130, maxHeight: 180, grow: 0, group: 'side', compact: true },
    effects: { minWidth: 130, minHeight: 76, preferredWidth: 160, preferredHeight: 96, maxHeight: 140, grow: 0, group: 'side', compact: true },
    bossBars: { minWidth: 130, minHeight: 76, preferredWidth: 160, preferredHeight: 96, maxHeight: 140, grow: 0, group: 'side', compact: true },
    nextRuns: { minWidth: 130, minHeight: 76, preferredWidth: 160, preferredHeight: 96, maxHeight: 140, grow: 0, group: 'side', compact: true }
  }
  function autoArrange(active, { columns = 12, width = 1200, height = 600, gap = 8, measurements = {}, editing = false } = {}) {
    columns = integer(columns, 12, 1, 12)
    width = Number.isFinite(width) && width > 0 ? width : 1200
    height = Number.isFinite(height) && height > 0 ? height : 600
    gap = Number.isFinite(gap) ? Math.max(0, gap) : 8
    const selected = new Set((Array.isArray(active) ? active : []).map(item => typeof item === 'string' ? item : item?.id))
    const ids = Object.keys(registry).filter(id => selected.has(id))
    const main = ids.filter(id => registry[id].group === 'main'), side = ids.filter(id => registry[id].group === 'side')
    const left = Math.round(columns * 2 / 3), pitch = (width + gap) / columns
    const fits = (items, span) => items.every(id => registry[id].minWidth <= span * pitch - gap)
    const split = columns >= 3 && width >= 900 && main.length && side.length && fits(main, left) && fits(side, columns - left)
    const groups = split ? [{ ids: main, x: 0, w: left }, { ids: side, x: left, w: columns - left }] : [{ ids, x: 0, w: columns }]
    for (const group of groups) {
      // Each module spans its column, including compact and collapsed panels.
      group.rows = group.ids.map(id => {
        const hint = registry[id], measured = measurements[id] || {}
        const natural = Number.isFinite(measured.naturalHeight) && measured.naturalHeight > 0 ? measured.naturalHeight : null
        let min = hint.minHeight, preferred = hint.preferredHeight, max = hint.maxHeight, grow = hint.grow
        if (measured.collapsed) {
          min = preferred = max = measured.headerHeight > 0 ? measured.headerHeight : 44; grow = 0
        } else if (measured.empty || hint.compact) {
          min = preferred = max = natural || (measured.empty ? 80 : preferred); grow = 0
        } else if (id === 'inventory' && natural) {
          min = Math.min(min, natural); preferred = natural; max = Math.max(max, natural)
        }
        const bar = editing ? editBarHeight : 0
        return { items: [{ id, w: group.w }], min: min + bar, preferred: preferred + bar, max: max + bar, grow,
          naturalInventory: id === 'inventory' && natural && !measured.collapsed && !measured.empty }
      })
    }
    const minHeight = Math.max(0, ...groups.map(group => group.rows.reduce((sum, row) => sum + row.min + gap, 0)))
    const available = Math.max(height, minHeight), layout = []
    for (const group of groups) {
      // Fill the inventory's natural grid before spending spare space on console
      // preferences. It may still scroll when even the minimum console cannot fit.
      let spare = available - group.rows.reduce((sum, row) => sum + row.min + gap, 0)
      for (const row of group.rows.filter(row => row.naturalInventory)) {
        const extra = Math.min(spare, row.preferred - row.min)
        row.min += extra; spare -= extra
      }
      const minimum = group.rows.reduce((sum, row) => sum + row.min + gap, 0)
      const preferred = group.rows.reduce((sum, row) => sum + row.preferred + gap, 0)
      const ratio = preferred > minimum ? Math.min(1, (available - minimum) / (preferred - minimum)) : 1
      for (const row of group.rows) row.height = row.min + (row.preferred - row.min) * ratio
      let remaining = available - group.rows.reduce((sum, row) => sum + row.height + gap, 0)
      let growing = group.rows.filter(row => row.grow && row.height < row.max)
      while (remaining > 0.01 && growing.length) {
        const weight = growing.reduce((sum, row) => sum + row.grow, 0), spare = remaining
        for (const row of growing) { const extra = Math.min(row.max - row.height, spare * row.grow / weight); row.height += extra; remaining -= extra }
        growing = growing.filter(row => row.height < row.max - 0.01)
      }
      let y = 0
      for (const row of group.rows) {
        const start = Math.round(y * rows / available)
        y += row.height + gap
        const h = Math.max(1, Math.round(y * rows / available) - start)
        let x = group.x
        for (const item of row.items) { layout.push({ id: item.id, x, y: start, w: item.w, h }); x += item.w }
      }
    }
    return { layout, rows, minHeight, height: available }
  }
  const moduleDefaults = Object.fromEntries([
    ...presets.Default,
    { id: 'scoreboard', x: 0, y: 0, w: 4, h: 250 }, { id: 'effects', x: 0, y: 0, w: 4, h: 167 },
    { id: 'bossBars', x: 0, y: 0, w: 4, h: 167 }, { id: 'nextRuns', x: 0, y: 0, w: 4, h: 167 },
    { id: 'minimap', x: 0, y: 0, w: 4, h: 417 }
  ].map(item => [item.id, item]))
  function isDefault(layout) { return layout.length === presets.Default.length && presets.Default.every(item => layout.some(other => ['id', 'x', 'y', 'w', 'h'].every(key => item[key] === other[key]))) }
  function rowCount(layout) { return Math.max(rows, ...layout.map(item => item.y + item.h)) }
  // Horizontal track pitches include the gap; vertical gaps live inside modules.
  // Pointer movement uses the same geometry as CSS when the viewport changes.
  function gridMetrics(width, height, rows, gap = 8) { return { x: (width + gap) / 12, y: height / rows } }
  function normalize(input) {
    if (!Array.isArray(input)) input = presets.Default
    const seen = new Set(), result = []
    for (const item of input.slice(0, 100)) {
      if (!item || !Object.hasOwn(names, item.id) || seen.has(item.id)) continue
      seen.add(item.id)
      const w = integer(item.w, 4, 1, 12), h = integer(item.h, 333, 1, 3000)
      const entry = { id: item.id, x: integer(item.x, 0, 0, 12 - w), y: integer(item.y, 0, 0, 10000), w, h }
      while (result.some(other => entry.x < other.x + other.w && entry.x + entry.w > other.x && entry.y < other.y + other.h && entry.y + entry.h > other.y)) entry.y++
      result.push(entry)
    }
    return result
  }
  function normalizeSettings(value) {
    const current = value?.version === version
    const inventoryHeight = !current && Number.isFinite(value?.inventoryHeight) ? integer(value.inventoryHeight, 335, 120, 600) : null
    const mode = (layout, saved) => current ? (saved === 'manual' ? 'manual' : 'auto')
      : (Array.isArray(layout) && (!isLegacyDefault(layout) || inventoryHeight !== null) ? 'manual' : 'auto')
    const read = layout => {
      if (current) return normalize(layout)
      const result = Array.isArray(layout) ? migrateLayout(layout) : normalize(presets.Default)
      // The old splitter size applied to fitted defaults. Fold it into their
      // migrated positions so the new grid keeps that manual sizing per scope.
      if (Array.isArray(layout) && isLegacyDefault(layout) && inventoryHeight !== null) {
        const inventory = result.find(item => item.id === 'inventory'), macro = result.find(item => item.id === 'macro'), console = result.find(item => item.id === 'console')
        inventory.h = Math.min(550, Math.round(inventoryHeight * rows / 600))
        macro.h = Math.round(80 * rows / 600)
        console.h = rows - inventory.h - macro.h; macro.y = console.h; inventory.y = macro.y + macro.h
      }
      return result
    }
    const overrides = Object.create(null), overrideModes = Object.create(null)
    if (value && typeof value.overrides === 'object' && value.overrides !== null && !Array.isArray(value.overrides)) {
      for (const [id, layout] of Object.entries(value.overrides).slice(0, 500)) if (id.length && id.length <= 200 && Array.isArray(layout)) {
        overrides[id] = read(layout); overrideModes[id] = mode(layout, value.overrideModes?.[id])
      }
    }
    return { version, global: read(value?.global), overrides: { ...overrides }, globalMode: mode(value?.global, value?.globalMode), overrideModes: { ...overrideModes } }
  }
  function isLegacyDefault(layout) { return layout.length === legacyPresets.Default.length && legacyPresets.Default.every(item => layout.some(other => ['id', 'x', 'y', 'w', 'h'].every(key => item[key] === other[key]))) }
  return { version, rows, editBarHeight, names, registry, presets, moduleDefaults, autoArrange, isDefault, rowCount, gridMetrics, normalize, normalizeSettings }
})
