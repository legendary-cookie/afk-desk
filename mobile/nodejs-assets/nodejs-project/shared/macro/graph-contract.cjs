'use strict'

const { TRIGGER_TYPES, STEP_TYPES } = require('./contract.cjs')
const control = { type: 'control' }
const valueType = type => ['number', 'string', 'item', 'entity', 'position'].includes(type) ? type : 'any'
const inputsFor = params => Object.fromEntries(Object.entries(params).map(([key, field]) => [key, { type: valueType(field.type), required: !!field.required }]))
const NODE_KINDS = Object.create(null)
for (const [name, spec] of Object.entries(TRIGGER_TYPES)) {
  NODE_KINDS[`trigger.${name}`] = { label: spec.label, category: 'Triggers', params: spec.params, inputs: inputsFor(spec.params), outputs: { out: control } }
}
for (const [name, spec] of Object.entries(STEP_TYPES)) {
  const outputs = name === 'if' ? { true: control, false: control, out: control } : name === 'repeat' ? { each: control, done: control } : { out: control }
  NODE_KINDS[name] = { label: spec.label, category: spec.category, params: spec.params, inputs: { in: control, ...inputsFor(spec.params) }, outputs }
}
const additions = {
  switch: ['Flow', { in: control, value: { type: 'any', required: true } }, { case0: control, case1: control, case2: control, case3: control, default: control, out: control }],
  while: ['Flow', { in: control, condition: { type: 'any', required: true } }, { each: control, done: control }],
  forEach: ['Flow', { in: control, items: { type: 'any', required: true } }, { each: control, done: control, item: { type: 'any' } }],
  waitUntil: ['Flow', { in: control, condition: { type: 'any', required: true } }, { out: control }],
  parallel: ['Flow', { in: control }, { out: control }], merge: ['Flow', { in: control }, { out: control }],
  tryCatch: ['Flow', { in: control }, { try: control, out: control, error: control }],
  inventoryCount: ['Data', { name: { type: 'string' } }, { value: { type: 'number' } }],
  entityCount: ['Data', {}, { value: { type: 'number' } }], nearestEntity: ['Data', {}, { value: { type: 'entity' } }],
  position: ['Data', {}, { value: { type: 'position' } }], health: ['Data', {}, { value: { type: 'number' } }], food: ['Data', {}, { value: { type: 'number' } }],
  regexExtract: ['Data', { text: { type: 'string', required: true }, pattern: { type: 'string', required: true } }, { value: { type: 'string' } }],
  math: ['Data', { a: { type: 'number', required: true }, b: { type: 'number', required: true } }, { value: { type: 'number' } }],
  compare: ['Data', { a: { type: 'any', required: true }, b: { type: 'any', required: true } }, { value: { type: 'any' } }],
  textFormat: ['Data', { text: { type: 'string', required: true } }, { value: { type: 'string' } }],
  getVar: ['Data', { variable: { type: 'string', required: true } }, { value: { type: 'any' } }], random: ['Data', {}, { value: { type: 'number' } }]
}
for (const [kind, [category, inputs, outputs]] of Object.entries(additions)) {
  const params = Object.fromEntries(Object.entries(inputs).filter(([, p]) => p.type !== 'control').map(([name, p]) => [name, { ...p, label: name }]))
  NODE_KINDS[kind] = { label: kind, category, params, inputs, outputs }
}
// Parameters that configure a node without being value inputs.
const extraParams = {
  switch: { cases: { type: 'array', label: 'Cases' } },
  forEach: { source: { type: 'string', label: 'Source' } },
  while: { maxIterations: { type: 'number', label: 'Maximum iterations' } },
  waitUntil: { intervalMs: { type: 'number', label: 'Poll interval' } },
  regexExtract: { group: { type: 'number', label: 'Capture group' } },
  math: { operation: { type: 'string', label: 'Operation' } },
  compare: { operator: { type: 'string', label: 'Operator' } },
  getVar: { scope: { type: 'string', label: 'Scope' } },
  random: { min: { type: 'number', label: 'Minimum' }, max: { type: 'number', label: 'Maximum' } },
  nearestEntity: { entityType: { type: 'string', label: 'Entity type' } }
}
for (const [kind, fields] of Object.entries(extraParams)) Object.assign(NODE_KINDS[kind].params, fields)
NODE_KINDS.forEach.inputs.items.required = false
NODE_KINDS.setVar.params.scope = { type: 'string', label: 'Scope' }
NODE_KINDS.math.params.operation.enum = ['add', 'subtract', 'multiply', 'divide']
NODE_KINDS.compare.params.operator.enum = ['==', '!=', '<', '<=', '>', '>=']
NODE_KINDS.getVar.params.scope.enum = NODE_KINDS.setVar.params.scope.enum = ['run', 'account', 'persistent']
NODE_KINDS.forEach.params.source.enum = ['items', 'players', 'entities']
NODE_KINDS.group = { label: 'Custom node', category: 'Custom', params: {}, inputs: {}, outputs: {} }
for (const [kind, label, category, params] of [
  ['fish', 'Catch one fish', 'Clicking', {}],
  ['screenshot', 'Screenshot alert', 'Communication', { message: { type: 'string', label: 'Message', default: 'Player nearby' } }],
  ['safetySettings', 'Eat and totem safety settings', 'Control', { autoEat: { type: 'boolean', label: 'Auto eat', default: true }, autoEatThreshold: { type: 'number', label: 'Food threshold', default: 14 }, autoTotem: { type: 'boolean', label: 'Auto totem', default: true }, totemDisconnect: { type: 'boolean', label: 'Disconnect without totems', default: true } }]
]) NODE_KINDS[kind] = { label, category, params, inputs: { in: control, ...inputsFor(params) }, outputs: { out: control } }
NODE_KINDS.heldDurability = { label: 'Held item durability (%)', category: 'Data', params: {}, inputs: {}, outputs: { value: { type: 'number' } } }
module.exports = { NODE_KINDS: Object.freeze(NODE_KINDS) }
