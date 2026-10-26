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
const { MacroLibraryStore, writeBackV1: writeBackMigratedMacro } = require('./macro/library-store.cjs')
const macroModel = require('./macro/model.cjs')
const macroTriggers = require('./macro/triggers.cjs')
const { MacroEngine: V2MacroEngine } = require('./macro/engine.cjs')
const { createFacade } = require('./macro/facade.cjs')
const { TriggerMatcher } = require('./macro/triggers.cjs')
const { createBotEventAdapter } = require('./macro/bot-events.cjs')
const { IPC: MACRO_IPC, LIMITS: MACRO_LIMITS } = require('./macro/contract.cjs')
const { NotifySettings, classifyKickReason, crossedLowHealth } = require('./notify/settings.cjs')
const { fetchWithPolicy } = require('./net-policy.cjs')
const { rememberedVersionState } = require('./version-compatibility.cjs')
const { supportedVersions, normalizeVersionSelection } = require('./version-support.cjs')
const { normalizeModdedProfile } = require('./modded-compatibility.cjs')
const {
  AlertManager, PersistentEventStore, SmartProxyManager,
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
let macroLibrary
let notifySettings
let notifier
let botEventAdapter
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
  notifySettings = new NotifySettings(settingsStore, safeStorage)
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
  macroLibrary = new MacroLibraryStore(app.getPath('userData'))
  const accounts = store.list()
  macroLibrary.load(accounts)
  for (const warning of macroLibrary.warnings) diagnosticLog.write({ event: 'warning', at: Date.now(), message: warning })
  const migration = macroModel.migrateV1(accounts, macroLibrary.library)
  if (migration.migratedAccountIds.length) macroLibrary.write(migration.library)
  macroLibrary.library = migration.library
  for (const warning of migration.warnings) diagnosticLog.write({ event: 'warning', at: Date.now(), message: warning })
  const resolveTargets = (macro) => {
    const all = store.list()
    if (macro.targets.mode === 'all') return all.map((a) => a.id)
    if (macro.targets.mode === 'accounts') { const ids = new Set(all.map((a) => a.id)); return macro.targets.accountIds.filter((id) => ids.has(id)) }
    const tags = new Set(macro.targets.tags)
    return all.filter((a) => Array.isArray(a.tags) && a.tags.some((tag) => tags.has(tag))).map((a) => a.id)
  }
  botEventAdapter = createBotEventAdapter({ sessionId: (id) => facade?.sessionId(id), isManualDisconnect: (id) => bots?.manager(id)?.reconnects?.get(id)?.manual === true })
  let facade
  try { notifier = require('./notify/notifier.cjs').createNotifier({ fetchWithPolicy, getChannels: () => notifySettings.getDecrypted(), onLog: (entry) => diagnosticLog.write(entry) }) } catch { notifier = null }
  facade = createFacade({ bots, getEdition: (id) => store.list().find((a) => a.id === id)?.edition || 'java', notify: (event) => notifyMacro(event) })
  macroEngine = new V2MacroEngine({ facade, matcher: new TriggerMatcher({}), now: Date.now, emit: emitMacroRunEvent, getAccountState: facade.state, resolveTargets, nextScheduleTime: macroTriggers.nextScheduleTime })
  macroEngine.setLibrary(macroLibrary.list())
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
    void macroEngine?.stop(id, 'shutdown')
    bots?.disconnect(id)
  }
  void macroEngine?.shutdown()
  void notifier?.flush?.()
})

