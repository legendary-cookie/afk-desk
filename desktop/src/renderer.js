const api = window.afkDesk

const KEY_CONTROLS = {
  KeyW: 'forward',
  KeyA: 'left',
  KeyS: 'back',
  KeyD: 'right',
  Space: 'jump'
}

const activeManualInputs = new Map()

const state = {
  accounts: [],
  selectedId: null,
  selectedInventorySlot: null,
  movingInventorySlot: null,
  draggedAccountId: null,
  statuses: new Map(),
  logs: new Map(),
  telemetry: new Map(),
  serverWindows: new Map(),
  chatHistory: new Map(),
  settings: { uiScale: 100, sidePanelWidth: 300, inventoryHeight: 400, macros: [] },
  resolvedVersions: new Map(),
  login: { code: '', url: 'https://microsoft.com/link' }
}

const el = Object.fromEntries([
  'account-list', 'account-count', 'add-account', 'open-settings', 'settings-dialog', 'close-settings', 'start-with-windows', 'stagger-startup-connections', 'startup-connection-delay', 'save-settings', 'empty-state', 'dashboard', 'account-title', 'app-version', 'settings-app-version',
  'edit-account', 'connection-button', 'status-banner', 'status-name', 'status-detail', 'server-address',
  'detail-username', 'detail-server', 'detail-version', 'detail-antiafk', 'detail-environment', 'detail-water', 'detail-health', 'detail-hunger', 'detail-coordinates', 'detail-chest', 'detail-dimension', 'inventory-count', 'inventory-grid', 'auto-deposit-toggle', 'move-selected', 'hold-selected', 'equip-destination', 'equip-selected', 'lock-selected', 'drop-selected', 'console-log', 'clear-console',
  'chat-form', 'chat-message', 'macro-pad', 'manage-macros', 'macro-editor', 'macro-rows', 'add-macro', 'cancel-macros', 'save-macros', 'account-dialog', 'account-form', 'dialog-title', 'account-id', 'label',
  'username', 'host', 'port', 'version', 'connect-on-startup', 'proxy-enabled', 'proxy-fields', 'proxy-type', 'proxy-host', 'proxy-port', 'proxy-username', 'proxy-password', 'proxy-password-help', 'proxy-clear-password', 'anti-afk', 'anti-afk-min-delay', 'anti-afk-max-delay', 'anti-afk-duration', 'anti-afk-look-degrees', 'anti-afk-walk-distance', 'anti-afk-jump', 'anti-afk-look', 'anti-afk-sneak', 'anti-afk-swing', 'anti-afk-walk', 'environmental-movement', 'auto-reconnect', 'auto-reconnect-delay', 'auto-reconnect-max', 'auto-deposit-setting', 'join-message', 'server-change-message',
  'message-delay', 'form-error', 'delete-account', 'login-dialog', 'login-code', 'open-login-private', 'open-login',
  'close-login', 'ui-scale', 'ui-scale-value', 'column-resizer', 'inventory-resizer', 'server-window-dialog', 'server-window-title', 'server-window-grid', 'close-server-window', 'item-tooltip', 'toast-region'
].map((id) => [id, document.getElementById(id)]))

async function init() {
  const [accounts, settings, appVersion] = await Promise.all([api.listAccounts(), api.getSettings(), api.getAppVersion()])
  state.accounts = accounts
  state.settings = settings
  el['app-version'].textContent = `v${appVersion}`
  el['settings-app-version'].textContent = `Version ${appVersion}`
  state.selectedId = state.accounts[0]?.id || null
  applyUiScale(state.settings.uiScale)
  applyPanelLayout(state.settings)
  bindEvents()
  render()
  observePanelFit()
  api.onBotEvent(handleBotEvent)
}

function bindEvents() {
  el['add-account'].addEventListener('click', () => openAccountDialog())
  el['open-settings'].addEventListener('click', openSettingsDialog)
  el['close-settings'].addEventListener('click', () => {
    applyUiScale(state.settings.uiScale)
    el['settings-dialog'].close()
  })
  el['save-settings'].addEventListener('click', saveSettings)
  el['stagger-startup-connections'].addEventListener('change', syncStartupDelay)
  document.querySelector('[data-action="add"]').addEventListener('click', () => openAccountDialog())
  el['edit-account'].addEventListener('click', () => openAccountDialog(selectedAccount()))
  el['account-form'].addEventListener('submit', saveAccount)
  document.querySelectorAll('[data-close-account]').forEach((button) => button.addEventListener('click', () => el['account-dialog'].close()))
  el['delete-account'].addEventListener('click', deleteAccount)
  el['connection-button'].addEventListener('click', toggleConnection)
  el['drop-selected'].addEventListener('click', dropSelectedStack)
  el['move-selected'].addEventListener('click', toggleMoveSelected)
  el['hold-selected'].addEventListener('click', holdSelectedItem)
  el['equip-selected'].addEventListener('click', equipSelectedItem)
  el['lock-selected'].addEventListener('click', toggleSelectedItemLock)
  el['auto-deposit-toggle'].addEventListener('change', toggleAutoDeposit)
  el['close-server-window'].addEventListener('click', closeServerWindow)
  el['server-window-dialog'].addEventListener('cancel', (event) => { event.preventDefault(); closeServerWindow() })
  el['proxy-enabled'].addEventListener('change', syncProxyFields)
  el['proxy-type'].addEventListener('change', () => {
    el['proxy-port'].value = el['proxy-type'].value === 'http' ? 8080 : 1080
  })
  el['chat-form'].addEventListener('submit', sendChat)
  el['chat-message'].addEventListener('keydown', navigateChatHistory)
  el['manage-macros'].addEventListener('click', () => el['macro-editor'].hidden ? openMacroEditor() : closeMacroEditor())
  el['add-macro'].addEventListener('click', () => addMacroRow())
  el['cancel-macros'].addEventListener('click', closeMacroEditor)
  el['save-macros'].addEventListener('click', saveMacros)
  el['ui-scale'].addEventListener('input', () => {
    el['ui-scale-value'].textContent = `${el['ui-scale'].value}%`
    applyUiScale(el['ui-scale'].value)
  })
  el['clear-console'].addEventListener('click', () => {
    state.logs.set(state.selectedId, [])
    renderConsole()
  })
  bindManualMovement()
  bindPanelResizers()
  document.querySelectorAll('[data-look]').forEach((button) => button.addEventListener('click', () => run(() => api.look(state.selectedId, button.dataset.look))))
  el['login-code'].addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.login.code)
    toast('Sign-in code copied.')
  })
  el['open-login'].addEventListener('click', () => run(() => api.openExternal(state.login.url)))
  el['open-login-private'].addEventListener('click', () => run(() => api.openIsolatedLogin(state.login.accountId, state.login.url, state.login.code)))
  el['close-login'].addEventListener('click', () => el['login-dialog'].close())
}

