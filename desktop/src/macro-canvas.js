'use strict'
;(function (root) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const WIDTH = 220, ROW = 24, PORT_TOP = 70
  const themes = {
    Triggers: ['#9466d8', '⚡'], Communication: ['#367daf', '✉'], Movement: ['#348a69', '➜'],
    Clicking: ['#a56c2f', '☝'], Inventory: ['#99752b', '▣'], Logic: ['#6c70b7', '◇'],
    Flow: ['#6c70b7', '⑂'], Control: ['#a45469', '▶'], Data: ['#368b91', 'ƒ']
  }
  function create(container, options) {
    const edit = root.afkMacroGraphEdit, kinds = options.kinds
    let graph = clone(options.graph), live = null, errors = [], selected = new Set(), selectedEdges = new Set()
    let clipboard = null, sequence = 0, gesture = null, scale = 1, pan = { x: 30, y: 50 }, selectMode = false, snapping = true
    const history = options.history || edit.createHistory(graph)
    const mask = value => (options.mask || String)(String(value ?? ''))
    const doc = container.ownerDocument || document
    const make = (tag, className, text) => {
      const element = doc.createElement(tag)
      if (className) element.className = className
      if (text !== undefined) element.textContent = mask(text)
      return element
    }
    const button = (text, action) => {
      const element = make('button', 'button secondary compact-btn', text); element.type = 'button'
      element.addEventListener('click', action); return element
    }
    const svgElement = tag => doc.createElementNS('http://www.w3.org/2000/svg', tag)
    const shell = make('div', 'macro-canvas'), toolbar = make('div', 'macro-canvas-toolbar')
    const body = make('div', 'macro-canvas-body'), palette = make('section', 'macro-canvas-palette')
    const viewport = make('div', 'macro-canvas-viewport'), surface = make('div', 'macro-canvas-surface')
    const inspector = make('section', 'macro-canvas-inspector'), message = make('div', 'macro-canvas-message')
    const svg = svgElement('svg'), cards = make('div', 'macro-canvas-cards'), labels = make('div', 'macro-canvas-labels')
    const box = make('div', 'macro-canvas-selection')
    svg.classList.add('macro-canvas-wires'); svg.setAttribute('width', '1'); svg.setAttribute('height', '1')
    viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Macro canvas. Drag to pan; Shift-drag to select; wheel to zoom.')
    palette.setAttribute('aria-label', 'Node palette'); inspector.setAttribute('aria-label', 'Node inspector')
    const runStatus = make('div', 'macro-graph-status', 'Graph run: idle')
    runStatus.setAttribute('role', 'status')
    message.setAttribute('role', 'status'); box.hidden = true
    surface.append(svg, labels, cards, box); viewport.append(surface)
    body.append(palette, viewport, inspector); shell.append(toolbar, runStatus, message, body); container.replaceChildren(shell)
    const undoButton = button('↶ Undo', () => undo()), redoButton = button('↷ Redo', () => redo())
    const selectButton = button('Box select', () => { selectMode = !selectMode; selectButton.setAttribute('aria-pressed', String(selectMode)) })
    selectButton.setAttribute('aria-pressed', 'false')
    const snapLabel = make('label', 'check-row'), snapInput = make('input')
    snapInput.type = 'checkbox'; snapInput.checked = true
    snapInput.addEventListener('change', () => { snapping = snapInput.checked })
    snapLabel.append(snapInput, make('span', '', 'Snap to grid'))
    toolbar.append(undoButton, redoButton, button('Copy', copy), button('Paste', paste), button('Delete', remove), selectButton, snapLabel, button('Fit', fit))
    const search = make('input'); search.type = 'search'; search.placeholder = 'Search nodes…'; search.setAttribute('aria-label', 'Search node palette')
    const paletteItems = make('div'); palette.append(search, paletteItems)
    search.addEventListener('input', renderPalette)
    function id(prefix = 'node') {
      let value
      do { value = `${prefix}-${++sequence}` } while ([...graph.nodes, ...graph.edges].some(item => item.id === value))
      return value
    }
    function point(event) {
      const rect = viewport.getBoundingClientRect()
      return { x: (event.clientX - rect.left - pan.x) / scale, y: (event.clientY - rect.top - pan.y) / scale }
    }
    const snap = value => snapping ? edit.snap(value) : value
    function position(node, index = graph.nodes.indexOf(node)) {
      return { x: Number.isFinite(node.position?.x) ? node.position.x : index * 280, y: Number.isFinite(node.position?.y) ? node.position.y : 0 }
    }
    function portSpec(port) { return kinds[graph.nodes.find(node => node.id === port.node)?.kind]?.[port.direction === 'output' ? 'outputs' : 'inputs']?.[port.port] }
    function portPosition(port) {
      const node = graph.nodes.find(node => node.id === port.node)
      if (!node) return null
      const ports = kinds[node.kind]?.[port.direction === 'output' ? 'outputs' : 'inputs'] || {}
      const index = Object.keys(ports).indexOf(port.port), pos = position(node)
      return index < 0 ? null : { x: pos.x + (port.direction === 'output' ? WIDTH : 0), y: pos.y + PORT_TOP + index * ROW }
    }
    function curve(a, b) {
      const bend = Math.max(60, Math.abs(b.x - a.x) / 2)
      return { a, b, c: { x: a.x + bend, y: a.y }, d: { x: b.x - bend, y: b.y } }
    }
    const pathData = c => `M ${c.a.x} ${c.a.y} C ${c.c.x} ${c.c.y}, ${c.d.x} ${c.d.y}, ${c.b.x} ${c.b.y}`
    function wireCurve(edge) {
      const a = portPosition({ ...edge.from, direction: 'output' }), b = portPosition({ ...edge.to, direction: 'input' })
      return a && b ? curve(a, b) : null
    }
    function wireAt(p) {
      let best = null, distance = 18 / scale
      for (const edge of graph.edges) {
        const c = wireCurve(edge)
        if (!c) continue
        for (let i = 0; i <= 50; i++) {
          const t = i / 50, s = 1 - t
          const x = s ** 3 * c.a.x + 3 * s * s * t * c.c.x + 3 * s * t * t * c.d.x + t ** 3 * c.b.x
          const y = s ** 3 * c.a.y + 3 * s * s * t * c.c.y + 3 * s * t * t * c.d.y + t ** 3 * c.b.y
          const next = Math.hypot(x - p.x, y - p.y)
          if (next < distance) { best = edge.id; distance = next }
        }
      }
      return best
    }
    function transform() {
      surface.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
      viewport.style.backgroundSize = `${20 * scale}px ${20 * scale}px`
      viewport.style.backgroundPosition = `${pan.x}px ${pan.y}px`
    }
    function notify() { options.onChange?.(clone(graph)); syncHistory() }
    function commit(next) { graph = clone(next); history.commit(graph); render(); notify() }
    function syncHistory() { undoButton.disabled = !history.canUndo(); redoButton.disabled = !history.canRedo() }
    function undo() { graph = history.undo(); render(); notify() }
    function redo() { graph = history.redo(); render(); notify() }
    function report(error) { message.textContent = mask(error.message || error) }
    function copy() { clipboard = edit.copySelection(graph, [...selected]); message.textContent = `${clipboard.nodes.length} nodes copied.` }
    function paste() {
      if (!clipboard?.nodes.length) return
      const next = edit.pasteSelection(graph, clipboard, () => id('copy'))
      selected = new Set(next.nodes.slice(graph.nodes.length).map(node => node.id)); selectedEdges.clear(); commit(next)
    }
    function remove() {
      const next = clone(graph)
      next.nodes = next.nodes.filter(node => !selected.has(node.id))
      next.edges = next.edges.filter(edge => !selectedEdges.has(edge.id) && !selected.has(edge.from.node) && !selected.has(edge.to.node))
      selected.clear(); selectedEdges.clear(); commit(next)
    }
    function fit() {
      if (!graph.nodes.length) { pan = { x: 30, y: 50 }; scale = 1; transform(); return }
      const positions = graph.nodes.map(position), minX = Math.min(...positions.map(p => p.x)), minY = Math.min(...positions.map(p => p.y))
      const width = Math.max(...positions.map(p => p.x + WIDTH)) - minX
      const height = Math.max(...graph.nodes.map((node, i) => positions[i].y + cardHeight(node))) - minY
      const rect = viewport.getBoundingClientRect()
      scale = Math.max(0.25, Math.min(1, (rect.width - 60) / width, (rect.height - 60) / height))
      pan = { x: 30 - minX * scale, y: 30 - minY * scale }; transform()
    }
    function insert(next, node, edgeId) {
      const edge = next.edges.find(edge => edge.id === edgeId)
      if (!edge) return { ...next, nodes: [...next.nodes, node] }
      const output = kinds[next.nodes.find(node => node.id === edge.from.node)?.kind]?.outputs?.[edge.from.port]
      const input = kinds[next.nodes.find(node => node.id === edge.to.node)?.kind]?.inputs?.[edge.to.port]
      const spec = kinds[node.kind]
      const inputPort = Object.keys(spec.inputs || {}).find(port => edit.compatible(output, spec.inputs[port]))
      const outputPort = Object.keys(spec.outputs || {}).find(port => edit.compatible(spec.outputs[port], input))
      if (!inputPort || !outputPort) throw new Error('This node cannot be inserted into that wire.')
      return edit.insertOnEdge(next, kinds, edgeId, node, inputPort, outputPort, [id('edge'), id('edge')])
    }
    function add(kind, p, edgeId) {
      if (!kinds[kind]) return
      const params = Object.fromEntries(Object.entries(kinds[kind].params || {}).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, clone(field.default)]))
      const node = { id: id(), kind, params, position: { x: snap(p.x), y: snap(p.y) } }
      try { const next = insert(graph, node, edgeId); selected = new Set([node.id]); commit(next) } catch (error) { report(error) }
    }
    function renderPalette() {
      paletteItems.replaceChildren()
      for (const group of edit.searchPalette(kinds, search.value || '')) {
        paletteItems.append(make('h4', '', group.category))
        for (const kind of group.kinds) {
          const item = button(kinds[kind].label || kind, () => {
            const rect = viewport.getBoundingClientRect()
            add(kind, { x: (rect.width / 2 - pan.x) / scale, y: (rect.height / 2 - pan.y) / scale })
          })
          item.draggable = true; item.dataset.kind = kind
          item.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-afk-macro-kind', kind); event.dataTransfer.effectAllowed = 'copy' })
          paletteItems.append(item)
        }
      }
    }
    function renderInspector() {
      inspector.replaceChildren(make('h4', '', 'Inspector'))
      const node = graph.nodes.find(node => selected.has(node.id))
      if (!node || selected.size !== 1) { inspector.append(make('p', '', selected.size ? `${selected.size} nodes selected` : 'Select a node to edit its parameters.')); return }
      inspector.append(make('strong', '', node.label || kinds[node.kind]?.label || node.kind))
      if (options.createSchemaFields) {
        const fields = options.createSchemaFields(kinds[node.kind]?.params || {}, node.params || {}, (key, value) => {
          const next = clone(graph), params = next.nodes.find(item => item.id === node.id).params
          if (value === undefined) delete params[key]; else params[key] = value
          commit(next)
        }, 0, options.conditionEditor)
        // Sensitive editable values stay intact in the model while hidden from
        // the stream, just as identity fields elsewhere in the desktop do.
        if (options.isMasked?.()) {
          for (const input of fields.querySelectorAll('input, textarea, select')) {
            if (input.type === 'checkbox') continue
            input.disabled = true
            if (input.tagName === 'SELECT') input.replaceChildren(make('option', '', 'Hidden in streamer mode'))
            else { input.value = ''; input.placeholder = 'Hidden in streamer mode' }
          }
        }
        inspector.append(fields)
      }
    }
    function cardHeight(node) { const spec = kinds[node.kind] || {}; return PORT_TOP + Math.max(1, Object.keys(spec.inputs || {}).length, Object.keys(spec.outputs || {}).length) * ROW + 10 }
    function renderWires() {
      svg.replaceChildren(); labels.replaceChildren()
      for (const edge of graph.edges) {
        const c = wireCurve(edge)
        if (!c) continue
        const path = svgElement('path'); path.setAttribute('d', pathData(c)); path.dataset.edgeId = edge.id
        path.classList.add('macro-canvas-wire'); if (selectedEdges.has(edge.id)) path.classList.add('selected')
        svg.append(path)
        const hit = svgElement('path'); hit.setAttribute('d', pathData(c)); hit.dataset.edgeId = edge.id; hit.classList.add('macro-canvas-wire-hit'); svg.append(hit)
        if (live && Object.prototype.hasOwnProperty.call(live.values || {}, edge.id)) {
          const label = make('div', 'macro-graph-wire-label', `${edge.from.port} → ${edge.to.port}: ${live.values[edge.id]}`)
          label.style.left = `${(c.a.x + c.b.x) / 2}px`; label.style.top = `${(c.a.y + c.b.y) / 2}px`; labels.append(label)
        }
      }
      if (gesture?.type === 'connect') {
        const start = portPosition(gesture.port), end = gesture.point
        if (start) { const path = svgElement('path'); path.classList.add('macro-canvas-preview'); path.setAttribute('d', pathData(gesture.port.direction === 'output' ? curve(start, end) : curve(end, start))); svg.append(path) }
      }
    }
    function renderCards() {
      cards.replaceChildren()
      const byNode = edit.nodeErrors(graph, errors)
      for (const node of graph.nodes) {
        const spec = kinds[node.kind] || {}, pos = position(node), theme = themes[spec.category] || ['#64748b', '◆']
        const card = make('article', 'macro-canvas-node'); card.dataset.nodeId = node.id
        card.classList.toggle('selected', selected.has(node.id)); card.classList.toggle('live-running', live?.nodeId === node.id)
        const messages = [...(byNode[node.id] || []), ...(live?.errors?.[node.id] ? [live.errors[node.id]] : [])]
        card.classList.toggle('live-failed', messages.length > 0)
        card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`; card.style.height = `${cardHeight(node)}px`
        const header = make('header', 'macro-canvas-node-header'); header.style.backgroundColor = theme[0]
        header.append(make('span', 'macro-canvas-icon', theme[1]), make('strong', '', node.label || spec.label || node.kind))
        const summary = Object.entries(node.params || {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ') || 'No parameters'
        const line = make('div', 'macro-canvas-summary', summary); line.title = mask(summary)
        card.append(header, line)
        for (const direction of ['input', 'output']) {
          Object.entries(spec[direction === 'input' ? 'inputs' : 'outputs'] || {}).forEach(([port, portType], index) => {
            const dot = make('button', `macro-canvas-port ${direction}`); dot.type = 'button'
            dot.dataset.nodeId = node.id; dot.dataset.port = port; dot.dataset.direction = direction
            dot.style.top = `${PORT_TOP + index * ROW}px`; dot.title = mask(`${port} (${portType.type})`); dot.setAttribute('aria-label', mask(`${node.label || spec.label || node.kind}: ${direction} ${port} (${portType.type})`))
            const portLabel = make('span', `macro-canvas-port-label ${direction}`, port)
            portLabel.style.top = `${PORT_TOP + index * ROW - 8}px`; card.append(dot, portLabel)
          })
        }
        if (messages.length) { const error = make('div', 'macro-graph-error', messages.join(' · ')); error.setAttribute('role', 'alert'); card.append(error) }
        cards.append(card)
      }
      shadePorts()
    }
    function shadePorts() {
      for (const dot of cards.querySelectorAll('.macro-canvas-port')) {
        const target = { node: dot.dataset.nodeId, port: dot.dataset.port, direction: dot.dataset.direction }
        const source = gesture?.type === 'connect' ? gesture.port : null
        const incompatible = source && (source.direction === target.direction || !edit.compatible(portSpec(source), portSpec(target)))
        dot.classList.toggle('incompatible', Boolean(incompatible)); dot.setAttribute('aria-disabled', String(Boolean(incompatible)))
      }
    }
    function render() {
      selected = new Set([...selected].filter(id => graph.nodes.some(node => node.id === id)))
      renderCards(); renderWires(); renderInspector(); transform(); syncHistory()
    }
    function start(event) {
      if (event.button !== 0 && event.button !== 1) return
      const port = event.target.closest?.('.macro-canvas-port'), card = event.target.closest?.('.macro-canvas-node'), edge = event.target.closest?.('[data-edge-id]')
      const p = point(event)
      viewport.focus(); event.preventDefault(); message.textContent = ''
      if (event.button === 1) gesture = { type: 'pan', x: event.clientX, y: event.clientY, pan: { ...pan } }
      else if (port) {
        gesture = { type: 'connect', port: { node: port.dataset.nodeId, port: port.dataset.port, direction: port.dataset.direction }, point: p }; shadePorts()
      } else if (card) {
        const nodeId = card.dataset.nodeId
        if (event.shiftKey) { if (selected.has(nodeId)) selected.delete(nodeId); else selected.add(nodeId) }
        else if (!selected.has(nodeId)) selected = new Set([nodeId])
        selectedEdges.clear()
        gesture = { type: 'nodes', point: p, original: clone(graph), moved: false }; render()
      } else if (edge) { selected.clear(); selectedEdges = new Set([edge.dataset.edgeId]); render() }
      else if (event.shiftKey || selectMode) {
        gesture = { type: 'box', point: p, selected: event.shiftKey ? new Set(selected) : new Set() }; box.hidden = false
      } else { selected.clear(); selectedEdges.clear(); gesture = { type: 'pan', x: event.clientX, y: event.clientY, pan: { ...pan } }; render() }
      viewport.setPointerCapture?.(event.pointerId)
    }
    function move(event) {
      if (!gesture) return
      const p = point(event)
      if (gesture.type === 'pan') { pan = { x: gesture.pan.x + event.clientX - gesture.x, y: gesture.pan.y + event.clientY - gesture.y }; transform() }
      else if (gesture.type === 'connect') { gesture.point = p; renderWires() }
      else if (gesture.type === 'nodes') {
        const dx = p.x - gesture.point.x, dy = p.y - gesture.point.y
        if (Math.hypot(dx, dy) < 2 && !gesture.moved) return
        gesture.moved = true
        for (const node of graph.nodes) if (selected.has(node.id)) {
          const original = gesture.original.nodes.find(item => item.id === node.id), pos = position(original)
          node.position = { x: snap(pos.x + dx), y: snap(pos.y + dy) }
        }
        renderCards(); renderWires()
      } else if (gesture.type === 'box') {
        const x = Math.min(p.x, gesture.point.x), y = Math.min(p.y, gesture.point.y), width = Math.abs(p.x - gesture.point.x), height = Math.abs(p.y - gesture.point.y)
        Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
        selected = new Set(gesture.selected)
        for (const node of graph.nodes) { const pos = position(node); if (pos.x <= x + width && pos.x + WIDTH >= x && pos.y <= y + height && pos.y + cardHeight(node) >= y) selected.add(node.id) }
        renderCards(); renderInspector()
      }
    }
    function finish(event, cancel = false) {
      if (!gesture) return
      const previous = gesture; gesture = null; box.hidden = true
      if (event.pointerId !== undefined && viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
      if (cancel) { if (previous.original) graph = previous.original; render(); return }
      if (previous.type === 'connect') {
        const target = (doc.elementFromPoint?.(event.clientX, event.clientY) || event.target).closest?.('.macro-canvas-port')
        if (target) {
          const end = { node: target.dataset.nodeId, port: target.dataset.port, direction: target.dataset.direction }, start = previous.port
          if (end.direction !== start.direction) {
            const from = start.direction === 'output' ? start : end, to = start.direction === 'input' ? start : end
            try { commit(edit.connect(graph, kinds, { id: id('edge'), from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } })) } catch (error) { report(error) }
          }
        }
        renderCards(); renderWires()
      } else if (previous.type === 'nodes' && previous.moved) {
        const edgeId = wireAt(point(event)), node = graph.nodes.find(node => selected.has(node.id))
        if (edgeId && selected.size === 1 && !graph.edges.some(edge => edge.from.node === node.id || edge.to.node === node.id)) {
          try { graph = insert({ ...graph, nodes: graph.nodes.filter(item => item.id !== node.id) }, node, edgeId) } catch (error) { report(error) }
        }
        commit(graph)
      }
    }
    viewport.addEventListener('pointerdown', start); viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerup', event => finish(event)); viewport.addEventListener('pointercancel', event => finish(event, true))
    viewport.addEventListener('wheel', event => {
      event.preventDefault(); const p = point(event), rect = viewport.getBoundingClientRect()
      scale = Math.max(0.25, Math.min(2.5, scale * Math.exp(-event.deltaY * 0.001)))
      pan = { x: event.clientX - rect.left - p.x * scale, y: event.clientY - rect.top - p.y * scale }; transform()
    }, { passive: false })
    viewport.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' })
    viewport.addEventListener('drop', event => {
      event.preventDefault(); const p = point(event)
      add(event.dataTransfer.getData('application/x-afk-macro-kind'), p, event.target.closest?.('[data-edge-id]')?.dataset.edgeId || wireAt(p))
    })
    shell.addEventListener('keydown', event => {
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase()
      if (mod && ['z', 'y', 'c', 'v', 'a'].includes(key)) {
        event.preventDefault(); event.stopPropagation()
        if (key === 'z') event.shiftKey ? redo() : undo()
        if (key === 'y') redo()
        if (key === 'c') copy()
        if (key === 'v') paste()
        if (key === 'a') { selected = new Set(graph.nodes.map(node => node.id)); render() }
      } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove() }
      else if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); finish(event, true) }
    })
    renderPalette(); render()
    const initialBounds = viewport.getBoundingClientRect()
    if (initialBounds.width > 0 && initialBounds.height > 0 && graph.nodes.some(node => {
      const pos = position(node)
      return pos.x + pan.x < 0 || pos.y + pan.y < 0 || pos.x + WIDTH + pan.x > initialBounds.width || pos.y + cardHeight(node) + pan.y > initialBounds.height
    })) fit()
    return {
      getGraph: () => clone(graph), undo, redo,
      setGraph(next) {
        // Live events re-send the saved draft while a drag has temporary positions.
        if (gesture?.type === 'nodes' && JSON.stringify(next) === JSON.stringify(gesture.original)) return
        if (JSON.stringify(next) !== JSON.stringify(graph)) { graph = clone(next); render() }
        syncHistory()
      },
      setLive(next) { live = next; runStatus.textContent = mask(`Graph run: ${live?.status === 'started' ? 'running' : live?.status || 'idle'}`); renderCards(); renderWires() },
      setErrors(next) { errors = next || []; renderCards() },
      refresh() { renderPalette(); render() },
      destroy() { gesture = null; container.replaceChildren() }
    }
  }
  root.afkMacroCanvas = { create }
})(typeof window === 'undefined' ? globalThis : window)
