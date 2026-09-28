const test = require('node:test')
const assert = require('node:assert/strict')

const { supportedVersions, normalizeVersionSelection, resolvePingVersion } = require('../electron/version-support.cjs')

test('version picker advertises the tested Mineflayer range, not protocol-only versions', () => {
  assert.equal(supportedVersions().length, 28)
  assert.equal(supportedVersions()[0], '1.21.11')
  assert.equal(supportedVersions().at(-1), '1.8.8')
  assert.equal(supportedVersions().includes('26.1'), false)
  assert.equal(supportedVersions().includes('1.8.8'), true)
  assert.equal(supportedVersions().includes('1.21.11'), true)
  assert.equal(supportedVersions().includes('1.7'), false)
})

test('version selection accepts Auto or an advertised engine version only', () => {
  assert.equal(normalizeVersionSelection(''), '')
  assert.equal(normalizeVersionSelection('auto'), '')
  assert.equal(normalizeVersionSelection(' 1.21.8 '), '1.21.8')
  assert.throws(() => normalizeVersionSelection('1.7'), /not supported/)
  assert.throws(() => normalizeVersionSelection('1.21.7'), /not supported/)
})

test('server ping protocols resolve to the matching supported game version', () => {
  assert.equal(resolvePingVersion({ version: { name: 'Velocity 1.8-1.21.11', protocol: 774 } }), '1.21.11')
  assert.equal(resolvePingVersion({ version: { name: 'Paper 1.20.4', protocol: 765 } }), '1.20.4')
  assert.equal(resolvePingVersion({ version: { name: 'Proxy supports 1.21.11', protocol: 765 } }), '1.20.4')
})
