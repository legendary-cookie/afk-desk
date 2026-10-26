'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
test('AppCore module can be loaded when electron imports are forbidden', () => {
  const filename = path.join(__dirname, '../core/app-core.cjs'), realRequire = createRequire(filename)
  const module = { exports: {} }
  const wrapper = new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))
  wrapper((name) => { if (name === 'electron') throw new Error('electron forbidden'); return realRequire(name) }, module, module.exports)
  assert.equal(typeof module.exports.AppCore, 'function')
})
test('AppCore creates stores without loading Electron', (t) => {
  const { AppCore } = require('../core/app-core.cjs')
  const userDataPath = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'afk-core-')); t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const core = new AppCore({ userDataPath, secretBox: { available: () => true, encrypt: String, decrypt: String } })
  assert.deepEqual(core.accounts.list(), [])
  assert.equal(typeof core.start, 'function'); assert.equal(typeof core.shutdown, 'function')
})
test('main keeps the original IPC channel set', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  const fixed = ['accounts:list','accounts:save','accounts:delete','accounts:duplicate-profile','accounts:reorder','bot:connect','bot:disconnect','bot:chat','bot:complete-chat','bot:control','bot:control-state','bot:look','bot:look-delta','bot:drop-stack','bot:drop-items','bot:deposit-slot','bot:item-lock','bot:inventory-move','bot:equip-item','bot:window-click','bot:window-close','bot:world-snapshot','bot:world-action','logs:list','logs:clear','macros:list','macros:save','macros:delete','macros:set-enabled','macros:run','macros:stop','macros:runs','macros:import','macros:export','notify:list','notify:save','notify:delete','notify:test','proxy:health','bot:auto-deposit','auth:open-isolated','system:open-external','settings:get','app:version','app:supported-versions','settings:save','macro-run']
  const actual = [...source.matchAll(/handle\('([^']+)'/g)].map((m) => m[1])
  const macroChannels = Object.values(require('../electron/macro/contract.cjs').IPC)
  assert.deepEqual([...actual, ...macroChannels].sort(), fixed.sort())
})
