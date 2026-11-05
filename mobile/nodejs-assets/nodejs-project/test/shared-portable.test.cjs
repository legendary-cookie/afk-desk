'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('React Native shared modules and packaged engine copies stay identical', () => {
  const root = path.resolve(__dirname, '../../..')
  for (const file of ['linked-profiles.cjs', 'macro/graph-contract.cjs', 'macro/graph-model.cjs', 'macro/graph-interpreter.cjs', 'macro/graph-edit.cjs', 'macro/contract.cjs', 'macro/safe-regex.cjs']) {
    assert.equal(fs.readFileSync(path.join(root, 'shared', file), 'utf8'), fs.readFileSync(path.join(__dirname, '../shared', file), 'utf8'), file)
  }
  assert.equal(require('../../../macro-library.cjs').storeGraph instanceof Function, true)
})
