'use strict'

// Read the proposed v3 interchange format without changing the supplied graph.
function graphCards(json) {
  let graph
  try { graph = JSON.parse(json) } catch { throw new Error('Enter valid graph JSON.') }
  if (!graph || graph.version !== 3 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Expected a version 3 graph with nodes and edges.')
  const ids = new Set()
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.kind !== 'string' || !node.kind || ids.has(node.id)) throw new Error('Each node needs a unique id and kind.')
    ids.add(node.id)
  }
  for (const edge of graph.edges) {
    if (!edge || !edge.from || !edge.to || !ids.has(edge.from.node) || !ids.has(edge.to.node) || typeof edge.from.port !== 'string' || typeof edge.to.port !== 'string') throw new Error('Each edge must connect existing node ports.')
  }
  return {name: typeof graph.name === 'string' ? graph.name : 'Untitled graph', nodes: graph.nodes.map(node => ({
    id: node.id, kind: node.kind, label: typeof node.label === 'string' ? node.label : node.kind,
    disabled: node.disabled === true,
    params: JSON.stringify(node.params ?? {}, null, 2),
    connections: graph.edges.filter(edge => edge.from.node === node.id).map(edge => `${edge.from.port} → ${edge.to.node} · ${edge.to.port}`)
  }))}
}
module.exports = {graphCards}
