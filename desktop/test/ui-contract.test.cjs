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
    'detail-coordinates', 'detail-chest', 'inventory-grid', 'hold-selected', 'equip-destination', 'equip-selected', 'lock-selected', 'drop-selected', 'auto-deposit-toggle', 'auto-deposit-setting',
    'server-window-dialog', 'server-window-title', 'server-window-grid', 'close-server-window',
    'anti-afk-min-delay', 'anti-afk-max-delay', 'anti-afk-duration', 'anti-afk-look-degrees',
    'anti-afk-walk-distance', 'anti-afk-jump', 'anti-afk-look', 'anti-afk-sneak', 'anti-afk-swing',
    'anti-afk-walk', 'environmental-movement', 'stagger-startup-connections', 'startup-connection-delay'
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /id="proxy-password" type="password"/)
  assert.match(html, /id="message-delay"[^>]*value="6"/)
  assert.match(html, /id="anti-afk-duration"[^>]*step="0\.05"[^>]*value="0\.25"/)
  assert.match(html, /minecraft-items\.js/)
})

test('desktop body stays bound while the dashboard and dense regions scroll independently', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(css, /body\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s)
  assert.match(css, /\.dashboard\s*\{[^}]*grid-template-rows:[^;}]*minmax\(0,\s*1fr\)[^;}]*;[^}]*min-height:\s*680px;[^}]*height:\s*max\(100%,\s*680px\);/s)
  assert.match(css, /\.main-content\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*auto;/s)
  assert.match(css, /\.console-panel\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s)
  assert.match(css, /\.console-log\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s)
})

test('inventory and server menus use a Minecraft-style icon grid and hover tooltip', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(css, /\.minecraft-slot-grid\s*\{[^}]*repeat\(9,\s*40px\)/s)
  assert.match(css, /\.minecraft-item-icon\s*\{[^}]*minecraft-items\.png/s)
  assert.match(css, /\.minecraft-tooltip\s*\{[^}]*position:\s*fixed/s)
  assert.match(script, /createInventorySection\('Inventory'/)
  assert.match(script, /createInventorySection\('Hotbar'/)
  assert.match(script, /item\.enchants/)
  assert.match(script, /item\.lore/)
})

test('chat, controls, and inventory expose independent persistent splitters', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(html, /id="column-resizer"[^>]*role="separator"[^>]*aria-orientation="vertical"[^>]*tabindex="0"/)
  assert.match(html, /id="inventory-resizer"[^>]*role="separator"[^>]*aria-orientation="horizontal"[^>]*tabindex="0"/)
  assert.match(css, /--side-panel-width:\s*300px/)
  assert.match(css, /--inventory-height:\s*220px/)
  assert.match(html, /id="toggle-inventory"/)
  assert.doesNotMatch(html, /id="focus-chat"/)
  assert.match(script, /function toggleInventory/)
  assert.match(css, /\.column-resizer\s*\{[^}]*cursor:\s*col-resize;/s)
  assert.match(css, /\.inventory-resizer\s*\{[^}]*cursor:\s*row-resize;/s)
  assert.match(script, /function bindPanelResizers/)
  assert.match(script, /pointerdown/)
  assert.match(script, /function applyPanelLayout/)
  assert.match(script, /function savePanelLayout/)
})

test('resized panels reflow their contents and preserve enough usable height', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(css, /\.controls-column\s*\{[^}]*container-type:\s*inline-size;/s)
  assert.match(css, /@container controls \(max-width:\s*280px\)/)
  assert.match(css, /@container controls \(max-width:\s*250px\)/)
  assert.match(css, /@container inventory \(max-width:\s*680px\)/)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  assert.match(script, /function minimumInventoryHeight/)
  assert.match(script, /ResizeObserver/)
})

test('desktop branding exposes the packaged icon and installed app version', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.match(html, /id="app-version"/)
  assert.match(html, /id="settings-app-version"/)
  assert.match(html, /afk-desk-icon\.png/)
  assert.match(preload, /getAppVersion:.*app:version/)
  assert.match(main, /app:version.*app\.getVersion/)
  assert.equal(manifest.build.win.icon, 'assets/afk-desk.ico')
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'assets', 'afk-desk-icon.png')), true)
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'assets', 'afk-desk.ico')), true)
})

