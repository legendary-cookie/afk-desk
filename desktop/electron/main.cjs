const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { AccountStore, SettingsStore, startupConnectionDelay } = require('./store.cjs')
const { BotManager, normalizeSkinUrl } = require('./bot-manager.cjs')
const { AccessStore } = require('./remote/access-store.cjs')
const { RemoteAccessServer } = require('./remote/server.cjs')
const { sendToWindow } = require('./window-events.cjs')
const execFileAsync = promisify(execFile)
const movementDiagnosticsEnabled = process.env.AFK_DESK_MOVEMENT_DIAGNOSTICS === '1'

let mainWindow
let store
let settingsStore
let bots
let accessStore
let remoteAccess
const runtime = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0b0e13',
    title: 'AFK Desk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
}

app.whenReady().then(async () => {
  store = new AccountStore(app.getPath('userData'))
  settingsStore = new SettingsStore(app.getPath('userData'))
  accessStore = new AccessStore(app.getPath('userData'))
  bots = new BotManager({
    profilesPath: path.join(app.getPath('userData'), 'profiles'),
    emit: emitBotEvent,
    diagnose: movementDiagnosticsEnabled
      ? (entry) => console.log(`[movement-diagnostic] ${JSON.stringify(entry)}`)
      : undefined
  })
  remoteAccess = new RemoteAccessServer({
    accessStore,
    getAccounts: () => store.list(),
    getRuntime: getRuntime,
    handleAction: handleRemoteAction
  })
  await remoteAccess.start()
  registerIpc()
  createWindow()
  autoConnectConfiguredAccounts()
  if (process.argv.includes('--smoke-test')) setTimeout(() => app.quit(), 5000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const account of store?.list() || []) bots?.disconnect(account.id)
  remoteAccess?.stop()
})

function registerIpc() {
  ipcMain.handle('accounts:list', () => store.list().map(publicAccount))
  ipcMain.handle('accounts:save', async (_event, input) => {
    const existing = store.list().find((account) => account.id === input?.id)
    const account = validateAccount(input, existing)
    const saved = store.save(account)
    if (existing && existing.autoDepositToChest !== saved.autoDepositToChest) await bots.setAutoDeposit(saved.id, saved.autoDepositToChest)
    if (existing && existing.environmentalMovement !== saved.environmentalMovement) bots.setEnvironmentalMovement(saved.id, saved.environmentalMovement)
    if (existing && antiAfkChanged(existing, saved)) bots.setAntiAfk(saved.id, saved)
    return publicAccount(saved)
  })
  ipcMain.handle('accounts:delete', (_event, id) => {
    bots.disconnect(id)
    store.delete(id)
  })
  ipcMain.handle('accounts:reorder', (_event, orderedIds) => store.reorder(orderedIds).map(publicAccount))
  ipcMain.handle('bot:connect', (_event, id) => bots.connect(requireAccount(id)))
  ipcMain.handle('bot:disconnect', (_event, id) => bots.disconnect(id))
  ipcMain.handle('bot:chat', (_event, { id, message }) => bots.sendChat(id, message))
  ipcMain.handle('bot:control', (_event, { id, control, duration }) => bots.control(id, control, duration))
  ipcMain.handle('bot:look', (_event, { id, direction }) => bots.look(id, direction))
  ipcMain.handle('bot:drop-stack', (_event, { id, slot }) => bots.dropStack(id, slot))
  ipcMain.handle('bot:auto-deposit', async (_event, { id, enabled }) => {
    const account = store.list().find((item) => item.id === id)
    if (!account) throw new Error('Account not found.')
    const updated = store.save({ ...account, autoDepositToChest: enabled === true })
    await bots.setAutoDeposit(id, updated.autoDepositToChest)
    return publicAccount(updated)
  })
  ipcMain.handle('auth:open-isolated', (_event, { id, url, code }) => openIsolatedLogin(id, url, code))
  ipcMain.handle('remote:status', () => remoteAccess.status())
  ipcMain.handle('remote:open-owner', () => shell.openExternal(remoteAccess.ownerUrl()))
  ipcMain.handle('remote:enable-tailscale', async () => {
    const { stdout, stderr } = await execFileAsync('tailscale', ['serve', '--bg', String(remoteAccess.port)], { timeout: 20_000, windowsHide: true })
    const output = `${stdout || ''}\n${stderr || ''}`.trim()
    const url = output.match(/https:\/\/[^\s]+/)?.[0]?.replace(/[.,]$/, '') || ''
    return { output: output.slice(0, 1000), url }
  })
  ipcMain.handle('remote:list-grants', () => accessStore.publicList())
  ipcMain.handle('remote:create-grant', (_event, input) => {
    const created = remoteAccess.createGrant(input || {})
    return {
      grant: created.grant,
      localUrl: `${remoteAccess.status().localUrl}/session?token=${encodeURIComponent(created.token)}`,
      sharePath: `/session?token=${encodeURIComponent(created.token)}`
    }
  })
  ipcMain.handle('remote:revoke-grant', (_event, id) => accessStore.revoke(String(id)))
  ipcMain.handle('system:open-external', (_event, url) => {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported link.')
    return shell.openExternal(parsed.toString())
  })
  ipcMain.handle('settings:get', () => ({
    startWithWindows: app.getLoginItemSettings().openAtLogin,
    ...settingsStore.get()
  }))
  ipcMain.handle('settings:save', (_event, input) => {
    const startWithWindows = input?.startWithWindows === true
    app.setLoginItemSettings({ openAtLogin: startWithWindows })
    return {
      startWithWindows: app.getLoginItemSettings().openAtLogin,
      ...settingsStore.save(input)
    }
  })
}

