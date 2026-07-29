const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('desktop UI exposes cancellable account setup, settings, proxy, startup, and inventory controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.equal((html.match(/formnovalidate/g) || []).length, 2)
  for (const id of [
    'open-settings', 'start-with-windows', 'connect-on-startup', 'proxy-enabled', 'proxy-type',
    'proxy-host', 'proxy-port', 'proxy-username', 'proxy-password', 'detail-health',
    'detail-coordinates', 'inventory-grid'
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /id="proxy-password" type="password"/)
})