function render() {
  renderAccountList()
  const account = selectedAccount()
  el['empty-state'].hidden = Boolean(account)
  el.dashboard.hidden = !account
  if (!account) { renderServerWindow(); return }

  const status = getStatus(account.id)
  el['account-title'].textContent = account.label
  el['server-address'].textContent = `${account.host}:${account.port}`
  el['detail-username'].textContent = account.username
  el['detail-server'].textContent = `${account.host}:${account.port}`
  const resolvedVersion = state.resolvedVersions.get(account.id) || account.lastSuccessfulVersion
  el['detail-version'].textContent = account.version || (resolvedVersion ? `${resolvedVersion} (auto)` : 'Auto-detect')
  const minDelay = account.antiAfkMinDelay ?? account.antiAfkInterval ?? 45
  const maxDelay = account.antiAfkMaxDelay ?? account.antiAfkInterval ?? minDelay
  el['detail-antiafk'].textContent = account.antiAfk ? `${minDelay}–${maxDelay} seconds` : 'Disabled'
  el['detail-environment'].textContent = account.environmentalMovement !== false ? 'Allowed' : 'Position held'
  el['auto-deposit-toggle'].checked = account.autoDepositToChest === true
  renderStatus(status)
  renderConsole()
  renderMacroPad()
  renderTelemetry()
  renderServerWindow()
}

function renderAccountList() {
  el['account-count'].textContent = state.accounts.length
  el['account-list'].replaceChildren(...state.accounts.map((account, index) => {
    const row = document.createElement('div')
    row.className = 'account-row'
    row.draggable = state.accounts.length > 1
    row.dataset.accountId = account.id
    const button = document.createElement('button')
    const status = getStatus(account.id).status
    button.type = 'button'
    button.className = 'account-item'
    button.setAttribute('aria-current', String(account.id === state.selectedId))
    const avatar = createPlayerHead(account, 'account-avatar')
    const copy = document.createElement('span')
    copy.className = 'account-copy'
    const title = document.createElement('strong')
    title.textContent = account.label
    const server = document.createElement('span')
    server.textContent = account.host
    copy.append(title, server)
    const indicator = document.createElement('span')
    indicator.className = `mini-status ${status}`
    indicator.setAttribute('aria-label', status)
    button.append(avatar, copy, indicator)
    button.addEventListener('click', () => {
      releaseAllManualInputs()
      state.selectedId = account.id
      state.selectedInventorySlot = null
      state.movingInventorySlot = null
      hideItemTooltip()
      render()
    })
    const controls = document.createElement('span')
    controls.className = 'account-order-controls'
    const up = createOrderButton(account, 'up', index === 0)
    const down = createOrderButton(account, 'down', index === state.accounts.length - 1)
    controls.append(up, down)
    row.append(button, controls)
    row.addEventListener('dragstart', (event) => {
      if (state.accounts.length < 2) return event.preventDefault()
      state.draggedAccountId = account.id
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', account.id)
      requestAnimationFrame(() => row.classList.add('dragging'))
    })
    row.addEventListener('dragover', (event) => {
      if (!state.draggedAccountId || state.draggedAccountId === account.id) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      row.classList.toggle('drop-after', event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2)
      row.classList.add('drag-over')
    })
    row.addEventListener('dragleave', (event) => {
      if (!row.contains(event.relatedTarget)) row.classList.remove('drag-over', 'drop-after')
    })
    row.addEventListener('drop', (event) => {
      event.preventDefault()
      const draggedId = state.draggedAccountId || event.dataTransfer.getData('text/plain')
      const after = row.classList.contains('drop-after')
      clearDragStyles()
      if (draggedId && draggedId !== account.id) run(() => dropAccount(draggedId, account.id, after))
    })
    row.addEventListener('dragend', clearDragStyles)
    return row
  }))
}

function createOrderButton(account, direction, disabled) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'account-order-button'
  button.textContent = direction === 'up' ? '↑' : '↓'
  button.title = `Move ${account.label} ${direction}`
  button.setAttribute('aria-label', button.title)
  button.disabled = disabled
  button.draggable = false
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    run(() => moveAccount(account.id, direction === 'up' ? -1 : 1))
  })
  return button
}

async function moveAccount(id, offset) {
  const from = state.accounts.findIndex((account) => account.id === id)
  const to = from + offset
  if (from < 0 || to < 0 || to >= state.accounts.length) return
  const ordered = [...state.accounts]
  const [account] = ordered.splice(from, 1)
  ordered.splice(to, 0, account)
  await persistAccountOrder(ordered)
}

async function dropAccount(draggedId, targetId, after) {
  const dragged = state.accounts.find((account) => account.id === draggedId)
  if (!dragged) return
  const ordered = state.accounts.filter((account) => account.id !== draggedId)
  let target = ordered.findIndex((account) => account.id === targetId)
  if (target < 0) return
  if (after) target += 1
  ordered.splice(target, 0, dragged)
  await persistAccountOrder(ordered)
}

async function persistAccountOrder(ordered) {
  state.accounts = await api.reorderAccounts(ordered.map((account) => account.id))
  render()
  toast('Account order saved.')
}

function clearDragStyles() {
  state.draggedAccountId = null
  el['account-list'].querySelectorAll('.dragging, .drag-over, .drop-after').forEach((row) => row.classList.remove('dragging', 'drag-over', 'drop-after'))
}

function renderStatus({ status, detail }) {
  const online = status === 'online'
  const canInteract = online || status === 'connected'
  const active = online || status === 'connecting' || status === 'connected' || status === 'reconnecting'
  el['status-banner'].className = `status-banner ${['connected', 'reconnecting'].includes(status) ? 'connecting' : status}`
  el['status-name'].textContent = status
  el['status-detail'].textContent = detail
  el['connection-button'].textContent = status === 'reconnecting' ? 'Cancel reconnect' : active ? 'Disconnect' : 'Connect'
  el['connection-button'].className = `button ${active ? 'secondary' : 'primary'}`
  el['chat-message'].disabled = !canInteract
  el['chat-form'].querySelector('button').disabled = !canInteract
  renderMacroPad(canInteract)
  document.querySelectorAll('[data-control], [data-look]').forEach((button) => { button.disabled = !canInteract })
  updateInventoryActions(canInteract)
}

