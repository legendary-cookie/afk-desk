const test = require('node:test')
const assert = require('node:assert/strict')
const { preferredVersionForAccount, rememberedVersionState } = require('../electron/version-compatibility.cjs')

test('auto version learns the most common working version from accounts on the same server', () => {
  const target = { id: 'auto', host: 'Play.Example.com', port: 25565, version: '' }
  const accounts = [
    target,
    { id: 'one', host: 'play.example.com', port: 25565, version: '1.21.1' },
    { id: 'two', host: 'play.example.com', port: 25565, version: '1.21.1' },
    { id: 'three', host: 'play.example.com', port: 25565, lastSuccessfulVersion: '1.21.8' },
    { id: 'other-port', host: 'play.example.com', port: 25566, version: '1.20.4' }
  ]
  assert.equal(preferredVersionForAccount(target, accounts), '1.21.1')
})

test('explicit and stable account-specific versions take priority over peer suggestions', () => {
  const peers = [{ host: 'play.example.com', port: 25565, version: '1.21.1' }]
  assert.equal(preferredVersionForAccount({ host: 'play.example.com', port: 25565, version: '1.21.8' }, peers), '1.21.8')
  assert.equal(preferredVersionForAccount({ host: 'play.example.com', port: 25565, version: '', lastSuccessfulVersion: '1.21.6', lastSuccessfulVersionStable: true }, peers), '1.21.6')
})

test('an unconfirmed lobby version does not override a proven same-server version', () => {
  const target = { id: 'auto', host: 'play.example.com', port: 25565, version: '', lastSuccessfulVersion: '1.21.11' }
  const peers = [target, { id: 'working', host: 'play.example.com', port: 25565, version: '1.21.1' }]
  assert.equal(preferredVersionForAccount(target, peers), '1.21.1')
})

test('auto version leaves fresh detection enabled when the server has no history', () => {
  assert.equal(preferredVersionForAccount({ id: 'new', host: 'new.example.com', port: 25565, version: '' }, []), '')
})

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
