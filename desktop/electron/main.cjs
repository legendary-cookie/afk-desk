const { app, BrowserWindow, ipcMain, shell, safeStorage, Notification, dialog } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const smokeTest = process.argv.includes('--smoke-test')
if (smokeTest) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-release-smoke-')))
const { pathToFileURL } = require('node:url')
const { registerTrustedHandler, restrictWindow, isMicrosoftLoginUrl } = require('./ipc-security.cjs')
const { validateProfileId } = require('./profile-path.cjs')
const documentPath = path.join(__dirname, '..', 'src', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const { AccountStore, SettingsStore, startupConnectionDelay } = require('./store.cjs')
const { BotManager, normalizeSkinUrl } = require('./bot-manager.cjs')
const { BedrockBotManager } = require('./bedrock-bot-manager.cjs')
const { MultiEditionBotManager } = require('./multi-edition-manager.cjs')
const { sendToWindow } = require('./window-events.cjs')
const { DiagnosticLog } = require('./diagnostic-log.cjs')
const { preferredVersionForAccount, rememberedVersionState } = require('./version-compatibility.cjs')
const { supportedVersions, normalizeVersionSelection } = require('./version-support.cjs')
const { normalizeModdedProfile } = require('./modded-compatibility.cjs')
const {
  AlertManager, MacroEngine, PersistentEventStore, SmartProxyManager,
  identityIdFor, normalizeAutomations, normalizeEdition
} = require('./beta-core.cjs')
const movementDiagnosticsEnabled = process.env.AFK_DESK_MOVEMENT_DIAGNOSTICS === '1'

let mainWindow
let store
let settingsStore
let bots
let diagnosticLog
let eventStore
let alerts
let macroEngine
let smartProxies
let storageErrorShown = false
const runtime = new Map()
const assignedProxies = new Map()
const startupTimers = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !smokeTest,
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0b0e13',
    title: 'AFK Desk',
    icon: path.join(__dirname, '..', 'assets', 'afk-desk-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  restrictWindow(mainWindow)
  if (smokeTest) {
    const deadline = setTimeout(() => app.exit(1), 20000)
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const [version, accounts, versions] = await Promise.all([window.afkDesk.getAppVersion(), window.afkDesk.listAccounts(), window.afkDesk.getSupportedVersions()]);
          await window.afkDesk.getSettings();
          return { version, accountCount: accounts.length, supportedVersions: versions.length, bridge: true };
        })()`)
        if (result.accountCount !== 0 || !result.supportedVersions) throw new Error('Smoke data isolation or protocol initialization failed.')
        if (process.env.AFK_DESK_SMOKE_REPORT) fs.writeFileSync(process.env.AFK_DESK_SMOKE_REPORT, JSON.stringify({ ...result, userData: app.getPath('userData') }, null, 2))
        console.log('AFK_DESK_SMOKE_PASS', JSON.stringify(result))
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error('AFK_DESK_SMOKE_FAIL', error.message)
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  }
  mainWindow.loadFile(documentPath)
}

app.whenReady().then(async () => {
  store = new AccountStore(app.getPath('userData'))
  settingsStore = new SettingsStore(app.getPath('userData'))
  diagnosticLog = new DiagnosticLog(app.getPath('userData'))
  eventStore = new PersistentEventStore(app.getPath('userData'))
  alerts = new AlertManager(({ title, body }) => {
    try {
      if (settingsStore.get().notificationsEnabled === true && Notification.isSupported()) {
        new Notification({ title, body, silent: false }).show()
      }
    } catch {}
  })
  smartProxies = new SmartProxyManager()
  const managerOptions = {
    profilesPath: path.join(app.getPath('userData'), 'profiles'),
    emit: emitBotEvent,
    diagnose: (entry) => {
      diagnosticLog.write(entry)
      if (movementDiagnosticsEnabled) console.log(`[movement-diagnostic] ${JSON.stringify(entry)}`)
    }
  }
  bots = new MultiEditionBotManager({
    java: new BotManager(managerOptions),
    bedrock: new BedrockBotManager({ profilesPath: managerOptions.profilesPath, emit: emitBotEvent })
  })
  macroEngine = new MacroEngine({
    getAccount: (id) => store.list().find((item) => item.id === id),
    getState: getRuntime,
    execute: executeMacroStep,
    emit: emitBotEvent
  })
  for (const account of store.list()) macroEngine.sync(account)
  registerIpc()
  createWindow()
  if (!smokeTest) autoConnectConfiguredAccounts()
}).catch((error) => {
  if (smokeTest) { console.error('AFK_DESK_SMOKE_FAIL', error.message); app.exit(1); return }
  dialog.showErrorBox('AFK Desk could not start', String(error?.message || error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const timer of startupTimers.values()) clearTimeout(timer)
  startupTimers.clear()
  for (const id of runtime.keys()) {
    macroEngine?.stop(id)
    macroEngine?.cancelTimers(id)
    bots?.disconnect(id)
  }
})

function registerIpc() {
  const handle = (channel, callback) => registerTrustedHandler(ipcMain, () => mainWindow, documentUrl, channel, callback)
  handle('accounts:list', () => store.list().map(publicAccount))
  handle('accounts:save', async (_event, input) => {
    const existing = store.list().find((account) => account.id === input?.id)
    const account = validateAccount(input, existing)
    const saved = store.save(account)
    macroEngine.sync(saved)
    if (existing && (existing.autoDepositToChest !== saved.autoDepositToChest || existing.autoDepositRange !== saved.autoDepositRange)) {
      bots.setAutoDeposit(saved.id, saved.autoDepositToChest, saved.autoDepositRange)
    }
    if (existing && existing.environmentalMovement !== saved.environmentalMovement) bots.setEnvironmentalMovement(saved.id, saved.environmentalMovement)
    if (existing && antiAfkChanged(existing, saved)) bots.setAntiAfk(saved.id, saved)
    return publicAccount(saved)
  })
  handle('accounts:delete', (_event, id) => {
    cancelStartupConnection(id)
    bots.disconnect(id)
    macroEngine.stop(id)
    macroEngine.cancelTimers(id)
    store.delete(id)
  })
  handle('accounts:duplicate-profile', (_event, id) => {
    const source = store.list().find((account) => account.id === id)
    if (!source) throw new Error('Account profile not found.')
    const copy = store.save({
      ...source,
      id: crypto.randomUUID(),
      profileName: `${source.profileName || source.label || source.host} copy`.slice(0, 60),
      connectOnStartup: false,
      autoDepositToChest: false
    })
    macroEngine.sync(copy)
    return publicAccount(copy)
  })
  handle('accounts:reorder', (_event, orderedIds) => store.reorder(orderedIds).map(publicAccount))
  handle('bot:connect', (_event, id) => {
    cancelStartupConnection(id)
    return connectProfile(id)
  })
  handle('bot:disconnect', (_event, id) => {
    cancelStartupConnection(id)
    bots.disconnect(id)
    smartProxies.release(assignedProxies.get(id))
    assignedProxies.delete(id)
  })
  handle('bot:chat', (_event, { id, message }) => bots.sendChat(id, message))
  handle('bot:complete-chat', (_event, { id, text }) => bots.completeChat(id, text))
  handle('bot:control', (_event, { id, control, duration }) => bots.control(id, control, duration))
  handle('bot:control-state', (_event, { id, control, active }) => bots.setControlState(id, control, active))
  handle('bot:look', (_event, { id, direction }) => bots.look(id, direction))
  handle('bot:look-delta', (_event, { id, yawDelta, pitchDelta }) => bots.lookDelta(id, yawDelta, pitchDelta))
  handle('bot:drop-stack', (_event, { id, slot }) => bots.dropStack(id, slot))
  handle('bot:drop-items', (_event, { id, slot, count }) => bots.dropItems(id, slot, count))
  handle('bot:deposit-slot', (_event, { id, slot, count }) => bots.depositSlot(id, slot, count))
  handle('bot:item-lock', (_event, { id, slot, locked }) => {
    const account = store.list().find((item) => item.id === id)
    if (!account) throw new Error('Account not found.')
    const slots = new Set(account.lockedInventorySlots || [])
    if (locked === true) slots.add(Number(slot))
    else slots.delete(Number(slot))
    const updated = store.save({ ...account, lockedInventorySlots: normalizeLockedSlots([...slots]) })
    bots.setItemLocks(id, updated.lockedInventorySlots)
    return publicAccount(updated)
  })
  handle('bot:inventory-move', async (_event, { id, sourceSlot, destinationSlot }) => {
    const account = store.list().find((item) => item.id === id)
    if (!account) throw new Error('Account not found.')
    const result = await bots.moveInventorySlot(id, sourceSlot, destinationSlot)
    const updated = store.save(relocateLockedSlots(account, result.sourceSlot, result.targetSlot))
    bots.setItemLocks(id, updated.lockedInventorySlots)
    return { account: publicAccount(updated), ...result }
  })
  handle('bot:equip-item', async (_event, { id, slot, destination }) => {
    const account = store.list().find((item) => item.id === id)
    if (!account) throw new Error('Account not found.')
    const result = await bots.equipInventoryItem(id, slot, destination)
    const updated = store.save(relocateLockedSlots(account, result.sourceSlot, result.targetSlot))
    bots.setItemLocks(id, updated.lockedInventorySlots)
    return { account: publicAccount(updated), ...result }
  })
  handle('bot:window-click', (_event, { id, slot }) => bots.clickWindowSlot(id, slot))
  handle('bot:window-close', (_event, id) => bots.closeWindow(id))
  handle('bot:world-snapshot', (_event, { id, radius, blockRefreshMs }) => bots.worldSnapshot(id, radius, blockRefreshMs))
  handle('bot:world-action', (_event, { id, action, target }) => bots.worldAction(id, action, target))
  handle('logs:list', (_event, { id, limit, kinds }) => eventStore.list(id, { limit, kinds }))
  handle('logs:clear', (_event, id) => eventStore.clear(id))
  handle('macro:run', (_event, { id, macroId }) => macroEngine.run(id, macroId))
  handle('macro:stop', (_event, id) => macroEngine.stop(id))
  handle('proxy:health', () => smartProxies.snapshot())
  handle('bot:auto-deposit', async (_event, { id, enabled }) => {
    const account = store.list().find((item) => item.id === id)
    if (!account) throw new Error('Account not found.')
    const updated = store.save({ ...account, autoDepositToChest: enabled === true })
    bots.setAutoDeposit(id, updated.autoDepositToChest, updated.autoDepositRange)
    return publicAccount(updated)
  })
  handle('auth:open-isolated', (_event, { id, url, code }) => openIsolatedLogin(id, url, code))
  handle('system:open-external', (_event, url) => {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported link.')
    return shell.openExternal(parsed.toString())
  })
  handle('settings:get', () => ({
    startWithWindows: app.getLoginItemSettings().openAtLogin,
    ...settingsStore.get()
  }))
  handle('app:version', () => app.getVersion())
  handle('app:supported-versions', () => supportedVersions())
  handle('settings:save', (_event, input) => {
    const startWithWindows = input?.startWithWindows === true
    const settings = settingsStore.save(input)
    app.setLoginItemSettings({ openAtLogin: startWithWindows })
    return {
      startWithWindows: app.getLoginItemSettings().openAtLogin,
      ...settings
    }
  })
}

function autoConnectConfiguredAccounts() {
  const settings = settingsStore.get()
  store.list().filter((account) => account.connectOnStartup).forEach((account, index) => {
    startupTimers.set(account.id, setTimeout(() => {
      startupTimers.delete(account.id)
      try {
        const current = store.list().find((item) => item.id === account.id)
        if (!current?.connectOnStartup) return
        connectProfile(current.id)
      }
      catch (error) {
        emitBotEvent('log', account.id, { kind: 'error', message: `Startup connection failed: ${error.message}`, at: Date.now() })
        emitBotEvent('status', account.id, { status: 'offline', detail: 'Startup connection failed' })
      }
    }, startupConnectionDelay(settings, index)))
  })
}

function cancelStartupConnection(id) {
  const timer = startupTimers.get(id)
  if (timer) clearTimeout(timer)
  startupTimers.delete(id)
}

function connectProfile(id) {
  if (bots.java.sessions.has(id) || bots.bedrock.sessions.has(id)) throw new Error('This profile is already connecting or online.')
  const account = requireAccount(id)
  smartProxies.release(assignedProxies.get(id))
  assignedProxies.set(id, account.proxy)
  try { return bots.connect(account) }
  catch (error) {
    smartProxies.release(assignedProxies.get(id))
    assignedProxies.delete(id)
    throw error
  }
}

function openIsolatedLogin(id, rawUrl, code) {
  if (!store.list().some((account) => account.id === id)) throw new Error('Account not found.')
  const supplied = new URL(rawUrl || 'https://microsoft.com/link')
  if (!isMicrosoftLoginUrl(supplied.href)) throw new Error('Microsoft sign-in must use a trusted Microsoft HTTPS address.')
  const loginUrl = new URL('https://microsoft.com/link')
  if (code) loginUrl.searchParams.set('otc', String(code).slice(0, 32))
  const authWindow = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    parent: mainWindow,
    title: 'Microsoft sign-in — AFK Desk',
    autoHideMenuBar: true,
    webPreferences: {
      partition: `afkdesk-auth-${id}-${Date.now()}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  })
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (isMicrosoftLoginUrl(target.href)) authWindow.loadURL(target.toString())
    } catch {}
    return { action: 'deny' }
  })
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    authWindow.webContents.on(name, (event, url) => {
      if (!isMicrosoftLoginUrl(url || event.url)) event.preventDefault()
    })
  }
  const isolatedSession = authWindow.webContents.session
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  authWindow.on('closed', () => isolatedSession.clearStorageData().catch(() => {}))
  return authWindow.loadURL(loginUrl.toString())
}

