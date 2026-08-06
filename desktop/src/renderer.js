const api = window.afkDesk

const state = {
  accounts: [],
  selectedId: null,
  selectedInventorySlot: null,
  draggedAccountId: null,
  statuses: new Map(),
  logs: new Map(),
  telemetry: new Map(),
  login: { code: '', url: 'https://microsoft.com/link' }
}

const el = Object.fromEntries([
  'account-list', 'account-count', 'add-account', 'browser-access', 'open-settings', 'settings-dialog', 'close-settings', 'start-with-windows', 'stagger-startup-connections', 'startup-connection-delay', 'save-settings', 'empty-state', 'dashboard', 'account-title',
  'edit-account', 'connection-button', 'status-banner', 'status-name', 'status-detail', 'server-address',
  'detail-username', 'detail-server', 'detail-version', 'detail-antiafk', 'detail-environment', 'detail-water', 'detail-health', 'detail-hunger', 'detail-coordinates', 'detail-chest', 'detail-dimension', 'inventory-count', 'inventory-grid', 'auto-deposit-toggle', 'drop-selected', 'console-log', 'clear-console',
  'chat-form', 'chat-message', 'account-dialog', 'account-form', 'dialog-title', 'account-id', 'label',
  'username', 'host', 'port', 'version', 'connect-on-startup', 'proxy-enabled', 'proxy-fields', 'proxy-type', 'proxy-host', 'proxy-port', 'proxy-username', 'proxy-password', 'proxy-password-help', 'proxy-clear-password', 'anti-afk', 'anti-afk-min-delay', 'anti-afk-max-delay', 'anti-afk-duration', 'anti-afk-look-degrees', 'anti-afk-walk-distance', 'anti-afk-jump', 'anti-afk-look', 'anti-afk-sneak', 'anti-afk-swing', 'anti-afk-walk', 'environmental-movement', 'auto-reconnect', 'auto-reconnect-delay', 'auto-reconnect-max', 'auto-deposit-setting', 'join-message', 'server-change-message',
  'message-delay', 'form-error', 'delete-account', 'login-dialog', 'login-code', 'open-login-private', 'open-login',
  'close-login', 'remote-dialog', 'close-remote', 'remote-local-url', 'open-dashboard', 'tailscale-command',
  'enable-tailscale', 'tailscale-result', 'remote-base-url', 'grant-label', 'grant-accounts', 'create-grant', 'generated-link', 'share-link',
  'copy-share-link', 'grant-list', 'toast-region'
].map((id) => [id, document.getElementById(id)]))

async function init() {
  state.accounts = await api.listAccounts()
  state.selectedId = state.accounts[0]?.id || null
  bindEvents()
  render()
  api.onBotEvent(handleBotEvent)
}

function bindEvents() {
  el['add-account'].addEventListener('click', () => openAccountDialog())
  el['browser-access'].addEventListener('click', openRemoteDialog)
  el['open-settings'].addEventListener('click', openSettingsDialog)
  el['close-settings'].addEventListener('click', () => el['settings-dialog'].close())
  el['save-settings'].addEventListener('click', saveSettings)
  el['stagger-startup-connections'].addEventListener('change', syncStartupDelay)
  document.querySelector('[data-action="add"]').addEventListener('click', () => openAccountDialog())
  el['edit-account'].addEventListener('click', () => openAccountDialog(selectedAccount()))
  el['account-form'].addEventListener('submit', saveAccount)
  document.querySelectorAll('[data-close-account]').forEach((button) => button.addEventListener('click', () => el['account-dialog'].close()))
  el['delete-account'].addEventListener('click', deleteAccount)
  el['connection-button'].addEventListener('click', toggleConnection)
  el['drop-selected'].addEventListener('click', dropSelectedStack)
  el['auto-deposit-toggle'].addEventListener('change', toggleAutoDeposit)
  el['proxy-enabled'].addEventListener('change', syncProxyFields)
  el['proxy-type'].addEventListener('change', () => {
    el['proxy-port'].value = el['proxy-type'].value === 'http' ? 8080 : 1080
  })
  el['chat-form'].addEventListener('submit', sendChat)
  el['clear-console'].addEventListener('click', () => {
    state.logs.set(state.selectedId, [])
    renderConsole()
  })
  document.querySelectorAll('[data-control]').forEach((button) => button.addEventListener('click', () => run(() => api.control(state.selectedId, button.dataset.control))))
  document.querySelectorAll('[data-look]').forEach((button) => button.addEventListener('click', () => run(() => api.look(state.selectedId, button.dataset.look))))
  el['login-code'].addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.login.code)
    toast('Sign-in code copied.')
  })
  el['open-login'].addEventListener('click', () => run(() => api.openExternal(state.login.url)))
  el['open-login-private'].addEventListener('click', () => run(() => api.openIsolatedLogin(state.login.accountId, state.login.url, state.login.code)))
  el['close-login'].addEventListener('click', () => el['login-dialog'].close())
  el['close-remote'].addEventListener('click', () => el['remote-dialog'].close())
  el['open-dashboard'].addEventListener('click', () => run(() => api.openRemoteDashboard()))
  el['enable-tailscale'].addEventListener('click', enableTailscale)
  el['create-grant'].addEventListener('click', createRemoteGrant)
  el['copy-share-link'].addEventListener('click', async () => {
    await navigator.clipboard.writeText(el['share-link'].value)
    toast('Access link copied.')
  })
}

