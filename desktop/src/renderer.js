const api = window.afkDesk
const povMath = window.afkPovMath

const KEY_CONTROLS = {
  KeyW: 'forward',
  KeyA: 'left',
  KeyS: 'back',
  KeyD: 'right',
  Space: 'jump'
}

const activeManualInputs = new Map()
let chatCompletionTimer = null
let povTimer = null
let povPaused = false
let povFocusId = null
let povRefreshActive = false
const povSnapshots = new Map()
const povDisplaySnapshots = new Map()
let povAnimationFrame = null
let povLastAnimationAt = 0
let povLookAnimationFrame = null
let povLookDelta = { accountId: null, yaw: 0, pitch: 0 }
let automationDraft = []
let automationIndex = 0
let automationStepIndex = -1

const ENCHANTMENT_DETAILS = {
  aqua_affinity: [1, 'Speeds up underwater mining.'],
  bane_of_arthropods: [5, (level) => `Adds ${formatEffectNumber(level * 2.5)} damage to arthropods and slows them.`],
  binding_curse: [1, 'Prevents equipped armor from being removed.'],
  blast_protection: [4, 'Reduces explosion damage and knockback.'],
  breach: [4, (level) => `Reduces the target's effective armor by ${level * 15}%.`],
  channeling: [1, 'Summons lightning when a thrown trident hits during a thunderstorm.'],
  curse_of_binding: [1, 'Prevents equipped armor from being removed.'],
  curse_of_vanishing: [1, 'Causes the item to disappear when its holder dies.'],
  density: [5, (level) => `Adds ${formatEffectNumber(level * 0.5)} damage per block fallen to mace smash attacks.`],
  depth_strider: [3, 'Increases underwater movement speed.'],
  efficiency: [5, 'Increases mining speed.'],
  feather_falling: [4, 'Reduces fall damage.'],
  fire_aspect: [2, 'Sets melee targets on fire.'],
  fire_protection: [4, 'Reduces fire damage and burn time.'],
  flame: [1, 'Sets arrows on fire.'],
  fortune: [3, 'Increases certain block drops.'],
  frost_walker: [2, 'Freezes nearby water while walking.'],
  impaling: [5, 'Increases trident damage against aquatic targets.'],
  infinity: [1, 'Allows normal arrows to be fired without consuming them.'],
  knockback: [2, 'Increases melee knockback.'],
  looting: [3, 'Increases mob drops.'],
  loyalty: [3, 'Returns a thrown trident to its owner.'],
  luck_of_the_sea: [3, 'Improves fishing treasure quality.'],
  lure: [3, 'Reduces the wait for a fish to bite.'],
  mending: [1, 'Uses collected experience to repair the item.'],
  multishot: [1, 'Fires three projectiles while consuming one.'],
  piercing: [4, (level) => `Lets crossbow projectiles pass through up to ${level} target${level === 1 ? '' : 's'}.`],
  power: [5, 'Increases arrow damage.'],
  projectile_protection: [4, 'Reduces projectile damage.'],
  protection: [4, 'Reduces most incoming damage.'],
  punch: [2, 'Increases arrow knockback.'],
  quick_charge: [3, 'Reduces crossbow loading time.'],
  respiration: [3, 'Extends underwater breathing time.'],
  riptide: [3, 'Launches the user with a wet thrown trident.'],
  sharpness: [5, (level) => `Increases melee damage by ${formatEffectNumber(0.5 * level + 0.5)}.`],
  silk_touch: [1, 'Makes certain blocks drop themselves.'],
  smite: [5, (level) => `Adds ${formatEffectNumber(level * 2.5)} damage to undead targets.`],
  soul_speed: [3, 'Increases movement speed on soul sand and soul soil.'],
  sweeping_edge: [3, 'Increases sweeping attack damage.'],
  swift_sneak: [3, 'Increases movement speed while sneaking.'],
  thorns: [3, 'May damage attackers when the wearer is hit.'],
  unbreaking: [3, 'Reduces the chance that durability is consumed.'],
  vanishing_curse: [1, 'Causes the item to disappear when its holder dies.'],
  wind_burst: [3, 'Launches the attacker upward after a mace smash attack.']
}

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
  chatSuggestions: [],
  chatSuggestionIndex: 0,
  chatCompletionRequest: 0,
  supportedVersions: [],
  settings: { uiScale: 100, workspaceDesign: 'hybrid', colorTheme: 'obsidian', sidePanelWidth: 300, inventoryHeight: 220, macros: [] },
  inventoryCollapsed: false,
  workspaceView: 'overview',
  resolvedVersions: new Map(),
  login: { code: '', url: 'https://microsoft.com/link' }
}

const el = Object.fromEntries([
  'account-list', 'account-count', 'add-account', 'open-settings', 'toggle-sidebar', 'open-command-center', 'command-dialog', 'command-search', 'command-results', 'close-command-center', 'quick-scale', 'quick-scale-number', 'reset-scale', 'quick-scale-value', 'quick-workspace-design', 'quick-color-theme', 'workspace-design', 'color-theme', 'display-menu', 'console-menu', 'macro-menu', 'settings-dialog', 'close-settings', 'start-with-windows', 'notifications-enabled', 'stagger-startup-connections', 'startup-connection-delay', 'save-settings', 'empty-state', 'dashboard', 'account-title', 'app-version', 'settings-app-version',
  'edit-account', 'open-logs', 'open-automations', 'open-pov', 'connection-button', 'status-banner', 'status-name', 'status-detail', 'server-address',
  'detail-username', 'detail-server', 'detail-version', 'detail-antiafk', 'detail-environment', 'detail-water', 'detail-health', 'detail-hunger', 'detail-coordinates', 'detail-chest', 'detail-dimension', 'inventory-count', 'inventory-grid', 'auto-deposit-toggle', 'hold-selected', 'equip-destination', 'equip-selected', 'lock-selected', 'inventory-action-count', 'deposit-selected', 'drop-count-selected', 'drop-selected', 'toggle-inventory', 'console-log', 'clear-console',
  'chat-form', 'chat-message', 'chat-suggestions', 'macro-pad', 'manage-macros', 'macro-dialog', 'close-macro-dialog', 'macro-editor', 'macro-rows', 'add-macro', 'cancel-macros', 'save-macros', 'account-dialog', 'account-form', 'dialog-title', 'account-id', 'identity-id', 'profile-name', 'edition', 'label',
  'username', 'host', 'port', 'version', 'modded-fields', 'mod-loader', 'mod-handshake', 'client-brand', 'mod-list', 'mod-channels', 'connect-on-startup', 'proxy-mode', 'proxy-enabled', 'proxy-fields', 'proxy-type', 'proxy-host', 'proxy-port', 'proxy-username', 'proxy-password', 'proxy-password-help', 'proxy-clear-password', 'share-proxy-pool', 'proxy-label', 'proxy-max-sessions', 'alert-disconnect', 'alert-errors', 'alert-health', 'anti-afk', 'anti-afk-min-delay', 'anti-afk-max-delay', 'anti-afk-duration', 'anti-afk-look-degrees', 'anti-afk-walk-distance', 'anti-afk-jump', 'anti-afk-look', 'anti-afk-sneak', 'anti-afk-swing', 'anti-afk-walk', 'environmental-movement', 'auto-reconnect', 'auto-reconnect-delay', 'auto-reconnect-backoff', 'auto-reconnect-max-delay', 'auto-reconnect-rate-limit-delay', 'auto-reconnect-max', 'connect-timeout', 'reconnect-reset-delay', 'auto-deposit-setting', 'auto-deposit-range', 'join-message', 'server-change-message',
  'message-delay', 'form-error', 'delete-account', 'duplicate-profile', 'login-dialog', 'login-code', 'open-login-private', 'open-login',
  'close-login', 'ui-scale', 'ui-scale-value', 'pov-settings-refresh', 'pov-settings-fps', 'pov-settings-radius', 'pov-settings-columns', 'pov-max-feeds', 'pov-settings-view-mode', 'pov-show-hud', 'column-resizer', 'inventory-resizer', 'server-window-dialog', 'server-window-title', 'server-window-stage', 'server-window-art', 'server-window-grid', 'close-server-window', 'logs-dialog', 'close-logs', 'log-filter', 'refresh-logs', 'clear-persistent-logs', 'persistent-log-view', 'automation-dialog', 'close-automation', 'automation-json', 'automation-list', 'automation-flow', 'automation-palette', 'automation-inspector', 'automation-add', 'automation-delete', 'automation-scope', 'automation-json-toggle', 'automation-test', 'save-automations', 'stop-automation', 'pov-dialog', 'close-pov', 'pov-grid', 'pov-search', 'pov-columns', 'pov-refresh', 'pov-fps', 'pov-view-mode', 'pov-pause', 'pov-back-grid', 'pov-radius', 'pov-x', 'pov-y', 'pov-z', 'pov-detail', 'item-tooltip', 'toast-region'
].map((id) => [id, document.getElementById(id)]))

async function init() {
  const [accounts, settings, appVersion, versions] = await Promise.all([api.listAccounts(), api.getSettings(), api.getAppVersion(), api.getSupportedVersions()])
  state.accounts = accounts
  state.settings = settings
  state.supportedVersions = versions
  populateVersionOptions(versions)
  el['app-version'].textContent = `v${appVersion}`
  el['settings-app-version'].textContent = `Version ${appVersion}`
  state.selectedId = state.accounts[0]?.id || null
  applyUiScale(state.settings.uiScale)
  applyVisualDesign(state.settings.workspaceDesign, state.settings.colorTheme)
  applyPanelLayout(state.settings)
  bindEvents()
  render()
  observePanelFit()
  api.onBotEvent(handleBotEvent)
}

