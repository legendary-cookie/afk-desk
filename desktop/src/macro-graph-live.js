'use strict'
;(function (root) {
  function update(previous, event, graph) {
    if (event.status === 'started') return { runId: event.runId, status: 'started', values: {}, errors: {}, nodeId: null }
    if (!previous || previous.runId !== event.runId) return previous
    const next = { ...previous, values: { ...previous.values }, errors: { ...previous.errors } }
    if (event.status === 'graphNode') next.nodeId = event.nodeId
    else if (event.status === 'graphValue') next.values[event.edgeId] = event.value
    else if (event.status === 'graphError') next.errors[event.nodeId] = event.error?.message || 'Error'
    else if (event.status === 'stepFailed') {
      const node = graph?.nodes?.[event.stepPath?.[0]]
      if (node) next.errors[node.id] = event.error?.message || 'Error'
    } else if (event.status !== 'step') {
      next.status = event.status
      next.nodeId = null
    }
    return next
  }
  function render(container, graph, live, mask = String) {
    if (!container) return
    container.replaceChildren()
    if (!graph || graph.version !== 3) { container.hidden = true; return }
    container.hidden = false
    const status = document.createElement('div')
    status.className = 'macro-graph-status'
    status.textContent = `Graph run: ${live?.status === 'started' ? 'running' : (live?.status || 'idle')}`
    status.setAttribute('role', 'status')
    const viewport = document.createElement('div')
    viewport.className = 'macro-graph-viewport'
    const surface = document.createElement('div')
    surface.className = 'macro-graph-surface'
    const positions = new Map()
    for (const [index, node] of (graph.nodes || []).entries()) {
      const x = Number.isFinite(node.position?.x) ? node.position.x : (index % 4) * 200
      const y = Number.isFinite(node.position?.y) ? node.position.y : Math.floor(index / 4) * 140
      positions.set(node.id, { x: Math.max(0, x), y: Math.max(0, y) })
    }
    const width = Math.max(600, ...[...positions.values()].map(p => p.x + 220))
    const height = Math.max(240, ...[...positions.values()].map(p => p.y + 140))
    surface.style.width = `${width}px`; surface.style.height = `${height}px`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', width); svg.setAttribute('height', height); svg.classList.add('macro-graph-wires')
    for (const edge of graph.edges || []) {
      const from = positions.get(edge.from.node), to = positions.get(edge.to.node)
      if (!from || !to) continue
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', from.x + 160); line.setAttribute('y1', from.y + 35)
      line.setAttribute('x2', to.x); line.setAttribute('y2', to.y + 35)
      svg.append(line)
      const label = document.createElement('div')
      label.className = 'macro-graph-wire-label'
      label.style.left = `${(from.x + 160 + to.x) / 2}px`; label.style.top = `${(from.y + to.y) / 2 + 35}px`
      const value = live && Object.hasOwn(live.values, edge.id) ? `: ${live.values[edge.id]}` : ''
      label.textContent = mask(`${edge.from.port} → ${edge.to.port}${value}`)
      surface.append(label)
    }
    surface.prepend(svg)
    for (const node of graph.nodes || []) {
      const pos = positions.get(node.id), card = document.createElement('div')
      card.className = `macro-graph-node${live?.nodeId === node.id ? ' live-running' : ''}${live?.errors[node.id] ? ' live-failed' : ''}`
      card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`
      const title = document.createElement('strong'); title.textContent = mask(node.kind); card.append(title)
      const id = document.createElement('small'); id.textContent = mask(node.id); card.append(id)
      if (live?.errors[node.id]) { const error = document.createElement('div'); error.className = 'macro-graph-error'; error.textContent = mask(live.errors[node.id]); card.append(error) }
      surface.append(card)
    }
    viewport.append(surface); container.append(status, viewport)
  }
  const api = { update, render }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.afkMacroGraphLive = api
})(typeof window === 'undefined' ? globalThis : window)
