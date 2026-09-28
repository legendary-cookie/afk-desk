const test = require('node:test')
const assert = require('node:assert/strict')
const { registerTrustedHandler, restrictWindow, isMicrosoftLoginUrl } = require('../electron/ipc-security.cjs')
const { EventEmitter } = require('node:events')

test('isolated login navigation accepts Microsoft hosts, not lookalikes or custom schemes', () => {
  for (const url of ['https://microsoft.com/link', 'https://login.live.com/oauth20_authorize.srf', 'https://login.microsoftonline.com/common']) assert.equal(isMicrosoftLoginUrl(url), true)
  for (const url of ['http://login.live.com/', 'https://login.live.com.evil.example/', 'https://evil.example/?next=microsoft.com', 'javascript:alert(1)', 'https://user:password@login.live.com/', 'garbage']) assert.equal(isMicrosoftLoginUrl(url), false)
})

test('privileged handlers accept only the application main frame', () => {
  const handlers = new Map()
  const ipc = { handle: (name, handler) => handlers.set(name, handler) }
  const frame = { url: 'file:///app/index.html' }
  const sender = { mainFrame: frame }
  const window = { webContents: sender, isDestroyed: () => false }
  let calls = 0
  registerTrustedHandler(ipc, () => window, 'file:///app/index.html', 'save', () => ++calls)
  const handler = handlers.get('save')
  assert.equal(handler({ sender, senderFrame: frame }), 1)
  for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: { url: frame.url } }, {}]) {
    assert.throws(() => handler(event), /Untrusted/)
  }
  frame.url = 'https://example.com/'
  assert.throws(() => handler({ sender, senderFrame: frame }), /Untrusted/)
  assert.equal(calls, 1)
})

test('application windows deny navigation, popups and permission requests', () => {
  const contents = new EventEmitter()
  let popup, request, check
  contents.setWindowOpenHandler = (handler) => { popup = handler }
  contents.session = {
    setPermissionRequestHandler: (handler) => { request = handler },
    setPermissionCheckHandler: (handler) => { check = handler }
  }
  restrictWindow({ webContents: contents })
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    let prevented = false
    contents.emit(name, { preventDefault: () => { prevented = true } }, 'https://example.com')
    assert.equal(prevented, true)
  }
  assert.deepEqual(popup({ url: 'https://example.com' }), { action: 'deny' })
  request(null, 'camera', (allowed) => assert.equal(allowed, false))
  assert.equal(check(), false)
})