function bindEvents() {
  el['add-account'].addEventListener('click', () => openAccountDialog())
  el['open-settings'].addEventListener('click', openSettingsDialog)
  el['open-command-center'].addEventListener('click', openCommandCenter)
  el['close-command-center'].addEventListener('click', closeCommandCenter)
  el['command-search'].addEventListener('input', renderCommandResults)
  el['command-search'].addEventListener('keydown', handleCommandSearchKey)
  el['command-dialog'].addEventListener('cancel', (event) => { event.preventDefault(); closeCommandCenter() })
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandCenter() }
  })
  el['close-settings'].addEventListener('click', () => {
    applyUiScale(state.settings.uiScale)
    el['settings-dialog'].close()
  })
  el['save-settings'].addEventListener('click', saveSettings)
  el['stagger-startup-connections'].addEventListener('change', syncStartupDelay)
  document.querySelector('[data-action="add"]').addEventListener('click', () => openAccountDialog())
  el['edit-account'].addEventListener('click', () => openAccountDialog(selectedAccount()))
  el['open-logs'].addEventListener('click', openPersistentLogs)
  el['open-automations'].addEventListener('click', openAutomations)
  el['open-pov'].addEventListener('click', openPov)
  el['account-form'].addEventListener('submit', saveAccount)
  document.querySelectorAll('[data-close-account]').forEach((button) => button.addEventListener('click', () => el['account-dialog'].close()))
  el['delete-account'].addEventListener('click', deleteAccount)
  el['duplicate-profile'].addEventListener('click', duplicateProfile)
  el['connection-button'].addEventListener('click', toggleConnection)
  el['drop-selected'].addEventListener('click', dropSelectedStack)
  el['drop-count-selected'].addEventListener('click', dropSelectedCount)
  el['deposit-selected'].addEventListener('click', depositSelectedCount)
  el['hold-selected'].addEventListener('click', holdSelectedItem)
  el['equip-selected'].addEventListener('click', equipSelectedItem)
  el['lock-selected'].addEventListener('click', toggleSelectedItemLock)
  el['auto-deposit-toggle'].addEventListener('change', toggleAutoDeposit)
  el['close-server-window'].addEventListener('click', closeServerWindow)
  el['server-window-dialog'].addEventListener('cancel', (event) => { event.preventDefault(); closeServerWindow() })
  el['proxy-enabled'].addEventListener('change', () => { el['proxy-mode'].value = el['proxy-enabled'].checked ? 'manual' : 'direct'; syncProxyFields() })
  el['proxy-mode'].addEventListener('change', syncProxyFields)
  el.edition.addEventListener('change', syncEditionFields)
  el['mod-loader'].addEventListener('change', syncModdedFields)
  el['proxy-type'].addEventListener('change', () => {
    el['proxy-port'].value = el['proxy-type'].value === 'http' ? 8080 : 1080
  })
  el['chat-form'].addEventListener('submit', sendChat)
  el['chat-message'].addEventListener('keydown', handleChatKeyDown)
  el['chat-message'].addEventListener('input', scheduleChatCompletion)
  el['chat-message'].addEventListener('blur', () => setTimeout(closeChatSuggestions, 120))
  el['manage-macros'].addEventListener('click', openMacroEditor)
  el['add-macro'].addEventListener('click', () => addMacroRow())
  el['cancel-macros'].addEventListener('click', closeMacroEditor)
  el['save-macros'].addEventListener('click', saveMacros)
  el['close-macro-dialog'].addEventListener('click', closeMacroEditor)
  el['macro-dialog'].addEventListener('cancel', (event) => { event.preventDefault(); closeMacroEditor() })
  el['ui-scale'].addEventListener('input', () => {
    el['ui-scale-value'].textContent = `${el['ui-scale'].value}%`
    applyUiScale(el['ui-scale'].value)
  })
  el['clear-console'].addEventListener('click', () => {
    state.logs.set(state.selectedId, [])
    renderConsole()
    el['console-menu'].hidePopover?.()
  })
  el['toggle-inventory'].addEventListener('click', toggleInventory)
  el['toggle-sidebar'].addEventListener('click', toggleSidebar)
  el['quick-scale'].addEventListener('input', () => previewQuickScale(el['quick-scale'].value))
  el['quick-scale'].addEventListener('change', () => saveQuickScale(el['quick-scale'].value))
  el['quick-scale-number'].addEventListener('input', () => previewTypedScale(el['quick-scale-number'].value))
  el['quick-scale-number'].addEventListener('change', () => saveQuickScale(el['quick-scale-number'].value))
  el['quick-scale-number'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void saveQuickScale(el['quick-scale-number'].value) }
  })
  el['reset-scale'].addEventListener('click', () => saveQuickScale(100))
  el['quick-workspace-design'].addEventListener('change', () => saveVisualDesign(el['quick-workspace-design'].value, el['quick-color-theme'].value))
  el['quick-color-theme'].addEventListener('change', () => saveVisualDesign(el['quick-workspace-design'].value, el['quick-color-theme'].value))
  el['workspace-design'].addEventListener('change', () => applyVisualDesign(el['workspace-design'].value, el['color-theme'].value))
  el['color-theme'].addEventListener('change', () => applyVisualDesign(el['workspace-design'].value, el['color-theme'].value))
  document.querySelectorAll('[data-collapse-target]').forEach((button) => button.addEventListener('click', () => toggleSection(button)))
  document.querySelectorAll('[data-workspace-view]').forEach((button) => button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView)))
  document.querySelector('[data-workspace-dialog="pov"]').addEventListener('click', openPov)
  document.querySelector('[data-workspace-dialog="automations"]').addEventListener('click', openAutomations)
  document.querySelector('[data-workspace-dialog="logs"]').addEventListener('click', openPersistentLogs)
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
  el['close-logs'].addEventListener('click', () => el['logs-dialog'].close())
  el['refresh-logs'].addEventListener('click', refreshPersistentLogs)
  el['log-filter'].addEventListener('change', refreshPersistentLogs)
  el['clear-persistent-logs'].addEventListener('click', clearPersistentLogs)
  el['close-automation'].addEventListener('click', () => el['automation-dialog'].close())
  el['save-automations'].addEventListener('click', saveAutomations)
  el['stop-automation'].addEventListener('click', () => run(() => api.stopAutomation(state.selectedId)))
  el['automation-add'].addEventListener('click', addAutomation)
  el['automation-delete'].addEventListener('click', deleteAutomation)
  el['automation-json-toggle'].addEventListener('change', toggleAutomationJson)
  el['automation-test'].addEventListener('click', testAutomation)
  el['close-pov'].addEventListener('click', closePov)
  el['pov-dialog'].addEventListener('close', closePovInput)
  document.addEventListener('mousemove', handlePovMouseMove)
  document.addEventListener('pointerlockchange', handlePovPointerLockChange)
  el['pov-radius'].addEventListener('change', refreshPov)
  el['pov-search'].addEventListener('input', renderPovGrid)
  el['pov-columns'].addEventListener('change', updatePovOptions)
  el['pov-refresh'].addEventListener('change', updatePovOptions)
  el['pov-fps'].addEventListener('change', updatePovOptions)
  el['pov-view-mode'].addEventListener('change', updatePovOptions)
  el['pov-pause'].addEventListener('click', togglePovPause)
  el['pov-back-grid'].addEventListener('click', () => { povFocusId = null; renderPovGrid(); startPovPolling() })
  document.querySelectorAll('[data-world-action]').forEach((button) => button.addEventListener('click', () => runWorldAction(button.dataset.worldAction)))
}

function populateVersionOptions(versions) {
  const automatic = document.createElement('option')
  automatic.value = ''
  automatic.textContent = 'Automatic (detect from server)'
  const options = (Array.isArray(versions) ? versions : []).map((version) => {
    const option = document.createElement('option')
    option.value = version
    option.textContent = `Minecraft ${version}`
    return option
  })
  el.version.replaceChildren(automatic, ...options)
}

function render() {
  renderAccountList()
  const account = selectedAccount()
  el['empty-state'].hidden = Boolean(account)
  el.dashboard.hidden = !account
  if (!account) { renderServerWindow(); return }

  const status = getStatus(account.id)
  el['account-title'].textContent = account.profileName || account.label
  el['server-address'].textContent = `${account.host}:${account.port}`
  el['detail-username'].textContent = account.username
  el['detail-server'].textContent = `${account.host}:${account.port}`
  const resolvedVersion = state.resolvedVersions.get(account.id) || account.lastSuccessfulVersion
  el['detail-version'].textContent = account.edition === 'bedrock' ? `Bedrock ${resolvedVersion || 'auto'}` : account.version || (resolvedVersion ? `${resolvedVersion} (auto)` : 'Auto-detect')
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
    title.textContent = account.profileName || account.label
    const server = document.createElement('span')
    server.textContent = `${account.edition === 'bedrock' ? 'Bedrock · ' : ''}${account.host}`
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
  if (!canInteract) closeChatSuggestions()
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
  const depositRange = selectedAccount()?.autoDepositRange || 5
  el['detail-chest'].textContent = telemetry?.nearestChest ? `${formatContainerType(telemetry.nearestChest.type)} at ${telemetry.nearestChest.x}, ${telemetry.nearestChest.y}, ${telemetry.nearestChest.z} (${formatNumber(telemetry.nearestChest.distance)} blocks)` : telemetry ? `No visible container within ${depositRange} blocks` : '—'
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
  if (item.enchants?.length) {
    const badge = document.createElement('span')
    badge.className = 'minecraft-enchanted'
    badge.textContent = '✦'
    badge.title = `${item.enchants.length} enchantment${item.enchants.length === 1 ? '' : 's'}`
    fragment.append(badge)
  }
  if (item.lore?.length) {
    const badge = document.createElement('span')
    badge.className = 'minecraft-lore'
    badge.textContent = '▤'
    badge.title = `${item.lore.length} lore line${item.lore.length === 1 ? '' : 's'}`
    fragment.append(badge)
  }
  if (locked) { const badge = document.createElement('span'); badge.className = 'minecraft-lock'; badge.textContent = '◆'; fragment.append(badge) }
  if (held) { const badge = document.createElement('span'); badge.className = 'minecraft-held'; badge.textContent = '▲'; fragment.append(badge) }
  return fragment
}

