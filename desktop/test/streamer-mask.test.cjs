const test = require('node:test')
const assert = require('node:assert/strict')
const { label, displayAccount, maskText } = require('../src/streamer-mask.js')
const { SettingsStore, normalizeSettings } = require('../electron/store.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const accounts = [
  { id: 'first', username: 'one@example.com', minecraftName: 'Player_1', profileName: 'My Profile' },
  { id: 'second', username: 'two@example.com', minecraftName: 'Player_12' }
]
test('labels are stable across reorder and identity changes', () => {
  assert.equal(label(accounts[0]), label({ ...accounts[0], username: 'new@example.com' }))
  assert.notEqual(label(accounts[0]), label(accounts[1]))
  assert.equal(displayAccount(accounts[0], false), 'My Profile')
  assert.equal(displayAccount(accounts[0], true), label(accounts[0]))
})
test('masks known account identities in text without masking other player names', () => {
  const text = 'PLAYER_1 met Player_12 and Player_123; one@example.com (My Profile)'
  assert.equal(maskText(text, accounts, false), text)
  assert.equal(maskText(text, accounts, true), `${label(accounts[0])} met ${label(accounts[1])} and Player_123; ${label(accounts[0])} (${label(accounts[0])})`)
  assert.equal(maskText('a.b@example.com', [{ id: 'x', username: 'a.b@example.com' }], true), label({ id: 'x' }))
})
test('streamer setting defaults off and persists as a boolean', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new SettingsStore(dir)
  assert.equal(store.get().streamerMode, false)
  assert.equal(normalizeSettings({ streamerMode: 'true' }).streamerMode, false)
  store.save({ streamerMode: true })
  assert.equal(store.get().streamerMode, true)
})
