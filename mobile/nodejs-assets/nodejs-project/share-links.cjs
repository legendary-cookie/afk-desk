'use strict'
const { gzipSync, gunzipSync } = require('node:zlib')
const { TRIGGER_TYPES, STEP_TYPES, CONDITION_METADATA } = require('./macro/contract.cjs')
const { NODE_KINDS } = require('./macro/graph-contract.cjs')

const MAX_SIZE = 256 * 1024
// Only connection and non-text behavior settings are portable. In particular,
// automatic chat, proxy credentials, identities and embedded automations stay local.
const PROFILE_FIELDS = ['host', 'port', 'edition', 'profileName', 'version', 'modLoader', 'modHandshake', 'clientBrand', 'mods', 'modChannels', 'antiAfk', 'antiAfkInterval', 'antiAfkMinDelay', 'antiAfkMaxDelay', 'antiAfkActionDuration', 'antiAfkWalkDistance', 'antiAfkLookDegrees', 'antiAfkJump', 'antiAfkLook', 'antiAfkSneak', 'antiAfkSwing', 'antiAfkWalk', 'environmentalMovement', 'autoReconnect', 'autoReconnectDelay', 'autoReconnectBackoffMultiplier', 'autoReconnectMaxDelay', 'autoReconnectRateLimitDelay', 'autoReconnectMaxAttempts', 'connectTimeoutSeconds', 'reconnectResetDelay', 'autoDepositToChest', 'autoDepositRange', 'autoDepositMode', 'autoDepositInterval', 'autoDepositFullThreshold', 'lockedInventorySlots', 'alerts']
function profileData(input) {
  const result = Object.fromEntries(PROFILE_FIELDS.filter(key => Object.hasOwn(input, key) && (input[key] === null || ['string', 'number', 'boolean'].includes(typeof input[key]))).map(key => [key, input[key]]))
  if (Array.isArray(input.mods)) result.mods = input.mods.map(mod => ({ modid: String(mod?.modid || ''), version: String(mod?.version || '') }))
  if (Array.isArray(input.modChannels)) result.modChannels = input.modChannels.filter(x => typeof x === 'string')
  if (Array.isArray(input.lockedInventorySlots)) result.lockedInventorySlots = input.lockedInventorySlots.filter(Number.isInteger)
  if (input.alerts && typeof input.alerts === 'object') result.alerts = { disconnect: input.alerts.disconnect, errors: input.alerts.errors, healthBelow: input.alerts.healthBelow }
  return result
}
function macroData(input, model) {
  const macro = model.normalizeMacro(input)
  macro.id = undefined
  macro.origin = {}
  macro.notify = {}
  macro.enabled = false
  macro.targets = { mode: 'accounts', accountIds: [] }
  // Arbitrary macro text can contain passwords, account names or webhook URLs.
  const structural = { type: [...Object.keys(STEP_TYPES), ...Object.keys(TRIGGER_TYPES), ...Object.keys(CONDITION_METADATA), ...Object.keys(NODE_KINDS)], mode: ['all', 'accounts', 'tags'], concurrency: ['skip', 'restart', 'queue', 'parallel'], onError: ['stop', 'continue'], comparator: ['==', '!=', '<', '<=', '>', '>='], match: ['contains', 'glob'], source: ['items', 'players', 'entities'] }
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean)
    if (typeof value === 'string') return ''
    if (!value || typeof value !== 'object') return value
    const schema = STEP_TYPES[value.type]?.params || TRIGGER_TYPES[value.type]?.params || CONDITION_METADATA[value.type]?.params || NODE_KINDS[value.type]?.params || {}
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|webhook|account|username|uuid/i.test(key)).map(([key, val]) => [key, typeof val === 'string' && !(schema[key]?.enum?.includes(val)) && !structural[key]?.includes(val) ? '' : typeof val === 'string' ? val : clean(val)]))
  }
  const result = clean(macro)
  if (macro.version === 3) {
    const portable = portableGraph(macro, clean)
    result.nodes = portable.nodes; result.edges = portable.edges
    result.vars = []
    delete result.migration
  }
  result.name = 'Shared macro'
  return result
}
// Preserve only contract ports; regenerate every user-controlled identifier,
// including interface names, throughout embedded custom definitions.
function portableGraph(source, clean, depth = 0) {
  if (depth > 8) throw new Error('Custom nodes are nested too deeply.')
  const ids = new Map(), ports = new Map(), nodes = [], edges = []
  for (const node of source.nodes || []) {
    if (!node || ids.has(node.id) || !NODE_KINDS[node.kind]) continue
    const id = `n${ids.size + 1}`; ids.set(node.id, id)
    const params = clean({ ...node.params, type: node.kind.startsWith('trigger.') ? node.kind.slice(8) : node.kind }); delete params.type
    if (node.kind === 'group') {
      const d = node.params?.definition
      if (!d) throw new Error('Invalid custom node definition.')
      const inner = portableGraph(d, clean, depth + 1), mapping = { inputs: new Map(), outputs: new Map() }
      const definition = { id: 'shared-custom', name: 'Shared custom node', version: 3, nodes: inner.nodes, edges: inner.edges, inputs: {}, outputs: {} }
      for (const direction of ['inputs', 'outputs']) for (const [name, boundary] of Object.entries(d[direction] || {})) {
        const endpoint = inner.endpoint(boundary, direction)
        if (!['control', 'number', 'string', 'item', 'entity', 'position', 'any'].includes(boundary.type) || !endpoint) continue
        const key = `${direction === 'inputs' ? 'in' : 'out'}${mapping[direction].size + 1}`
        mapping[direction].set(name, key)
        definition[direction][key] = { ...endpoint, type: boundary.type, ...(boundary.required ? { required: true } : {}) }
      }
      ports.set(node.id, mapping)
      for (const key of Object.keys(params)) delete params[key]
      params.definition = definition
      for (const [old, key] of mapping.inputs) if (Object.hasOwn(node.params, old)) params[key] = clean({ value: node.params[old] }).value
    }
    nodes.push({ id, kind: node.kind, params, position: { x: Number.isFinite(node.position?.x) ? node.position.x : 0, y: Number.isFinite(node.position?.y) ? node.position.y : 0 }, ...(node.disabled ? { disabled: true } : {}) })
  }
  function endpoint(value, direction) {
    const node = source.nodes.find(node => node.id === value?.node)
    if (!node || !ids.has(node.id)) return null
    const port = node.kind === 'group' ? ports.get(node.id)?.[direction].get(value.port) : Object.hasOwn(NODE_KINDS[node.kind][direction], value.port) ? value.port : null
    return port ? { node: ids.get(node.id), port } : null
  }
  for (const edge of source.edges || []) {
    const from = endpoint(edge?.from, 'outputs'), to = endpoint(edge?.to, 'inputs')
    if (from && to) edges.push({ id: `e${edges.length + 1}`, from, to })
  }
  return { nodes, edges, endpoint }
}
function customData(definition, model) {
  const macro = macroData({ version: 3, nodes: [{ id: 'custom', kind: 'group', params: { definition } }], edges: [] }, model)
  return macro.nodes[0].params.definition
}
function encode(kind, data) {
  if (!['profile', 'macro', 'custom'].includes(kind)) throw new Error('Unknown share kind.')
  const json = JSON.stringify({ version: 1, data })
  if (Buffer.byteLength(json) > MAX_SIZE) throw new Error('Share data is too large.')
  return `afkdesk://share/${kind}/${gzipSync(json).toString('base64url')}`
}
function decode(link) {
  if (typeof link !== 'string' || link.length > MAX_SIZE) throw new Error('Invalid share link.')
  const match = /^afkdesk:\/\/share\/(profile|macro|custom)\/([A-Za-z0-9_-]+)$/.exec(link.trim())
  if (!match) throw new Error('Invalid share link.')
  let parsed
  try { parsed = JSON.parse(gunzipSync(Buffer.from(match[2], 'base64url'), { maxOutputLength: MAX_SIZE }).toString('utf8')) } catch { throw new Error('Invalid share data.') }
  if (!parsed || parsed.version !== 1 || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new Error('Unsupported or invalid share data.')
  return { kind: match[1], data: parsed.data }
}
module.exports = { encode, decode, profileData, macroData, customData }
