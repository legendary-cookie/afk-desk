const test = require('node:test')
const assert = require('node:assert/strict')
const { validateCommand, isRequestId } = require('../bridge-command.cjs')

test('bridge command validation rejects malformed envelopes inside the handler boundary', () => {
  for (const value of [null, 1, 'command', [], {}, { requestId: 1 }, { action: 'chat', requestId: '' }, { action: 'chat', requestId: 0 }, { action: 'chat', requestId: -3 }, { action: 'chat', requestId: 1.5 }, { action: 'chat', requestId: {} }, { action: '', requestId: 1 }]) {
    assert.throws(() => validateCommand(value), /Engine command/)
  }
})

test('bridge command validation accepts the numeric requestId the React Native app actually sends', () => {
  // App.tsx engineCommand: const requestId = ++requestSequence
  for (let requestSequence = 0; requestSequence < 3;) {
    const command = { requestId: ++requestSequence, action: 'chat', accountId: 'account-1', value: 'hi' }
    assert.equal(validateCommand(command), command)
  }
  const stringId = { action: 'chat', requestId: 'request-1' }
  assert.equal(validateCommand(stringId), stringId)
  assert.equal(isRequestId(42), true)
  assert.equal(isRequestId('x'), true)
  assert.equal(isRequestId(null), false)
})
