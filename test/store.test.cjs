const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AccountStore } = require('../electron/store.cjs')

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