function createItemIcon(item) {
  const icon = document.createElement('span')
  icon.className = `minecraft-item-icon${item.enchants?.length ? ' enchanted' : ''}`
  if (item.resourceIcon) {
    icon.classList.add('custom-resource')
    icon.style.backgroundImage = `url("${item.resourceIcon}")`
    return icon
  }
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
  for (const enchant of item.enchants || []) {
    const detail = enchantmentDetail(enchant)
    const line = document.createElement('span')
    line.className = `enchant${detail.curse ? ' curse' : ''}`
    line.textContent = `${formatMinecraftName(enchant.name)} ${romanNumeral(enchant.level)}`
    const effect = document.createElement('span')
    effect.className = 'enchant-detail'
    effect.textContent = detail.description
    const level = document.createElement('span')
    level.className = 'enchant-level'
    level.textContent = detail.maximum ? `Level ${detail.level} of ${detail.maximum}` : `Level ${detail.level}`
    lines.push(line, effect, level)
  }
  if (item.lore?.length) {
    const heading = document.createElement('span')
    heading.className = 'lore-heading'
    heading.textContent = 'Lore'
    lines.push(heading)
  }
  for (const [index, loreText] of (item.lore || []).entries()) {
    const line = document.createElement('span')
    line.className = 'lore'
    const segments = item.loreSegments?.[index]
    if (Array.isArray(segments) && segments.length) appendLoreSegments(line, segments)
    else line.textContent = loreText
    lines.push(line)
  }
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

function enchantmentDetail(enchant) {
  const name = String(enchant?.name || '').replace(/^minecraft:/, '')
  const level = Math.max(1, Number(enchant?.level) || 1)
  const [maximum, description] = ENCHANTMENT_DETAILS[name] || [null, 'Enchanted item effect.']
  return {
    level,
    maximum,
    description: typeof description === 'function' ? description(level) : description,
    curse: name.includes('curse')
  }
}

function formatEffectNumber(value) { return Number.isInteger(value) ? String(value) : Number(value).toFixed(1) }

function appendLoreSegments(container, segments) {
  for (const segment of segments) {
    const part = document.createElement('span')
    part.textContent = String(segment.text || '')
    if (/^#[0-9a-f]{6}$/i.test(segment.color || '')) part.style.color = segment.color
    if (segment.bold) part.style.fontWeight = '700'
    if (segment.italic === false) part.style.fontStyle = 'normal'
    else if (segment.italic) part.style.fontStyle = 'italic'
    const decorations = [segment.underlined && 'underline', segment.strikethrough && 'line-through'].filter(Boolean)
    if (decorations.length) part.style.textDecoration = decorations.join(' ')
    container.append(part)
  }
}

function updateInventoryActions(canInteract = ['online', 'connected'].includes(getStatus(state.selectedId).status)) {
  const telemetry = state.telemetry.get(state.selectedId)
  const item = telemetry?.inventory?.find((entry) => entry.slot === state.selectedInventorySlot)
  const locked = item && isSelectedAccountSlotLocked(item.slot)
  el['drop-selected'].disabled = !canInteract || !item || locked
  el['drop-count-selected'].disabled = !canInteract || !item || locked
  el['deposit-selected'].disabled = !canInteract || !item || locked
  el['drop-selected'].textContent = 'Drop'
  el['drop-selected'].title = item ? locked ? `${item.displayName} is locked` : `Drop ${item.count} × ${item.displayName}` : 'Select a stack to drop'
  el['lock-selected'].disabled = !item
  el['lock-selected'].textContent = locked ? 'Unlock' : 'Lock'
  el['lock-selected'].title = item ? `${locked ? 'Unlock' : 'Lock'} ${item.displayName}` : 'Select a stack to lock'
  el['hold-selected'].disabled = !canInteract || !item
  el['equip-selected'].disabled = !canInteract || !item
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

async function dropSelectedCount() {
  const slot = state.selectedInventorySlot
  if (slot == null) return
  const count = Math.max(1, Math.min(Number(el['inventory-action-count'].value) || 1, 64))
  try { await api.dropItems(state.selectedId, slot, count); toast(`Dropped ${count} item${count === 1 ? '' : 's'}.`) }
  catch (error) { toast(cleanError(error), 'error') }
}

async function depositSelectedCount() {
  const slot = state.selectedInventorySlot
  if (slot == null) return
  const count = Math.max(1, Math.min(Number(el['inventory-action-count'].value) || 1, 64))
  try { await api.depositSlot(state.selectedId, slot, count); toast(`Deposited ${count} item${count === 1 ? '' : 's'}.`) }
  catch (error) { toast(cleanError(error), 'error') }
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
  el['identity-id'].value = account?.identityId || ''
  el['profile-name'].value = account?.profileName || account?.host || ''
  el.edition.value = account?.edition || 'java'
  el.label.value = account?.minecraftName || ''
  el.username.value = account?.username || ''
  el.host.value = account?.host || ''
  el.port.value = account?.port || 25565
  el.version.value = account?.version || ''
  el['mod-loader'].value = account?.modLoader || 'auto'
  el['mod-handshake'].value = account?.modHandshake || 'auto'
  el['client-brand'].value = account?.clientBrand || ''
  el['mod-list'].value = (account?.mods || []).map((mod) => `${mod.modid}@${mod.version}`).join('\n')
  el['mod-channels'].value = (account?.modChannels || []).join('\n')
  el['connect-on-startup'].checked = account?.connectOnStartup === true
  el['proxy-enabled'].checked = account?.proxy?.enabled === true
  el['proxy-mode'].value = account?.proxyMode || (account?.proxy?.enabled ? 'manual' : 'direct')
  el['proxy-type'].value = account?.proxy?.type || 'socks5'
  el['proxy-host'].value = account?.proxy?.host || ''
  el['proxy-port'].value = account?.proxy?.port || (account?.proxy?.type === 'http' ? 8080 : 1080)
  el['proxy-username'].value = account?.proxy?.username || ''
  el['proxy-password'].value = ''
  el['proxy-password'].placeholder = account?.proxy?.hasPassword ? 'Saved password unchanged' : 'Not saved yet'
  el['proxy-password-help'].textContent = account?.proxy?.hasPassword ? 'A password is saved with Windows encryption. Enter a new one only to replace it.' : 'Encrypted with Windows protection when saved.'
  el['proxy-clear-password'].checked = false
  el['share-proxy-pool'].checked = account?.shareProxyToPool === true
  el['proxy-label'].value = account?.proxyLabel || ''
  el['proxy-max-sessions'].value = account?.proxyMaxSessions || 1
  el['alert-disconnect'].checked = account?.alerts?.disconnect !== false
  el['alert-errors'].checked = account?.alerts?.errors !== false
  el['alert-health'].value = account?.alerts?.healthBelow ?? 6
  syncProxyFields()
  syncEditionFields(false)
  syncModdedFields()
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
  el['auto-reconnect-backoff'].value = account?.autoReconnectBackoffMultiplier ?? 2
  el['auto-reconnect-max-delay'].value = account?.autoReconnectMaxDelay ?? 300
  el['auto-reconnect-rate-limit-delay'].value = account?.autoReconnectRateLimitDelay ?? 30
  el['auto-reconnect-max'].value = account?.autoReconnectMaxAttempts ?? 0
  el['connect-timeout'].value = account?.connectTimeoutSeconds ?? 60
  el['reconnect-reset-delay'].value = account?.reconnectResetDelay ?? 60
  el['auto-deposit-setting'].checked = account?.autoDepositToChest === true
  el['auto-deposit-range'].value = account?.autoDepositRange ?? 5
  el['join-message'].value = account?.joinMessage || ''
  el['server-change-message'].value = account?.serverChangeMessage || ''
  el['message-delay'].value = account?.messageDelay ?? 6
  el['dialog-title'].textContent = account ? 'Edit account' : 'Add account'
  el['delete-account'].hidden = !account
  el['duplicate-profile'].hidden = !account
  el['account-dialog'].showModal()
  setTimeout(() => (account ? el.host : el.username).focus(), 0)
}

async function saveAccount(event) {
  event.preventDefault()
  const existing = state.accounts.find((account) => account.id === el['account-id'].value)
  const input = {
    id: el['account-id'].value || undefined,
    identityId: el['identity-id'].value || undefined,
    profileName: el['profile-name'].value,
    edition: el.edition.value,
    label: el.label.value,
    username: el.username.value,
    host: el.host.value,
    port: Number(el.port.value),
    version: el.version.value,
    modLoader: el['mod-loader'].value,
    modHandshake: el['mod-handshake'].value,
    clientBrand: el['client-brand'].value,
    modList: el['mod-list'].value,
    modChannels: el['mod-channels'].value,
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
    proxyMode: el['proxy-mode'].value,
    shareProxyToPool: el['share-proxy-pool'].checked,
    proxyLabel: el['proxy-label'].value,
    proxyMaxSessions: Number(el['proxy-max-sessions'].value),
    alerts: {
      disconnect: el['alert-disconnect'].checked,
      errors: el['alert-errors'].checked,
      healthBelow: Number(el['alert-health'].value)
    },
    automations: existing?.automations || [],
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
    autoReconnectBackoffMultiplier: Number(el['auto-reconnect-backoff'].value),
    autoReconnectMaxDelay: Number(el['auto-reconnect-max-delay'].value),
    autoReconnectRateLimitDelay: Number(el['auto-reconnect-rate-limit-delay'].value),
    autoReconnectMaxAttempts: Number(el['auto-reconnect-max'].value),
    connectTimeoutSeconds: Number(el['connect-timeout'].value),
    reconnectResetDelay: Number(el['reconnect-reset-delay'].value),
    autoDepositToChest: el['auto-deposit-setting'].checked,
    autoDepositRange: Number(el['auto-deposit-range'].value),
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

async function duplicateProfile() {
  const id = el['account-id'].value
  if (!id) return
  try {
    const copy = await api.duplicateProfile(id)
    state.accounts.push(copy)
    state.selectedId = copy.id
    el['account-dialog'].close()
    render()
    openAccountDialog(copy)
    toast('Server profile duplicated. Authentication identity is shared.')
  } catch (error) { toast(cleanError(error), 'error') }
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
  closeChatSuggestions()
  await sendChatMessage(message)
}

function scheduleChatCompletion() {
  clearTimeout(chatCompletionTimer)
  chatCompletionTimer = setTimeout(requestChatSuggestions, 140)
}

async function requestChatSuggestions() {
  const text = el['chat-message'].value
  const status = getStatus(state.selectedId).status
  if (!text || !['online', 'connected'].includes(status)) return closeChatSuggestions()
  const request = ++state.chatCompletionRequest
  try {
    const suggestions = await api.completeChat(state.selectedId, text)
    if (request !== state.chatCompletionRequest || text !== el['chat-message'].value) return
    state.chatSuggestions = Array.isArray(suggestions) ? suggestions.slice(0, 40) : []
    state.chatSuggestionIndex = 0
    renderChatSuggestions()
  } catch { closeChatSuggestions() }
}

function renderChatSuggestions() {
  const suggestions = state.chatSuggestions
  el['chat-suggestions'].hidden = suggestions.length === 0
  el['chat-message'].setAttribute('aria-expanded', String(suggestions.length > 0))
  el['chat-suggestions'].replaceChildren(...suggestions.map((suggestion, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `chat-suggestion${index === state.chatSuggestionIndex ? ' selected' : ''}`
    button.role = 'option'
    button.setAttribute('aria-selected', String(index === state.chatSuggestionIndex))
    const label = document.createElement('span')
    label.textContent = suggestion.label || suggestion.value
    const detail = document.createElement('small')
    detail.textContent = suggestion.tooltip || suggestion.source || ''
    button.append(label, detail)
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', () => applyChatSuggestion(index))
    return button
  }))
}

function closeChatSuggestions() {
  state.chatCompletionRequest += 1
  state.chatSuggestions = []
  state.chatSuggestionIndex = 0
  el['chat-suggestions'].hidden = true
  el['chat-suggestions'].replaceChildren()
  el['chat-message'].setAttribute('aria-expanded', 'false')
}

function applyChatSuggestion(index = state.chatSuggestionIndex) {
  const suggestion = state.chatSuggestions[index]
  if (!suggestion) return
  el['chat-message'].value = suggestion.value
  closeChatSuggestions()
  el['chat-message'].focus()
  el['chat-message'].setSelectionRange(el['chat-message'].value.length, el['chat-message'].value.length)
}

function handleChatKeyDown(event) {
  if (state.chatSuggestions.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      state.chatSuggestionIndex = (state.chatSuggestionIndex + delta + state.chatSuggestions.length) % state.chatSuggestions.length
      renderChatSuggestions()
      return
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault()
      applyChatSuggestion()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeChatSuggestions()
      return
    }
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    void requestChatSuggestions()
    return
  }
  navigateChatHistory(event)
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
  if (!state.selectedId) return true
  const openDialog = document.querySelector('dialog[open]')
  if (openDialog && openDialog !== el['pov-dialog']) return true
  if (openDialog === el['pov-dialog'] && !povFocusId) return true
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
    closeChatSuggestions()
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
  el['macro-menu'].hidePopover?.()
  if (!state.settings.macros?.length) addMacroRow()
  if (!el['macro-dialog'].open) el['macro-dialog'].showModal()
  el['macro-rows'].querySelector('input')?.focus()
}

function closeMacroEditor() {
  if (el['macro-dialog'].open) el['macro-dialog'].close()
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
        el['account-title'].textContent = account.profileName || account.label
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
  if (type === 'macro') {
    const logs = state.logs.get(id) || []
    state.logs.set(id, [...logs.slice(-499), { kind: payload.status === 'failed' ? 'error' : 'system', message: `Automation ${payload.name || payload.macroId}: ${payload.status}${payload.error ? ` — ${payload.error}` : ''}`, at: payload.at }])
    if (id === state.selectedId) {
      renderConsole()
      if (payload.status === 'failed') toast(`Automation failed: ${payload.error}`, 'error')
    }
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
  void renderServerWindowArt(menu.resourceTitle, size)
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
    if (item.resourceModel) button.dataset.resourceModel = item.resourceModel
    button.setAttribute('aria-label', `${itemTooltipName(item)}, server slot ${item.slot}`)
    if (!/pixiestudios_air$/i.test(item.resourceModel || '')) button.append(createSlotContents(item))
    bindItemTooltip(button, item)
    button.addEventListener('click', () => run(() => api.clickWindowSlot(state.selectedId, item.slot)))
    return button
  }))
  if (!el['server-window-dialog'].open) el['server-window-dialog'].showModal()
}

let serverArtGeneration = 0
const resourceImageCache = new Map()

async function renderServerWindowArt(resourceTitle, menuSize = 0) {
  const generation = ++serverArtGeneration
  const canvas = el['server-window-art']
  const stage = el['server-window-stage']
  const glyphs = Array.isArray(resourceTitle?.glyphs) ? resourceTitle.glyphs.slice(0, 160) : []
  if (!glyphs.some((glyph) => glyph.image)) {
    canvas.hidden = true
    stage.classList.remove('has-resource-art')
    stage.classList.remove('has-container-art')
    stage.style.removeProperty('--resource-art-width')
    stage.style.removeProperty('--resource-art-height')
    return
  }
  const drawable = []
  let cursor = 0
  let minX = 0
  let maxX = 1
  let baseline = 0
  let belowBaseline = 0
  for (const glyph of glyphs) {
    const height = Math.max(1, Math.min(Number(glyph.renderHeight) || 8, 512))
    const ascent = Math.max(-512, Math.min(Number(glyph.ascent) || height, 512))
    const sourceWidth = Math.max(1, Number(glyph.sourceWidth) || 1)
    const sourceHeight = Math.max(1, Number(glyph.sourceHeight) || 1)
    const width = Math.max(1, Math.round(sourceWidth * (height / sourceHeight)))
    if (glyph.image) drawable.push({ glyph, x: cursor, width, height, ascent })
    minX = Math.min(minX, cursor)
    maxX = Math.max(maxX, cursor + width)
    baseline = Math.max(baseline, ascent)
    belowBaseline = Math.max(belowBaseline, height - ascent)
    cursor += Number.isFinite(Number(glyph.advance)) ? Number(glyph.advance) : width
  }
  const width = Math.max(1, Math.min(Math.ceil(maxX - minX), 2048))
  const height = Math.max(1, Math.min(Math.ceil(baseline + belowBaseline), 1024))
  const images = await Promise.all(drawable.map(({ glyph }) => loadResourceImage(glyph.image)))
  if (generation !== serverArtGeneration) return
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, width, height)
  context.imageSmoothingEnabled = false
  drawable.forEach(({ glyph, x, width: drawWidth, height: drawHeight, ascent }, index) => {
    const image = images[index]
    if (!image) return
    context.drawImage(image, Number(glyph.sourceX) || 0, Number(glyph.sourceY) || 0, Number(glyph.sourceWidth) || image.width, Number(glyph.sourceHeight) || image.height, Math.round(x - minX), Math.round(baseline - ascent), drawWidth, drawHeight)
  })
  const bounds = opaqueCanvasBounds(context, width, height)
  const artWidth = bounds?.width || width
  const artHeight = bounds?.height || height
  if (bounds && (bounds.x || bounds.y || bounds.width !== width || bounds.height !== height)) {
    const pixels = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height)
    canvas.width = bounds.width
    canvas.height = bounds.height
    const croppedContext = canvas.getContext('2d')
    croppedContext.imageSmoothingEnabled = false
    croppedContext.putImageData(pixels, 0, 0)
  }
  canvas.hidden = false
  stage.classList.add('has-resource-art')
  const containerArt = Number(menuSize) >= 9 && artWidth >= 100 && artHeight >= 100
  stage.classList.toggle('has-container-art', containerArt)
  if (containerArt) {
    stage.style.setProperty('--resource-art-width', `${artWidth * 2}px`)
    stage.style.setProperty('--resource-art-height', `${artHeight * 2}px`)
    canvas.style.width = `${artWidth * 2}px`
    canvas.style.height = `${artHeight * 2}px`
  } else {
    stage.style.removeProperty('--resource-art-width')
    stage.style.removeProperty('--resource-art-height')
    canvas.style.removeProperty('width')
    canvas.style.removeProperty('height')
  }
}