function emitBotEvent(type, id, payload) {
  let accountForEvent
  try {
    accountForEvent = store?.list().find((item) => item.id === id)
    storageErrorShown = false
  } catch (error) { reportRuntimeStorageError(error) }
  if (eventStore && (type !== 'telemetry' || telemetryChanged(getRuntime(id).telemetry, payload))) eventStore.append(id, { type, ...payload })
  if (accountForEvent) alerts?.handle(accountForEvent, type, payload)
  if (type === 'status' && payload.status === 'online') smartProxies?.report(assignedProxies.get(id), true)
  if (type === 'status' && payload.status === 'offline') {
    smartProxies?.release(assignedProxies.get(id))
    assignedProxies.delete(id)
  }
  if (type === 'log' && payload.kind === 'error') smartProxies?.report(assignedProxies.get(id), false)
  if (type === 'status') diagnosticLog?.write({ event: 'status', at: payload.at, accountId: id, status: payload.status, detail: payload.detail })
  if (type === 'telemetry') diagnosticLog?.write({ event: 'telemetry', at: payload.at, accountId: id, position: payload.position, environment: payload.environment, health: payload.health })
  if (type === 'log' && payload.kind === 'error') diagnosticLog?.write({ event: 'error', at: payload.at, accountId: id, message: payload.message })
  if (movementDiagnosticsEnabled && type === 'status') {
    console.log(`[movement-status] ${JSON.stringify({ accountId: id, status: payload.status })}`)
  }
  if (movementDiagnosticsEnabled && type === 'telemetry') {
    console.log(`[movement-telemetry] ${JSON.stringify({ accountId: id, position: payload.position, environment: payload.environment })}`)
  }
  if (movementDiagnosticsEnabled && type === 'log' && payload.kind === 'error') {
    console.log(`[movement-error] ${JSON.stringify({ accountId: id, message: String(payload.message || '').slice(0, 240) })}`)
  }
  const current = getRuntime(id)
  if (type === 'status') runtime.set(id, { ...current, status: payload.status, detail: payload.detail })
  if (type === 'log') runtime.set(id, { ...current, logs: [...current.logs.slice(-499), payload] })
  if (type === 'telemetry') runtime.set(id, { ...current, telemetry: payload })
  if (type === 'version') {
    runtime.set(id, { ...current, resolvedVersion: payload.version })
    const account = accountForEvent
    if (account && payload.version && payload.stable === true) {
      saveEventAccount({ ...account, lastSuccessfulVersion: String(payload.version).slice(0, 32), lastSuccessfulVersionStable: true })
    }
  }
  if (type === 'identity') {
    const account = accountForEvent
    if (account) {
      const minecraftName = normalizeMinecraftName(payload.username) || account.minecraftName || ''
      saveEventAccount({
        ...account,
        label: minecraftName || account.label,
        minecraftName,
        minecraftUuid: normalizeUuid(payload.uuid) || account.minecraftUuid || '',
        skinUrl: normalizeSkinUrl(payload.skinUrl) || account.skinUrl || ''
      })
    }
  }
  sendToWindow(mainWindow, 'bot:event', { type, id, payload })
  macroEngine?.handleEvent(id, type, payload).catch((error) => {
    if (type !== 'macro') emitBotEvent('macro', id, { status: 'failed', error: String(error?.message || error).slice(0, 200), at: Date.now() })
  })
}

