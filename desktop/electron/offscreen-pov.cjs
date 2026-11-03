// Serialize frames so a timed-out renderer can never overlap its replacement.
function createOffscreenPov({ createWindow, snapshot, radius, timeoutMs = 5000, idleMs = 60000 }) {
  let window = null, idleTimer = null, tail = Promise.resolve(), closed = false
  function destroy() {
    clearTimeout(idleTimer); idleTimer = null
    const old = window; window = null
    if (old && !old.isDestroyed()) old.destroy()
  }
  async function frame(id, settings) {
    if (closed) return null
    clearTimeout(idleTimer); idleTimer = null
    let timer
    try {
      return await Promise.race([
        (async () => {
          if (!window || window.isDestroyed()) {
            const created = createWindow()
            window = created
            await created.loadFile(require('node:path').join(__dirname, '..', 'src', 'offscreen-pov.html'))
            if (created !== window || created.isDestroyed()) return null
          }
          const current = window
          const world = await snapshot(id, radius(settings, 'perspective', settings.povRadius))
          if (!world?.position || current !== window || current.isDestroyed()) return null
          return await current.webContents.executeJavaScript(`window.renderOffscreenPov(${JSON.stringify(world)})`)
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('POV frame timed out')), timeoutMs) })
      ])
    } catch { destroy(); return null } finally {
      clearTimeout(timer)
      if (window && !closed) idleTimer = setTimeout(destroy, idleMs)
    }
  }
  return {
    request(id, settings) {
      const result = tail.then(() => frame(id, settings))
      tail = result.catch(() => null)
      return result
    },
    close() { closed = true; destroy() }
  }
}
module.exports = { createOffscreenPov }