test('browser and remote access are absent from the desktop application', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.doesNotMatch(html, /browser-access|remote-dialog|Browser access|Tailscale/i)
  assert.doesNotMatch(script, /openRemoteDialog|remoteStatus|createRemoteGrant|enableTailscale/)
  assert.doesNotMatch(preload, /remote:|RemoteGrant|enableTailscale/)
  assert.doesNotMatch(main, /RemoteAccessServer|AccessStore|remote:/)
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'electron', 'remote')), false)
})

test('chat exposes history navigation, editable macros, and interface scaling', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  for (const id of ['macro-pad', 'macro-menu-trigger', 'manage-macros', 'macro-dialog', 'macro-editor', 'macro-rows', 'add-macro', 'save-macros', 'ui-scale']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /ArrowUp.*ArrowDown/)
  assert.match(script, /function renderMacroPad/)
  assert.match(script, /function saveMacros/)
  assert.match(preload, /setUiScale:.*setZoomFactor/)
})

test('dashboard exposes quick scaling, whole-page scrolling, and collapsible regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(html, /id="display-menu-trigger"[^>]*popovertarget="display-menu"/)
  assert.match(html, /id="quick-scale"[^>]*type="range"/)
  assert.match(html, /id="quick-scale-number"[^>]*type="number"/)
  assert.match(html, /id="reset-scale"/)
  assert.match(html, /id="console-menu-trigger"[^>]*popovertarget="console-menu"/)
  assert.match(html, /id="clear-console"/)
  assert.match(html, /id="toggle-sidebar"/)
  assert.match(html, /data-collapse-target="console-panel"/)
  assert.match(html, /data-collapse-target="details-panel"/)
  assert.match(html, /id="movement-panel"[^>]*class="[^"]*collapsed[^"]*"/)
  assert.match(html, /data-collapse-target="movement-panel"[^>]*aria-expanded="false"/)
  assert.match(html, /data-collapse-target="macro-section"/)
  assert.match(css, /\.main-content\s*\{[^}]*overflow:\s*auto/s)
  assert.match(css, /\.collapsible\.collapsed/)
  assert.match(script, /function previewQuickScale/)
  assert.match(script, /function saveQuickScale/)
  assert.match(script, /function toggleSection/)
  assert.match(script, /function toggleSidebar/)
  assert.doesNotMatch(html, /id="focus-chat"/)
  assert.doesNotMatch(html, /id="move-selected"/)
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
  assert.match(preload, /setItemLock:.*bot:item-lock/)
  assert.match(preload, /moveInventorySlot:.*bot:inventory-move/)
  assert.match(preload, /equipInventoryItem:.*bot:equip-item/)
  assert.match(preload, /clickWindowSlot:.*bot:window-click/)
  assert.match(preload, /closeServerWindow:.*bot:window-close/)
  assert.match(main, /lockedInventorySlots:/)
  assert.match(main, /autoDepositToChest:\s*input\?\.autoDepositToChest === true/)
  assert.match(main, /messageDelay:.*\? 6 :/)
  assert.match(main, /environmentalMovement:\s*input\?\.environmentalMovement !== false/)
  assert.match(main, /startupConnectionDelay\(settings, index\)/)
})

test('desktop movement supports held buttons and physical WASD plus Space controls', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  assert.match(script, /pointerdown/)
  assert.match(script, /pointerup/)
  assert.match(script, /keydown/)
  assert.match(script, /keyup/)
  for (const mapping of ["KeyW: 'forward'", "KeyA: 'left'", "KeyS: 'back'", "KeyD: 'right'", "Space: 'jump'"]) {
    assert.match(script, new RegExp(mapping.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(preload, /setControlState:.*bot:control-state/)
  assert.match(main, /bot:control-state.*setControlState/)
})