function registerIpc() {
  const handle = (channel, callback) => registerTrustedHandler(ipcMain, () => mainWindow, documentUrl, channel, callback)
  handle('accounts:list', () => store.list().map(publicAccount))
  handle('accounts:save', async (_event, input) => {
    const existing = store.list().find((account) => account.id === input?.id)
    const account = validateAccount(input, existing)
    const saved = store.save(account)
    macroEngine.setLibrary(macroLibrary.list())
    if (existing && (existing.autoDepositToChest !== saved.autoDepositToChest || existing.autoDepositRange !== saved.autoDepositRange)) {
      bots.setAutoDeposit(saved.id, saved.autoDepositToChest, saved.autoDepositRange)
    }
    if (existing && existing.environmentalMovement !== saved.environmentalMovement) bots.setEnvironmentalMovement(saved.id, saved.environmentalMovement)
    if (existing && antiAfkChanged(existing, saved)) bots.setAntiAfk(saved.id, saved)
    if (existing) {
      // Refresh the config retry/reconnect callbacks use; never fail a completed save over it.
      try { bots.updateAccountConfig(retryConfig(saved)) } catch (error) { diagnosticLog?.write({ event: 'error', at: Date.now(), accountId: saved.id, message: `Could not refresh live config: ${String(error?.message || error).slice(0, 200)}` }) }
    }
    return publicAccount(saved)
  })
  handle('accounts:delete', (_event, id) => {
    cancelStartupConnection(id)
    bots.disconnect(id)
    void macroEngine.stop(id, 'account-deleted')
    store.delete(id)
    macroEngine.setLibrary(macroLibrary.list())
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
    macroEngine.setLibrary(macroLibrary.list())
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
    if (!store.list().some((item) => item.id === id)) throw new Error('Account not found.')
    const result = await bots.moveInventorySlot(id, sourceSlot, destinationSlot)
    return { account: applyLockRelocation(id, result), ...result }
  })
  handle('bot:equip-item', async (_event, { id, slot, destination }) => {
    if (!store.list().some((item) => item.id === id)) throw new Error('Account not found.')
    const result = await bots.equipInventoryItem(id, slot, destination)
    return { account: applyLockRelocation(id, result), ...result }
  })
  handle('bot:window-click', (_event, { id, slot }) => bots.clickWindowSlot(id, slot))
  handle('bot:window-close', (_event, id) => bots.closeWindow(id))
  handle('bot:world-snapshot', (_event, { id, radius, blockRefreshMs }) => bots.worldSnapshot(id, radius, blockRefreshMs))
  handle('bot:world-action', (_event, { id, action, target }) => bots.worldAction(id, action, target))
  handle('logs:list', (_event, { id, limit, kinds }) => eventStore.list(id, { limit, kinds }))
  handle('logs:clear', (_event, id) => eventStore.clear(id))
  handle(MACRO_IPC.list, () => macroListResult())
  handle(MACRO_IPC.save, (_event, input) => saveMacro(input))
  handle(MACRO_IPC.remove, (_event, id) => removeMacro(id))
  handle(MACRO_IPC.setEnabled, (_event, input) => setMacroEnabled(input))
  handle(MACRO_IPC.run, (_event, input) => { assertMacroPayload(input); return macroEngine.run(input.accountId, input.macroId) })
  handle(MACRO_IPC.stop, (_event, input) => { assertMacroPayload(input); return macroEngine.stop(input.accountId) })
  handle(MACRO_IPC.runs, (_event, id) => { assertMacroPayload(id); return macroEngine.runLog(id) })
  handle(MACRO_IPC.importJson, (_event, json) => { assertMacroPayload(json); const result = macroModel.importMacros(json, { accountIds: store.list().map((a) => a.id), editionOf: (id) => store.list().find((a) => a.id === id)?.edition }); if (result.errors.length) return result; const merged = [...macroLibrary.list(), ...result.macros].slice(0, MACRO_LIMITS.maxMacros); macroLibrary.replaceAll(merged); macroEngine.setLibrary(macroLibrary.list()); return { ...result, macros: result.macros } })
  handle(MACRO_IPC.exportJson, (_event, ids) => { assertMacroPayload(ids); const set = new Set(Array.isArray(ids) ? ids : []); return macroModel.exportMacros(macroLibrary.list().filter((m) => !set.size || set.has(m.id))) })
  handle('notify:list', () => notifySettings.list())
  handle('notify:save', (_event, input) => notifySettings.save(input))
  handle('notify:delete', (_event, id) => notifySettings.delete(id))
  handle('notify:test', async (_event, id) => notifier ? notifier.test(id) : { ok: false, error: 'Notifier unavailable' })
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
  handle('settings:get', () => {
    return { startWithWindows: app.getLoginItemSettings().openAtLogin, ...settingsStore.get() }
  })
  handle('app:version', () => app.getVersion())
  handle('app:supported-versions', () => supportedVersions())
  handle('settings:save', (_event, input) => {
    const startWithWindows = input?.startWithWindows === true
    const settings = settingsStore.save(input)
    app.setLoginItemSettings({ openAtLogin: startWithWindows })
    const { notifyChannels: _privateChannels, ...publicSettings } = settings
    return {
      startWithWindows: app.getLoginItemSettings().openAtLogin,
      ...publicSettings
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
  if (accountForEvent) alerts?.handle(accountForEvent, type, payload)
  for (const event of botEventAdapter?.(type, id, payload) || []) {
    macroEngine?.onBotEvent(event)
    notifyForBotEvent(event, accountForEvent)
  }
  if (type === 'log' && payload.kind === 'error' && /kicked:/i.test(payload.message || '')) {
    const reason = String(payload.message).replace(/^.*?kicked:\s*/i, '')
    const kind = classifyKickReason(reason)
    const displayName = accountDisplayName(accountForEvent)
    sendNotification({ kind, accountId: id, accountName: displayName, message: `${displayName} was ${kind}.`, payload: { reason }, at: Number(payload.at) || Date.now() })
  }
  if (type === 'status' && payload.status === 'reconnecting' && accountForEvent) {
    const delaySeconds = Number(String(payload.detail || '').match(/in\s+([\d.]+)s/i)?.[1]) || undefined
    const name = accountDisplayName(accountForEvent)
    sendNotification({ kind: 'reconnecting', accountId: id, accountName: name, message: `${name} is reconnecting.`, payload: { delaySeconds }, at: Number(payload.at) || Date.now() })
  }
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
  const persistEvent = eventStore && (type !== 'telemetry' || telemetryChanged(current.telemetry, payload))
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
  if (persistEvent) persistEventSafely(id, type, payload)
}

function sendNotification(event) { try { notifier?.notify(event) } catch {} }
function notifyForBotEvent(event, account) {
  if (!account) return
  const name = accountDisplayName(account)
  if (event.type === 'connected') sendNotification({ kind: 'connected', accountId: account.id, accountName: name, message: `${name} connected.`, at: event.at })
  if (event.type === 'disconnected') sendNotification({ kind: 'disconnected', accountId: account.id, accountName: name, message: `${name} disconnected: ${event.payload.reason}`, payload: event.payload, at: event.at })
  if (event.type === 'disconnected') { healthEdges.delete(account.id); previousInventoryFull.delete(account.id) }
  if (event.type === 'telemetry') {
    const previous = healthEdges.get(account.id)
    const health = Number(event.payload.health)
    if (crossedLowHealth(previous, health)) sendNotification({ kind: 'lowHealth', accountId: account.id, accountName: name, message: `${name} health is ${health}/20.`, payload: { health }, at: event.at })
    if (event.payload.inventoryFull && previousInventoryFull.get(account.id) !== true) sendNotification({ kind: 'inventoryFull', accountId: account.id, accountName: name, message: `${name} inventory is full.`, at: event.at })
    healthEdges.set(account.id, health); previousInventoryFull.set(account.id, event.payload.inventoryFull === true)
  }
  if (event.type === 'death') sendNotification({ kind: 'death', accountId: account.id, accountName: name, message: `${name} died.`, at: event.at })
}
const healthEdges = new Map()
const previousInventoryFull = new Map()
function notifyMacro(event) {
  const account = store.list().find((item) => item.id === event.accountId)
  const name = account?.profileName || account?.label || 'Minecraft account'
  const message = String(event.message || event.error || 'Macro notification').slice(0, 500)
  try { if (event.desktop !== false && settingsStore.get().notificationsEnabled && Notification.isSupported()) new Notification({ title: accountDisplayName(account) === 'Minecraft account' ? 'AFK Desk macro' : accountDisplayName(account), body: message }).show() } catch {}
  sendNotification({ kind: 'macro', accountId: event.accountId, accountName: name, message, payload: { macroName: event.macroName || 'Macro', status: event.status || 'notify' }, at: Date.now() })
}
function accountDisplayName(account) {
  for (const candidate of [account?.profileName, account?.minecraftName, account?.label]) {
    const value = String(candidate || '').trim()
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value.slice(0, 60)
  }
  return 'Minecraft account'
}
function emitMacroRunEvent(event) {
  sendToWindow(mainWindow, MACRO_IPC.event, event)
  if (event.accountId) persistEventSafely(event.accountId, 'macro', event)
  if (event.status === 'failed') notifyMacro({ accountId: event.accountId, macroName: macroLibrary?.get(event.macroId)?.name, status: 'failed', error: event.error?.message || event.reason || 'Macro failed' })
}

function assertMacroPayload(value) {
  let json
  try { json = JSON.stringify(value) } catch { throw new Error('Macro payload must be JSON serializable.') }
  if (Buffer.byteLength(json === undefined ? 'null' : json, 'utf8') > MACRO_LIMITS.maxIpcPayloadBytes) throw new Error('Macro payload exceeds 256 KB.')
}
function macroValidationOptions() { const accounts = store.list(); return { accountIds: accounts.map((a) => a.id), editionOf: (id) => accounts.find((a) => a.id === id)?.edition } }
function macroListResult() {
  const validation = {}
  for (const macro of macroLibrary.list()) validation[macro.id] = macroModel.validateMacro(macro, macroValidationOptions())
  return { macros: macroLibrary.list(), validation }
}
function writeBackV1(macro, deleted = false) {
  return writeBackMigratedMacro(store, macro, deleted)
}
function saveMacro(input) {
  assertMacroPayload(input)
  const previous = macroLibrary.get(input?.id)
  const macro = macroModel.normalizeMacro({ ...input, origin: input?.origin || previous?.origin })
  const errors = macroModel.validateMacro(macro, macroValidationOptions())
  if (errors.length) { const error = new Error(errors.map((e) => `${e.path}: ${e.message}`).join(' ')); error.validation = errors; throw error }
  writeBackV1(macro)
  macroLibrary.save(macro); macroEngine.setLibrary(macroLibrary.list()); return macro
}
function setMacroEnabled(input) {
  assertMacroPayload(input)
  const macro = macroLibrary.get(input?.macroId)
  if (!macro) throw new Error('Macro not found.')
  const updated = macroModel.normalizeMacro({ ...macro, enabled: input.enabled === true })
  const errors = macroModel.validateMacro(updated, macroValidationOptions())
  if (updated.enabled && errors.length) { const error = new Error(errors.map((e) => e.message).join(' ')); error.validation = errors; throw error }
  writeBackV1(updated); macroLibrary.save(updated); macroEngine.setLibrary(macroLibrary.list()); return updated
}
function removeMacro(id) {
  assertMacroPayload(id)
  const macro = macroLibrary.get(id); if (!macro) return false
  writeBackV1(macro, true); macroLibrary.remove(id); macroEngine.setLibrary(macroLibrary.list()); return true
}

// History persistence is best effort: a failing disk must not block live delivery or throw into bot callbacks.
const eventStorageWarnings = new Map()
function persistEventSafely(id, type, payload) {
  try { eventStore.append(id, { type, ...payload }) }
  catch (error) {
    try {
      const code = String(error?.code || 'UNKNOWN').slice(0, 32)
      const now = Date.now()
      const last = eventStorageWarnings.get(code)
      if (last !== undefined && now - last < 60_000) return
      eventStorageWarnings.set(code, now)
      // Straight to the renderer: routing this through emitBotEvent would re-enter the failing store.
      sendToWindow(mainWindow, 'bot:event', { type: 'storage-warning', id, payload: { code, message: 'Event history could not be saved.', at: now } })
    } catch {}
  }
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
    tags: [...new Set((Array.isArray(input?.tags) ? input.tags : existing?.tags || []).filter((tag) => typeof tag === 'string').map((tag) => tag.trim().slice(0, 24)).filter(Boolean))].slice(0, 10),
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

// Re-reads the current record after the server operation so concurrent edits survive and deleted profiles stay deleted.
function applyLockRelocation(id, result) {
  const updated = store.updateAccount(id, (current) => relocateLockedSlots(current, result.sourceSlot, result.targetSlot))
  if (!updated) throw new Error('Account not found.')
  bots.setItemLocks(id, updated.lockedInventorySlots)
  return publicAccount(updated)
}

function retryConfig(saved) {
  const resolved = withProxyPassword(saved)
  // Smart-proxy profiles keep the proxy already assigned to the running session.
  if (saved.proxyMode === 'smart' && assignedProxies.get(saved.id)) return { ...resolved, proxy: assignedProxies.get(saved.id) }
  return resolved
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
  const enabled = account.proxyMode === 'manual' ? proxy.enabled === true : account.proxyMode === 'smart' ? true : false
  return { ...account, proxy: { ...proxy, enabled, password } }
}

function publicAccount(account) {
  const { passwordEncrypted, password, ...proxy } = account.proxy || {}
  return { ...account, proxy: { ...proxy, hasPassword: Boolean(passwordEncrypted) } }
}
