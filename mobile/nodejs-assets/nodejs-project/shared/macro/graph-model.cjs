'use strict'
const { NODE_KINDS } = require('./graph-contract.cjs')
const { nodeSpec } = require('./graph-edit.cjs')
const clone = value => JSON.parse(JSON.stringify(value))
function normalizeGraph(input) {
  const graph = input && typeof input === 'object' ? clone(input) : {}
  graph.version = 3
  graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  graph.edges = Array.isArray(graph.edges) ? graph.edges : []
  graph.vars = Array.isArray(graph.vars) ? graph.vars : []
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') continue
    node.params = node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : {}
    node.position = node.position && typeof node.position === 'object' ? node.position : { x: 0, y: 0 }
  }
  return graph
}
// Validate supplied action values; missing values can be supplied by wires or defaults.
function actionParamErrors(kind, params, skip = new Set()) {
  const { STEP_TYPES } = require('./contract.cjs')
  const schema = STEP_TYPES[kind]?.params
  if (!schema) return []
  const errors = []
  for (const [name, spec] of Object.entries(schema)) {
    if (skip.has(name) || !Object.hasOwn(params, name) || params[name] === undefined) continue
    const value = params[name]
    if (value === null && spec.default === null) continue
    let valid = true
    if (spec.type === 'number') valid = typeof value === 'number' && Number.isFinite(value) && (spec.min == null || value >= spec.min) && (spec.max == null || value <= spec.max)
    else if (spec.type === 'string' || spec.type === 'boolean') valid = typeof value === spec.type
    else if (spec.type === 'array') valid = Array.isArray(value)
    else if (spec.type === 'condition') valid = typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value))
    else if (spec.type === 'object') valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (valid && spec.enum) valid = spec.enum.includes(value)
    if (!valid) errors.push({ name, message: `Invalid ${name} for ${kind}.` })
  }
  return errors
}
function validateGraph(graph, options = {}) {
  const errors = [], nodes = new Map(), edges = Array.isArray(graph && graph.edges) ? graph.edges : []
  const error = (code, path, message) => errors.push({ code, path, message })
  for (const [i, node] of (Array.isArray(graph && graph.nodes) ? graph.nodes : []).entries()) {
    if (!node || typeof node.id !== 'string' || !node.id || nodes.has(node.id)) { error('INVALID_NODE_ID', `nodes.${i}`, 'Node id must be unique and nonempty.'); continue }
    nodes.set(node.id, node)
    if (!NODE_KINDS[node.kind]) error('UNKNOWN_KIND', `nodes.${i}.kind`, `Unknown node kind: ${node.kind}`)
  }
  if (options.requireTrigger !== false && ![...nodes.values()].some(n => !n.disabled && n.kind && n.kind.startsWith('trigger.') && NODE_KINDS[n.kind])) error('MISSING_TRIGGER', 'nodes', 'A trigger is required.')
  const connected = new Set(), adj = new Map()
  const edgeIds = new Set()
  for (const [i, edge] of edges.entries()) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) { error('INVALID_EDGE_ID', `edges.${i}`, 'Edge id must be unique and nonempty.'); continue }
    edgeIds.add(edge.id)
    const from = nodes.get(edge.from && edge.from.node), to = nodes.get(edge.to && edge.to.node)
    if (!from || !to) { error('DANGLING_EDGE', `edges.${i}`, 'Edge references a missing node.'); continue }
    const output = nodeSpec(from, NODE_KINDS)?.outputs[edge.from.port], input = nodeSpec(to, NODE_KINDS)?.inputs[edge.to.port]
    if (!output || !input) { error('UNKNOWN_PORT', `edges.${i}`, 'Edge references a missing port.'); continue }
    if (output.type !== input.type && !(output.type !== 'control' && input.type !== 'control' && (output.type === 'any' || input.type === 'any'))) { error('PORT_TYPE_MISMATCH', `edges.${i}`, 'Port types are incompatible.'); continue }
    connected.add(`${to.id}\0${edge.to.port}`)
    if (output.type === 'control' && from.kind !== 'wait' && from.kind !== 'waitUntil' && to.kind !== 'wait' && to.kind !== 'waitUntil') {
      if (!adj.has(from.id)) adj.set(from.id, [])
      adj.get(from.id).push(to.id)
    }
  }
  for (const node of nodes.values()) for (const [port, spec] of Object.entries(nodeSpec(node, NODE_KINDS)?.inputs || {})) {
    if (spec.required && !connected.has(`${node.id}\0${port}`) && (node.params?.[port] === undefined || node.params[port] === '')) error('REQUIRED_INPUT', `nodes.${node.id}.${port}`, `Required input ${port} is missing.`)
  }
  const visiting = new Set(), visited = new Set()
  function visit(id) {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adj.get(id) || []) if (visit(next)) return true
    visiting.delete(id); visited.add(id); return false
  }
  if ([...nodes.keys()].some(visit)) error('CYCLE_WITHOUT_WAIT', 'edges', 'Control cycle must pass through a wait node.')
  if (!options.expanded && [...nodes.values()].some(node => node.kind === 'group')) {
    const outerCycle = errors.findIndex(item => item.code === 'CYCLE_WITHOUT_WAIT')
    try {
      const expanded = expandGroups(graph)
      errors.push(...validateGraph(expanded, { ...options, expanded: true }).map(item => {
        const node = expanded.nodes.find(node => node._groupId && (item.path === `nodes.${node.id}` || item.path.startsWith(`nodes.${node.id}.`)))
        return node ? { ...item, path: `nodes.${node._groupId}` } : item
      }))
    } catch (failure) { error('INVALID_GROUP', 'nodes', failure.message) }
    // A group can contain a wait which is invisible to the outer cycle check.
    if (!errors.some(item => item.code === 'INVALID_GROUP')) {
      if (outerCycle >= 0) errors.splice(outerCycle, 1)
    }
  }
  return errors
}
// Expand embedded snapshots, preserving boundary endpoints exactly. Unique ids
// isolate repeated placements and nested groups while sharing the run's budgets.
function expandGroups(input, depth = 0, state = { count: 0 }) {
  if (depth > 8) throw new Error('Custom nodes are nested too deeply (maximum 8).')
  const graph = clone(input)
  for (const group of [...graph.nodes]) {
    if (++state.count > 2000) throw new Error('Custom graph exceeds 2000 nodes.')
    if (group.kind !== 'group') continue
    const d = group.params?.definition
    if (!d || !Array.isArray(d.nodes) || !d.nodes.length || !Array.isArray(d.edges) || !d.inputs || !d.outputs) throw new Error('Invalid custom node definition.')
    if (d.nodes.some(node => node?.kind?.startsWith('trigger.'))) throw new Error('Triggers must stay outside custom nodes.')
    const inner = clone(d), usedIds = new Set([...graph.nodes, ...graph.edges].map(item => item.id))
    const unique = base => { let id = base; while (usedIds.has(id)) id += '_'; usedIds.add(id); return id }
    const ids = new Map(inner.nodes.map((node, index) => [node.id, unique(`${group.id}/${index}:${node.id}`)]))
    if (ids.size !== inner.nodes.length) throw new Error('Custom node ids must be unique.')
    for (const direction of ['inputs', 'outputs']) {
      for (const [name, boundary] of Object.entries(d[direction])) {
        const target = inner.nodes.find(node => node.id === boundary.node)
        const spec = nodeSpec(target, NODE_KINDS)?.[direction]?.[boundary.port]
        if (!spec || spec.type !== boundary.type) throw new Error(`Invalid custom ${direction} port ${name}.`)
        if (direction === 'inputs' && boundary.type !== 'control' && Object.hasOwn(group.params, name)) {
          target.params ||= {}; target.params[boundary.port] = clone(group.params[name])
        }
      }
    }
    const innerErrors = validateGraph(inner, { requireTrigger: false, expanded: true })
      .filter(error => !['REQUIRED_INPUT', 'CYCLE_WITHOUT_WAIT'].includes(error.code))
    if (innerErrors.length) throw new Error(`Custom node ${d.name || group.id}: ${innerErrors[0].message}`)
    const endpoint = (value, direction) => {
      const boundary = d[direction][value.port]
      if (!boundary || !ids.has(boundary.node)) throw new Error('Custom wire references a missing port.')
      return { node: ids.get(boundary.node), port: boundary.port }
    }
    graph.edges = graph.edges.map(edge => ({ ...edge, from: edge.from.node === group.id ? endpoint(edge.from, 'outputs') : edge.from, to: edge.to.node === group.id ? endpoint(edge.to, 'inputs') : edge.to }))
    graph.nodes = graph.nodes.filter(node => node.id !== group.id)
    const renamed = { nodes: inner.nodes.map(node => ({ ...node, id: ids.get(node.id), _groupId: group._groupId || group.id, ...(group.disabled ? { disabled: true } : {}) })), edges: inner.edges.map((edge, index) => ({ ...edge, id: unique(`${group.id}/e${index}`), from: { ...edge.from, node: ids.get(edge.from.node) }, to: { ...edge.to, node: ids.get(edge.to.node) } })) }
    graph.nodes.push(...renamed.nodes); graph.edges.push(...renamed.edges)
  }
  return graph.nodes.some(node => node.kind === 'group') ? expandGroups(graph, depth + 1, state) : graph
}
function validateCustom(definition) {
  try {
    if (!definition || typeof definition.id !== 'string' || !definition.id || definition.id.length > 128 || typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 128) return [{ message: 'Custom node needs an id and name.' }]
    const graph = { nodes: [{ id: 'custom', kind: 'group', params: { definition } }], edges: [] }
    // Exposed required values are supplied when placing the node.
    const expanded = expandGroups(graph)
    return validateGraph(expanded, { requireTrigger: false, expanded: true }).filter(error => error.code !== 'REQUIRED_INPUT')
  } catch (error) { return [{ message: error.message }] }
}
const { migrateV2 } = require('./graph-edit.cjs')
function toV2(graph) {
  const source = clone(graph), byId = new Map(source.nodes.map(n => [n.id, n]))
  const next = (id, port) => source.edges.find(e => e.from.node === id && e.from.port === port)?.to.node
  const seen = new Set()
  function steps(id) {
    const result = []
    while (id) {
      if (seen.has(id)) throw new Error('Graph is not a structured v2 macro.')
      seen.add(id)
      const node = byId.get(id)
      if (!node) throw new Error('Dangling edge.')
      const step = { type: node.kind, ...node.params }
      if (node.kind === 'if') { const yes = steps(next(id, 'true')), no = steps(next(id, 'false')); if (!node.migration || node.migration.then) step.then = yes; if (!node.migration || node.migration.else) step.else = no }
      if (node.kind === 'repeat') { const body = steps(next(id, 'each')); if (!node.migration || node.migration.steps) step.steps = body }
      result.push(step)
      id = next(id, node.kind === 'repeat' ? 'done' : 'out')
    }
    return result
  }
  const trigger = source.nodes.find(n => n.kind.startsWith('trigger.'))
  if (!trigger) throw new Error('Missing trigger.')
  source.trigger = { type: trigger.kind.slice(8), ...trigger.params }
  source.steps = steps(next(trigger.id, 'out'))
  delete source.nodes; delete source.edges; delete source.vars; if (source.migration?.hadVersion) source.version = source.migration.version; else delete source.version; delete source.migration
  return source
}
module.exports = { actionParamErrors, normalizeGraph, validateGraph, expandGroups, validateCustom, migrateV2, toV2 }
