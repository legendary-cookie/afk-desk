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
    'detail-coordinates', 'detail-chest', 'inventory-grid', 'drop-selected', 'auto-deposit-toggle', 'auto-deposit-setting'
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /id="proxy-password" type="password"/)
  assert.match(html, /id="message-delay"[^>]*value="5"/)
})

test('desktop console has a fixed viewport and scrolls messages internally', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(css, /\.console-panel\s*\{[^}]*height:\s*560px;[^}]*min-height:\s*0;/s)
  assert.match(css, /\.console-log\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s)
})

test('desktop bridge exposes inventory actions and accounts default automatic deposits off', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(preload, /dropStack:.*bot:drop-stack/)
  assert.match(preload, /setAutoDeposit:.*bot:auto-deposit/)
  assert.match(main, /autoDepositToChest:\s*input\?\.autoDepositToChest === true/)
  assert.match(main, /messageDelay:.*\? 5 :/)
})
