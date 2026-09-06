const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AccountStore, SettingsStore, normalizeSettings, startupConnectionDelay } = require('../electron/store.cjs')
const betaDefaults = {
  notificationsEnabled: false, workspaceDesign: 'hybrid', colorTheme: 'obsidian',
  povRefreshMs: 1500, povFrameRate: 30, povRadius: 6, povColumns: 3,
  povMaxFeeds: 9, povViewMode: 'perspective', povShowHud: true
}

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

  assert.deepEqual(store.get(), { ...betaDefaults, staggerStartupConnections: true, startupConnectionDelay: 3, uiScale: 100, sidePanelWidth: 300, inventoryHeight: 220, macros: [] })
  assert.deepEqual(store.save({ staggerStartupConnections: false, startupConnectionDelay: 12 }), {
    ...betaDefaults,
    staggerStartupConnections: false,
    startupConnectionDelay: 12,
    uiScale: 100,
    sidePanelWidth: 300,
    inventoryHeight: 220,
    macros: []
  })
  assert.deepEqual(store.get(), { ...betaDefaults, staggerStartupConnections: false, startupConnectionDelay: 12, uiScale: 100, sidePanelWidth: 300, inventoryHeight: 220, macros: [] })
  assert.deepEqual(normalizeSettings({ startupConnectionDelay: 9999 }), { ...betaDefaults, staggerStartupConnections: true, startupConnectionDelay: 300, uiScale: 100, sidePanelWidth: 300, inventoryHeight: 220, macros: [] })
  assert.equal(startupConnectionDelay({ staggerStartupConnections: true, startupConnectionDelay: 5 }, 2), 10_700)
  assert.equal(startupConnectionDelay({ staggerStartupConnections: false, startupConnectionDelay: 5 }, 2), 700)
})

test('SettingsStore bounds persistent internal panel sizes', () => {
  const largeSide = normalizeSettings({ sidePanelWidth: 9999, inventoryHeight: 10 })
  assert.deepEqual({ sidePanelWidth: largeSide.sidePanelWidth, inventoryHeight: largeSide.inventoryHeight }, { sidePanelWidth: 520, inventoryHeight: 120 })
  const largeInventory = normalizeSettings({ sidePanelWidth: 120, inventoryHeight: 9999 })
  assert.deepEqual({ sidePanelWidth: largeInventory.sidePanelWidth, inventoryHeight: largeInventory.inventoryHeight }, { sidePanelWidth: 240, inventoryHeight: 360 })
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

for (const raw of ['{broken', '{}', 'null', '[null]', '[{"label":"missing id"}]', '[{"id":"one"},{"id":"one"}]']) {
  test(`AccountStore preserves invalid existing data: ${raw}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-invalid-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const store = new AccountStore(directory)
    fs.writeFileSync(store.file, raw)
    for (const action of [() => store.list(), () => store.save({ id: 'new' }), () => store.delete('one'), () => store.reorder(['one']), () => store.write([])]) {
      assert.throws(action, /accounts\.json.*preserved.*restore/i)
      assert.equal(fs.readFileSync(store.file, 'utf8'), raw)
    }
  })
}

for (const raw of ['{broken', '[]', 'null', 'true', '42']) {
  test(`SettingsStore preserves invalid existing data: ${raw}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-invalid-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const store = new SettingsStore(directory)
    fs.writeFileSync(store.file, raw)
    for (const action of [() => store.get(), () => store.save({ uiScale: 90 })]) {
      assert.throws(action, /settings\.json.*preserved.*restore/i)
      assert.equal(fs.readFileSync(store.file, 'utf8'), raw)
    }
  })
}

test('AccountStore preserves legacy timestamp IDs and unknown account fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-legacy-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AccountStore(directory)
  const account = { id: '1725000000000', futureField: { nested: true }, version: 'auto' }
  store.save(account)
  assert.deepEqual(store.list(), [account])
  assert.throws(() => store.save({ label: 'invalid' }), /account/i)
  assert.deepEqual(store.list(), [account])
})

test('Stores resume after explicit external repair without caching a failed load', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-repair-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const accounts = new AccountStore(directory)
  const settings = new SettingsStore(directory)
  for (const store of [accounts, settings]) fs.writeFileSync(store.file, '{broken')
  assert.throws(() => accounts.list(), { code: 'AFKDESK_STORAGE_UNREADABLE' })
  assert.throws(() => settings.get(), { code: 'AFKDESK_STORAGE_UNREADABLE' })
  fs.writeFileSync(accounts.file, '[{"id":"restored"}]')
  fs.writeFileSync(settings.file, '{"uiScale":90}')
  accounts.save({ id: 'second' })
  assert.deepEqual(accounts.list().map((account) => account.id), ['restored', 'second'])
  assert.equal(settings.get().uiScale, 90)
  assert.throws(() => settings.save(null), /Settings must be an object/)
  assert.equal(fs.readFileSync(settings.file, 'utf8'), '{"uiScale":90}')
  assert.equal(settings.save({ uiScale: 95 }).uiScale, 95)
})

test('Read errors other than missing files never become first-run defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-read-error-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const accounts = new AccountStore(directory)
  const settings = new SettingsStore(directory)
  for (const store of [accounts, settings]) fs.mkdirSync(store.file)
  assert.throws(() => accounts.save({ id: 'new' }), { code: 'AFKDESK_STORAGE_UNREADABLE' })
  assert.throws(() => settings.save({}), { code: 'AFKDESK_STORAGE_UNREADABLE' })
  for (const store of [accounts, settings]) assert.equal(fs.statSync(store.file).isDirectory(), true)
})