function opaqueCanvasBounds(context, width, height) {
  let pixels
  try { pixels = context.getImageData(0, 0, width, height).data } catch { return null }
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[((y * width + x) * 4) + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right >= left && bottom >= top ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null
}

function loadResourceImage(source) {
  if (!resourceImageCache.has(source)) resourceImageCache.set(source, new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = source
  }))
  return resourceImageCache.get(source)
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
    el['notifications-enabled'].checked = settings.notificationsEnabled === true
    el['stagger-startup-connections'].checked = settings.staggerStartupConnections !== false
    el['startup-connection-delay'].value = settings.startupConnectionDelay || 3
    el['ui-scale'].value = settings.uiScale || 100
    el['workspace-design'].value = settings.workspaceDesign || 'hybrid'
    el['color-theme'].value = settings.colorTheme || 'obsidian'
    el['pov-settings-refresh'].value = String(settings.povRefreshMs || 1500)
    el['pov-settings-fps'].value = String(settings.povFrameRate || 30)
    el['pov-settings-radius'].value = settings.povRadius || 6
    el['pov-settings-columns'].value = settings.povColumns || 3
    el['pov-max-feeds'].value = settings.povMaxFeeds || 9
    el['pov-settings-view-mode'].value = settings.povViewMode || 'perspective'
    el['pov-show-hud'].checked = settings.povShowHud !== false
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
      notificationsEnabled: el['notifications-enabled'].checked,
      staggerStartupConnections: el['stagger-startup-connections'].checked,
      startupConnectionDelay: Number(el['startup-connection-delay'].value),
      uiScale: Number(el['ui-scale'].value)
      ,workspaceDesign: el['workspace-design'].value
      ,colorTheme: el['color-theme'].value
      ,povRefreshMs: Number(el['pov-settings-refresh'].value)
      ,povFrameRate: Number(el['pov-settings-fps'].value)
      ,povRadius: Number(el['pov-settings-radius'].value)
      ,povColumns: Number(el['pov-settings-columns'].value)
      ,povMaxFeeds: Number(el['pov-max-feeds'].value)
      ,povViewMode: el['pov-settings-view-mode'].value
      ,povShowHud: el['pov-show-hud'].checked
    })
    applyUiScale(state.settings.uiScale)
    applyVisualDesign(state.settings.workspaceDesign, state.settings.colorTheme)
    el['settings-dialog'].close()
    toast('Settings saved.')
  } catch (error) { toast(cleanError(error), 'error') }
}

function applyUiScale(value) {
  const scale = Math.max(75, Math.min(Number(value) || 100, 125))
  if (el['quick-scale-value']) el['quick-scale-value'].textContent = `${scale}%`
  if (el['quick-scale']) el['quick-scale'].value = scale
  if (el['quick-scale-number']) el['quick-scale-number'].value = scale
  api.setUiScale(scale)
  requestAnimationFrame(() => applyPanelLayout(state.settings))
}

function previewQuickScale(value) {
  const scale = Math.max(75, Math.min(Number(value) || 100, 125))
  state.settings.uiScale = scale
  el['ui-scale'].value = scale
  el['ui-scale-value'].textContent = `${scale}%`
  applyUiScale(scale)
}

function previewTypedScale(value) {
  const scale = Number(value)
  if (!Number.isFinite(scale) || scale < 75 || scale > 125) return
  previewQuickScale(scale)
}

async function saveQuickScale(value) {
  const scale = Math.max(75, Math.min(Number(value) || 100, 125))
  state.settings.uiScale = scale
  el['ui-scale'].value = scale
  el['ui-scale-value'].textContent = `${scale}%`
  applyUiScale(scale)
  el['display-menu'].hidePopover?.()
  try { state.settings = await api.saveSettings({ ...state.settings }) } catch (error) { toast(`Scale was not saved: ${cleanError(error)}`, 'error') }
}

function toggleSidebar() {
  const collapsed = document.querySelector('.app-shell').classList.toggle('sidebar-collapsed')
  el['toggle-sidebar'].textContent = collapsed ? '›' : '‹'
  el['toggle-sidebar'].setAttribute('aria-expanded', String(!collapsed))
  el['toggle-sidebar'].title = collapsed ? 'Expand accounts sidebar' : 'Collapse accounts sidebar'
  requestAnimationFrame(() => applyPanelLayout(state.settings))
}

function toggleSection(button) {
  const target = document.getElementById(button.dataset.collapseTarget)
  if (!target) return
  const collapsed = target.classList.toggle('collapsed')
  button.textContent = collapsed ? '⌄' : '⌃'
  button.setAttribute('aria-expanded', String(!collapsed))
  button.title = `${collapsed ? 'Expand' : 'Collapse'} ${target.getAttribute('aria-labelledby')?.replace('-title', '') || 'section'}`
}

