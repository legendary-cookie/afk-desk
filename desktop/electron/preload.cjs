const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('afkDesk', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  saveAccount: (account) => ipcRenderer.invoke('accounts:save', account),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  reorderAccounts: (orderedIds) => ipcRenderer.invoke('accounts:reorder', orderedIds),
  duplicateProfile: (id) => ipcRenderer.invoke('accounts:duplicate-profile', id),
  connect: (id) => ipcRenderer.invoke('bot:connect', id),
  disconnect: (id) => ipcRenderer.invoke('bot:disconnect', id),
  sendChat: (id, message) => ipcRenderer.invoke('bot:chat', { id, message }),
  completeChat: (id, text) => ipcRenderer.invoke('bot:complete-chat', { id, text }),
  control: (id, control, duration) => ipcRenderer.invoke('bot:control', { id, control, duration }),
  setControlState: (id, control, active) => ipcRenderer.invoke('bot:control-state', { id, control, active }),
  look: (id, direction) => ipcRenderer.invoke('bot:look', { id, direction }),
  lookDelta: (id, yawDelta, pitchDelta) => ipcRenderer.invoke('bot:look-delta', { id, yawDelta, pitchDelta }),
  dropStack: (id, slot) => ipcRenderer.invoke('bot:drop-stack', { id, slot }),
  dropItems: (id, slot, count) => ipcRenderer.invoke('bot:drop-items', { id, slot, count }),
  depositSlot: (id, slot, count) => ipcRenderer.invoke('bot:deposit-slot', { id, slot, count }),
  setItemLock: (id, slot, locked) => ipcRenderer.invoke('bot:item-lock', { id, slot, locked }),
  moveInventorySlot: (id, sourceSlot, destinationSlot) => ipcRenderer.invoke('bot:inventory-move', { id, sourceSlot, destinationSlot }),
  equipInventoryItem: (id, slot, destination) => ipcRenderer.invoke('bot:equip-item', { id, slot, destination }),
  setAutoDeposit: (id, enabled) => ipcRenderer.invoke('bot:auto-deposit', { id, enabled }),
  clickWindowSlot: (id, slot) => ipcRenderer.invoke('bot:window-click', { id, slot }),
  closeServerWindow: (id) => ipcRenderer.invoke('bot:window-close', id),
  getWorldSnapshot: (id, radius, blockRefreshMs) => ipcRenderer.invoke('bot:world-snapshot', { id, radius, blockRefreshMs }),
  worldAction: (id, action, target) => ipcRenderer.invoke('bot:world-action', { id, action, target }),
  listLogs: (id, options = {}) => ipcRenderer.invoke('logs:list', { id, ...options }),
  clearLogs: (id) => ipcRenderer.invoke('logs:clear', id),
  runAutomation: (id, macroId) => ipcRenderer.invoke('macro:run', { id, macroId }),
  stopAutomation: (id) => ipcRenderer.invoke('macro:stop', id),
  getProxyHealth: () => ipcRenderer.invoke('proxy:health'),
  openIsolatedLogin: (id, url, code) => ipcRenderer.invoke('auth:open-isolated', { id, url, code }),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getSupportedVersions: () => ipcRenderer.invoke('app:supported-versions'),
  setUiScale: (percent) => webFrame.setZoomFactor(Math.max(0.75, Math.min(Number(percent) || 100, 125)) / 100),
  onBotEvent: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bot:event', listener)
    return () => ipcRenderer.removeListener('bot:event', listener)
  }
})
