const test = require('node:test')
const assert = require('node:assert/strict')
const contract = require('../electron/macro/contract.cjs')

test('macro contract enumerations are frozen and internally consistent', () => {
  for (const key of ['LIMITS', 'TRIGGER_TYPES', 'STEP_TYPES', 'ENGINE_STEP_TYPES', 'CONDITION_TYPES', 'RUN_STATUSES', 'ERROR_CODES', 'FACADE_METHODS', 'INPUTS', 'IPC']) {
    assert.ok(Object.isFrozen(contract[key]), key)
  }
  for (const type of contract.ENGINE_STEP_TYPES) assert.ok(contract.STEP_TYPES[type], type)
  for (const [name, spec] of Object.entries({ ...contract.TRIGGER_TYPES, ...contract.STEP_TYPES })) {
    assert.ok(spec.editions.length > 0 && spec.editions.every((e) => e === 'java' || e === 'bedrock'), name)
  }
  // Every facade-executed step type has a facade method of the same name.
  for (const type of Object.keys(contract.STEP_TYPES)) {
    if (!contract.ENGINE_STEP_TYPES.includes(type)) assert.ok(contract.FACADE_METHODS.includes(type), `facade method for ${type}`)
  }
  assert.equal(new Set(Object.values(contract.IPC)).size, Object.values(contract.IPC).length)
})

test('MacroActionError keeps known codes and coerces unknown ones to INVALID', () => {
  assert.equal(new contract.MacroActionError('LOCKED_SLOT', 'x').code, 'LOCKED_SLOT')
  assert.equal(new contract.MacroActionError('NOPE', 'x').code, 'INVALID')
  assert.ok(new contract.MacroActionError('OFFLINE', 'x') instanceof Error)
})

test('assertFacade names every missing method', () => {
  assert.throws(() => contract.assertFacade({ chat() {} }), /missing: sessionId, state, notify/)
  const full = Object.fromEntries(contract.FACADE_METHODS.map((name) => [name, () => {}]))
  assert.equal(contract.assertFacade(full), full)
})