function applyPanelLayout(settings = state.settings) {
  const sidePanelWidth = Math.max(240, Math.min(Number(settings.sidePanelWidth) || 300, 520))
  const minimum = minimumInventoryHeight()
  const dashboardHeight = el.dashboard?.clientHeight || document.querySelector('.main-content')?.clientHeight || innerHeight
  const reservedWorkspace = innerHeight <= 680 ? 190 : 285
  const chromeHeight = (document.querySelector('.topbar')?.offsetHeight || 46) + (el['status-banner']?.offsetHeight || 52) + 40
  const maximum = Math.max(minimum, Math.min(360, Math.floor(dashboardHeight * 0.34), dashboardHeight - chromeHeight - reservedWorkspace))
  const inventoryHeight = Math.max(minimum, Math.min(Number(settings.inventoryHeight) || 220, maximum))
  state.settings.sidePanelWidth = sidePanelWidth
  state.settings.inventoryHeight = inventoryHeight
  document.documentElement.style.setProperty('--side-panel-width', `${sidePanelWidth}px`)
  document.documentElement.style.setProperty('--inventory-height', `${state.inventoryCollapsed ? 58 : inventoryHeight}px`)
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
    const reservedWorkspace = innerHeight <= 680 ? 190 : 285
    const chromeHeight = (document.querySelector('.topbar')?.offsetHeight || 46) + (el['status-banner']?.offsetHeight || 52) + 40
    const maximum = Math.max(minimum, Math.min(360, Math.floor(dashboardHeight * 0.34), dashboardHeight - chromeHeight - reservedWorkspace))
    state.settings.inventoryHeight = Math.max(minimum, Math.min(inventoryHeight, maximum))
    applyPanelLayout(state.settings)
  }
  bindSplitter(el['column-resizer'], {
    axis: 'x', value: () => state.settings.sidePanelWidth || 300,
    resize: (start, delta) => resizeSide(start - delta),
    keys: { ArrowLeft: 1, ArrowRight: -1 }
  })
  bindSplitter(el['inventory-resizer'], {
    axis: 'y', value: () => state.settings.inventoryHeight || 220,
    resize: (start, delta) => resizeInventory(start - delta),
    keys: { ArrowUp: 1, ArrowDown: -1 }
  })
}

function minimumInventoryHeight() {
  return matchMedia('(max-width: 960px)').matches || innerHeight <= 680 ? 120 : 150
}

function toggleInventory() {
  state.inventoryCollapsed = !state.inventoryCollapsed
  el.dashboard.classList.toggle('inventory-collapsed', state.inventoryCollapsed)
  el['toggle-inventory'].textContent = state.inventoryCollapsed ? 'Expand' : 'Collapse'
  el['toggle-inventory'].setAttribute('aria-expanded', String(!state.inventoryCollapsed))
  el['inventory-resizer'].hidden = state.inventoryCollapsed
  applyPanelLayout(state.settings)
}

function observePanelFit() {
  const inventoryHeader = document.querySelector('.inventory-header')
  if (!inventoryHeader || typeof ResizeObserver !== 'function') return
  const observer = new ResizeObserver(() => {
    if (el.dashboard.hidden) return
    applyPanelLayout(state.settings)
  })
  observer.observe(inventoryHeader)
  window.addEventListener('resize', () => requestAnimationFrame(() => applyPanelLayout(state.settings)))
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
    config.resize(config.axis === 'x' ? 300 : 280, 0)
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
  const mode = el['proxy-mode'].value
  el['proxy-enabled'].checked = mode === 'manual'
  const disabled = mode !== 'manual'
  el['proxy-fields'].querySelectorAll('input, select').forEach((input) => { input.disabled = disabled })
  el['proxy-fields'].classList.toggle('disabled', disabled)
}

function applyVisualDesign(design = 'hybrid', theme = 'obsidian') {
  const designs = new Set(['operations', 'community', 'command', 'hybrid', 'studio', 'telemetry'])
  const themes = new Set(['obsidian', 'midnight', 'graphite', 'ember', 'arctic', 'high-contrast'])
  const resolvedDesign = designs.has(design) ? design : 'hybrid'
  const resolvedTheme = themes.has(theme) ? theme : 'obsidian'
  document.documentElement.dataset.workspace = resolvedDesign
  document.documentElement.dataset.theme = resolvedTheme
  if (el['quick-workspace-design']) el['quick-workspace-design'].value = resolvedDesign
  if (el['quick-color-theme']) el['quick-color-theme'].value = resolvedTheme
  if (el['workspace-design']) el['workspace-design'].value = resolvedDesign
  if (el['color-theme']) el['color-theme'].value = resolvedTheme
  state.settings.workspaceDesign = resolvedDesign
  state.settings.colorTheme = resolvedTheme
  requestAnimationFrame(() => applyPanelLayout(state.settings))
}

async function saveVisualDesign(design, theme) {
  applyVisualDesign(design, theme)
  el['display-menu'].hidePopover?.()
  try { state.settings = await api.saveSettings({ ...state.settings }) }
  catch (error) { toast(`Display choice was not saved: ${cleanError(error)}`, 'error') }
}

function setWorkspaceView(view = 'overview') {
  const resolved = ['overview', 'chat', 'inventory'].includes(view) ? view : 'overview'
  state.workspaceView = resolved
  el.dashboard.dataset.view = resolved
  document.querySelectorAll('[data-workspace-view]').forEach((button) => button.classList.toggle('active', button.dataset.workspaceView === resolved))
  if (resolved === 'chat') requestAnimationFrame(() => el['chat-message'].focus())
  if (resolved === 'inventory') state.inventoryCollapsed = false
  applyPanelLayout(state.settings)
}

let commandSelection = 0
function commandItems() {
  const items = [
    { label: 'Connect or disconnect selected profile', group: 'Account', keywords: 'reconnect online offline', run: toggleConnection },
    { label: 'Open chat', group: 'Workspace', keywords: 'console messages', run: () => el['chat-message'].focus() },
    { label: 'Open inventory', group: 'Workspace', keywords: 'items hotbar gear', run: () => document.querySelector('.inventory-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
    { label: 'Open POV and world actions', group: 'Workspace', keywords: 'camera entities blocks', run: openPov },
    { label: 'Open automations', group: 'Workspace', keywords: 'macro conditions loops', run: openAutomations },
    { label: 'Open persistent logs', group: 'Workspace', keywords: 'alerts history events', run: openPersistentLogs },
    { label: 'Edit selected profile', group: 'Account', keywords: 'server proxy settings', run: () => openAccountDialog(selectedAccount()) },
    { label: 'Add server profile', group: 'Account', keywords: 'duplicate account new', run: () => openAccountDialog() },
    ...['operations', 'community', 'command', 'hybrid', 'studio', 'telemetry'].map(design => ({ label: `Use ${design} workspace`, group: 'Display', keywords: 'layout design theme', run: () => saveVisualDesign(design, state.settings.colorTheme) })),
    ...state.accounts.map(account => ({ label: `Switch to ${account.profileName || account.label || account.username}`, group: 'Profiles', keywords: `${account.host} ${account.edition || 'java'}`, run: () => { state.selectedId = account.id; render() } }))
  ]
  const query = el['command-search']?.value.trim().toLowerCase() || ''
  return query ? items.filter(item => `${item.label} ${item.group} ${item.keywords}`.toLowerCase().includes(query)) : items
}

function openCommandCenter() {
  commandSelection = 0
  el['command-search'].value = ''
  renderCommandResults()
  if (!el['command-dialog'].open) el['command-dialog'].showModal()
  requestAnimationFrame(() => el['command-search'].focus())
}

function closeCommandCenter() { if (el['command-dialog'].open) el['command-dialog'].close() }

function renderCommandResults() {
  const items = commandItems()
  commandSelection = Math.max(0, Math.min(commandSelection, Math.max(0, items.length - 1)))
  el['command-results'].replaceChildren(...items.map((item, index) => {
    const button = document.createElement('button')
    button.type = 'button'; button.className = `command-result${index === commandSelection ? ' selected' : ''}`
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === commandSelection))
    const copy = document.createElement('span'); copy.textContent = item.label
    const group = document.createElement('small'); group.textContent = item.group
    button.append(copy, group)
    button.addEventListener('click', () => { closeCommandCenter(); void item.run() })
    return button
  }))
}

function handleCommandSearchKey(event) {
  const items = commandItems()
  if (event.key === 'Escape') { event.preventDefault(); closeCommandCenter(); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); commandSelection = Math.min(items.length - 1, commandSelection + 1); renderCommandResults() }
  if (event.key === 'ArrowUp') { event.preventDefault(); commandSelection = Math.max(0, commandSelection - 1); renderCommandResults() }
  if (event.key === 'Enter' && items[commandSelection]) { event.preventDefault(); closeCommandCenter(); void items[commandSelection].run() }
}

async function openPersistentLogs() {
  if (!selectedAccount()) return
  el['logs-dialog'].showModal()
  await refreshPersistentLogs()
}

async function refreshPersistentLogs() {
  const account = selectedAccount()
  if (!account) return
  el['persistent-log-view'].textContent = 'Loading…'
  try {
    const filter = el['log-filter'].value
    const events = await api.listLogs(account.id, { limit: 2000, kinds: filter ? [filter] : [] })
    el['persistent-log-view'].textContent = events.length ? events.map(formatPersistentEvent).join('\n') : 'No matching persistent events.'
    el['persistent-log-view'].scrollTop = el['persistent-log-view'].scrollHeight
  } catch (error) { el['persistent-log-view'].textContent = cleanError(error) }
}

function formatPersistentEvent(event) {
  const time = new Date(event.at || Date.now()).toLocaleString()
  const category = String(event.kind || event.type || 'event').toUpperCase().padEnd(10)
  const message = event.message || event.detail || event.error || event.status || JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !['at', 'profileId', 'type', 'kind'].includes(key))))
  return `${time}  ${category} ${String(message || '').replace(/\s+/g, ' ').slice(0, 2000)}`
}

async function clearPersistentLogs() {
  const account = selectedAccount()
  if (!account || !confirm(`Clear persistent history for ${account.profileName || account.label}?`)) return
  await api.clearLogs(account.id)
  await refreshPersistentLogs()
}

const AUTOMATION_STEP_TYPES = {
  chat: ['Chat', { message: '/help' }], wait: ['Wait', { milliseconds: 1000 }], move: ['Move', { control: 'forward', duration: 500 }],
  look: ['Look', { direction: 'left' }], drop: ['Drop item', { slot: 36, count: 1 }], deposit: ['Deposit', { slot: 36, count: 64 }],
  equip: ['Equip', { slot: 36, destination: 'hand' }], clickGui: ['GUI click', { slot: 0 }], attackNearest: ['Attack nearest', {}],
  useHeld: ['Use held', {}], notify: ['Alert', { message: 'Automation event' }], if: ['Condition', { condition: { type: 'healthBelow', value: 6 }, then: [] }],
  repeat: ['Repeat', { times: 2, steps: [] }]
}

function openAutomations() {
  const account = selectedAccount()
  if (!account) return
  automationDraft = structuredClone(account.automations?.length ? account.automations : [{ id: cryptoId(), name: 'New workflow', enabled: true, trigger: { type: 'manual' }, steps: [{ type: 'wait', milliseconds: 1000 }] }])
  automationIndex = 0; automationStepIndex = -1
  el['automation-json-toggle'].checked = false; el['automation-json'].hidden = true; el['automation-workspace']?.removeAttribute('hidden')
  renderAutomationFlow(); el['automation-dialog'].showModal()
}