function renderConsole() {
  const logs = state.logs.get(state.selectedId) || []
  if (!logs.length) {
    const placeholder = document.createElement('div')
    placeholder.className = 'console-placeholder'
    placeholder.textContent = 'Server messages will appear here after you connect.'
    el['console-log'].replaceChildren(placeholder)
    return
  }
  el['console-log'].replaceChildren(...logs.map((entry) => {
    const line = document.createElement('div')
    line.className = `log-line ${entry.kind}`
    const time = document.createElement('time')
    time.dateTime = new Date(entry.at).toISOString()
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const message = document.createElement('span')
    appendLogMessage(message, entry)
    line.append(time, message)
    return line
  }))
  el['console-log'].scrollTop = el['console-log'].scrollHeight
}

function renderTelemetry() {
  const telemetry = state.telemetry.get(state.selectedId)
  el['detail-water'].textContent = describeWater(telemetry?.environment)
  el['detail-health'].textContent = telemetry ? `${formatNumber(telemetry.health)} / 20` : '—'
  el['detail-hunger'].textContent = telemetry ? `${formatNumber(telemetry.food)} / 20` : '—'
  el['detail-coordinates'].textContent = telemetry?.position ? `${telemetry.position.x}, ${telemetry.position.y}, ${telemetry.position.z}` : '—'
  el['detail-chest'].textContent = telemetry?.nearestChest ? `${formatContainerType(telemetry.nearestChest.type)} at ${telemetry.nearestChest.x}, ${telemetry.nearestChest.y}, ${telemetry.nearestChest.z} (${formatNumber(telemetry.nearestChest.distance)} blocks)` : telemetry ? 'Not found within 5 blocks' : '—'
  el['detail-dimension'].textContent = telemetry ? String(telemetry.dimension || 'unknown').replace(/^minecraft:/, '') : '—'
  const items = telemetry?.inventory || []
  if (!items.some((item) => item.slot === state.selectedInventorySlot)) state.selectedInventorySlot = null
  if (!items.some((item) => item.slot === state.movingInventorySlot)) state.movingInventorySlot = null
  el['inventory-count'].textContent = telemetry ? `${items.length} occupied slot${items.length === 1 ? '' : 's'}` : 'Connect to view items'
  if (!telemetry) {
    const empty = document.createElement('div')
    empty.className = 'inventory-empty'
    empty.textContent = 'Inventory will appear while this account is online.'
    el['inventory-grid'].replaceChildren(empty)
    updateInventoryActions()
    return
  }
  const bySlot = new Map(items.map((item) => [item.slot, item]))
  const shell = document.createElement('div')
  shell.className = 'minecraft-inventory'
  const equipment = createInventorySection('Gear', [5, 6, 7, 8, 45], bySlot, telemetry, 'equipment')
  const storage = createInventorySection('Inventory', Array.from({ length: 27 }, (_, index) => index + 9), bySlot, telemetry, 'storage')
  const hotbar = createInventorySection('Hotbar', Array.from({ length: 9 }, (_, index) => index + 36), bySlot, telemetry, 'hotbar')
  const main = document.createElement('div')
  main.className = 'minecraft-inventory-main'
  main.append(storage, hotbar)
  shell.append(equipment, main)
  el['inventory-grid'].replaceChildren(shell)
  updateInventoryActions()
}

function createInventorySection(labelText, slots, bySlot, telemetry, kind) {
  const section = document.createElement('section')
  section.className = `minecraft-inventory-section ${kind}`
  const label = document.createElement('div')
  label.className = 'minecraft-section-label'
  label.textContent = labelText
  const grid = document.createElement('div')
  grid.className = `minecraft-slot-grid ${kind}`
  grid.replaceChildren(...slots.map((slotNumber) => createPlayerSlot(slotNumber, bySlot.get(slotNumber), telemetry)))
  section.append(label, grid)
  return section
}

function createPlayerSlot(slotNumber, item, telemetry) {
  const slot = document.createElement('button')
  slot.type = 'button'
  const locked = item && isSelectedAccountSlotLocked(slotNumber)
  const held = slotNumber === 36 + (telemetry.selectedHotbarSlot || 0)
  slot.className = `minecraft-slot${item ? '' : ' empty'}${slotNumber === state.selectedInventorySlot ? ' selected' : ''}${slotNumber === state.movingInventorySlot ? ' moving' : ''}${locked ? ' locked' : ''}${held ? ' held' : ''}`
  slot.dataset.slot = slotNumber
  slot.setAttribute('aria-label', item ? `${itemTooltipName(item)}, slot ${slotNumber}${locked ? ', locked' : ''}${held ? ', held' : ''}` : `Empty slot ${slotNumber}`)
  slot.append(createSlotContents(item, { locked, held }))
  slot.addEventListener('click', () => {
    if (state.movingInventorySlot != null) return void moveInventoryItem(state.movingInventorySlot, slotNumber)
    if (!item) return
    state.selectedInventorySlot = state.selectedInventorySlot === slotNumber ? null : slotNumber
    renderTelemetry()
  })
  if (item) {
    slot.draggable = true
    slot.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', String(slotNumber)); event.dataTransfer.effectAllowed = 'move' })
    bindItemTooltip(slot, item)
  }
  slot.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' })
  slot.addEventListener('drop', (event) => { event.preventDefault(); const source = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(source)) void moveInventoryItem(source, slotNumber) })
  return slot
}

function createSlotContents(item, { locked = false, held = false } = {}) {
  const fragment = document.createDocumentFragment()
  if (!item) return fragment
  fragment.append(createItemIcon(item))
  if (item.count > 1) {
    const count = document.createElement('span')
    count.className = 'minecraft-item-count'
    count.textContent = item.count
    fragment.append(count)
  }
  if (item.durability) {
    const durability = document.createElement('span')
    durability.className = 'minecraft-durability'
    durability.style.setProperty('--durability', `${item.durability.percent}%`)
    fragment.append(durability)
  }
  if (locked) { const badge = document.createElement('span'); badge.className = 'minecraft-lock'; badge.textContent = '◆'; fragment.append(badge) }
  if (held) { const badge = document.createElement('span'); badge.className = 'minecraft-held'; badge.textContent = '▲'; fragment.append(badge) }
  return fragment
}

function createItemIcon(item) {
  const icon = document.createElement('span')
  icon.className = `minecraft-item-icon${item.enchants?.length ? ' enchanted' : ''}`
  const atlas = window.__minecraftItemAtlas
  const index = atlas?.items?.[item.name]
  if (Number.isInteger(index)) {
    icon.style.backgroundPosition = `${-(index % atlas.columns) * atlas.cell}px ${-Math.floor(index / atlas.columns) * atlas.cell}px`
    icon.style.backgroundSize = `${atlas.columns * atlas.cell}px ${atlas.rows * atlas.cell}px`
  } else icon.classList.add('missing')
  return icon
}