function autoConnectConfiguredAccounts() {
  const settings = settingsStore.get()
  store.list().filter((account) => account.connectOnStartup).forEach((account, index) => {
    setTimeout(() => {
      try { bots.connect(withProxyPassword(account)) }
      catch (error) {
        emitBotEvent('log', account.id, { kind: 'error', message: `Startup connection failed: ${error.message}`, at: Date.now() })
        emitBotEvent('status', account.id, { status: 'offline', detail: 'Startup connection failed' })
      }
    }, startupConnectionDelay(settings, index))
  })
}

function openIsolatedLogin(id, rawUrl, code) {
  requireAccount(id)
  const supplied = new URL(rawUrl || 'https://microsoft.com/link')
  if (supplied.protocol !== 'https:') throw new Error('Microsoft sign-in must use HTTPS.')
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
      if (target.protocol === 'https:') authWindow.loadURL(target.toString())
    } catch {}
    return { action: 'deny' }
  })
  authWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).protocol !== 'https:') event.preventDefault()
    } catch { event.preventDefault() }
  })
  const isolatedSession = authWindow.webContents.session
  authWindow.on('closed', () => isolatedSession.clearStorageData().catch(() => {}))
  return authWindow.loadURL(loginUrl.toString())
}

function emitBotEvent(type, id, payload) {
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
  if (type === 'identity') {
    const account = store.list().find((item) => item.id === id)
    if (account) {
      const minecraftName = normalizeMinecraftName(payload.username) || account.minecraftName || ''
      store.save({
        ...account,
        label: minecraftName || account.label,
        minecraftName,
        minecraftUuid: normalizeUuid(payload.uuid) || account.minecraftUuid || '',
        skinUrl: normalizeSkinUrl(payload.skinUrl) || account.skinUrl || ''
      })
    }
  }
  sendToWindow(mainWindow, 'bot:event', { type, id, payload })
}

function getRuntime(id) {
  return runtime.get(id) || { status: 'offline', detail: 'Ready to connect', logs: [] }
}

function handleRemoteAction(id, action, payload) {
  if (action === 'connect') return bots.connect(requireAccount(id))
  if (action === 'disconnect') return bots.disconnect(id)
  if (action === 'chat') return bots.sendChat(id, payload.message)
  if (action === 'control') return bots.control(id, payload.control, payload.duration)
  if (action === 'look') return bots.look(id, payload.direction)
  throw new Error('Unknown remote action.')
}

function requireAccount(id) {
  const account = store.list().find((item) => item.id === id)
  if (!account) throw new Error('Account not found.')
  return withProxyPassword(account)
}

function validateAccount(input, existing) {
  const host = String(input?.host || '').trim()
  const username = String(input?.username || '').trim()
  if (!host) throw new Error('Server address is required.')
  if (!username) throw new Error('Microsoft account email is required.')
  const port = Number(input?.port) || 25565
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.')
  const minecraftName = normalizeMinecraftName(input?.minecraftName)
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
    id: input?.id || crypto.randomUUID(),
    label: minecraftName || String(input?.label || username.split('@')[0] || 'Minecraft account').trim().slice(0, 50),
    username,
    host,
    port,
    version: String(input?.version || '').trim(),
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
    autoReconnectDelay: Math.max(1, Math.min(Number(input?.autoReconnectDelay) || 5, 300)),
    autoReconnectMaxAttempts: Math.max(0, Math.min(Number(input?.autoReconnectMaxAttempts) || 0, 1000)),
    connectOnStartup: input?.connectOnStartup === true,
    autoDepositToChest: input?.autoDepositToChest === true,
    proxy: validateProxy(input?.proxy, existing?.proxy),
    joinMessage: String(input?.joinMessage || '').trim().slice(0, 256),
    serverChangeMessage: String(input?.serverChangeMessage || '').trim().slice(0, 256),
    messageDelay: Math.max(0, Math.min(input?.messageDelay === '' || input?.messageDelay == null ? 5 : Number(input.messageDelay) || 0, 30))
  }
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
  return { ...account, proxy: { ...proxy, password } }
}

function publicAccount(account) {
  const { passwordEncrypted, password, ...proxy } = account.proxy || {}
  return { ...account, proxy: { ...proxy, hasPassword: Boolean(passwordEncrypted) } }
}