function renderAutomationFlow() {
  automationIndex = Math.max(0, Math.min(automationIndex, Math.max(0, automationDraft.length - 1)))
  const workflow = automationDraft[automationIndex]
  el['automation-list'].replaceChildren(...automationDraft.map((item, index) => automationTab(item, index)))
  el['automation-flow'].replaceChildren()
  if (!workflow) { el['automation-flow'].textContent = 'Create a workflow to begin.'; renderAutomationInspector(); return }
  el['automation-flow'].append(automationNode(`WHEN · ${workflow.trigger?.type || 'manual'}`, triggerSummary(workflow.trigger), -1, 'trigger'))
  ;(workflow.steps || []).forEach((step, index) => el['automation-flow'].append(automationNode(AUTOMATION_STEP_TYPES[step.type]?.[0] || step.type, stepSummary(step), index, 'action')))
  const add = document.createElement('button'); add.type = 'button'; add.className = 'automation-add-node'; add.textContent = '＋ Add a step'; add.addEventListener('click', () => el['automation-palette'].scrollIntoView({ behavior: 'smooth', block: 'nearest' })); el['automation-flow'].append(add)
  renderAutomationPalette(); renderAutomationInspector()
}

function automationTab(item, index) { const button = document.createElement('button'); button.type = 'button'; button.className = `automation-tab${index === automationIndex ? ' selected' : ''}`; button.textContent = item.name || `Workflow ${index + 1}`; button.addEventListener('click', () => { automationIndex = index; automationStepIndex = -1; renderAutomationFlow() }); return button }
function automationNode(title, summary, index, kind) { const button = document.createElement('button'); button.type = 'button'; button.className = `automation-node ${kind}${automationStepIndex === index ? ' selected' : ''}`; const name = document.createElement('span'); name.textContent = title; const detail = document.createElement('small'); detail.textContent = summary; button.append(name, detail); button.addEventListener('click', () => { automationStepIndex = index; renderAutomationFlow() }); return button }
function triggerSummary(trigger = {}) { return trigger.type === 'timer' ? `Every ${trigger.intervalSeconds || 60}s` : trigger.type === 'chat' ? `Message contains “${trigger.contains || ''}”` : trigger.type === 'health' ? `Health below ${trigger.below || 6}` : `Runs on ${trigger.type || 'manual'}` }
function stepSummary(step = {}) { return step.message || step.direction || step.destination || (step.type === 'wait' ? `${step.milliseconds || 0} ms` : step.type === 'repeat' ? `${step.count || 1} times` : step.type === 'if' ? step.condition?.type || 'condition' : 'Configured action') }

function renderAutomationPalette() { el['automation-palette'].replaceChildren(...Object.entries(AUTOMATION_STEP_TYPES).map(([type, [label]]) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'automation-palette-item'; button.textContent = `＋ ${label}`; button.addEventListener('click', () => addAutomationStep(type)); return button })) }
function addAutomationStep(type) { const workflow = automationDraft[automationIndex]; if (!workflow) return; const defaults = structuredClone(AUTOMATION_STEP_TYPES[type]?.[1] || {}); workflow.steps ||= []; workflow.steps.push({ type, ...defaults }); automationStepIndex = workflow.steps.length - 1; renderAutomationFlow() }