function itemTooltipName(item) { return item.customName || item.displayName || item.name || 'Unknown item' }

function bindItemTooltip(target, item) {
  target.addEventListener('mouseenter', (event) => showItemTooltip(item, event))
  target.addEventListener('mousemove', positionItemTooltip)
  target.addEventListener('mouseleave', hideItemTooltip)
  target.addEventListener('focus', (event) => showItemTooltip(item, event))
  target.addEventListener('blur', hideItemTooltip)
}

function showItemTooltip(item, event) {
  const layer = event.currentTarget?.closest('dialog') || document.body
  if (el['item-tooltip'].parentElement !== layer) layer.append(el['item-tooltip'])
  const lines = []
  const title = document.createElement('strong')
  title.textContent = itemTooltipName(item)
  lines.push(title)
  for (const enchant of item.enchants || []) { const line = document.createElement('span'); line.className = 'enchant'; line.textContent = `${formatMinecraftName(enchant.name)} ${romanNumeral(enchant.level)}`; lines.push(line) }
  for (const loreText of item.lore || []) { const line = document.createElement('span'); line.className = 'lore'; line.textContent = loreText; lines.push(line) }
  if (item.durability) { const line = document.createElement('span'); line.textContent = `Durability: ${item.durability.remaining} / ${item.durability.maximum}`; lines.push(line) }
  const technical = document.createElement('span')
  technical.className = 'technical'
  technical.textContent = `minecraft:${item.name} · ×${item.count}`
  lines.push(technical)
  el['item-tooltip'].replaceChildren(...lines)
  el['item-tooltip'].hidden = false
  positionItemTooltip(event)
}