function render() {
  renderAccountList()
  const account = selectedAccount()
  el['empty-state'].hidden = Boolean(account)
  el.dashboard.hidden = !account
  if (!account) return

  const status = getStatus(account.id)
  el['account-title'].textContent = account.label
  el['server-address'].textContent = `${account.host}:${account.port}`
  el['detail-username'].textContent = account.username
  el['detail-server'].textContent = `${account.host}:${account.port}`
  el['detail-version'].textContent = account.version || 'Auto-detect'
  const minDelay = account.antiAfkMinDelay ?? account.antiAfkInterval ?? 45
  const maxDelay = account.antiAfkMaxDelay ?? account.antiAfkInterval ?? minDelay
  el['detail-antiafk'].textContent = account.antiAfk ? `${minDelay}–${maxDelay} seconds` : 'Disabled'
  el['detail-environment'].textContent = account.environmentalMovement !== false ? 'Allowed' : 'Position held'
  el['auto-deposit-toggle'].checked = account.autoDepositToChest === true
  renderStatus(status)
  renderConsole()
  renderTelemetry()
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
      state.selectedId = account.id
      state.selectedInventorySlot = null
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
  el['detail-chest'].textContent = telemetry?.nearestChest ? `${telemetry.nearestChest.x}, ${telemetry.nearestChest.y}, ${telemetry.nearestChest.z} (${formatNumber(telemetry.nearestChest.distance)} blocks)` : telemetry ? 'Not found within 5 blocks' : '—'
  el['detail-dimension'].textContent = telemetry ? String(telemetry.dimension || 'unknown').replace(/^minecraft:/, '') : '—'
  const items = telemetry?.inventory || []
  if (!items.some((item) => item.slot === state.selectedInventorySlot)) state.selectedInventorySlot = null
  el['inventory-count'].textContent = telemetry ? `${items.length} occupied slot${items.length === 1 ? '' : 's'}` : 'Connect to view items'
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'inventory-empty'
    empty.textContent = telemetry ? 'Inventory is empty.' : 'Inventory will appear while this account is online.'
    el['inventory-grid'].replaceChildren(empty)
    updateInventoryActions()
    return
  }
  el['inventory-grid'].replaceChildren(...items.map((item) => {
    const slot = document.createElement('button')
    slot.type = 'button'
    slot.className = `inventory-slot${item.slot === state.selectedInventorySlot ? ' selected' : ''}`
    slot.setAttribute('aria-pressed', item.slot === state.selectedInventorySlot ? 'true' : 'false')
    slot.addEventListener('click', () => {
      state.selectedInventorySlot = state.selectedInventorySlot === item.slot ? null : item.slot
      renderTelemetry()
    })
    const name = document.createElement('strong')
    name.textContent = item.displayName
    const meta = document.createElement('span')
    meta.textContent = `×${item.count} · slot ${item.slot}`
    slot.append(name, meta)
    return slot
  }))
  updateInventoryActions()
}

function updateInventoryActions(canInteract = ['online', 'connected'].includes(getStatus(state.selectedId).status)) {
  const telemetry = state.telemetry.get(state.selectedId)
  const item = telemetry?.inventory?.find((entry) => entry.slot === state.selectedInventorySlot)
  el['drop-selected'].disabled = !canInteract || !item
  el['drop-selected'].textContent = item ? `Drop ${item.count} × ${item.displayName}` : 'Drop selected stack'
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
  await run(() => api.sendChat(state.selectedId, message))
  el['chat-message'].value = ''
}

