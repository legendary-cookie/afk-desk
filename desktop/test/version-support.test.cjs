const test = require('node:test')
const assert = require('node:assert/strict')
const protocol = require('minecraft-protocol')

const { supportedVersions, normalizeVersionSelection, resolvePingVersion } = require('../electron/version-support.cjs')

test('version picker advertises every protocol supported by the installed engine', () => {
  assert.deepEqual(supportedVersions(), [...protocol.supportedVersions].reverse())
  assert.equal(supportedVersions().includes('1.8.8'), true)
  assert.equal(supportedVersions().includes('1.21.11'), true)
})

test('version selection accepts Auto or an advertised engine version only', () => {
  assert.equal(normalizeVersionSelection(''), '')
  assert.equal(normalizeVersionSelection('auto'), '')
  assert.equal(normalizeVersionSelection(' 1.21.8 '), '1.21.8')
  assert.throws(() => normalizeVersionSelection('1.21.7'), /not supported/)
})

test('server ping protocols resolve to the matching supported game version', () => {
  assert.equal(resolvePingVersion({ version: { name: 'Velocity 1.8-1.21.11', protocol: 774 } }), '1.21.11')
  assert.equal(resolvePingVersion({ version: { name: 'Paper 1.20.4', protocol: 765 } }), '1.20.4')
})
