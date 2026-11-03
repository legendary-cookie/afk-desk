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

test('all contract definitions describe their parameters', () => {
  for (const definitions of [contract.TRIGGER_TYPES, contract.STEP_TYPES, contract.CONDITION_METADATA]) {
    for (const [type, spec] of Object.entries(definitions)) {
      assert.ok(spec.params && typeof spec.params === 'object', type)
      for (const [key, field] of Object.entries(spec.params)) {
        assert.ok(field.type && field.label && typeof field.required === 'boolean', `${type}.${key}`)
        assert.ok('default' in field, `${type}.${key} default`)
      }
    }
  }
})

test('rendering schema forms leaves every template macro unchanged', () => {
  const { createSchemaFields } = require('../src/macro-editor.js')
  const oldDocument = global.document
  global.document = { createElement(tag) { return { tag, children: [], append(...nodes) { this.children.push(...nodes) }, setAttribute() {}, addEventListener() {} } } }
  try {
    function visitCondition(value) {
      if (!value) return
      createSchemaFields(contract.CONDITION_METADATA[value.type].params, value, () => { throw Error('render changed data') }, 0, () => ({}))
      visitCondition(value.condition)
    }
    function visitStep(step) {
      createSchemaFields(contract.STEP_TYPES[step.type].params, step, () => { throw Error('render changed data') }, 0, () => ({}))
      visitCondition(step.condition); visitCondition(step.while)
      for (const child of [...(step.then || []), ...(step.else || []), ...(step.steps || [])]) visitStep(child)
    }
    for (const [name, make] of Object.entries(TEMPLATES)) {
      const macro = make(), original = structuredClone(macro)
      createSchemaFields(contract.TRIGGER_TYPES[macro.trigger.type].params, macro.trigger, () => { throw Error('render changed data') })
      macro.steps.forEach(visitStep)
      ;(macro.stopWhen || []).forEach(visitCondition)
      assert.deepEqual(parseDraft(serializeDraft(macro)), original, name)
    }
  } finally { global.document = oldDocument }
})