function reportRuntimeStorageError(error) {
  if (storageErrorShown) return
  storageErrorShown = true
  dialog.showErrorBox('AFK Desk storage needs attention', String(error?.message || error))
}

function saveEventAccount(account) {
  try { store.save(account) }
  catch (error) { reportRuntimeStorageError(error) }
}

function getRuntime(id) {
  return runtime.get(id) || { status: 'offline', detail: 'Ready to connect', logs: [] }
}

function requireAccount(id) {
  const account = store.list().find((item) => item.id === id)
  if (!account) throw new Error('Account not found.')
  const resolved = withProxyPassword(account)
  if (account.proxyMode !== 'smart') return resolved
  const pool = store.list().map((candidate) => withProxyPassword(candidate))
  return { ...resolved, proxy: smartProxies.select(resolved, pool) }
}

function telemetryChanged(before, after) {
  if (!before) return true
  return before.health !== after.health || before.food !== after.food || before.dimension !== after.dimension ||
    JSON.stringify(before.position) !== JSON.stringify(after.position) || JSON.stringify(before.inventory) !== JSON.stringify(after.inventory)
}

function validateAccount(input, existing) {
  const host = String(input?.host || '').trim()
  const username = String(input?.username || '').trim()
  if (!host) throw new Error('Server address is required.')
  if (!username) throw new Error('Microsoft account email is required.')
  const edition = normalizeEdition(input?.edition ?? existing?.edition)
  const port = Number(input?.port) || (edition === 'bedrock' ? 19132 : 25565)
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.')
  const minecraftName = normalizeMinecraftName(input?.minecraftName)
  const version = edition === 'java' ? normalizeVersionSelection(input?.version) : ''
  const rememberedVersion = rememberedVersionState(version, input, existing)
  const modded = edition === 'java' ? normalizeModdedProfile(input) : normalizeModdedProfile({ modLoader: 'vanilla', modHandshake: 'off' })
  const antiAfk = input?.antiAfk !== false
  const antiAfkJump = input?.antiAfkJump !== false
  const antiAfkLook = input?.antiAfkLook !== false
  const antiAfkSneak = input?.antiAfkSneak === true
  const antiAfkSwing = input?.antiAfkSwing === true
  const antiAfkWalk = input?.antiAfkWalk === true
  if (antiAfk && ![antiAfkJump, antiAfkLook, antiAfkSneak, antiAfkSwing, antiAfkWalk].some(Boolean)) {
    throw new Error('Select at least one anti-AFK action or turn anti-AFK off.')
  }
  return {
    id: validateProfileId(input?.id || crypto.randomUUID()),
    identityId: validateProfileId(existing?.identityId || identityIdFor(edition, username)),
    edition,
    profileName: String(input?.profileName || existing?.profileName || host).trim().slice(0, 60),
    label: minecraftName || String(input?.label || username.split('@')[0] || 'Minecraft account').trim().slice(0, 50),
    username,
    host,
    port,
    version,
    modLoader: modded.loader,
    modHandshake: modded.handshake,
    clientBrand: modded.brand,
    mods: modded.mods,
    modChannels: modded.channels,
    ...rememberedVersion,
    minecraftName,
    minecraftUuid: normalizeUuid(input?.minecraftUuid),
    skinUrl: normalizeSkinUrl(input?.skinUrl),
    antiAfk,
    antiAfkInterval: bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
    antiAfkMinDelay: bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
    antiAfkMaxDelay: Math.max(
      bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
      bounded(input?.antiAfkMaxDelay ?? input?.antiAfkInterval, 2, 3600, 45)
    ),
    antiAfkActionDuration: bounded(input?.antiAfkActionDuration, 0.1, 10, 0.25),
    antiAfkWalkDistance: bounded(input?.antiAfkWalkDistance, 0.1, 8, 0.5),
    antiAfkLookDegrees: bounded(input?.antiAfkLookDegrees, 5, 180, 12),
    antiAfkJump,
    antiAfkLook,
    antiAfkSneak,
    antiAfkSwing,
    antiAfkWalk,
    environmentalMovement: input?.environmentalMovement !== false,
    autoReconnect: input?.autoReconnect !== false,
    autoReconnectDelay: bounded(input?.autoReconnectDelay, 1, 3600, 5),
    autoReconnectBackoffMultiplier: bounded(input?.autoReconnectBackoffMultiplier, 1, 10, 2),
    autoReconnectMaxDelay: bounded(input?.autoReconnectMaxDelay, 1, 86400, 300),
    autoReconnectRateLimitDelay: bounded(input?.autoReconnectRateLimitDelay, 1, 86400, 30),
    autoReconnectMaxAttempts: Math.max(0, Math.min(Number(input?.autoReconnectMaxAttempts) || 0, 1000)),
    connectTimeoutSeconds: bounded(input?.connectTimeoutSeconds, 5, 300, 60),
    reconnectResetDelay: bounded(input?.reconnectResetDelay, 5, 3600, 60),
    connectOnStartup: input?.connectOnStartup === true,
    autoDepositToChest: input?.autoDepositToChest === true,
    autoDepositRange: Math.round(bounded(input?.autoDepositRange ?? existing?.autoDepositRange, 1, 16, 5)),
    lockedInventorySlots: normalizeLockedSlots(input?.lockedInventorySlots ?? existing?.lockedInventorySlots),
    proxy: validateProxy(input?.proxy, existing?.proxy),
    proxyMode: ['direct', 'manual', 'smart'].includes(input?.proxyMode) ? input.proxyMode : (input?.proxy?.enabled ? 'manual' : 'direct'),
    shareProxyToPool: input?.shareProxyToPool === true,
    proxyLabel: String(input?.proxyLabel || '').trim().slice(0, 60),
    proxyMaxSessions: Math.max(1, Math.min(Number(input?.proxyMaxSessions) || 1, 100)),
    alerts: {
      disconnect: input?.alerts?.disconnect !== false,
      errors: input?.alerts?.errors !== false,
      healthBelow: Math.max(0, Math.min(Number(input?.alerts?.healthBelow) || 6, 20))
    },
    automations: normalizeAutomations(input?.automations ?? existing?.automations),
    joinMessage: String(input?.joinMessage || '').trim().slice(0, 256),
    serverChangeMessage: String(input?.serverChangeMessage || '').trim().slice(0, 256),
    messageDelay: Math.max(0, Math.min(input?.messageDelay === '' || input?.messageDelay == null ? 6 : Number(input.messageDelay) || 0, 600))
  }
}