function handleBotEvent({ type, id, payload }) {
  if (type === 'status') {
    state.statuses.set(id, payload)
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

async function openRemoteDialog() {
  try {
    const status = await api.remoteStatus()
    el['remote-local-url'].textContent = status.localUrl
    el['tailscale-command'].textContent = `tailscale serve --bg ${status.port}`
    renderGrantAccounts()
    await renderGrantList()
    el['generated-link'].hidden = true
    el['remote-dialog'].showModal()
  } catch (error) { toast(cleanError(error), 'error') }
}

function renderGrantAccounts() {
  el['grant-accounts'].replaceChildren(...state.accounts.map((account) => {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = account.id
    const text = document.createElement('span')
    text.textContent = `${account.label} — ${account.host}`
    label.append(checkbox, text)
    return label
  }))
}

async function openSettingsDialog() {
  try {
    const settings = await api.getSettings()
    el['start-with-windows'].checked = settings.startWithWindows === true
    el['stagger-startup-connections'].checked = settings.staggerStartupConnections !== false
    el['startup-connection-delay'].value = settings.startupConnectionDelay || 3
    syncStartupDelay()
    el['settings-dialog'].showModal()
  } catch (error) { toast(cleanError(error), 'error') }
}

async function saveSettings() {
  try {
    await api.saveSettings({
      startWithWindows: el['start-with-windows'].checked,
      staggerStartupConnections: el['stagger-startup-connections'].checked,
      startupConnectionDelay: Number(el['startup-connection-delay'].value)
    })
    el['settings-dialog'].close()
    toast('Settings saved.')
  } catch (error) { toast(cleanError(error), 'error') }
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

async function createRemoteGrant() {
  const accountIds = [...el['grant-accounts'].querySelectorAll('input:checked')].map((input) => input.value)
  const permissions = ['view', ...[...document.querySelectorAll('[data-permission]:checked:not(:disabled)')].map((input) => input.dataset.permission)]
  try {
    const created = await api.createRemoteGrant({ label: el['grant-label'].value, accountIds, permissions })
    const base = el['remote-base-url'].value.trim().replace(/\/$/, '')
    el['share-link'].value = base ? `${base}${created.sharePath}` : created.localUrl
    el['generated-link'].hidden = false
    await renderGrantList()
    el['share-link'].select()
  } catch (error) { toast(cleanError(error), 'error') }
}

async function enableTailscale() {
  el['enable-tailscale'].disabled = true
  try {
    const result = await api.enableTailscale()
    el['tailscale-result'].textContent = result.output || 'Tailscale browser access is enabled.'
    el['tailscale-result'].hidden = false
    if (result.url) el['remote-base-url'].value = result.url
  } catch (error) {
    el['tailscale-result'].textContent = `Could not enable Tailscale: ${cleanError(error)}`
    el['tailscale-result'].hidden = false
  } finally { el['enable-tailscale'].disabled = false }
}

async function renderGrantList() {
  const grants = await api.listRemoteGrants()
  if (!grants.length) {
    const empty = document.createElement('div')
    empty.className = 'grant-empty'
    empty.textContent = 'No browser access links created yet.'
    el['grant-list'].replaceChildren(empty)
    return
  }
  el['grant-list'].replaceChildren(...grants.sort((a, b) => b.createdAt - a.createdAt).map((grant) => {
    const item = document.createElement('div')
    item.className = `grant-item ${grant.revokedAt ? 'revoked' : ''}`
    const copy = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = grant.label
    const detail = document.createElement('span')
    detail.textContent = `${grant.accountIds.length} account${grant.accountIds.length === 1 ? '' : 's'} · ${grant.permissions.join(', ')}${grant.revokedAt ? ' · revoked' : ''}`
    copy.append(title, detail)
    item.append(copy)
    if (!grant.revokedAt) {
      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'button danger'
      revoke.textContent = 'Revoke'
      revoke.addEventListener('click', async () => {
        await api.revokeRemoteGrant(grant.id)
        await renderGrantList()
        toast('Browser access revoked.')
      })
      item.append(revoke)
    }
    return item
  }))
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
