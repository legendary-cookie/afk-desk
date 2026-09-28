const test = require('node:test')
const assert = require('node:assert/strict')
const { rememberedVersionState } = require('../electron/version-compatibility.cjs')

test('clearing an explicit version also clears its stale remembered auto-version state', () => {
  assert.deepEqual(
    rememberedVersionState('', {}, { version: '1.21.1', lastSuccessfulVersion: '1.21.1', lastSuccessfulVersionStable: true }),
    { lastSuccessfulVersion: '', lastSuccessfulVersionStable: false }
  )
})

test('editing other fields in Auto mode preserves a stable learned version', () => {
  assert.deepEqual(
    rememberedVersionState('', {}, { version: '', lastSuccessfulVersion: '1.21.8', lastSuccessfulVersionStable: true }),
    { lastSuccessfulVersion: '1.21.8', lastSuccessfulVersionStable: true }
  )
})
