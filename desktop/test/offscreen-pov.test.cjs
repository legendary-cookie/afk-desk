const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOffscreenPov } = require('../electron/offscreen-pov.cjs')

function harness(options = {}) {
  const windows = [], calls = [], pending = []
  const service = createOffscreenPov({
    createWindow() {
      const win = { dead: false, isDestroyed() { return this.dead }, destroy() { this.dead = true }, loadFile: async () => {}, webContents: { executeJavaScript(code) { calls.push(code); return new Promise(resolve => pending.push(resolve)) } } }
      windows.push(win); return win
    },
    snapshot: id => ({ position: { x: 1, y: 2, z: 3 }, id }), radius: () => 16,
    ...options
  })
  return { service, windows, calls, pending }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('frames are serialized and reuse the window until idle', async () => {
  const h = harness({ idleMs: 20 })
  const a = h.service.request('a', {}), b = h.service.request('b', {})
  await tick(); assert.equal(h.calls.length, 1)
  h.pending.shift()('first'); assert.equal(await a, 'first')
  await tick(); assert.equal(h.calls.length, 2); assert.equal(h.windows.length, 1)
  h.pending.shift()('second'); assert.equal(await b, 'second')
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(h.windows[0].dead, true); h.service.close()
})

test('timeout destroys the window and lets the next request proceed', async () => {
  const h = harness({ timeoutMs: 20 })
  const a = h.service.request('a', {}), b = h.service.request('b', {})
  assert.equal(await a, null)
  await tick(); assert.equal(h.windows.length, 2); assert.equal(h.windows[0].dead, true)
  h.pending[1]('second'); assert.equal(await b, 'second')
  h.service.close(); assert.equal(h.windows[1].dead, true)
})