function normalizeLockedSlots(slots) {
  return [...new Set((Array.isArray(slots) ? slots : []).map(Number).filter((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 255))].sort((a, b) => a - b).slice(0, 46)
}

function relocateLockedSlots(account, sourceSlot, targetSlot) {
  const slots = new Set(normalizeLockedSlots(account?.lockedInventorySlots))
  const sourceLocked = slots.has(sourceSlot)
  const targetLocked = slots.has(targetSlot)
  slots.delete(sourceSlot)
  slots.delete(targetSlot)
  if (sourceLocked) slots.add(targetSlot)
  if (targetLocked) slots.add(sourceSlot)
  return { ...account, lockedInventorySlots: normalizeLockedSlots([...slots]) }
}

function bounded(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.min(number, maximum)) : fallback
}

function antiAfkChanged(before, after) {
  return [
    'antiAfk', 'antiAfkMinDelay', 'antiAfkMaxDelay', 'antiAfkActionDuration',
    'antiAfkWalkDistance', 'antiAfkLookDegrees', 'antiAfkJump', 'antiAfkLook',
    'antiAfkSneak', 'antiAfkSwing', 'antiAfkWalk'
  ].some((field) => before?.[field] !== after?.[field])
}

function normalizeUuid(value) {
  const uuid = String(value || '').replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(uuid) ? uuid : ''
}

