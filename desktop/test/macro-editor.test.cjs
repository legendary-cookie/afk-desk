'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const contract = require('../electron/macro/contract.cjs')
const { TEMPLATES, serializeDraft, parseDraft, paletteGroups } = require('../src/macro-editor.js')

test('every example macro round trips through the JSON editor', () => {
  for (const [name, make] of Object.entries(TEMPLATES)) {
    const macro = make()
    assert.deepEqual(parseDraft(serializeDraft(macro)), macro, name)
  }
  assert.throws(() => parseDraft('[]'), /object/)
  assert.throws(() => parseDraft('{'))
})

test('contract metadata covers each trigger, step and condition and drives palette groups', () => {
  for (const definitions of [contract.TRIGGER_TYPES, contract.STEP_TYPES, contract.CONDITION_METADATA]) {
    for (const [type, spec] of Object.entries(definitions)) {
      assert.ok(spec.label && spec.category, type)
    }
  }
  assert.deepEqual(Object.keys(contract.CONDITION_METADATA).sort(), [...contract.CONDITION_TYPES].sort())
  const groups = paletteGroups(contract.STEP_TYPES)
  assert.deepEqual(groups.flatMap(group => group.types).sort(), Object.keys(contract.STEP_TYPES).sort())
  for (const group of groups) for (const type of group.types) assert.equal(contract.STEP_TYPES[type].category, group.group)
})