function positionItemTooltip(event) {
  if (el['item-tooltip'].hidden) return
  const x = Number(event.clientX) || event.currentTarget?.getBoundingClientRect().right || 0
  const y = Number(event.clientY) || event.currentTarget?.getBoundingClientRect().top || 0
  const width = el['item-tooltip'].offsetWidth
  const height = el['item-tooltip'].offsetHeight
  const dialog = el['item-tooltip'].parentElement?.matches('dialog') ? el['item-tooltip'].parentElement.getBoundingClientRect() : null
  const bounds = dialog || { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  el['item-tooltip'].style.left = `${Math.max(bounds.left + 8, Math.min(x + 14, bounds.right - width - 8))}px`
  el['item-tooltip'].style.top = `${Math.max(bounds.top + 8, Math.min(y + 14, bounds.bottom - height - 8))}px`
}

function hideItemTooltip() { el['item-tooltip'].hidden = true }

function formatMinecraftName(value) { return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }

function romanNumeral(value) {
  const known = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  return known[value] || String(value)
}

function updateInventoryActions(canInteract = ['online', 'connected'].includes(getStatus(state.selectedId).status)) {
  const telemetry = state.telemetry.get(state.selectedId)
  const item = telemetry?.inventory?.find((entry) => entry.slot === state.selectedInventorySlot)
  const locked = item && isSelectedAccountSlotLocked(item.slot)
  el['drop-selected'].disabled = !canInteract || !item || locked
  el['drop-selected'].textContent = item ? locked ? `${item.displayName} is locked` : `Drop ${item.count} × ${item.displayName}` : 'Drop selected stack'
  el['lock-selected'].disabled = !item
  el['lock-selected'].textContent = item ? `${locked ? 'Unlock' : 'Lock'} ${item.displayName}` : 'Lock selected stack'
  el['move-selected'].disabled = !canInteract || !item
  el['move-selected'].textContent = state.movingInventorySlot == null ? 'Move selected' : 'Cancel move'
  el['hold-selected'].disabled = !canInteract || !item
  el['equip-selected'].disabled = !canInteract || !item
}

function toggleMoveSelected() {
  state.movingInventorySlot = state.movingInventorySlot == null ? state.selectedInventorySlot : null
  if (state.movingInventorySlot != null) toast('Choose an empty or occupied destination slot, or drag the item.')
  renderTelemetry()
}

async function moveInventoryItem(sourceSlot, destinationSlot) {
  if (sourceSlot === destinationSlot) { state.movingInventorySlot = null; renderTelemetry(); return }
  hideItemTooltip()
  try {
    const result = await api.moveInventorySlot(state.selectedId, sourceSlot, destinationSlot)
    const account = selectedAccount()
    if (account && result.account) Object.assign(account, result.account)
    state.selectedInventorySlot = result.targetSlot
    state.movingInventorySlot = null
    toast(`Moved item to slot ${result.targetSlot}.`)
  } catch (error) { toast(cleanError(error), 'error') }
  renderTelemetry()
}

async function holdSelectedItem() { await equipOrHoldSelected('hand') }

async function equipSelectedItem() { await equipOrHoldSelected(el['equip-destination'].value) }

async function equipOrHoldSelected(destination) {
  const slot = state.selectedInventorySlot
  if (slot == null) return
  hideItemTooltip()
  try {
    const result = await api.equipInventoryItem(state.selectedId, slot, destination)
    const account = selectedAccount()
    if (account && result.account) Object.assign(account, result.account)
    state.selectedInventorySlot = result.targetSlot
    state.movingInventorySlot = null
    toast(result.destination === 'hand' ? 'Selected item is now held.' : `Equipped to ${formatMinecraftName(result.destination)}.`)
  } catch (error) { toast(cleanError(error), 'error') }
  renderTelemetry()
}

async function toggleSelectedItemLock() {
  const account = selectedAccount()
  const slot = state.selectedInventorySlot
  if (!account || slot == null) return
  const locked = !isSelectedAccountSlotLocked(slot)
  el['lock-selected'].disabled = true
  try {
    const saved = await api.setItemLock(account.id, slot, locked)
    Object.assign(account, saved)
    toast(locked ? 'Item stack locked.' : 'Item stack unlocked.')
  } catch (error) { toast(cleanError(error), 'error') }
  renderTelemetry()
}

function isSelectedAccountSlotLocked(slot) {
  return (selectedAccount()?.lockedInventorySlots || []).includes(Number(slot))
}

function formatSlotType(item) {
  return item.slotType && item.slotType !== 'inventory' ? item.slotType : `slot ${item.slot}`
}

function formatContainerType(type) {
  return String(type || 'chest').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

async function dropSelectedStack() {
  const slot = state.selectedInventorySlot
  if (slot == null) return
  el['drop-selected'].disabled = true
  try {
    await api.dropStack(state.selectedId, slot)
    state.selectedInventorySlot = null
    toast('Selected stack dropped.')
  } catch (error) { toast(cleanError(error), 'error') }
  renderTelemetry()
}

async function toggleAutoDeposit() {
  const account = selectedAccount()
  if (!account) return
  const enabled = el['auto-deposit-toggle'].checked
  el['auto-deposit-toggle'].disabled = true
  try {
    const saved = await api.setAutoDeposit(account.id, enabled)
    Object.assign(account, saved)
    toast(enabled ? 'Auto-deposit enabled.' : 'Auto-deposit disabled.')
  } catch (error) {
    el['auto-deposit-toggle'].checked = account.autoDepositToChest === true
    toast(cleanError(error), 'error')
  } finally { el['auto-deposit-toggle'].disabled = false }
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : Number(value || 0).toFixed(1)
}

function openAccountDialog(account) {
  el['account-form'].reset()
  el['form-error'].hidden = true
  el['account-id'].value = account?.id || ''
  el.label.value = account?.minecraftName || ''
  el.username.value = account?.username || ''
  el.host.value = account?.host || ''
  el.port.value = account?.port || 25565
  el.version.value = account?.version || ''
  el['connect-on-startup'].checked = account?.connectOnStartup === true
  el['proxy-enabled'].checked = account?.proxy?.enabled === true
  el['proxy-type'].value = account?.proxy?.type || 'socks5'
  el['proxy-host'].value = account?.proxy?.host || ''
  el['proxy-port'].value = account?.proxy?.port || (account?.proxy?.type === 'http' ? 8080 : 1080)
  el['proxy-username'].value = account?.proxy?.username || ''
  el['proxy-password'].value = ''
  el['proxy-password'].placeholder = account?.proxy?.hasPassword ? 'Saved password unchanged' : 'Not saved yet'
  el['proxy-password-help'].textContent = account?.proxy?.hasPassword ? 'A password is saved with Windows encryption. Enter a new one only to replace it.' : 'Encrypted with Windows protection when saved.'
  el['proxy-clear-password'].checked = false
  syncProxyFields()
  el['anti-afk'].checked = account?.antiAfk !== false
  const legacyAntiAfkDelay = account?.antiAfkInterval || 45
  el['anti-afk-min-delay'].value = account?.antiAfkMinDelay ?? legacyAntiAfkDelay
  el['anti-afk-max-delay'].value = account?.antiAfkMaxDelay ?? legacyAntiAfkDelay
  el['anti-afk-duration'].value = account?.antiAfkActionDuration ?? 0.25
  el['anti-afk-look-degrees'].value = account?.antiAfkLookDegrees ?? 12
  el['anti-afk-walk-distance'].value = account?.antiAfkWalkDistance ?? 0.5
  el['anti-afk-jump'].checked = account?.antiAfkJump !== false
  el['anti-afk-look'].checked = account?.antiAfkLook !== false
  el['anti-afk-sneak'].checked = account?.antiAfkSneak === true
  el['anti-afk-swing'].checked = account?.antiAfkSwing === true
  el['anti-afk-walk'].checked = account?.antiAfkWalk === true
  el['environmental-movement'].checked = account?.environmentalMovement !== false
  el['auto-reconnect'].checked = account?.autoReconnect !== false
  el['auto-reconnect-delay'].value = account?.autoReconnectDelay || 5
  el['auto-reconnect-max'].value = account?.autoReconnectMaxAttempts ?? 0
  el['auto-deposit-setting'].checked = account?.autoDepositToChest === true
  el['join-message'].value = account?.joinMessage || ''
  el['server-change-message'].value = account?.serverChangeMessage || ''
  el['message-delay'].value = account?.messageDelay ?? 6
  el['dialog-title'].textContent = account ? 'Edit account' : 'Add account'
  el['delete-account'].hidden = !account
  el['account-dialog'].showModal()
  setTimeout(() => (account ? el.host : el.username).focus(), 0)
}

async function saveAccount(event) {
  event.preventDefault()
  const existing = state.accounts.find((account) => account.id === el['account-id'].value)
  const input = {
    id: el['account-id'].value || undefined,
    label: el.label.value,
    username: el.username.value,
    host: el.host.value,
    port: Number(el.port.value),
    version: el.version.value,
    connectOnStartup: el['connect-on-startup'].checked,
    proxy: {
      enabled: el['proxy-enabled'].checked,
      type: el['proxy-type'].value,
      host: el['proxy-host'].value,
      port: Number(el['proxy-port'].value),
      username: el['proxy-username'].value,
      password: el['proxy-password'].value,
      clearPassword: el['proxy-clear-password'].checked
    },
    minecraftName: existing?.minecraftName || '',
    minecraftUuid: existing?.minecraftUuid || '',
    skinUrl: existing?.skinUrl || '',
    antiAfk: el['anti-afk'].checked,
    antiAfkMinDelay: Number(el['anti-afk-min-delay'].value),
    antiAfkMaxDelay: Number(el['anti-afk-max-delay'].value),
    antiAfkActionDuration: Number(el['anti-afk-duration'].value),
    antiAfkLookDegrees: Number(el['anti-afk-look-degrees'].value),
    antiAfkWalkDistance: Number(el['anti-afk-walk-distance'].value),
    antiAfkJump: el['anti-afk-jump'].checked,
    antiAfkLook: el['anti-afk-look'].checked,
    antiAfkSneak: el['anti-afk-sneak'].checked,
    antiAfkSwing: el['anti-afk-swing'].checked,
    antiAfkWalk: el['anti-afk-walk'].checked,
    environmentalMovement: el['environmental-movement'].checked,
    autoReconnect: el['auto-reconnect'].checked,
    autoReconnectDelay: Number(el['auto-reconnect-delay'].value),
    autoReconnectMaxAttempts: Number(el['auto-reconnect-max'].value),
    autoDepositToChest: el['auto-deposit-setting'].checked,
    joinMessage: el['join-message'].value,
    serverChangeMessage: el['server-change-message'].value,
    messageDelay: Number(el['message-delay'].value)
  }
  try {
    const saved = await api.saveAccount(input)
    const index = state.accounts.findIndex((account) => account.id === saved.id)
    if (index === -1) state.accounts.push(saved)
    else state.accounts[index] = saved
    state.selectedId = saved.id
    state.selectedInventorySlot = null
    el['account-dialog'].close()
    render()
    toast('Account saved.')
  } catch (error) {
    el['form-error'].textContent = cleanError(error)
    el['form-error'].hidden = false
  }
}

async function deleteAccount() {
  const id = el['account-id'].value
  if (!id || !confirm('Delete this account profile? Microsoft tokens for it remain on this computer.')) return
  await api.deleteAccount(id)
  state.accounts = state.accounts.filter((account) => account.id !== id)
  state.statuses.delete(id)
  state.logs.delete(id)
  state.telemetry.delete(id)
  state.selectedId = state.accounts[0]?.id || null
  state.selectedInventorySlot = null
  el['account-dialog'].close()
  render()
  toast('Account deleted.')
}

async function toggleConnection() {
  const account = selectedAccount()
  if (!account) return
  const status = getStatus(account.id).status
  await run(() => ['online', 'connecting', 'connected', 'reconnecting'].includes(status) ? api.disconnect(account.id) : api.connect(account.id))
}

async function sendChat(event) {
  event.preventDefault()
  const message = el['chat-message'].value.trim()
  if (!message) return
  await sendChatMessage(message)
}

function bindManualMovement() {
  document.querySelectorAll('[data-control]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      if (button.disabled || event.button !== 0) return
      event.preventDefault()
      button.setPointerCapture?.(event.pointerId)
      pressManualInput(`pointer:${event.pointerId}:${button.dataset.control}`, button.dataset.control, button)
    })
    const release = (event) => releaseManualInput(`pointer:${event.pointerId}:${button.dataset.control}`)
    button.addEventListener('pointerup', release)
    button.addEventListener('pointercancel', release)
  })
  document.addEventListener('keydown', (event) => {
    const control = KEY_CONTROLS[event.code]
    if (!control || event.repeat || shouldIgnoreMovementKey(event.target, event.code)) return
    event.preventDefault()
    pressManualInput(`key:${event.code}`, control, document.querySelector(`[data-control="${control}"]`))
  })
  document.addEventListener('keyup', (event) => {
    if (!KEY_CONTROLS[event.code]) return
    releaseManualInput(`key:${event.code}`)
  })
  window.addEventListener('blur', releaseAllManualInputs)
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllManualInputs() })
}

