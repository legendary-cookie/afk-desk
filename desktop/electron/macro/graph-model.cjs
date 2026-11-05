'use strict'
const { NODE_KINDS } = require('./graph-contract.cjs')
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
function validateGraph(graph) {
  const errors = [], nodes = new Map(), edges = Array.isArray(graph && graph.edges) ? graph.edges : []
  const error = (code, path, message) => errors.push({ code, path, message })
  for (const [i, node] of (Array.isArray(graph && graph.nodes) ? graph.nodes : []).entries()) {
    if (!node || typeof node.id !== 'string' || !node.id || nodes.has(node.id)) { error('INVALID_NODE_ID', `nodes.${i}`, 'Node id must be unique and nonempty.'); continue }
    nodes.set(node.id, node)
    if (!NODE_KINDS[node.kind]) error('UNKNOWN_KIND', `nodes.${i}.kind`, `Unknown node kind: ${node.kind}`)
  }
  if (![...nodes.values()].some(n => !n.disabled && n.kind && n.kind.startsWith('trigger.') && NODE_KINDS[n.kind])) error('MISSING_TRIGGER', 'nodes', 'A trigger is required.')
  const connected = new Set(), adj = new Map()
  const edgeIds = new Set()
  for (const [i, edge] of edges.entries()) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) { error('INVALID_EDGE_ID', `edges.${i}`, 'Edge id must be unique and nonempty.'); continue }
    edgeIds.add(edge.id)
    const from = nodes.get(edge.from && edge.from.node), to = nodes.get(edge.to && edge.to.node)
    if (!from || !to) { error('DANGLING_EDGE', `edges.${i}`, 'Edge references a missing node.'); continue }
    const output = NODE_KINDS[from.kind]?.outputs[edge.from.port], input = NODE_KINDS[to.kind]?.inputs[edge.to.port]
    if (!output || !input) { error('UNKNOWN_PORT', `edges.${i}`, 'Edge references a missing port.'); continue }
    if (output.type !== input.type && !(output.type !== 'control' && input.type !== 'control' && (output.type === 'any' || input.type === 'any'))) { error('PORT_TYPE_MISMATCH', `edges.${i}`, 'Port types are incompatible.'); continue }
    connected.add(`${to.id}\0${edge.to.port}`)
    if (output.type === 'control' && from.kind !== 'wait' && from.kind !== 'waitUntil' && to.kind !== 'wait' && to.kind !== 'waitUntil') {
      if (!adj.has(from.id)) adj.set(from.id, [])
      adj.get(from.id).push(to.id)
    }
  }
  for (const node of nodes.values()) for (const [port, spec] of Object.entries(NODE_KINDS[node.kind]?.inputs || {})) {
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
  return errors
}
const { migrateV2 } = require('../../src/macro-graph-edit.js')
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
module.exports = { normalizeGraph, validateGraph, migrateV2, toV2 }
