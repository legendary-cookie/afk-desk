const {test} = require('node:test')
const assert = require('node:assert/strict')
const {maskNames, addRecent} = require('../../../mobile-ui-logic.cjs')
test('streamer mask handles case, regex characters and longer overlapping names', () => {
  const accounts = [{username: 'a+b@example.com', minecraftName: 'Alex'}, {username: 'AlexLong'}]
  assert.equal(maskNames('A+B@example.com AlexLong alex', accounts, true), 'Account 1 Account 2 Account 1')
  assert.equal(maskNames('Alex', accounts, false), 'Alex')
})
test('recent messages are unique, newest first and bounded', () => {
  assert.deepEqual(addRecent(['a', 'b'], 'b'), ['b', 'a'])
  assert.equal(addRecent(Array.from({length: 20}, (_, i) => String(i)), 'new').length, 20)
})
