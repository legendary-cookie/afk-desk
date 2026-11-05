'use strict'

// Pure graph editing operations. The editor can use these without exposing Node
// APIs to the sandboxed renderer. All operations return independent snapshots.
;(function (root) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const snap = (value, grid = 20) => Math.round(value / grid) * grid
  const compatible = (output, input) => Boolean(output && input && (output.type === input.type || (output.type !== 'control' && input.type !== 'control' && (output.type === 'any' || input.type === 'any'))))
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
  const api = { snap, compatible, connect, insertOnEdge, copySelection, pasteSelection }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.afkMacroGraphEdit = api
})(typeof window === 'undefined' ? globalThis : window)