function normalizeMinecraftName(value) {
  const name = String(value || '').trim()
  return /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : ''
}

function validateProxy(input, existing = {}) {
  const enabled = input?.enabled === true
  const type = input?.type === 'http' ? 'http' : 'socks5'
  const host = String(input?.host || '').trim()
  const port = Number(input?.port) || (type === 'http' ? 8080 : 1080)
  const username = String(input?.username || '').trim()
  if (enabled && (!host || host.length > 255 || /[\s\r\n]/.test(host))) throw new Error('Enter a valid proxy host.')
  if (enabled && (port < 1 || port > 65535)) throw new Error('Proxy port must be between 1 and 65535.')
  if (username.length > 128 || /[\r\n]/.test(username)) throw new Error('Proxy username is invalid.')
  let passwordEncrypted = String(existing?.passwordEncrypted || '')
  if (input?.clearPassword === true) passwordEncrypted = ''
  const password = String(input?.password || '')
  if (password) {
    if (password.length > 512 || /[\r\n]/.test(password)) throw new Error('Proxy password is invalid.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is not available. Proxy password was not saved.')
    passwordEncrypted = safeStorage.encryptString(password).toString('base64')
  }
  return { enabled, type, host, port, username, passwordEncrypted }
}

function withProxyPassword(account) {
  const proxy = account.proxy || {}
  let password = ''
  if (proxy.passwordEncrypted) {
    try { password = safeStorage.decryptString(Buffer.from(proxy.passwordEncrypted, 'base64')) }
    catch { throw new Error('Could not decrypt this account’s proxy password. Re-enter it in account settings.') }
  }
  const lastSuccessfulVersion = account.version ? account.lastSuccessfulVersion : preferredVersionForAccount(account, store.list())
  const enabled = account.proxyMode === 'manual' ? proxy.enabled === true : account.proxyMode === 'smart' ? true : false
  return { ...account, lastSuccessfulVersion, proxy: { ...proxy, enabled, password } }
}