function shouldIgnoreMovementKey(target, code) {
  if (!state.selectedId || document.querySelector('dialog[open]')) return true
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return true
  return code === 'Space' && Boolean(target?.closest?.('button, a'))
}

function pressManualInput(source, control, button) {
  if (activeManualInputs.has(source) || !state.selectedId || getStatus(state.selectedId).status !== 'online') return
  const input = { accountId: state.selectedId, control, button }
  activeManualInputs.set(source, input)
  button?.classList.add('pressed')
  if ([...activeManualInputs.values()].filter((item) => item.accountId === input.accountId && item.control === control).length > 1) return
  api.setControlState(input.accountId, control, true).catch((error) => {
    activeManualInputs.delete(source)
    button?.classList.remove('pressed')
    toast(cleanError(error), 'error')
  })
}

function releaseManualInput(source) {
  const input = activeManualInputs.get(source)
  if (!input) return
  activeManualInputs.delete(source)
  input.button?.classList.remove('pressed')
  const stillHeld = [...activeManualInputs.values()].some((item) => item.accountId === input.accountId && item.control === input.control)
  if (!stillHeld) api.setControlState(input.accountId, input.control, false).catch(() => {})
}

function releaseAllManualInputs(accountId = null) {
  const sources = [...activeManualInputs.entries()]
    .filter(([, input]) => !accountId || input.accountId === accountId)
    .map(([source]) => source)
  for (const source of sources) releaseManualInput(source)
}

async function sendChatMessage(message) {
  const text = String(message || '').trim().slice(0, 256)
  if (!text || !state.selectedId) return
  rememberChatMessage(state.selectedId, text)
  try {
    await api.sendChat(state.selectedId, text)
    el['chat-message'].value = ''
  } catch (error) { toast(cleanError(error), 'error') }
}

function rememberChatMessage(accountId, message) {
  const history = state.chatHistory.get(accountId) || { entries: [], index: 0, draft: '' }
  if (history.entries.at(-1) !== message) history.entries = [...history.entries.slice(-99), message]
  history.index = history.entries.length
  history.draft = ''
  state.chatHistory.set(accountId, history)
}

function navigateChatHistory(event) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !state.selectedId) return
  const history = state.chatHistory.get(state.selectedId)
  if (!history?.entries.length) return
  event.preventDefault()
  if (event.key === 'ArrowUp') {
    if (history.index >= history.entries.length) history.draft = el['chat-message'].value
    history.index = Math.max(0, history.index - 1)
    el['chat-message'].value = history.entries[history.index]
  } else if (history.index < history.entries.length - 1) {
    history.index += 1
    el['chat-message'].value = history.entries[history.index]
  } else {
    history.index = history.entries.length
    el['chat-message'].value = history.draft
  }
  el['chat-message'].setSelectionRange(el['chat-message'].value.length, el['chat-message'].value.length)
}

function renderMacroPad(canInteract = ['online', 'connected'].includes(getStatus(state.selectedId).status)) {
  const macros = state.settings.macros || []
  if (!macros.length) {
    const empty = document.createElement('span')
    empty.className = 'macro-empty'
    empty.textContent = 'No macros yet. Choose Edit to add one.'
    el['macro-pad'].replaceChildren(empty)
    return
  }
  el['macro-pad'].replaceChildren(...macros.map((macro) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'macro-button'
    button.textContent = macro.label
    button.title = macro.message
    button.disabled = !canInteract
    button.addEventListener('click', () => sendChatMessage(macro.message))
    return button
  }))
}

function openMacroEditor() {
  el['macro-rows'].replaceChildren()
  for (const macro of state.settings.macros || []) addMacroRow(macro)
  el['macro-editor'].hidden = false
  el['manage-macros'].setAttribute('aria-expanded', 'true')
  if (!state.settings.macros?.length) addMacroRow()
  el['macro-rows'].querySelector('input')?.focus()
}

function closeMacroEditor() {
  el['macro-editor'].hidden = true
  el['manage-macros'].setAttribute('aria-expanded', 'false')
}

