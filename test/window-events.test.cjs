const test = require('node:test')
const assert = require('node:assert/strict')
const { sendToWindow } = require('../electron/window-events.cjs')

test('does not emit bot events after the Electron window is destroyed', () => {
  let sent = false
  const destroyedWindow = {
    isDestroyed: () => true,
    webContents: { isDestroyed: () => true, send: () => { sent = true } }
  }
  assert.equal(sendToWindow(destroyedWindow, 'bot:event', {}), false)
  assert.equal(sent, false)

  const activeWindow = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: () => { sent = true } }
  }
  assert.equal(sendToWindow(activeWindow, 'bot:event', {}), true)
  assert.equal(sent, true)
})
