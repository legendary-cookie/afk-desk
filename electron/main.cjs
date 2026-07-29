const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')
const { AccountStore } = require('./store.cjs')
const { BotManager } = require('./bot-manager.cjs')

let mainWindow
let store
let bots

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

app.whenReady().then(() => {
  store = new AccountStore(app.getPath('userData'))
  bots = new BotManager({
    profilesPath: path.join(app.getPath('userData'), 'profiles'),
    emit: (type, id, payload) => mainWindow?.webContents.send('bot:event', { type, id, payload })
  })
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const account of store?.list() || []) bots?.disconnect(account.id)
})

function registerIpc() {
  ipcMain.handle('accounts:list', () => store.list())
  ipcMain.handle('accounts:save', (_event, input) => {
    const account = validateAccount(input)
    return store.save(account)
  })
  ipcMain.handle('accounts:delete', (_event, id) => {
    bots.disconnect(id)
    store.delete(id)
  })
  ipcMain.handle('bot:connect', (_event, id) => bots.connect(requireAccount(id)))
  ipcMain.handle('bot:disconnect', (_event, id) => bots.disconnect(id))
  ipcMain.handle('bot:chat', (_event, { id, message }) => bots.sendChat(id, message))
  ipcMain.handle('bot:control', (_event, { id, control, duration }) => bots.control(id, control, duration))
  ipcMain.handle('bot:look', (_event, { id, direction }) => bots.look(id, direction))
  ipcMain.handle('system:open-external', (_event, url) => {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported link.')
    return shell.openExternal(parsed.toString())
  })
}

function requireAccount(id) {
  const account = store.list().find((item) => item.id === id)
  if (!account) throw new Error('Account not found.')
  return account
}

function validateAccount(input) {
  const host = String(input?.host || '').trim()
  const username = String(input?.username || '').trim()
  if (!host) throw new Error('Server address is required.')
  if (!username) throw new Error('Microsoft account email is required.')
  const port = Number(input?.port) || 25565
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.')
  return {
    id: input?.id || crypto.randomUUID(),
    label: String(input?.label || username.split('@')[0] || 'Minecraft account').trim().slice(0, 50),
    username,
    host,
    port,
    version: String(input?.version || '').trim(),
    antiAfk: input?.antiAfk !== false,
    antiAfkInterval: Math.max(15, Math.min(Number(input?.antiAfkInterval) || 45, 3600))
  }
}