function addMacroRow(macro = {}) {
  const row = document.createElement('div')
  row.className = 'macro-row'
  const label = document.createElement('input')
  label.className = 'macro-label-input'
  label.maxLength = 40
  label.placeholder = 'Button label'
  label.setAttribute('aria-label', 'Macro button label')
  label.value = macro.label || ''
  const message = document.createElement('input')
  message.className = 'macro-message-input'
  message.maxLength = 256
  message.placeholder = 'Message or /command'
  message.setAttribute('aria-label', 'Macro message or command')
  message.value = macro.message || ''
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'icon-button macro-remove'
  remove.textContent = '×'
  remove.setAttribute('aria-label', 'Delete macro')
  remove.addEventListener('click', () => row.remove())
  row.append(label, message, remove)
  el['macro-rows'].append(row)
  message.focus()
}

async function saveMacros() {
  const macros = [...el['macro-rows'].querySelectorAll('.macro-row')].map((row) => ({
    label: row.querySelector('.macro-label-input').value,
    message: row.querySelector('.macro-message-input').value
  })).filter((macro) => macro.message.trim())
  try {
    state.settings = await api.saveSettings({ ...state.settings, macros })
    closeMacroEditor()
    renderMacroPad()
    toast('Macro pad saved.')
  } catch (error) { toast(cleanError(error), 'error') }
}

function handleBotEvent({ type, id, payload }) {
  if (type === 'status') {
    state.statuses.set(id, payload)
    if (!['online', 'connected'].includes(payload.status)) {
      releaseAllManualInputs(id)
      state.serverWindows.delete(id)
    }
    renderAccountList()
    if (id === state.selectedId) renderStatus(payload)
  }
  if (type === 'log') {
    const logs = state.logs.get(id) || []
    state.logs.set(id, [...logs.slice(-499), payload])
    if (id === state.selectedId) renderConsole()
  }
  if (type === 'telemetry') {
    state.telemetry.set(id, payload)
    if (id === state.selectedId) renderTelemetry()
  }
  if (type === 'window') {
    if (payload.open) state.serverWindows.set(id, payload)
    else state.serverWindows.delete(id)
    if (id === state.selectedId) renderServerWindow()
  }
  if (type === 'version') {
    state.resolvedVersions.set(id, payload.version)
    const account = state.accounts.find((item) => item.id === id)
    if (account) account.lastSuccessfulVersion = payload.version
    if (id === state.selectedId) el['detail-version'].textContent = account?.version || `${payload.version} (auto)`
  }
  if (type === 'identity') {
    const account = state.accounts.find((item) => item.id === id)
    if (account) {
      if (/^[A-Za-z0-9_]{1,16}$/.test(payload.username || '')) {
        account.minecraftName = payload.username
        account.label = payload.username
      }
      if (payload.uuid) account.minecraftUuid = payload.uuid
      if (validSkinUrl(payload.skinUrl)) account.skinUrl = payload.skinUrl
      renderAccountList()
      if (id === state.selectedId) {
        el['account-title'].textContent = account.label
        el['detail-username'].textContent = account.username
      }
    }
  }
  if (type === 'login-code') {
    state.login = {
      accountId: id,
      code: payload.code,
      url: payload.verificationUri || 'https://microsoft.com/link'
    }
    el['login-code'].textContent = payload.code || 'See console'
    if (!el['login-dialog'].open) el['login-dialog'].showModal()
  }
}

function renderServerWindow() {
  const menu = state.serverWindows.get(state.selectedId)
  if (!menu) {
    if (el['server-window-dialog'].open) el['server-window-dialog'].close()
    return
  }
  el['server-window-title'].textContent = menu.title || 'Server menu'
  const slots = new Map((menu.slots || []).map((item) => [item.slot, item]))
  const highestSlot = Math.max(-1, ...slots.keys()) + 1
  const size = Math.max(highestSlot, Math.min(Number(menu.size) || 0, 256))
  el['server-window-grid'].replaceChildren(...Array.from({ length: size }, (_, slotNumber) => {
    const item = slots.get(slotNumber)
    if (!item) {
      const empty = document.createElement('span')
      empty.className = 'minecraft-slot empty server-window-empty'
      empty.setAttribute('aria-hidden', 'true')
      return empty
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'minecraft-slot server-window-slot'
    button.setAttribute('aria-label', `${itemTooltipName(item)}, server slot ${item.slot}`)
    button.append(createSlotContents(item))
    bindItemTooltip(button, item)
    button.addEventListener('click', () => run(() => api.clickWindowSlot(state.selectedId, item.slot)))
    return button
  }))
  if (!el['server-window-dialog'].open) el['server-window-dialog'].showModal()
}

async function closeServerWindow() {
  const id = state.selectedId
  if (!id) return
  try { await api.closeServerWindow(id) }
  catch (error) { toast(cleanError(error), 'error') }
}

async function openSettingsDialog() {
  try {
    const settings = await api.getSettings()
    state.settings = settings
    el['start-with-windows'].checked = settings.startWithWindows === true
    el['stagger-startup-connections'].checked = settings.staggerStartupConnections !== false
    el['startup-connection-delay'].value = settings.startupConnectionDelay || 3
    el['ui-scale'].value = settings.uiScale || 100
    el['ui-scale-value'].textContent = `${el['ui-scale'].value}%`
    syncStartupDelay()
    el['settings-dialog'].showModal()
  } catch (error) { toast(cleanError(error), 'error') }
}

async function saveSettings() {
  try {
    state.settings = await api.saveSettings({
      ...state.settings,
      startWithWindows: el['start-with-windows'].checked,
      staggerStartupConnections: el['stagger-startup-connections'].checked,
      startupConnectionDelay: Number(el['startup-connection-delay'].value),
      uiScale: Number(el['ui-scale'].value)
    })
    applyUiScale(state.settings.uiScale)
    el['settings-dialog'].close()
    toast('Settings saved.')
  } catch (error) { toast(cleanError(error), 'error') }
}

function applyUiScale(value) {
  const scale = Math.max(75, Math.min(Number(value) || 100, 125))
  api.setUiScale(scale)
}

function applyPanelLayout(settings = state.settings) {
  const sidePanelWidth = Math.max(240, Math.min(Number(settings.sidePanelWidth) || 300, 520))
  const inventoryHeight = Math.max(minimumInventoryHeight(), Math.min(Number(settings.inventoryHeight) || 400, 480))
  state.settings.sidePanelWidth = sidePanelWidth
  state.settings.inventoryHeight = inventoryHeight
  document.documentElement.style.setProperty('--side-panel-width', `${sidePanelWidth}px`)
  document.documentElement.style.setProperty('--inventory-height', `${inventoryHeight}px`)
  el['column-resizer'].setAttribute('aria-valuetext', `Controls ${sidePanelWidth} pixels wide`)
  el['inventory-resizer'].setAttribute('aria-valuetext', `Inventory ${inventoryHeight} pixels high`)
}

function bindPanelResizers() {
  const resizeSide = (sidePanelWidth) => {
    const workspaceWidth = document.querySelector('.workspace-grid')?.clientWidth || 900
    state.settings.sidePanelWidth = Math.max(240, Math.min(sidePanelWidth, Math.min(520, workspaceWidth - 360)))
    applyPanelLayout(state.settings)
  }
  const resizeInventory = (inventoryHeight) => {
    const dashboardHeight = el.dashboard?.clientHeight || 700
    const minimum = minimumInventoryHeight()
    const maximum = Math.max(minimum, Math.min(480, dashboardHeight - 260))
    state.settings.inventoryHeight = Math.max(minimum, Math.min(inventoryHeight, maximum))
    applyPanelLayout(state.settings)
  }
  bindSplitter(el['column-resizer'], {
    axis: 'x', value: () => state.settings.sidePanelWidth || 300,
    resize: (start, delta) => resizeSide(start - delta),
    keys: { ArrowLeft: 1, ArrowRight: -1 }
  })
  bindSplitter(el['inventory-resizer'], {
    axis: 'y', value: () => state.settings.inventoryHeight || 400,
    resize: (start, delta) => resizeInventory(start - delta),
    keys: { ArrowUp: 1, ArrowDown: -1 }
  })
}

function minimumInventoryHeight() {
  const headerHeight = document.querySelector('.inventory-header')?.scrollHeight || 36
  return Math.max(240, Math.min(420, Math.ceil(headerHeight) + 240))
}

function observePanelFit() {
  const inventoryHeader = document.querySelector('.inventory-header')
  if (!inventoryHeader || typeof ResizeObserver !== 'function') return
  const observer = new ResizeObserver(() => {
    if (el.dashboard.hidden) return
    const minimum = minimumInventoryHeight()
    if ((state.settings.inventoryHeight || 400) >= minimum) return
    state.settings.inventoryHeight = minimum
    applyPanelLayout(state.settings)
  })
  observer.observe(inventoryHeader)
  requestAnimationFrame(() => applyPanelLayout(state.settings))
}

function bindSplitter(handle, config) {
  let drag = null
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    drag = { pointerId: event.pointerId, position: config.axis === 'x' ? event.clientX : event.clientY, value: config.value() }
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('dragging')
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const position = config.axis === 'x' ? event.clientX : event.clientY
    config.resize(drag.value, position - drag.position)
  })
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag = null
    handle.classList.remove('dragging')
    savePanelLayout()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('dblclick', () => {
    config.resize(config.axis === 'x' ? 300 : 112, 0)
    savePanelLayout()
  })
  handle.addEventListener('keydown', (event) => {
    if (!config.keys[event.key]) return
    event.preventDefault()
    const step = event.shiftKey ? 20 : 8
    config.resize(config.value() + config.keys[event.key] * step, 0)
    savePanelLayout()
  })
}