function publicAccount(account) {
  const { passwordEncrypted, password, ...proxy } = account.proxy || {}
  return { ...account, proxy: { ...proxy, hasPassword: Boolean(passwordEncrypted) } }
}

async function executeMacroStep(id, step) {
  if (step.type === 'chat') return bots.sendChat(id, step.message)
  if (step.type === 'move') return bots.control(id, step.control, step.duration)
  if (step.type === 'look') return bots.look(id, step.direction)
  if (step.type === 'drop') return bots.dropItems(id, step.slot, step.count)
  if (step.type === 'deposit') return bots.depositSlot(id, step.slot, step.count)
  if (step.type === 'equip') return bots.equipInventoryItem(id, step.slot, step.destination)
  if (step.type === 'clickGui') return bots.clickWindowSlot(id, step.slot)
  if (step.type === 'attackNearest') return bots.worldAction(id, 'attack-nearest')
  if (step.type === 'useHeld') return bots.worldAction(id, 'use-held')
  if (step.type === 'notify') {
    const account = store.list().find((item) => item.id === id)
    try {
      if (settingsStore.get().notificationsEnabled === true && Notification.isSupported()) {
        new Notification({ title: account?.profileName || 'AFK Desk automation', body: step.message || 'Automation notification' }).show()
      }
    } catch {}
  }
}
