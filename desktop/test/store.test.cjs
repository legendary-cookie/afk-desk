const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AccountStore, SettingsStore, normalizeSettings, startupConnectionDelay } = require('../electron/store.cjs')

test('AccountStore saves, updates, and deletes profiles', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AccountStore(directory)

  assert.deepEqual(store.list(), [])
  store.save({ id: 'one', label: 'First' })
  store.save({ id: 'two', label: 'Second' })
  store.save({ id: 'one', label: 'Updated' })

  assert.deepEqual(store.list(), [
    { id: 'one', label: 'Updated' },
    { id: 'two', label: 'Second' }
  ])

  assert.deepEqual(store.reorder(['two', 'two', 'missing']), [
    { id: 'two', label: 'Second' },
    { id: 'one', label: 'Updated' }
  ])
  assert.deepEqual(store.list().map((account) => account.id), ['two', 'one'])

  store.delete('one')
  assert.deepEqual(store.list(), [{ id: 'two', label: 'Second' }])
})

test('SettingsStore persists safe startup connection staggering', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new SettingsStore(directory)

  assert.deepEqual(store.get(), { staggerStartupConnections: true, startupConnectionDelay: 3, uiScale: 100, macros: [] })
  assert.deepEqual(store.save({ staggerStartupConnections: false, startupConnectionDelay: 12 }), {
    staggerStartupConnections: false,
    startupConnectionDelay: 12,
    uiScale: 100,
    macros: []
  })
  assert.deepEqual(store.get(), { staggerStartupConnections: false, startupConnectionDelay: 12, uiScale: 100, macros: [] })
  assert.deepEqual(normalizeSettings({ startupConnectionDelay: 9999 }), { staggerStartupConnections: true, startupConnectionDelay: 300, uiScale: 100, macros: [] })
  assert.equal(startupConnectionDelay({ staggerStartupConnections: true, startupConnectionDelay: 5 }, 2), 10_700)
  assert.equal(startupConnectionDelay({ staggerStartupConnections: false, startupConnectionDelay: 5 }, 2), 700)
})

test('SettingsStore normalizes UI scale and an optional editable macro pad', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-macros-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new SettingsStore(directory)
  const saved = store.save({
    uiScale: 140,
    macros: [
      { label: 'Town', message: '/server towny' },
      { label: '', message: 'hello' },
      { label: 'Blank', message: '' }
    ]
  })

  assert.equal(saved.uiScale, 125)
  assert.deepEqual(saved.macros, [
    { label: 'Town', message: '/server towny' },
    { label: 'hello', message: 'hello' }
  ])
  assert.deepEqual(store.get().macros, saved.macros)
})
