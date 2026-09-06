const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { profilePath, validateProfileId } = require('../electron/profile-path.cjs')

test('profile folders preserve legacy IDs but reject traversal and Windows aliases', () => {
  const root = path.resolve('profiles')
  for (const id of ['saved-account', '1723456-abcd', 'identity-1234', 'a.b']) {
    assert.equal(profilePath(root, id), path.join(root, id))
  }
  for (const id of ['../outside', '..', '.', 'a/b', 'a\\b', 'C:\\temp', 'x:stream', 'CON', 'nul.txt', 'x.', '', null, {}, ' a']) {
    assert.throws(() => profilePath(root, id), /profile identifier/i)
  }
  assert.equal(validateProfileId('existing_id'), 'existing_id')
})
