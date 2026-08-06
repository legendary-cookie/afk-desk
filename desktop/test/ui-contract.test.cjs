const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('desktop UI exposes cancellable account setup, settings, proxy, startup, and inventory controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.equal((html.match(/data-close-account/g) || []).length, 2)
  for (const id of [
    'open-settings', 'start-with-windows', 'connect-on-startup', 'proxy-enabled', 'proxy-type',
    'proxy-host', 'proxy-port', 'proxy-username', 'proxy-password', 'detail-health', 'detail-environment', 'detail-water',
    'detail-coordinates', 'detail-chest', 'inventory-grid', 'drop-selected', 'auto-deposit-toggle', 'auto-deposit-setting',
    'anti-afk-min-delay', 'anti-afk-max-delay', 'anti-afk-duration', 'anti-afk-look-degrees',
    'anti-afk-walk-distance', 'anti-afk-jump', 'anti-afk-look', 'anti-afk-sneak', 'anti-afk-swing',
    'anti-afk-walk', 'environmental-movement', 'stagger-startup-connections', 'startup-connection-delay'
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /id="proxy-password" type="password"/)
  assert.match(html, /id="message-delay"[^>]*value="6"/)
  assert.match(html, /id="anti-afk-duration"[^>]*step="0\.05"[^>]*value="0\.25"/)
})

test('desktop dashboard stays viewport-bound and scrolls only bounded regions', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(css, /body\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s)
  assert.match(css, /\.dashboard\s*\{[^}]*grid-template-rows:[^;}]*minmax\(0,\s*1fr\)[^;}]*;[^}]*height:\s*100%;/s)
  assert.match(css, /\.console-panel\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s)
  assert.match(css, /\.console-log\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s)
})

test('chat exposes history navigation, editable macros, and interface scaling', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  for (const id of ['macro-pad', 'manage-macros', 'macro-editor', 'macro-rows', 'add-macro', 'save-macros', 'ui-scale']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /ArrowUp.*ArrowDown/)
  assert.match(script, /function renderMacroPad/)
  assert.match(script, /function saveMacros/)
  assert.match(preload, /setUiScale:.*setZoomFactor/)
})

test('account editor has explicit cancel controls and only its fields scroll', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.equal((html.match(/data-close-account/g) || []).length, 2)
  assert.doesNotMatch(html, /data-close-account[^>]*type="submit"/)
  assert.match(css, /#account-dialog\s*\{[^}]*overflow:\s*clip;/s)
  assert.match(css, /#account-form\s*\{[^}]*overflow:\s*hidden;/s)
  assert.match(css, /\.form-grid\s*\{[^}]*overflow-y:\s*auto;/s)
  assert.match(script, /querySelectorAll\('\[data-close-account\]'\)/)
})

test('open dialogs stay pinned to the viewport and lock page scrolling', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(css, /dialog\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s)
  assert.match(css, /dialog\s*\{[^}]*overflow:\s*clip;/s)
  assert.match(css, /body:has\(dialog\[open\]\)\s*\{[^}]*overflow:\s*hidden;/s)
  assert.match(css, /\.toggle-row\s*\{[^}]*position:\s*relative;/s)
  assert.match(css, /\.toggle-row\s*>\s*input\s*\{[^}]*width:\s*36px;[^}]*height:\s*20px;/s)
})

test('desktop bridge exposes inventory actions and accounts default automatic deposits off', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(preload, /dropStack:.*bot:drop-stack/)
  assert.match(preload, /setAutoDeposit:.*bot:auto-deposit/)
  assert.match(main, /autoDepositToChest:\s*input\?\.autoDepositToChest === true/)
  assert.match(main, /messageDelay:.*\? 6 :/)
  assert.match(main, /environmentalMovement:\s*input\?\.environmentalMovement !== false/)
  assert.match(main, /startupConnectionDelay\(settings, index\)/)
})

test('browser player state shows the closest chest coordinates', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'remote', 'public', 'index.html'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'electron', 'remote', 'public', 'app.js'), 'utf8')
  assert.match(html, /id="chest"/)
  assert.match(html, /id="water"/)
  assert.match(script, /telemetry\?\.nearestChest/)
  assert.match(script, /telemetry\?\.environment/)
})