function renderAutomationInspector() {
  const workflow = automationDraft[automationIndex]; el['automation-inspector'].replaceChildren(); if (!workflow) return
  if (automationStepIndex < 0) {
    addInspectorField('Workflow name', workflow.name || '', (value) => { workflow.name = value; renderAutomationFlow() })
    addInspectorSelect('Trigger', ['manual', 'connected', 'disconnected', 'chat', 'health', 'inventory', 'window', 'timer'], workflow.trigger?.type || 'manual', (value) => { workflow.trigger = { type: value }; renderAutomationFlow() })
    const trigger = workflow.trigger || (workflow.trigger = { type: 'manual' })
    if (trigger.type === 'chat') addInspectorField('Contains', trigger.contains || '', (value) => { trigger.contains = value })
    if (trigger.type === 'timer') addInspectorNumber('Interval seconds', trigger.intervalSeconds || 60, 1, 86400, (value) => { trigger.intervalSeconds = value })
    if (trigger.type === 'health') addInspectorNumber('Health below', trigger.below || 6, 1, 20, (value) => { trigger.below = value })
    addInspectorToggle('Enabled', workflow.enabled !== false, (value) => { workflow.enabled = value })
    return
  }
  const step = workflow.steps[automationStepIndex]; if (!step) return
  addInspectorSelect('Action', Object.keys(AUTOMATION_STEP_TYPES), step.type, (value) => { workflow.steps[automationStepIndex] = { type: value, ...structuredClone(AUTOMATION_STEP_TYPES[value]?.[1] || {}) }; renderAutomationFlow() })
  for (const [key, value] of Object.entries(step).filter(([key]) => key !== 'type')) {
    if (typeof value === 'number') addInspectorNumber(formatMinecraftName(key), value, 0, 86400000, (next) => { step[key] = next })
    else if (typeof value === 'boolean') addInspectorToggle(formatMinecraftName(key), value, (next) => { step[key] = next })
    else if (typeof value === 'string') addInspectorField(formatMinecraftName(key), value, (next) => { step[key] = next })
    else addInspectorJson(formatMinecraftName(key), value, (next) => { step[key] = next })
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = 'Remove step'; remove.addEventListener('click', () => { workflow.steps.splice(automationStepIndex, 1); automationStepIndex = -1; renderAutomationFlow() }); el['automation-inspector'].append(remove)
}

function inspectorRow(label, control) { const row = document.createElement('label'); row.className = 'field'; const caption = document.createElement('span'); caption.textContent = label; row.append(caption, control); el['automation-inspector'].append(row) }
function addInspectorField(label, value, update) { const input = document.createElement('input'); input.value = value; input.addEventListener('change', () => update(input.value)); inspectorRow(label, input) }
function addInspectorNumber(label, value, min, max, update) { const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.value = value; input.addEventListener('change', () => update(Number(input.value))); inspectorRow(label, input) }
function addInspectorSelect(label, options, value, update) { const select = document.createElement('select'); select.replaceChildren(...options.map((item) => { const option = document.createElement('option'); option.value = item; option.textContent = formatMinecraftName(item); return option })); select.value = value; select.addEventListener('change', () => update(select.value)); inspectorRow(label, select) }
function addInspectorToggle(label, value, update) { const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value; input.addEventListener('change', () => update(input.checked)); inspectorRow(label, input) }
function addInspectorJson(label, value, update) { const input = document.createElement('textarea'); input.rows = 5; input.value = JSON.stringify(value, null, 2); input.addEventListener('change', () => { try { update(JSON.parse(input.value)); input.setCustomValidity('') } catch { input.setCustomValidity('Invalid JSON'); input.reportValidity() } }); inspectorRow(label, input) }

function addAutomation() { automationDraft.push({ id: cryptoId(), name: `Workflow ${automationDraft.length + 1}`, enabled: true, trigger: { type: 'manual' }, steps: [{ type: 'wait', milliseconds: 1000 }] }); automationIndex = automationDraft.length - 1; automationStepIndex = -1; renderAutomationFlow() }
function deleteAutomation() { if (!automationDraft[automationIndex] || !confirm('Delete this workflow?')) return; automationDraft.splice(automationIndex, 1); automationIndex = Math.max(0, automationIndex - 1); automationStepIndex = -1; renderAutomationFlow() }
function toggleAutomationJson() { const json = el['automation-json-toggle'].checked; const workspace = document.querySelector('.automation-workspace'); if (json) { el['automation-json'].value = JSON.stringify(automationDraft, null, 2); el['automation-json'].hidden = false; workspace.hidden = true } else { try { const parsed = JSON.parse(el['automation-json'].value); if (!Array.isArray(parsed)) throw new Error('Root must be an array.'); automationDraft = parsed; el['automation-json'].hidden = true; workspace.hidden = false; renderAutomationFlow() } catch (error) { el['automation-json-toggle'].checked = true; toast(cleanError(error), 'error') } } }

async function saveAutomations() {
  try {
    if (el['automation-json-toggle'].checked) { const parsed = JSON.parse(el['automation-json'].value); if (!Array.isArray(parsed)) throw new Error('Automation JSON must be an array.'); automationDraft = parsed }
    const targets = el['automation-scope'].value === 'all' ? state.accounts : [selectedAccount()].filter(Boolean)
    for (const account of targets) { const saved = await api.saveAccount({ ...account, automations: structuredClone(automationDraft) }); Object.assign(account, saved) }
    renderAutomationFlow(); toast(`Automations validated and saved to ${targets.length} profile${targets.length === 1 ? '' : 's'}.`)
  } catch (error) { toast(cleanError(error), 'error') }
}
async function testAutomation() { await saveAutomations(); const workflow = automationDraft[automationIndex]; if (workflow) await run(() => api.runAutomation(state.selectedId, workflow.id)) }
function cryptoId() { return `macro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

function openPov() {
  if (!state.accounts.length) return
  povPaused = false; povFocusId = null; povSnapshots.clear(); povDisplaySnapshots.clear()
  el['pov-columns'].value = state.settings.povColumns || 3; el['pov-refresh'].value = String(state.settings.povRefreshMs || 1500); el['pov-fps'].value = String(state.settings.povFrameRate || 30); el['pov-view-mode'].value = state.settings.povViewMode || 'perspective'; el['pov-radius'].value = state.settings.povRadius || 6
  el['pov-dialog'].showModal(); renderPovGrid(); void refreshPov(); startPovPolling(); startPovAnimation()
}
function startPovPolling() { stopPovPolling(); if (!povPaused) povTimer = setInterval(refreshPov, povFocusId ? 50 : 200) }
function closePov() { closePovInput(); if (el['pov-dialog'].open) el['pov-dialog'].close() }
function closePovInput() {
  stopPovPolling(); stopPovAnimation(); releaseAllManualInputs(povFocusId)
  if (document.pointerLockElement?.closest?.('#pov-grid')) document.exitPointerLock?.()
  if (povLookAnimationFrame) cancelAnimationFrame(povLookAnimationFrame)
  povLookAnimationFrame = null; povLookDelta = { accountId: null, yaw: 0, pitch: 0 }
}
function stopPovPolling() { if (povTimer) clearInterval(povTimer); povTimer = null }
function togglePovPause() { povPaused = !povPaused; el['pov-pause'].textContent = povPaused ? 'Resume' : 'Pause'; el['pov-pause'].setAttribute('aria-pressed', String(povPaused)); if (povPaused) { stopPovPolling(); stopPovAnimation() } else { void refreshPov(); startPovPolling(); startPovAnimation() } }
async function updatePovOptions() { state.settings = await api.saveSettings({ ...state.settings, povColumns: Number(el['pov-columns'].value), povRefreshMs: Number(el['pov-refresh'].value), povFrameRate: Number(el['pov-fps'].value), povViewMode: el['pov-view-mode'].value, povRadius: Number(el['pov-radius'].value) }); renderPovGrid(); startPovPolling(); startPovAnimation() }

function startPovAnimation() {
  stopPovAnimation(); povLastAnimationAt = 0
  const frame = (now) => {
    if (!el['pov-dialog'].open || povPaused) { povAnimationFrame = null; return }
    const requested = povFocusId ? Number(el['pov-fps'].value) || 30 : 15
    if (!povLastAnimationAt || now - povLastAnimationAt >= 1000 / requested - 1) {
      const elapsed = povLastAnimationAt ? now - povLastAnimationAt : 1000 / requested
      povLastAnimationAt = now
      for (const canvas of el['pov-grid'].querySelectorAll('canvas[data-account-id]')) {
        const account = state.accounts.find((entry) => entry.id === canvas.dataset.accountId)
        const target = povSnapshots.get(canvas.dataset.accountId)
        if (!account || !target) continue
        const display = interpolatePovSnapshot(povDisplaySnapshots.get(account.id), target, elapsed)
        povDisplaySnapshots.set(account.id, display); drawPov(display, canvas, account)
      }
    }
    povAnimationFrame = requestAnimationFrame(frame)
  }
  povAnimationFrame = requestAnimationFrame(frame)
}
function stopPovAnimation() { if (povAnimationFrame) cancelAnimationFrame(povAnimationFrame); povAnimationFrame = null }
function interpolatePovSnapshot(current, target, elapsedMs) {
  if (!current?.position || !target?.position) return target
  const alpha = 1 - Math.exp(-Math.max(1, elapsedMs) / 90)
  const lerp = (from, to) => Number(from) + (Number(to) - Number(from)) * alpha
  const angle = (from, to) => Number(from) + Math.atan2(Math.sin(Number(to) - Number(from)), Math.cos(Number(to) - Number(from))) * alpha
  return { ...target, position: { x: lerp(current.position.x, target.position.x), y: lerp(current.position.y, target.position.y), z: lerp(current.position.z, target.position.z) }, yaw: angle(current.yaw || 0, target.yaw || 0), pitch: lerp(current.pitch || 0, target.pitch || 0) }
}
function visiblePovAccounts() { const search = el['pov-search'].value.trim().toLowerCase(); return state.accounts.filter((account) => !search || `${account.profileName} ${account.minecraftName} ${account.host}`.toLowerCase().includes(search)).filter((account) => !povFocusId || account.id === povFocusId).slice(0, state.settings.povMaxFeeds || 9) }

async function refreshPov() {
  if (!el['pov-dialog'].open || povPaused || povRefreshActive) return
  povRefreshActive = true
  const accounts = visiblePovAccounts().filter((account) => ['online', 'connected'].includes(getStatus(account.id).status))
  const results = await Promise.allSettled(accounts.map((account) => api.getWorldSnapshot(account.id, Number(el['pov-radius'].value), Number(el['pov-refresh'].value))))
  results.forEach((result, index) => { if (result.status === 'fulfilled') povSnapshots.set(accounts[index].id, result.value) })
  povRefreshActive = false
  const latest = povSnapshots.get(povFocusId || state.selectedId); if (latest?.position && !el['pov-x'].value) setPovTarget(latest.position)
  if (!document.pointerLockElement?.closest?.('#pov-grid')) el['pov-detail'].textContent = `${accounts.length} live feed${accounts.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString()} · click a perspective feed for WASD and mouse control.`
}

function renderPovGrid() {
  const accounts = visiblePovAccounts(); el['pov-back-grid'].hidden = !povFocusId; el['pov-grid'].classList.toggle('focused', Boolean(povFocusId)); el['pov-grid'].style.setProperty('--pov-columns', String(Math.max(1, Math.min(accounts.length || 1, Number(el['pov-columns'].value) || 3))))
  el['pov-grid'].replaceChildren(...accounts.map((account) => {
    const card = document.createElement('article'); card.className = 'pov-card'
    const header = document.createElement('header'); header.append(createPlayerHead(account, 'account-avatar')); const title = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = account.minecraftName || account.profileName || account.label; const small = document.createElement('small'); small.textContent = account.host; title.append(strong, small); const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'icon-button pov-expand'; expand.textContent = povFocusId ? '↙' : '↗'; expand.title = povFocusId ? 'Return to grid' : 'Focus this feed'; expand.addEventListener('click', () => { povFocusId = povFocusId ? null : account.id; state.selectedId = account.id; render(); renderPovGrid(); startPovPolling() }); header.append(title, expand)
    const canvas = document.createElement('canvas'); canvas.width = povFocusId ? 960 : 480; canvas.height = povFocusId ? 540 : 270; canvas.dataset.accountId = account.id; canvas.tabIndex = 0; canvas.setAttribute('aria-label', `${strong.textContent} POV. Click to focus, use WASD and Space to move, and move the mouse to look.`); canvas.addEventListener('click', selectPovTarget)
    const snapshot = povDisplaySnapshots.get(account.id) || povSnapshots.get(account.id); if (snapshot) requestAnimationFrame(() => drawPov(snapshot, canvas, account)); else drawPovPlaceholder(canvas, getStatus(account.id))
    card.append(header, canvas); return card
  }))
  if (!accounts.length) { const empty = document.createElement('p'); empty.className = 'dialog-copy'; empty.textContent = 'No profiles match this filter.'; el['pov-grid'].append(empty) }
}

function drawPov(snapshot, canvas, account) { if (el['pov-view-mode'].value === 'map') drawMapPov(snapshot, canvas); else drawPerspectivePov(snapshot, canvas, account) }
function drawPovPlaceholder(canvas, status) { const context = canvas.getContext('2d'); context.fillStyle = '#070b10'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#8f9baa'; context.font = '16px sans-serif'; context.textAlign = 'center'; context.fillText(['online', 'connected'].includes(status.status) ? 'Loading world…' : status.detail || 'Offline', canvas.width / 2, canvas.height / 2) }

function drawMapPov(snapshot, canvas) {
  const context = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)
  context.fillStyle = '#070b10'; context.fillRect(0, 0, width, height)
  if (!snapshot.position) return
  const radius = Number(snapshot.radius) || 6
  const scale = Math.min(width, height) / (radius * 2 + 3)
  const centerX = width / 2
  const centerY = height / 2
  const playerY = Math.floor(snapshot.position.y)
  for (const block of snapshot.blocks || []) {
    if (Math.abs(block.y - playerY) > 1) continue
    const x = centerX + (block.x - snapshot.position.x) * scale
    const y = centerY + (block.z - snapshot.position.z) * scale
    context.fillStyle = block.water ? '#2577ad' : block.solid ? '#566171' : '#36465a'
    context.fillRect(x - scale / 2, y - scale / 2, Math.max(2, scale - 1), Math.max(2, scale - 1))
  }
  for (const entity of snapshot.entities || []) {
    const x = centerX + (entity.x - snapshot.position.x) * scale
    const y = centerY + (entity.z - snapshot.position.z) * scale
    context.beginPath(); context.fillStyle = entity.type === 'player' ? '#f6c85f' : '#f16e74'; context.arc(x, y, 5, 0, Math.PI * 2); context.fill()
  }
  context.save(); context.translate(centerX, centerY); context.rotate(-(Number(snapshot.yaw) || 0)); context.fillStyle = '#60d394'; context.beginPath(); context.moveTo(0, -10); context.lineTo(7, 8); context.lineTo(-7, 8); context.closePath(); context.fill(); context.restore()
  canvas.dataset.position = JSON.stringify(snapshot.position)
  canvas.dataset.radius = String(radius)
}

function selectPovTarget(event) {
  const canvas = event.currentTarget
  const accountId = canvas.dataset.accountId
  if (accountId) { state.selectedId = accountId; povFocusId ||= accountId }
  const position = JSON.parse(canvas.dataset.position || 'null')
  if (el['pov-view-mode'].value !== 'map') {
    render(); renderPovGrid(); startPovPolling()
    const focusedCanvas = [...el['pov-grid'].querySelectorAll('canvas')].find((entry) => entry.dataset.accountId === accountId)
    focusedCanvas?.focus(); focusedCanvas?.requestPointerLock?.()
    return
  }
  if (!position) return
  const rectangle = canvas.getBoundingClientRect()
  const radius = Number(canvas.dataset.radius) || 6
  const scale = Math.min(canvas.width, canvas.height) / (radius * 2 + 3)
  const pixelX = (event.clientX - rectangle.left) * canvas.width / rectangle.width
  const pixelY = (event.clientY - rectangle.top) * canvas.height / rectangle.height
  setPovTarget({ x: Math.round(position.x + (pixelX - canvas.width / 2) / scale), y: Math.floor(position.y), z: Math.round(position.z + (pixelY - canvas.height / 2) / scale) })
}

function handlePovMouseMove(event) {
  const canvas = document.pointerLockElement
  const accountId = canvas?.closest?.('#pov-grid') ? canvas.dataset.accountId : null
  if (!accountId || accountId !== povFocusId || el['pov-view-mode'].value !== 'perspective') return
  povLookDelta.accountId = accountId
  const delta = povMath.mouseLookDelta(event.movementX, event.movementY)
  povLookDelta.yaw += delta.yaw
  povLookDelta.pitch += delta.pitch
  if (!povLookAnimationFrame) povLookAnimationFrame = requestAnimationFrame(flushPovLookDelta)
}

function flushPovLookDelta() {
  povLookAnimationFrame = null
  const delta = povLookDelta; povLookDelta = { accountId: null, yaw: 0, pitch: 0 }
  if (!delta.accountId || (!delta.yaw && !delta.pitch)) return
  for (const snapshots of [povSnapshots, povDisplaySnapshots]) {
    const snapshot = snapshots.get(delta.accountId)
    if (snapshot) snapshots.set(delta.accountId, { ...snapshot, yaw: Number(snapshot.yaw || 0) + delta.yaw, pitch: Math.max(-1.45, Math.min(1.45, Number(snapshot.pitch || 0) + delta.pitch)) })
  }
  api.lookDelta(delta.accountId, delta.yaw, delta.pitch).catch((error) => { document.exitPointerLock?.(); toast(cleanError(error), 'error') })
}

function handlePovPointerLockChange() {
  const canvas = document.pointerLockElement
  const active = Boolean(canvas?.closest?.('#pov-grid'))
  el['pov-grid'].classList.toggle('pointer-locked', active)
  if (!active) releaseAllManualInputs(povFocusId)
  el['pov-detail'].textContent = active
    ? 'Gameplay control active · WASD move · Space jumps · Mouse looks · Esc releases the mouse.'
    : 'Click a perspective feed to capture the mouse and enable gameplay controls.'
}

function drawPerspectivePov(snapshot, canvas, account) {
  const context = canvas.getContext('2d'), width = canvas.width, height = canvas.height
  if (!snapshot.position) return drawPovPlaceholder(canvas, { status: 'online', detail: 'Waiting for chunks…' })
  const renderWidth = povFocusId ? 320 : 192
  const renderHeight = Math.round(renderWidth * 9 / 16)
  const frame = renderLowResolutionVoxelView(snapshot, renderWidth, renderHeight)
  const lowResolutionCanvas = document.createElement('canvas')
  lowResolutionCanvas.width = renderWidth; lowResolutionCanvas.height = renderHeight
  lowResolutionCanvas.getContext('2d').putImageData(frame, 0, 0)
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, width, height)
  context.drawImage(lowResolutionCanvas, 0, 0, width, height)
  drawPovEntities(context, snapshot, canvas)
  drawCrosshair(context, canvas)
  if (state.settings.povShowHud !== false) drawPovHud(context, canvas, account)
  canvas.dataset.position = JSON.stringify(snapshot.position); canvas.dataset.radius = String(snapshot.radius || 6)
}

function renderLowResolutionVoxelView(snapshot, width, height) {
  const frame = new ImageData(width, height)
  const blocks = new Map((snapshot.blocks || []).map((block) => [`${block.x},${block.y},${block.z}`, block]))
  const position = snapshot.position
  const camera = { x: Number(position.x), y: Number(position.y) + 1.62, z: Number(position.z) }
  const { forward, right, up } = povMath.viewBasis(snapshot.yaw, snapshot.pitch)
  const fovScale = Math.tan(72 * Math.PI / 360), aspect = width / height
  const underwater = Boolean(blocks.get(`${Math.floor(camera.x)},${Math.floor(camera.y)},${Math.floor(camera.z)}`)?.water)
  const maxDistance = Math.max(4, (Number(snapshot.radius) || 6) * 1.7)
  for (let py = 0; py < height; py += 1) {
    const screenY = (1 - (py + .5) / height * 2) * fovScale
    for (let px = 0; px < width; px += 1) {
      const screenX = ((px + .5) / width * 2 - 1) * fovScale * aspect
      const ray = normalizeVector({ x: forward.x + right.x * screenX + up.x * screenY, y: forward.y + up.y * screenY, z: forward.z + right.z * screenX + up.z * screenY })
      const hit = traceVoxelRay(camera, ray, blocks, maxDistance, underwater)
      const color = hit ? shadeVoxelHit(hit, underwater) : voxelSkyColor(py / height, underwater)
      const offset = (py * width + px) * 4
      frame.data[offset] = color[0]; frame.data[offset + 1] = color[1]; frame.data[offset + 2] = color[2]; frame.data[offset + 3] = 255
    }
  }
  return frame
}

function traceVoxelRay(origin, direction, blocks, maxDistance, underwater) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z), distance = 0, face = 'y'
  const stepX = direction.x < 0 ? -1 : 1, stepY = direction.y < 0 ? -1 : 1, stepZ = direction.z < 0 ? -1 : 1
  const deltaX = direction.x === 0 ? Infinity : Math.abs(1 / direction.x)
  const deltaY = direction.y === 0 ? Infinity : Math.abs(1 / direction.y)
  const deltaZ = direction.z === 0 ? Infinity : Math.abs(1 / direction.z)
  let sideX = direction.x < 0 ? (origin.x - x) * deltaX : (x + 1 - origin.x) * deltaX
  let sideY = direction.y < 0 ? (origin.y - y) * deltaY : (y + 1 - origin.y) * deltaY
  let sideZ = direction.z < 0 ? (origin.z - z) * deltaZ : (z + 1 - origin.z) * deltaZ
  while (distance <= maxDistance) {
    const block = blocks.get(`${x},${y},${z}`)
    if (block && (block.solid || (block.water && !underwater))) {
      const hitX = origin.x + direction.x * distance, hitY = origin.y + direction.y * distance, hitZ = origin.z + direction.z * distance
      const u = face === 'x' ? fractional(hitZ) : fractional(hitX)
      const v = face === 'y' ? fractional(hitZ) : fractional(hitY)
      return { block, distance, face, x, y, z, u, v }
    }
    if (sideX < sideY && sideX < sideZ) { x += stepX; distance = sideX; sideX += deltaX; face = 'x' }
    else if (sideY < sideZ) { y += stepY; distance = sideY; sideY += deltaY; face = 'y' }
    else { z += stepZ; distance = sideZ; sideZ += deltaZ; face = 'z' }
  }
  return null
}

function shadeVoxelHit(hit, underwater) {
  const base = blockRgb(hit.block.name, hit.block.water)
  const faceLight = hit.face === 'y' ? 1 : hit.face === 'x' ? .82 : .68
  const texel = (Math.floor(hit.u * 8) * 17 + Math.floor(hit.v * 8) * 31 + hit.x * 13 + hit.y * 7 + hit.z * 19) & 7
  const edge = hit.u < .035 || hit.u > .965 || hit.v < .035 || hit.v > .965
  const pattern = (edge ? .62 : .9 + texel * .018) * (/leaves/.test(hit.block.name) && texel < 2 ? .76 : 1)
  const fog = Math.min(.78, hit.distance / 18)
  const fogColor = underwater ? [36, 112, 151] : [126, 166, 190]
  return base.map((channel, index) => Math.round(channel * faceLight * pattern * (1 - fog) + fogColor[index] * fog))
}

function voxelSkyColor(vertical, underwater) {
  if (underwater) return [Math.round(22 + vertical * 16), Math.round(86 + vertical * 26), Math.round(122 + vertical * 30)]
  if (vertical < .52) { const amount = vertical / .52; return [Math.round(94 + amount * 38), Math.round(157 + amount * 35), Math.round(205 + amount * 22)] }
  const amount = (vertical - .52) / .48; return [Math.round(82 - amount * 28), Math.round(116 - amount * 38), Math.round(69 - amount * 22)]
}

function blockRgb(name = '', water = false) {
  if (water || /water|kelp|seagrass/.test(name)) return [39, 126, 178]
  if (/grass|leaves|moss|vine/.test(name)) return [79, 127, 54]
  if (/stone|ore|deepslate|cobble/.test(name)) return [116, 120, 125]
  if (/sand|sandstone/.test(name)) return [202, 184, 107]
  if (/snow|quartz|white/.test(name)) return [218, 222, 218]
  if (/wood|log|plank|chest|barrel/.test(name)) return [139, 101, 59]
  if (/dirt|mud|clay/.test(name)) return [121, 88, 57]
  return [132, 109, 76]
}

function fractional(value) { return value - Math.floor(value) }
function normalizeVector(vector) { const length = Math.hypot(vector.x, vector.y, vector.z) || 1; return { x: vector.x / length, y: vector.y / length, z: vector.z / length } }
function drawCrosshair(context, canvas) { const x = canvas.width / 2, y = canvas.height / 2, arm = Math.max(5, canvas.width / 96); context.save(); context.strokeStyle = '#ffffffdd'; context.lineWidth = Math.max(1, canvas.width / 480); context.beginPath(); context.moveTo(x - arm, y); context.lineTo(x + arm, y); context.moveTo(x, y - arm); context.lineTo(x, y + arm); context.stroke(); context.restore() }
function drawPovEntities(context, snapshot, canvas) { const yaw = Number(snapshot.yaw) || 0, horizon = canvas.height * .5; context.font = `${Math.max(10, canvas.width / 48)}px sans-serif`; context.textAlign = 'center'; for (const entity of snapshot.entities || []) { const dx = Number(entity.x ?? entity.position?.x) - snapshot.position.x, dz = Number(entity.z ?? entity.position?.z) - snapshot.position.z, { side, depth } = povMath.projectHorizontal(dx, dz, yaw); if (depth <= .3) continue; const x = canvas.width / 2 + side / depth * canvas.width * .55, y = horizon - ((Number(entity.y ?? entity.position?.y) || snapshot.position.y) - snapshot.position.y) / depth * canvas.height * .55; if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) continue; context.fillStyle = entity.type === 'player' ? '#ffe06a' : '#ff7479'; context.fillText(entity.username || entity.name || entity.type || 'entity', x, y) } }
function drawPovHud(context, canvas, account) { const telemetry = state.telemetry.get(account.id) || {}; const health = Math.max(0, Math.min(20, Number(telemetry.health) || 0)); const food = Math.max(0, Math.min(20, Number(telemetry.food) || 0)); context.textAlign = 'left'; context.font = `${Math.max(12, canvas.width / 38)}px monospace`; context.fillStyle = '#ff5964'; context.fillText(`♥ ${health}/20`, 14, canvas.height - 44); context.fillStyle = '#e8b856'; context.fillText(`◆ ${food}/20`, 14, canvas.height - 18); const box = Math.max(20, Math.min(36, canvas.width / 15)), start = canvas.width / 2 - box * 4.5; for (let i = 0; i < 9; i++) { context.fillStyle = '#111b'; context.fillRect(start + i * box, canvas.height - box - 8, box - 2, box - 2); context.strokeStyle = '#ddd'; context.strokeRect(start + i * box, canvas.height - box - 8, box - 2, box - 2) } }

function setPovTarget(position) {
  el['pov-x'].value = Math.floor(position.x)
  el['pov-y'].value = Math.floor(position.y)
  el['pov-z'].value = Math.floor(position.z)
}

async function runWorldAction(action) {
  const target = { x: Number(el['pov-x'].value), y: Number(el['pov-y'].value), z: Number(el['pov-z'].value), range: 1 }
  await run(() => api.worldAction(povFocusId || state.selectedId, action, target))
  await refreshPov()
}

function syncEditionFields(changePort = true) {
  const bedrock = el.edition.value === 'bedrock'
  el.version.disabled = bedrock
  if (bedrock) el.version.value = ''
  el['modded-fields'].hidden = bedrock
  if (changePort && (!el.port.value || ['25565', '19132'].includes(el.port.value))) el.port.value = bedrock ? 19132 : 25565
  el['proxy-mode'].disabled = bedrock
  if (bedrock) el['proxy-mode'].value = 'direct'
  syncProxyFields()
}

function syncModdedFields() {
  const loader = el['mod-loader'].value
  const defaults = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' }
  if (!el['client-brand'].value || ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(el['client-brand'].value)) el['client-brand'].value = defaults[loader] || 'vanilla'
  el['mod-handshake'].disabled = !['auto', 'forge', 'neoforge'].includes(loader)
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
    if (segment.hover) part.title = segment.hover
    if (segment.click) {
      part.classList.add('clickable-chat')
      part.tabIndex = 0
      part.role = 'button'
      part.addEventListener('click', (event) => activateChatClick(segment.click, event))
      part.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateChatClick(segment.click, event) }
      })
    }
    container.append(part)
  }
}

async function activateChatClick(click, event = {}) {
  const action = String(click?.action || '')
  const value = String(click?.value || '').slice(0, 2048)
  if (!value) return
  if (action === 'suggest_command') {
    el['chat-message'].value = value
    el['chat-message'].focus()
    el['chat-message'].setSelectionRange(value.length, value.length)
    scheduleChatCompletion()
    return
  }
  if (action === 'run_command') {
    await sendChatMessage(value)
    return
  }
  if (action === 'open_url' && (event.ctrlKey || event.metaKey)) {
    await run(() => api.openExternal(value))
    return
  }
  if (action === 'open_url' || action === 'copy_to_clipboard') {
    await navigator.clipboard.writeText(value)
    toast(action === 'open_url' ? 'Link copied. Ctrl-click it to open.' : 'Text copied.')
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
