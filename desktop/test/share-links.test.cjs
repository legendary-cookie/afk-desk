'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')
const share = require('../electron/share-links.cjs')
const model = require('../electron/macro/model.cjs')
const { validateAccount } = require('../core/app-core.cjs')

test('profile links round trip portable settings without credentials or identities', () => {
  const input = { host: 'example.org', port: 25565, username: 'private@example.org', identityId: 'identity', joinMessage: '/login password', proxy: { password: 'secret' }, mods: [{ modid: 'fabric', version: '1', token: 'secret' }] }
  const link = share.encode('profile', share.profileData(input))
  const decoded = share.decode(link)
  assert.equal(decoded.kind, 'profile')
  assert.equal(decoded.data.host, 'example.org')
  assert.doesNotMatch(JSON.stringify(decoded.data), /private|identity|password|secret/)
  assert.equal(validateAccount({ ...decoded.data, username: 'preview' }, null, null).host, 'example.org')
  assert.throws(() => validateAccount({ ...decoded.data, host: '', username: 'preview' }, null, null), /address/)
})

test('macro links remove identities, secrets and arbitrary text and validate on import', () => {
  const data = share.macroData({ name: 'private name', targets: { mode: 'accounts', accountIds: ['account-id'] }, trigger: { type: 'manual' }, steps: [{ type: 'chat', message: '/login secret' }], notify: { webhookRef: 'token' } }, model)
  const decoded = share.decode(share.encode('macro', data))
  assert.doesNotMatch(JSON.stringify(decoded.data), /private name|account-id|secret|token/)
  const result = model.importMacros(JSON.stringify(decoded.data), { accountIds: ['local'] })
  assert.equal(result.macros.length, 1)
  assert.equal(result.macros[0].enabled, false)
  assert.ok(result.errors.some(error => /account|message/i.test(error.message)))
})

test('decoder rejects malformed, unsupported and oversized data', () => {
  for (const input of ['', 'afkdesk://share/profile/!', 'afkdesk://share/other/abc', 'afkdesk://share/profile/abc']) assert.throws(() => share.decode(input))
  const link = object => `afkdesk://share/profile/${gzipSync(JSON.stringify(object)).toString('base64url')}`
  assert.throws(() => share.decode(link({ version: 2, data: {} })))
  assert.throws(() => share.decode(link({ version: 1, data: { x: 'x'.repeat(300000) } })))
})

test('macro shares retain validated structural choices while redacting text', () => {
  const shared = share.macroData({ trigger: { type: 'manual' }, steps: [{ type: 'control', control: 'jump', action: 'release' }, { type: 'useInventory', select: { name: 'secret' }, click: 'drop' }, { type: 'autoclick', button: 'right', cps: 1, durationSec: 1 }] }, model)
  const steps = model.normalizeMacro(shared).steps
  assert.equal(steps[0].control, 'jump')
  assert.equal(steps[0].action, 'release')
  assert.equal(steps[1].click, 'drop')
  assert.equal(steps[2].button, 'right')
  assert.doesNotMatch(JSON.stringify(shared), /secret/)
})
