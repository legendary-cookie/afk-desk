window.createOverviewEditor = function ({ dashboard, settings, accountId, save, report }) {
  const model = window.afkOverviewLayout
  const nodes = { console: document.querySelector('#console-panel'), macro: document.querySelector('#macro-section'), details: document.querySelector('#details-panel'), movement: document.querySelector('#movement-panel'), inventory: document.querySelector('.inventory-panel'), scoreboard: document.querySelector('#scoreboard-panel'), effects: document.querySelector('#effects-panel'), bossBars: document.querySelector('#boss-bars-panel'), nextRuns: document.querySelector('#next-runs-panel'), minimap: document.querySelector('#minimap-panel') }
  const inventoryResizer = document.querySelector('#inventory-resizer')
  const resizerHome = document.createComment('inventory resizer'); inventoryResizer.before(resizerHome)
  const placeholders = {}
  for (const [id, node] of Object.entries(nodes)) { const marker = document.createComment(id); node.before(marker); placeholders[id] = marker }
  const toolbar = document.createElement('div'); toolbar.className = 'overview-toolbar'
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button secondary'; edit.textContent = 'Edit layout'
  const controls = document.createElement('div'); controls.className = 'overview-controls'; controls.hidden = true
  const overrideLabel = document.createElement('label'); const override = document.createElement('input'); override.type = 'checkbox'; overrideLabel.append(override, ' Use a layout for this account')
  const preset = document.createElement('select'); preset.setAttribute('aria-label', 'Layout preset')
  for (const name of ['Default', 'Compact', 'Monitoring']) { const option = document.createElement('option'); option.value = name; option.textContent = name; preset.append(option) }
  const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply preset'
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset layout'
  const picker = document.createElement('select'); picker.setAttribute('aria-label', 'Add module')
  const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add module'
  const help = document.createElement('span'); help.textContent = 'Drag a module or its corner. Focus its handle and use arrows to move, or Shift + arrows to resize.'
  const autoLabel = document.createElement('label'); const auto = document.createElement('input'); auto.type = 'checkbox'; auto.setAttribute('aria-label', 'Automatically arrange modules'); autoLabel.append(auto, ' Auto-arrange')
  const arrange = document.createElement('button'); arrange.type = 'button'; arrange.textContent = 'Auto-arrange'
  const notice = document.createElement('span'); notice.className = 'overview-layout-notice'
  const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'text-button'; restore.textContent = 'Auto-arrange'
  notice.append('Manual layout · ', restore)
  controls.append(overrideLabel, autoLabel, arrange, preset, apply, reset, picker, add, help); toolbar.append(edit, notice, controls)
  const grid = document.createElement('div'); grid.className = 'overview-modules'
  dashboard.append(toolbar, grid)
  let editing = false, currentAccount = null, active = false, layout = [], mode = 'auto', lastSize = '', saving = Promise.resolve()
  function config() { return model.normalizeSettings(settings().overviewLayout) }
  function persist() {
    const data = config()
    if (override.checked && currentAccount) { data.overrides[currentAccount] = model.normalize(layout); data.overrideModes[currentAccount] = mode }
    else { data.global = model.normalize(layout); data.globalMode = mode }
    settings().overviewLayout = data
    saving = saving.catch(() => {}).then(() => save(data)).catch(error => report(error))
  }
  function viewport() {
    const rect = grid.getBoundingClientRect(), area = dashboard.getBoundingClientRect()
    // client sizes are CSS pixels, including when the app uses CSS zoom.
    const scale = grid.clientWidth > 0 ? rect.width / grid.clientWidth : 1
    return { width: grid.clientWidth || rect.width, height: Math.max(1, Number.isFinite(area.bottom - rect.top) ? (area.bottom - rect.top) / scale : rect.height) }
  }
  function fit() {
    if (!active || mode !== 'auto') return
    const size = viewport(), key = `${size.width}:${Math.round(size.height)}`
    if (lastSize !== key) draw()
  }
  function draw() {
    auto.checked = mode === 'auto'; notice.hidden = mode === 'auto'
    const size = viewport(); lastSize = `${size.width}:${Math.round(size.height)}`
    const arranged = mode === 'auto' ? model.autoArrange(layout, size) : null
    if (arranged) layout = arranged.layout
    grid.style.minHeight = arranged ? `${arranged.minHeight}px` : '0px'
    grid.classList.toggle('overview-auto', mode === 'auto')
    // Detach panels before replacing their wrappers (macro and minimap can be nested).
    for (const node of Object.values(nodes)) node.remove()
    inventoryResizer.remove()
    grid.replaceChildren()
    dashboard.classList.toggle('overview-editing', editing)
    grid.style.setProperty('--overview-rows', model.rowCount(layout))
    const byId = new Map(layout.map(item => [item.id, item]))
    for (const [id, node] of Object.entries(nodes)) {
      const item = byId.get(id)
      if (!item) { node.hidden = true; grid.append(node); continue }
      node.hidden = false
      const wrapper = document.createElement('div'); wrapper.className = 'overview-module'; wrapper.dataset.module = id; wrapper.style.gridColumn = `${item.x + 1} / span ${item.w}`; wrapper.style.gridRow = `${item.y + 1} / span ${item.h}`
      const empty = ['scoreboard', 'effects', 'bossBars', 'nextRuns'].includes(id)
        ? !!node.querySelector('.module-empty') : id === 'minimap' && node.classList.contains('map-empty')
      wrapper.classList.toggle('overview-empty', empty)
      const bar = document.createElement('div'); bar.className = 'overview-module-bar'; bar.hidden = !editing
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'overview-module-handle'; handle.textContent = `Move ${model.names[id]}`; handle.setAttribute('aria-label', `Move ${model.names[id]}; shift and arrow keys resize`)
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${model.names[id]}`)
      const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'overview-module-resize'; resize.textContent = '◢'; resize.setAttribute('aria-label', `Resize ${model.names[id]}`); resize.hidden = !editing
      function change(dx, dy, sizing) {
        const updated = { ...item, ...(sizing ? { w: Math.max(1, Math.min(12 - item.x, item.w + dx)), h: Math.max(1, Math.min(3000, item.h + dy)) } : { x: Math.max(0, Math.min(12 - item.w, item.x + dx)), y: Math.max(0, item.y + dy) }) }
        mode = 'manual'
        layout = model.normalize([updated, ...layout.filter(entry => entry.id !== id)]); persist(); draw()
        grid.querySelector(`[data-handle="${id}"]`)?.focus()
      }
      handle.dataset.handle = id
      handle.addEventListener('keydown', event => { const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]; if (delta) { event.preventDefault(); change(delta[0], delta[1] * 25, event.shiftKey) } })
      function drag(event, sizing) {
        if (event.button !== 0) return
        event.preventDefault()
        const rect = grid.getBoundingClientRect(), pitch = model.gridMetrics(rect.width, rect.height, model.rowCount(layout))
        const startX = event.clientX, startY = event.clientY, width = pitch.x, height = pitch.y
        const up = e => { window.removeEventListener('pointerup', up); const dx = Math.round((e.clientX - startX) / width), dy = Math.round((e.clientY - startY) / height); if (dx || dy) change(dx, dy, sizing) }
        window.addEventListener('pointerup', up, { once: true })
      }
      handle.addEventListener('pointerdown', event => drag(event, false)); resize.addEventListener('pointerdown', event => drag(event, true))
      resize.addEventListener('keydown', event => { const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]; if (delta) { event.preventDefault(); change(delta[0], delta[1] * 25, true) } })
      remove.addEventListener('click', () => { layout = layout.filter(entry => entry.id !== id); draw(); persist() })
      bar.append(handle, remove); wrapper.append(bar, node, resize)
      grid.append(wrapper)
    }
    // A standalone map is opt-in. Otherwise it lives beside the movement buttons.
    if (!byId.has('minimap') && byId.has('movement')) { nodes.minimap.hidden = false; nodes.movement.append(nodes.minimap) }
    picker.replaceChildren()
    for (const [id, name] of Object.entries(model.names)) if (!byId.has(id)) { const option = document.createElement('option'); option.value = id; option.textContent = name; picker.append(option) }
    add.disabled = !picker.options.length
  }
  function refresh(force = false) {
    const id = accountId(), overview = dashboard.dataset.view === 'overview' || !dashboard.dataset.view
    if (!overview) {
      if (active) { for (const [key, node] of Object.entries(nodes)) { node.hidden = false; placeholders[key].after(node) } resizerHome.after(inventoryResizer); grid.replaceChildren(); dashboard.classList.remove('overview-editing'); active = false }
      toolbar.hidden = true; grid.hidden = true; return
    }
    toolbar.hidden = false; grid.hidden = false
    if (!active || id !== currentAccount || force) {
      active = true; currentAccount = id; const data = config(); override.checked = Object.hasOwn(data.overrides, id); layout = model.normalize(override.checked ? data.overrides[id] : data.global); mode = override.checked ? data.overrideModes[id] : data.globalMode; draw()
    }
  }
  edit.addEventListener('click', () => { editing = !editing; edit.textContent = editing ? 'Done editing' : 'Edit layout'; edit.setAttribute('aria-pressed', String(editing)); controls.hidden = !editing; draw() })
  override.addEventListener('change', () => {
    const data = config()
    if (override.checked && currentAccount) { data.overrides[currentAccount] = model.normalize(layout); data.overrideModes[currentAccount] = mode }
    else { delete data.overrides[currentAccount]; delete data.overrideModes[currentAccount]; layout = model.normalize(data.global); mode = data.globalMode }
    settings().overviewLayout = data; persist(); draw()
  })
  function arrangeNow() { mode = 'auto'; draw(); persist() }
  arrange.addEventListener('click', arrangeNow); restore.addEventListener('click', arrangeNow)
  auto.addEventListener('change', () => { mode = auto.checked ? 'auto' : 'manual'; draw(); persist() })
  apply.addEventListener('click', () => { layout = model.normalize(model.presets[preset.value]); mode = 'manual'; draw(); persist() })
  reset.addEventListener('click', () => { layout = model.normalize(model.presets.Default); arrangeNow() })
  add.addEventListener('click', () => { const item = model.moduleDefaults[picker.value]; if (item) { layout = model.normalize([...layout, { ...item, y: Math.max(0, ...layout.map(entry => entry.y + entry.h)) }]); draw(); persist() } })
  return { refresh, fit }
}
