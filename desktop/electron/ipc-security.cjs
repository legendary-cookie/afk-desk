function registerTrustedHandler(ipc, getWindow, documentUrl, channel, handler) {
  ipc.handle(channel, (event, ...args) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event?.sender !== window.webContents ||
        !event.senderFrame || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== documentUrl) {
      throw new Error('Untrusted application request.')
    }
    return handler(event, ...args)
  })
}

function restrictWindow(window) {
  const contents = window.webContents
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    contents.on(name, (event) => event.preventDefault())
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
}

function isMicrosoftLoginUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['microsoft.com', 'live.com', 'microsoftonline.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch { return false }
}

module.exports = { registerTrustedHandler, restrictWindow, isMicrosoftLoginUrl }
