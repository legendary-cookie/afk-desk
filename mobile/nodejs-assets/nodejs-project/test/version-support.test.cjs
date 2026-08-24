const test = require('node:test')
const assert = require('node:assert/strict')
const protocol = require('minecraft-protocol')
const { supportedVersions, normalizeVersionSelection } = require('../version-support.cjs')

test('Android advertises and validates every version supported by its embedded protocol engine', () => {
  assert.deepEqual(supportedVersions(), [...protocol.supportedVersions].reverse())
  for (const version of protocol.supportedVersions) assert.equal(normalizeVersionSelection(version), version)
  assert.equal(normalizeVersionSelection('Automatic'), '')
  assert.throws(() => normalizeVersionSelection('1.21.7'), /not supported/)
})
