const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('afkDesk', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  saveAccount: (account) => ipcRenderer.invoke('accounts:save', account),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  connect: (id) => ipcRenderer.invoke('bot:connect', id),
  disconnect: (id) => ipcRenderer.invoke('bot:disconnect', id),
  sendChat: (id, message) => ipcRenderer.invoke('bot:chat', { id, message }),
  control: (id, control, duration) => ipcRenderer.invoke('bot:control', { id, control, duration }),
  look: (id, direction) => ipcRenderer.invoke('bot:look', { id, direction }),
  openIsolatedLogin: (id, url, code) => ipcRenderer.invoke('auth:open-isolated', { id, url, code }),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  openRemoteDashboard: () => ipcRenderer.invoke('remote:open-owner'),
  enableTailscale: () => ipcRenderer.invoke('remote:enable-tailscale'),
  listRemoteGrants: () => ipcRenderer.invoke('remote:list-grants'),
  createRemoteGrant: (input) => ipcRenderer.invoke('remote:create-grant', input),
  revokeRemoteGrant: (id) => ipcRenderer.invoke('remote:revoke-grant', id),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  onBotEvent: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bot:event', listener)
    return () => ipcRenderer.removeListener('bot:event', listener)
  }
})
