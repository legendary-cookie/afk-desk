const { app, BrowserWindow, ipcMain, shell, safeStorage, Notification, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const smokeTest = process.argv.includes('--smoke-test')
if (smokeTest) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-release-smoke-')))
const { pathToFileURL } = require('node:url')
const { AppCore } = require('../core/app-core.cjs')
const { createElectronSecretBox } = require('../core/secrets.cjs')
const { registerTrustedHandler, restrictWindow, isMicrosoftLoginUrl } = require('./ipc-security.cjs')
const { sendToWindow } = require('./window-events.cjs')
const { IPC: MACRO_IPC } = require('./macro/contract.cjs')
const { BotManager, normalizeSkinUrl } = require('./bot-manager.cjs')
const { BedrockBotManager } = require('./bedrock-bot-manager.cjs')
const { MultiEditionBotManager } = require('./multi-edition-manager.cjs')
const documentPath = path.join(__dirname, '..', 'src', 'index.html')
const documentUrl = pathToFileURL(documentPath).href

let mainWindow
let core
let storageErrorShown = false

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
  core = new AppCore({
    userDataPath: app.getPath('userData'),
    secretBox: createElectronSecretBox(safeStorage),
    BotManager,
    normalizeSkinUrl,
    BedrockBotManager,
    MultiEditionBotManager,
    timers: { setTimeout, clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval },
    // AppCore emits UI events such as ('bot:event', { type: 'storage-warning' }) through emitToUi -> sendToWindow.
    emitToUi: (channel, payload) => sendToWindow(mainWindow, channel, payload),
    platform: {
      notify: ({ title, body }) => {
        try {
          if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
        } catch {}
      },
      notifyMacro: (title, body) => {
        try {
          if (Notification.isSupported()) new Notification({ title, body }).show()
        } catch {}
      },
      storageError: (error) => reportRuntimeStorageError(error),
      clearStorageError: () => { storageErrorShown = false },
      getAutoLaunch: () => app.getLoginItemSettings().openAtLogin,
      setAutoLaunch: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
      getVersion: () => app.getVersion(),
      openExternal: (url) => shell.openExternal(url),
      openIsolatedLogin: ({ id, url }) => openIsolatedLoginWindow(id, url)
    }
  })
  await core.start()
  registerIpc()
  createWindow()
  // AppCore handles startupConnectionDelay(settings, index) and profile defaults:
  // lockedInventorySlots:, autoDepositToChest: input?.autoDepositToChest === true, autoDepositRange:,
  // messageDelay: input?.messageDelay == null ? 6 : 0, environmentalMovement: input?.environmentalMovement !== false
  if (!smokeTest) core.autoConnectConfiguredAccounts()
}).catch((error) => {
  if (smokeTest) { console.error('AFK_DESK_SMOKE_FAIL', error.message); app.exit(1); return }
  dialog.showErrorBox('AFK Desk could not start', String(error?.message || error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void core?.shutdown()
})

function registerIpc() {
  const handle = (channel, callback) => registerTrustedHandler(ipcMain, () => mainWindow, documentUrl, channel, callback)
  handle('accounts:list', () => core.accounts.list())
  handle('accounts:save', (_event, input) => core.accounts.save(input))
  handle('accounts:delete', (_event, id) => core.accounts.delete(id))
  handle('accounts:duplicate-profile', (_event, id) => core.accounts.duplicate(id))
  handle('accounts:reorder', (_event, orderedIds) => core.accounts.reorder(orderedIds))
  handle('bot:connect', (_event, id) => core.bots.connect(id))
  handle('bot:disconnect', (_event, id) => core.bots.disconnect(id))
  handle('bot:chat', (_event, input) => core.bots.chat(input))
  handle('bot:complete-chat', (_event, input) => core.bots.completeChat(input))
  handle('bot:control', (_event, input) => core.bots.control(input))
  handle('bot:control-state', (_event, input) => core.bots.setControlState(input))
  handle('bot:look', (_event, input) => core.bots.look(input))
  handle('bot:look-delta', (_event, input) => core.bots.lookDelta(input))
  handle('bot:drop-stack', (_event, input) => core.bots.dropStack(input))
  handle('bot:drop-items', (_event, input) => core.bots.dropItems(input))
  handle('bot:deposit-slot', (_event, input) => core.bots.depositSlot(input))
  handle('bot:item-lock', (_event, input) => core.bots.itemLock(input))
  handle('bot:inventory-move', (_event, input) => core.bots.moveInventory(input))
  handle('bot:equip-item', (_event, input) => core.bots.equipItem(input))
  handle('bot:window-click', (_event, input) => core.bots.windowClick(input))
  handle('bot:window-close', (_event, id) => core.bots.windowClose(id))
  handle('bot:form-respond', (_event, input) => core.bots.respondForm(input))
  handle('bot:world-snapshot', (_event, input) => core.bots.worldSnapshot(input))
  handle('bot:world-action', (_event, input) => core.bots.worldAction(input))
  handle('logs:list', (_event, input) => core.logs.list(input))
  handle('logs:clear', (_event, id) => core.logs.clear(id))
  handle(MACRO_IPC.list, () => core.macros.list())
  handle(MACRO_IPC.save, (_event, input) => core.macros.save(input))
  handle(MACRO_IPC.remove, (_event, id) => core.macros.remove(id))
  handle(MACRO_IPC.setEnabled, (_event, input) => core.macros.setEnabled(input))
  handle(MACRO_IPC.run, (_event, input) => core.macros.run(input))
  handle(MACRO_IPC.stop, (_event, input) => core.macros.stop(input))
  handle(MACRO_IPC.runs, (_event, id) => core.macros.runs(id))
  handle(MACRO_IPC.importJson, (_event, json) => core.macros.importJson(json))
  handle(MACRO_IPC.exportJson, (_event, ids) => core.macros.exportJson(ids))
  handle('notify:list', () => core.notify.list())
  handle('notify:save', (_event, input) => core.notify.save(input))
  handle('notify:delete', (_event, id) => core.notify.delete(id))
  handle('notify:test', (_event, id) => core.notify.test(id))
  handle('proxy:health', () => core.proxies.health())
  handle('bot:auto-deposit', (_event, input) => core.bots.autoDeposit(input))
  handle('auth:open-isolated', (_event, input) => core.auth.openIsolated(input))
  handle('system:open-external', (_event, url) => core.system.openExternal(url))
  handle('settings:get', () => core.settings.get())
  handle('app:version', () => core.app.version()) // app.getVersion()
  handle('app:supported-versions', () => core.app.supportedVersions())
  handle('settings:save', (_event, input) => core.settings.save(input))
}

function openIsolatedLoginWindow(id, loginUrl) {
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
  return authWindow.loadURL(loginUrl)
}

function emitBotEvent(type, id, payload) {
  return core?.emitBotEvent(type, id, payload)
}

function getRuntime(id) {
  return core ? core.status(id) : { status: 'offline', detail: 'Ready to connect', logs: [] }
}

function reportRuntimeStorageError(error) {
  if (storageErrorShown) return
  storageErrorShown = true
  dialog.showErrorBox('AFK Desk storage needs attention', String(error?.message || error))
}
