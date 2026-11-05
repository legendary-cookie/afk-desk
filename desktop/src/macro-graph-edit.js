'use strict'

// Pure graph editing operations. The editor can use these without exposing Node
// APIs to the sandboxed renderer. All operations return independent snapshots.
;(function (root) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const snap = (value, grid = 20) => Math.round(value / grid) * grid
  const compatible = (output, input) => Boolean(output && input && (output.type === input.type || (output.type !== 'control' && input.type !== 'control' && (output.type === 'any' || input.type === 'any'))))
  // Shared by the renderer and graph model, so opening and saving use the same
  // branch/loop migration as the engine.
  function migrateV2(macro) {
    const source = clone(macro), nodes = [], edges = []
    let count = 0, edgeCount = 0
    function add(kind, params) { const id = `n${++count}`; nodes.push({ id, kind, params, position: { x: count * 280, y: 0 } }); return id }
    function link(from, port, to) { if (to) edges.push({ id: `e${++edgeCount}`, from: { node: from, port }, to: { node: to, port: 'in' } }) }
    function steps(items, continuation) {
      let next = continuation
      for (let i = items.length - 1; i >= 0; i--) {
        const step = items[i], { type, then, else: otherwise, steps: body, ...params } = step
        const id = add(type, params)
        if (type === 'if' || type === 'repeat') nodes[nodes.length - 1].migration = Object.fromEntries(['then', 'else', 'steps'].map(key => [key, Object.prototype.hasOwnProperty.call(step, key)]))
        if (type === 'if') { link(id, 'true', steps(then || [], null)); link(id, 'false', steps(otherwise || [], null)); link(id, 'out', next) }
        else if (type === 'repeat') { link(id, 'each', steps(body || [], null)); link(id, 'done', next) }
        else link(id, 'out', next)
        next = id
      }
      return next
    }
    const { type, ...triggerParams } = source.trigger || { type: 'manual' }
    const trigger = add(`trigger.${type}`, triggerParams)
    link(trigger, 'out', steps(source.steps || [], null))
    delete source.trigger; delete source.steps
    return { ...source, version: 3, nodes, edges, vars: [], migration: { hadVersion: Object.prototype.hasOwnProperty.call(source, 'version'), version: source.version } }
  }
  // Simple view can only express a single structured control tree. Refuse any
  // lossy projection (data wires, fan-out, cycles, orphan/disabled nodes).
  function toSimple(graph, stepKinds) {
    const source = clone(graph), seen = new Set(), used = new Set()
    const fail = () => { throw new Error('This graph needs Canvas view (data wires, multiple paths, or unconnected nodes).') }
    const next = (id, port) => {
      const edges = source.edges.filter(edge => edge.from.node === id && edge.from.port === port)
      if (edges.length > 1) fail()
      if (edges[0]) { if (edges[0].to.port !== 'in') fail(); used.add(edges[0].id) }
      return edges[0]?.to.node
    }
    function steps(id) {
      const result = []
      while (id) {
        const node = source.nodes.find(node => node.id === id)
        if (!node || seen.has(id) || node.disabled || !stepKinds[node.kind]) fail()
        seen.add(id)
        const step = { type: node.kind, ...node.params }
        if (node.kind === 'if') { step.then = steps(next(id, 'true')); step.else = steps(next(id, 'false')) }
        if (node.kind === 'repeat') step.steps = steps(next(id, 'each'))
        result.push(step); id = next(id, node.kind === 'repeat' ? 'done' : 'out')
      }
      return result
    }
    const triggers = source.nodes.filter(node => node.kind.startsWith('trigger.'))
    if (triggers.length !== 1 || triggers[0].disabled || source.vars?.length) fail()
    const trigger = triggers[0]; seen.add(trigger.id)
    source.trigger = { type: trigger.kind.slice(8), ...trigger.params }
    source.steps = steps(next(trigger.id, 'out'))
    if (seen.size !== source.nodes.length || used.size !== source.edges.length) fail()
    delete source.nodes; delete source.edges; delete source.vars; delete source.migration; delete source.version
    return source
  }
  function connect(graph, kinds, edge) {
    const from = graph.nodes.find(node => node.id === edge.from.node)
    const to = graph.nodes.find(node => node.id === edge.to.node)
    const output = kinds[from?.kind]?.outputs?.[edge.from.port]
    const input = kinds[to?.kind]?.inputs?.[edge.to.port]
    if (!compatible(output, input)) throw new Error('Incompatible ports.')
    if (graph.edges.some(item => item.id === edge.id)) throw new Error('Duplicate edge id.')
    if (input.type !== 'control' && graph.edges.some(item => item.to.node === edge.to.node && item.to.port === edge.to.port)) throw new Error('Input already connected.')
    const result = clone(graph)
    result.edges.push(clone(edge))
    return result
  }
  function insertOnEdge(graph, kinds, edgeId, node, inputPort, outputPort, edgeIds) {
    const edge = graph.edges.find(item => item.id === edgeId)
    if (!edge) throw new Error('Edge not found.')
    if (graph.nodes.some(item => item.id === node.id)) throw new Error('Duplicate node id.')
    const result = clone(graph)
    result.edges = result.edges.filter(item => item.id !== edgeId)
    result.nodes.push(clone(node))
    const first = connect(result, kinds, { id: edgeIds[0], from: edge.from, to: { node: node.id, port: inputPort } })
    return connect(first, kinds, { id: edgeIds[1], from: { node: node.id, port: outputPort }, to: edge.to })
  }
  function copySelection(graph, ids) {
    const selected = new Set(ids)
    return clone({ nodes: graph.nodes.filter(node => selected.has(node.id)), edges: graph.edges.filter(edge => selected.has(edge.from.node) && selected.has(edge.to.node)) })
  }
  function pasteSelection(graph, selection, makeId, offset = 20) {
    const result = clone(graph), ids = new Map(), used = new Set([...result.nodes, ...result.edges].map(item => item.id))
    function nextId() {
      const id = makeId()
      if (typeof id !== 'string' || !id || used.has(id)) throw new Error('Generated id must be unique and nonempty.')
      used.add(id)
      return id
    }
    for (const node of selection.nodes) {
      if (ids.has(node.id)) throw new Error('Duplicate copied node id.')
      const copy = clone(node), id = nextId()
      ids.set(node.id, id); copy.id = id
      copy.position = { x: snap((node.position?.x || 0) + offset), y: snap((node.position?.y || 0) + offset) }
      result.nodes.push(copy)
    }
    for (const edge of selection.edges) {
      if (!ids.has(edge.from.node) || !ids.has(edge.to.node)) throw new Error('Copied edge references a missing node.')
      const copy = clone(edge)
      copy.id = nextId(); copy.from.node = ids.get(edge.from.node); copy.to.node = ids.get(edge.to.node)
      result.edges.push(copy)
    }
    return result
  }
  // Keep the contract as the source of truth for both categories and labels.
  function searchPalette(kinds, query = '') {
    const needle = query.trim().toLocaleLowerCase()
    const groups = new Map()
    for (const [kind, spec] of Object.entries(kinds)) {
      const category = spec.category || 'Other'
      if (needle && !`${kind} ${spec.label || ''} ${category}`.toLocaleLowerCase().includes(needle)) continue
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category).push(kind)
    }
    return [...groups].map(([category, kinds]) => ({ category, kinds }))
  }
  // Validation paths can identify a node by its array index or its id.
  function nodeErrors(graph, errors) {
    const result = Object.create(null)
    for (const error of errors) {
      const path = String(error.path || '').replace(/^\//, '').replace(/\./g, '/')
      if (!path.startsWith('nodes/')) continue
      const rest = path.slice(6)
      const node = graph.nodes.filter(item => typeof item?.id === 'string').sort((a, b) => b.id.length - a.id.length).find(item => {
        const id = item.id.replace(/\./g, '/').replace(/~/g, '~0')
        return rest === id || rest.startsWith(`${id}/`)
      }) || (/^\d+(?:\/|$)/.test(rest) ? graph.nodes[Number(rest.split('/')[0])] : null)
      if (!node) continue
      ;(result[node.id] ||= []).push(error.message)
    }
    return result
  }
  // A transaction is recorded after the edit, so the first edit can be undone
  // and a new edit after undo discards the abandoned redo branch.
  function createHistory(initial, limit = 50) {
    let snapshots = [clone(initial)], index = 0
    return {
      current: () => clone(snapshots[index]),
      canUndo: () => index > 0,
      canRedo: () => index < snapshots.length - 1,
      commit(value) {
        const next = clone(value)
        if (JSON.stringify(next) === JSON.stringify(snapshots[index])) return false
        snapshots = snapshots.slice(0, index + 1)
        snapshots.push(next)
        if (snapshots.length > Math.max(2, limit)) snapshots.shift()
        index = snapshots.length - 1
        return true
      },
      undo() { if (index > 0) index--; return clone(snapshots[index]) },
      redo() { if (index < snapshots.length - 1) index++; return clone(snapshots[index]) }
    }
  }
  const api = { snap, compatible, connect, insertOnEdge, copySelection, pasteSelection, searchPalette, nodeErrors, createHistory, migrateV2, toSimple }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.afkMacroGraphEdit = api
})(typeof window === 'undefined' ? globalThis : window)
