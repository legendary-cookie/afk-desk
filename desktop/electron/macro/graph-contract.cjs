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
  switch: ['Flow', { in: control, value: { type: 'any', required: true } }, { out: control }],
  while: ['Flow', { in: control, condition: { type: 'any', required: true } }, { each: control, done: control }],
  forEach: ['Flow', { in: control, items: { type: 'any', required: true } }, { each: control, done: control, item: { type: 'any' } }],
  waitUntil: ['Flow', { in: control, condition: { type: 'any', required: true } }, { out: control }],
  parallel: ['Flow', { in: control }, { out: control }], merge: ['Flow', { in: control }, { out: control }],
  tryCatch: ['Flow', { in: control }, { out: control, error: control }],
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
module.exports = { NODE_KINDS: Object.freeze(NODE_KINDS) }
