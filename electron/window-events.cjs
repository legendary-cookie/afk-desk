function sendToWindow(window, channel, payload) {
  if (!window || window.isDestroyed?.() || !window.webContents || window.webContents.isDestroyed?.()) return false
  window.webContents.send(channel, payload)
  return true
}

module.exports = { sendToWindow }
