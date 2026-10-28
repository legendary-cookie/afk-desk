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
    'server-window-dialog', 'server-window-title', 'server-window-stage', 'server-window-art', 'server-window-grid', 'close-server-window',
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
  assert.match(script, /item\.resourceIcon/)
  assert.match(script, /renderServerWindowArt/)
  assert.match(css, /\.server-window-art\s*\{[^}]*image-rendering:\s*pixelated/s)
  assert.match(css, /\.server-window-stage\.has-container-art\s*\{[^}]*--resource-art-width/s)
  assert.match(css, /\.server-window-stage\.has-container-art \.server-window-grid\s*\{[^}]*top:\s*36px[^}]*left:\s*16px[^}]*repeat\(9,\s*32px\)/s)
  assert.match(css, /\.server-window-stage\.has-container-art \.minecraft-slot\s*\{[^}]*width:\s*32px[^}]*background:\s*transparent/s)
  assert.match(script, /pixiestudios_air\$\/i/)
  assert.match(script, /opaqueCanvasBounds/)
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

test('desktop exposes supported version selection, chat completion, and Minecraft click actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(html, /<select id="version"/)
  assert.match(html, /id="chat-suggestions"/)
  assert.match(preload, /getSupportedVersions:.*app:supported-versions/)
  assert.match(preload, /completeChat:.*bot:complete-chat/)
  assert.match(main, /app:supported-versions/)
  assert.match(main, /bot:complete-chat/)
  assert.match(script, /function renderChatSuggestions/)
  assert.match(script, /function activateChatClick/)
  assert.match(script, /suggest_command/)
  assert.match(script, /run_command/)
  assert.match(script, /copy_to_clipboard/)
  assert.match(script, /open_url/)
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
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.match(preload, /dropStack:.*bot:drop-stack/)
  assert.match(preload, /setAutoDeposit:.*bot:auto-deposit/)
  assert.match(preload, /setItemLock:.*bot:item-lock/)
  assert.match(preload, /moveInventorySlot:.*bot:inventory-move/)
  assert.match(preload, /equipInventoryItem:.*bot:equip-item/)
  assert.match(preload, /clickWindowSlot:.*bot:window-click/)
  assert.match(preload, /closeServerWindow:.*bot:window-close/)
  assert.match(preload, /respondForm:.*bot:form-respond/)
  assert.match(main, /handle\('bot:form-respond'/)
  assert.match(main, /lockedInventorySlots:/)
  assert.match(main, /autoDepositToChest:\s*input\?\.autoDepositToChest === true/)
  assert.match(main, /autoDepositRange:/)
  assert.match(html, /id="auto-deposit-range"[^>]+min="1"[^>]+max="16"/)
  assert.match(html, /id="auto-deposit-mode"/)
  assert.match(html, /id="auto-deposit-interval"/)
  assert.match(html, /id="auto-deposit-full-threshold"/)
  assert.match(html, /id="server-change-retry-minutes"/)
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


test('every bot:event type the main process emits has a renderer handler', () => {
  // Review finding: main sent 'storage-warning' but the renderer silently dropped it.
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const emitted = [...main.matchAll(/'bot:event',\s*\{\s*type:\s*'([a-z-]+)'/g)].map((match) => match[1])
  assert.ok(emitted.includes('storage-warning'))
  for (const type of emitted) assert.match(script, new RegExp(`type === '${type}'`), type)
  // The warning reaches the user through the textContent-based toast, not innerHTML.
  const branch = script.slice(script.indexOf("type === 'storage-warning'"), script.indexOf("type === 'telemetry'"))
  assert.match(branch, /toast\(message, 'error'\)/)
  assert.doesNotMatch(branch, /innerHTML/)
})

test('Stage 3: every window.afkDesk and macros method called in renderer and macro-editor exists in preload.cjs', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const macroEditor = fs.readFileSync(path.join(__dirname, '..', 'src', 'macro-editor.js'), 'utf8')
  const notifyPanel = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifications-panel.js'), 'utf8')

  for (const src of [renderer, macroEditor]) {
    const directCalls = [...src.matchAll(/\bapi\.([a-zA-Z0-9_]+)\s*(?:\(|\?\.|\b)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'macros' && name !== 'notify')
    for (const method of new Set(directCalls)) {
      assert.match(preload, new RegExp(`\\b${method}\\s*:`), `Expected preload.cjs to expose api.${method}`)
    }
    const macroCalls = [...src.matchAll(/\bapi\.macros(?:\?\.)?\.([a-zA-Z0-9_]+)/g)].map((m) => m[1])
    for (const method of new Set(macroCalls)) {
      assert.match(preload, new RegExp(`\\b${method}\\s*:`), `Expected preload.cjs macros namespace to expose ${method}`)
    }
  }

  for (const channel of ['notify:list', 'notify:save', 'notify:delete', 'notify:test']) {
    assert.match(notifyPanel, new RegExp(channel))
    assert.match(main, new RegExp(`handle\\('${channel}'`), `Expected main.cjs to register ${channel}`)
  }
  assert.match(preload, /\bonMacroRun\s*:/)
})

test('Stage 3: macro-editor.js, notifications-panel.js, and renderer.js never use innerHTML or eval and index.html is CSP-safe', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const macroEditor = fs.readFileSync(path.join(__dirname, '..', 'src', 'macro-editor.js'), 'utf8')
  const notifyPanel = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifications-panel.js'), 'utf8')

  for (const [name, src] of [['renderer.js', renderer], ['macro-editor.js', macroEditor], ['notifications-panel.js', notifyPanel]]) {
    assert.doesNotMatch(src, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|\beval\s*\(|new\s+Function\b/, `${name} must not use innerHTML or eval`)
  }

  // CSP meta tag intact and no inline handlers or inline styles/scripts in index.html
  assert.match(html, /Content-Security-Policy"[^>]*script-src 'self'; style-src 'self'/)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'index.html must not contain inline on*= event attributes')
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'index.html must not contain inline style= attributes')
  assert.doesNotMatch(html, /<style\b/i, 'index.html must not contain inline <style> tags')
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.ok(scriptTags.length >= 7)
  for (const [, attrs, body] of scriptTags) {
    assert.match(attrs, /\bsrc="[^"]+"/, 'Every <script> in index.html must use an external src attribute')
    assert.equal(body.trim(), '', 'Every <script> in index.html must have an empty body')
  }
})

test('Stage 3: macro editor and notifications panel cover all contract step/trigger/condition/event types and security/accessibility rules', () => {
  const macroContract = require('../electron/macro/contract.cjs')
  const notifyContract = require('../electron/notify/contract.cjs')
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const macroEditor = fs.readFileSync(path.join(__dirname, '..', 'src', 'macro-editor.js'), 'utf8')
  const notifyPanel = fs.readFileSync(path.join(__dirname, '..', 'src', 'notifications-panel.js'), 'utf8')

  for (const stepType of Object.keys(macroContract.STEP_TYPES)) {
    assert.match(macroEditor, new RegExp(`\\b${stepType}\\s*:\\s*\\{`), `macro-editor.js missing step type ${stepType}`)
  }
  for (const triggerType of Object.keys(macroContract.TRIGGER_TYPES)) {
    assert.match(macroEditor, new RegExp(`\\b${triggerType}\\s*:\\s*\\{`), `macro-editor.js missing trigger type ${triggerType}`)
  }
  for (const condType of macroContract.CONDITION_TYPES) {
    assert.match(macroEditor, new RegExp(`value:\\s*'${condType}'`), `macro-editor.js missing condition type ${condType}`)
  }
  for (const eventKind of notifyContract.EVENT_KINDS) {
    assert.match(notifyPanel, new RegExp(`id:\\s*'${eventKind}'`), `notifications-panel.js missing event kind ${eventKind}`)
  }

  assert.match(html, /id="notify-webhook-url"[^>]*type="password"/)
  assert.match(html, /id="notify-bot-token"[^>]*type="password"/)
  assert.match(notifyPanel, /\(unchanged\)/)
  assert.match(html, /https:\/\/github\.com\/legendary-cookie\/afk-desk\/blob\/main\/docs\/user-guide\/notifications\.md/)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
})


test('every IPC channel the preload invokes is registered by main.cjs, and notify:* is exposed', () => {
  // Regression: the notifications panel shipped calling api.notify.* while preload had no notify namespace.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
  for (const channel of ['notify:list', 'notify:save', 'notify:delete', 'notify:test']) assert.ok(invoked.includes(channel), channel)
  const { IPC: MACRO_IPC } = require('../electron/macro/contract.cjs')
  const viaConstant = new Set(Object.entries(MACRO_IPC).filter(([key]) => main.includes(`MACRO_IPC.${key}`)).map(([, value]) => value))
  for (const channel of new Set(invoked)) {
    const literal = main.includes(`'${channel}'`) || main.includes(`"${channel}"`)
    assert.ok(literal || viaConstant.has(channel), `main.cjs registers ${channel}`)
  }
})

test('remote access settings section is fully configurable in desktop mode and read-only in browser mode', async () => {
  const { mountRemoteAccessSettingsUi } = require('../server/browser-bridge.js')

  function makeMockDoc() {
    function makeElement(tag) {
      return {
        tag, id: '', className: '', textContent: '', value: '', type: '', checked: false,
        readOnly: false, disabled: false, children: [], attributes: {}, listeners: {},
        append(...nodes) { this.children.push(...nodes) },
        insertBefore(node) { this.children.unshift(node) },
        replaceChildren(...nodes) { this.children = [...nodes] },
        setAttribute(k, v) { this.attributes[k] = v },
        getAttribute(k) { return this.attributes[k] },
        addEventListener(ev, fn) { this.listeners[ev] = fn },
        querySelector(sel) {
          if (sel === '.settings-body') return dialog.body
          if (sel === '.settings-about') return dialog.about
          return null
        }
      }
    }
    const openBtn = makeElement('button')
    openBtn.id = 'open-settings'
    const dialog = makeElement('dialog')
    dialog.id = 'settings-dialog'
    const body = makeElement('div')
    body.className = 'settings-body'
    const about = makeElement('div')
    about.className = 'settings-about'
    body.append(about)
    dialog.body = body
    dialog.about = about
    const elementsById = { 'open-settings': openBtn, 'settings-dialog': dialog }
    return {
      doc: { getElementById: (id) => elementsById[id] || null, createElement: makeElement },
      openBtn,
      body
    }
  }

  function findById(node, id) {
    if (node.id === id) return node
    for (const child of node.children || []) {
      const found = findById(child, id)
      if (found) return found
    }
    return null
  }

  // 1. Desktop mode: interactive and configurable
  {
    const { doc, openBtn, body } = makeMockDoc()
    const savedCalls = []
    globalThis.afkDesk = {
      isBrowser: false,
      getSettings: async () => ({
        uiScale: 100,
        remoteAccess: {
          enabled: true,
          bind: '100.85.14.94',
          port: 8787,
          allowedHosts: ['myhost.tailscale.ts.net'],
          running: true,
          interfaces: [
            { name: 'all', address: '0.0.0.0', label: 'All interfaces (0.0.0.0)' },
            { name: 'tailscale0', address: '100.85.14.94', label: '100.85.14.94 (tailscale0)' }
          ],
          tokens: [{ id: 't1', name: 'Dashboard', scope: 'admin', tokenHint: '••••abcd' }]
        }
      }),
      saveSettings: async (payload) => {
        savedCalls.push(payload)
        return payload
      }
    }

    mountRemoteAccessSettingsUi(doc, { isDesktop: true })
    await openBtn.listeners['click']?.()

    const section = body.children.find((c) => c.id === 'remote-access-settings-section')
    assert.ok(section, 'Desktop: remote-access-settings-section must exist')
    const note = section.children.find((c) => c.id === 'remote-access-desktop-only-note')
    assert.equal(note, undefined, 'Desktop: desktop-only note must not be rendered')

    const enabled = findById(section, 'remote-access-enabled')
    assert.ok(enabled, 'Desktop: #remote-access-enabled checkbox must exist')
    assert.equal(enabled.disabled, false)

    const bind = findById(section, 'remote-access-bind')
    assert.ok(bind, 'Desktop: #remote-access-bind select must exist')
    assert.equal(bind.disabled, false)
    const bindOptions = bind.children.map(o => o.value)
    assert.ok(bindOptions.includes('100.85.14.94'), 'Desktop: detected Tailscale interface must be available in bind dropdown')

    const applyBtn = findById(section, 'remote-access-apply')
    assert.ok(applyBtn, 'Desktop: apply button must exist')

    const tokenCreateBtn = findById(section, 'remote-access-token-create')
    assert.ok(tokenCreateBtn, 'Desktop: token create button must exist')
  }

  // 2. Browser mode: read-only
  {
    const { doc, openBtn, body } = makeMockDoc()
    globalThis.afkDesk = {
      isBrowser: true,
      getSettings: async () => ({
        uiScale: 100,
        remoteAccess: {
          bind: '127.0.0.1',
          port: 8787,
          running: true,
          tokens: []
        }
      })
    }

    mountRemoteAccessSettingsUi(doc, { isDesktop: false })
    await openBtn.listeners['click']?.()

    const section = body.children.find((c) => c.id === 'remote-access-settings-section')
    assert.ok(section, 'Browser: remote-access-settings-section must exist')
    const note = section.children.find((c) => c.id === 'remote-access-desktop-only-note')
    assert.ok(note, 'Browser: desktop-only note must exist')
    assert.match(note.textContent, /desktop app/i)

    const applyBtn = findById(section, 'remote-access-apply')
    assert.equal(applyBtn, null, 'Browser: apply button must not exist')
  }
})

test('collapsed sidebar has narrow 56px icon rail styles and server window titles strip PUA glyphs', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

  // Sidebar collapse narrow rail 56px
  assert.match(css, /\.app-shell\.sidebar-collapsed[^{]*\{[^}]*grid-template-columns:\s*56px minmax\(0,\s*1fr\)/)
  assert.match(css, /\.sidebar-collapsed (?:[^{]* )?\.account-avatar/)

  // Server menu title PUA glyph filter
  assert.match(renderer, /formatServerWindowTitle/)
  assert.match(renderer, /\\uE000-\\uF8FF/)
  assert.match(renderer, /'Server menu'/)

  // Server window container art z-index
  assert.match(css, /\.server-window-stage\.has-container-art \.server-window-art\s*\{[^}]*z-index:\s*2/s)
  assert.match(css, /\.server-window-stage\.has-container-art \.server-window-art\s*\{[^}]*pointer-events:\s*none/s)
})

test('macro library starter templates include at least 10 valid, safe, disabled examples and a template picker dialog', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const { TEMPLATES } = require('../src/macro-editor.js')
  const { validateMacro } = require('../electron/macro/model.cjs')

  assert.match(html, /id="macro-templates-btn"/)
  assert.match(html, /id="macro-templates-dialog"/)
  assert.match(html, /id="macro-templates-grid"/)

  const templateKeys = Object.keys(TEMPLATES)
  assert.ok(templateKeys.length >= 10, 'Expected at least 10 starter templates, got ' + templateKeys.length)
  const templates = templateKeys.map(k => TEMPLATES[k]())

  const requiredTitles = [
    'Join → /afk',
    'Anti-AFK look-around every 60 s',
    'Auto-eat when hunger < 14',
    'Inventory full → deposit to chest',
    'Kick/disconnect → notify',
    'Death → wait then /home',
    'Chat trigger "{player} has invited you" → /tpaccept',
    'Scheduled daily message',
    'Window opens "Shop" → click item by name then close',
    'Repeat sell loop with /sell all every 5 min'
  ]
  for (const title of requiredTitles) {
    const found = templates.some(t => t.name.toLowerCase().includes(title.toLowerCase().slice(0, 8)))
    assert.ok(found, 'Expected template matching ' + title)
  }

  for (const t of templates) {
    assert.equal(t.enabled, false, 'Template ' + t.name + ' must be disabled by default')
    const errors = validateMacro(t)
    assert.deepEqual(errors, [], 'Template ' + t.name + ' validation failed: ' + JSON.stringify(errors))
  }
})


test('renderer element-id list has no holes and every id exists in index.html', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const body = src.match(/const el = Object\.fromEntries\(\[([\s\S]*?)\]\.map\(\(id\)/)[1]
  assert.doesNotMatch(body, /,\s*,/, 'empty array slot in el id list (merge artifact)')
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const missing = [...body.matchAll(/'([\w-]+)'/g)].map((m) => m[1]).filter((id) => !html.includes(`id="${id}"`))
  assert.deepEqual(missing, [])
})
