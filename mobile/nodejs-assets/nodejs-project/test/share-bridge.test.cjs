'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const bridge = require('../share-bridge.cjs')
const desktop = require('../../../../desktop/electron/share-links.cjs')
const model = require('../../../../desktop/electron/macro/model.cjs')

test('profile links interoperate and redact secrets on export and preview', () => {
  const profile = { host: 'example.org', port: 25565, username: 'private', proxy: { password: 'secret' }, joinMessage: 'secret' }
  const mobileLink = bridge.exportShare('profile', profile)
  assert.equal(desktop.decode(mobileLink).data.host, 'example.org')
  const preview = bridge.previewShare(desktop.encode('profile', profile))
  assert.doesNotMatch(JSON.stringify(preview), /private|secret/)
  assert.throws(() => bridge.previewShare(desktop.encode('profile', {host: '', port: 3})))
  assert.throws(() => bridge.previewShare(desktop.encode('profile', {host: 'ok', port: 99999})))
})
test('macro links interoperate, remove text and remain disabled', () => {
  const macro = {name: 'private', trigger: {type: 'manual'}, steps: [{type: 'chat', message: 'secret'}]}
  const exported = desktop.decode(bridge.exportShare('macro', macro))
  assert.doesNotMatch(JSON.stringify(exported), /private|secret/)
  const preview = bridge.previewShare(desktop.encode('macro', desktop.macroData(macro, model)))
  assert.equal(preview.data.enabled, false)
  assert.ok(preview.errors.length)
  assert.throws(() => bridge.previewShare('invalid'))
})
