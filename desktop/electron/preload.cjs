const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('afkDesk', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  saveAccount: (account) => ipcRenderer.invoke('accounts:save', account),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  reorderAccounts: (orderedIds) => ipcRenderer.invoke('accounts:reorder', orderedIds),
  connect: (id) => ipcRenderer.invoke('bot:connect', id),
  disconnect: (id) => ipcRenderer.invoke('bot:disconnect', id),
  sendChat: (id, message) => ipcRenderer.invoke('bot:chat', { id, message }),
  control: (id, control, duration) => ipcRenderer.invoke('bot:control', { id, control, duration }),
  setControlState: (id, control, active) => ipcRenderer.invoke('bot:control-state', { id, control, active }),
  look: (id, direction) => ipcRenderer.invoke('bot:look', { id, direction }),
  dropStack: (id, slot) => ipcRenderer.invoke('bot:drop-stack', { id, slot }),
  setAutoDeposit: (id, enabled) => ipcRenderer.invoke('bot:auto-deposit', { id, enabled }),
  openIsolatedLogin: (id, url, code) => ipcRenderer.invoke('auth:open-isolated', { id, url, code }),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  setUiScale: (percent) => webFrame.setZoomFactor(Math.max(0.75, Math.min(Number(percent) || 100, 125)) / 100),
  onBotEvent: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bot:event', listener)
    return () => ipcRenderer.removeListener('bot:event', listener)
  }
})