async function savePanelLayout() {
  try {
    state.settings = await api.saveSettings({ ...state.settings })
    applyPanelLayout(state.settings)
  } catch (error) { toast(`Panel size was not saved: ${cleanError(error)}`, 'error') }
}

function describeWater(environment) {
  if (!environment) return 'Connect to inspect'
  if (!environment.enabled) return 'Disabled'
  if (!environment.physicsEnabled) return 'Physics paused'
  if (environment.waterStatus === 'dry') return 'Not in water'
  if (environment.waterStatus === 'still') return `Water detected (${environment.waterBlocks}), no horizontal current`
  if (environment.waterStatus === 'error') return 'Inspection error'
  if (environment.waterStatus === 'unavailable') return 'World data unavailable'
  if (environment.current) {
    const mode = environment.fallbackActive ? ', fallback active' : ''
    const corrections = environment.serverCorrections ? `, ${environment.serverCorrections} server correction${environment.serverCorrections === 1 ? '' : 's'}` : ''
    return `Flow x ${environment.current.x}, z ${environment.current.z}${mode}${corrections}`
  }
  return 'Checking…'
}

function syncStartupDelay() {
  el['startup-connection-delay'].disabled = !el['stagger-startup-connections'].checked
}

function selectedAccount() {
  return state.accounts.find((account) => account.id === state.selectedId)
}

function getStatus(id) {
  return state.statuses.get(id) || { status: 'offline', detail: 'Ready to connect' }
}

async function run(action) {
  try { return await action() }
  catch (error) { toast(cleanError(error), 'error') }
}

function cleanError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function syncProxyFields() {
  const disabled = !el['proxy-enabled'].checked
  el['proxy-fields'].querySelectorAll('input, select').forEach((input) => { input.disabled = disabled })
  el['proxy-fields'].classList.toggle('disabled', disabled)
}

function createPlayerHead(account, className) {
  const avatar = document.createElement('span')
  avatar.className = className
  avatar.setAttribute('aria-hidden', 'true')
  if (!validSkinUrl(account.skinUrl)) {
    avatar.textContent = account.minecraftName?.slice(0, 1).toUpperCase() || account.label.slice(0, 1).toUpperCase()
    return avatar
  }
  avatar.classList.add('has-skin')
  avatar.style.backgroundImage = `url("${account.skinUrl}")`
  const overlay = document.createElement('span')
  overlay.className = 'skin-overlay'
  overlay.style.backgroundImage = `url("${account.skinUrl}")`
  avatar.append(overlay)
  return avatar
}

function validSkinUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'textures.minecraft.net' && /^\/texture\/[a-z0-9]+$/i.test(url.pathname)
  } catch { return false }
}

function appendLogMessage(container, entry) {
  if (entry.kind === 'sent') {
    container.textContent = `You: ${entry.message}`
    return
  }
  if (!Array.isArray(entry.segments) || !entry.segments.length) {
    container.textContent = entry.message
    return
  }
  for (const segment of entry.segments) {
    const part = document.createElement('span')
    part.textContent = String(segment.text || '')
    if (/^#[0-9a-f]{6}$/i.test(segment.color || '')) part.style.color = segment.color
    if (segment.bold) part.classList.add('chat-bold')
    if (segment.italic) part.classList.add('chat-italic')
    if (segment.underlined) part.classList.add('chat-underlined')
    if (segment.strikethrough) part.classList.add('chat-strikethrough')
    container.append(part)
  }
}

function toast(message, kind = '') {
  const item = document.createElement('div')
  item.className = `toast ${kind}`
  item.textContent = message
  el['toast-region'].append(item)
  setTimeout(() => item.remove(), 4000)
}

init().catch((error) => toast(cleanError(error), 'error'))
