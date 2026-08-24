const test = require('node:test')
const assert = require('node:assert/strict')
const protocol = require('minecraft-protocol')
const { supportedVersions, normalizeVersionSelection } = require('../version-support.cjs')

test('Android advertises and validates every version supported by its embedded protocol engine', () => {
  const functionalVersions = protocol.supportedVersions.filter(version => version !== '1.7')
  assert.deepEqual(supportedVersions(), [...functionalVersions].reverse())
  for (const version of functionalVersions) assert.equal(normalizeVersionSelection(version), version)
  assert.throws(() => normalizeVersionSelection('1.7'), /not supported/)
  assert.equal(normalizeVersionSelection('Automatic'), '')
  assert.throws(() => normalizeVersionSelection('1.21.7'), /not supported/)
})
