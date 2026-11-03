'use strict'
const { validateGraph } = require('./graph-model.cjs')
const { NODE_KINDS } = require('./graph-contract.cjs')
const { LIMITS, MacroActionError } = require('./contract.cjs')
const { safeRegex } = require('./safe-regex.cjs')

// Runs inside MacroEngine's run context, reusing its budgets, facade and ownership.
async function runGraph(engine, ctx) {
  const graph = ctx.macro, errors = validateGraph(graph)
  if (errors.length) throw new MacroActionError('INVALID', `${errors[0].code}: ${errors[0].message}`)
  const nodes = new Map(graph.nodes.map((node, index) => [node.id, { node, index }]))
  const outgoing = (id, port) => graph.edges.filter(e => e.from.node === id && e.from.port === port).map(e => e.to.node)
  const incoming = (id, port) => graph.edges.find(e => e.to.node === id && e.to.port === port)
  const counts = new Map(), activeValues = new Set()
  const budget = Number.isFinite(graph.nodeStepBudget) ? Math.max(1, Math.floor(graph.nodeStepBudget)) : 10000
  function value(id, port) {
    const key = `${id}:${port}`
    if (activeValues.has(key)) throw new MacroActionError('INVALID', 'Value cycle detected.')
    const entry = nodes.get(id), node = entry.node
    activeValues.add(key)
    try {
      const p = params(node), state = engine._state(ctx.accountId)
      switch (node.kind) {
        case 'inventoryCount': return (state.inventory || []).filter(i => String(i.name || '').includes(p.name || '')).reduce((n, i) => n + (Number(i.count) || 0), 0)
        case 'entityCount': return (state.entities || []).length
        case 'nearestEntity': return (state.entities || []).slice().sort((a, b) => a.distance - b.distance)[0]
        case 'position': return state.position
        case 'health': return state.health
        case 'food': return state.food
        case 'getVar': return ctx.variables[p.variable]
        case 'random': return engine._unit()
        case 'forEach': return ctx.graphItem
        case 'regexExtract': {
          if (!safeRegex(p.pattern)) throw new MacroActionError('INVALID', 'Unsafe regular expression.')
          const match = new RegExp(p.pattern).exec(String(p.text).slice(0, 4096))
          return match ? (match[Number(p.group) || 0] || '') : ''
        }
        case 'textFormat': return String(p.text).replace(/\{(\w+)\}/g, (s, k) => ctx.variables[k] === undefined ? s : String(ctx.variables[k]))
        case 'math': switch (p.operation) { case 'subtract': return p.a - p.b; case 'multiply': return p.a * p.b; case 'divide': return p.a / p.b; default: return Number(p.a) + Number(p.b) }
        case 'compare': switch (p.operator) { case '!=': return p.a !== p.b; case '<': return p.a < p.b; case '<=': return p.a <= p.b; case '>': return p.a > p.b; case '>=': return p.a >= p.b; default: return p.a === p.b }
        default: throw new MacroActionError('UNSUPPORTED', `Unsupported value node ${node.kind}.`)
      }
    } finally { activeValues.delete(key) }
  }
  function params(node) {
    const result = { ...node.params }
    for (const [name, spec] of Object.entries(NODE_KINDS[node.kind].inputs)) {
      if (spec.type === 'control') continue
      const edge = incoming(node.id, name)
      if (edge) result[name] = value(edge.from.node, edge.from.port)
    }
    return result
  }
  async function walk(id) {
    if (!id) return
    engine._throwIfAborted(ctx)
    const { node, index } = nodes.get(id), path = [index]
    const visits = (counts.get(id) || 0) + 1
    counts.set(id, visits)
    if (visits > budget) throw new MacroActionError('INVALID', `Node ${id} exceeded its step budget.`)
    if (node.disabled) { for (const next of outgoing(id, 'out')) await walk(next); return }
    const p = params(node), type = node.kind
    if (type.startsWith('trigger.')) { for (const next of outgoing(id, 'out')) await walk(next); return }
    if (type === 'if') {
      await engine._gate(ctx, path, type)
      const branch = (typeof p.condition === 'boolean' ? p.condition : engine._evaluate(ctx, p.condition, 0)) ? 'true' : 'false'
      for (const next of outgoing(id, branch)) await walk(next)
      for (const next of outgoing(id, 'out')) await walk(next)
      return
    }
    if (type === 'repeat') {
      await engine._gate(ctx, path, type)
      const limit = Math.max(0, Math.floor(Number(p.while ? p.maxIterations ?? 10000 : p.times) || 0))
      for (let i = 0; i < limit; i++) {
        engine._throwIfAborted(ctx)
        if (p.while && !engine._evaluate(ctx, p.while, 0)) break
        const start = engine.now()
        for (const next of outgoing(id, 'each')) await walk(next)
        const elapsed = engine.now() - start
        if (elapsed < LIMITS.minLoopYieldMs) await engine._sleep(ctx, LIMITS.minLoopYieldMs - elapsed)
      }
      for (const next of outgoing(id, 'done')) await walk(next)
      return
    }
    if (['merge', 'parallel', 'switch', 'tryCatch'].includes(type)) throw new MacroActionError('UNSUPPORTED', `Graph node ${type} is not implemented.`)
    if (type === 'while' || type === 'forEach') {
      await engine._gate(ctx, path, type)
      const items = type === 'forEach' && Array.isArray(p.items) ? p.items : []
      const limit = type === 'forEach' ? items.length : Math.max(0, Math.floor(Number(p.maxIterations) || 10000))
      for (let i = 0; i < limit; i++) {
        engine._throwIfAborted(ctx)
        if (type === 'while') {
          const current = params(node).condition
          if (!(typeof current === 'boolean' ? current : engine._evaluate(ctx, current, 0))) break
        } else ctx.graphItem = items[i]
        const start = engine.now()
        for (const next of outgoing(id, 'each')) await walk(next)
        if (engine.now() - start < LIMITS.minLoopYieldMs) await engine._sleep(ctx, LIMITS.minLoopYieldMs - (engine.now() - start))
      }
      for (const next of outgoing(id, 'done')) await walk(next)
      return
    }
    if (type === 'waitUntil') {
      await engine._gate(ctx, path, type)
      while (true) {
        const condition = params(node).condition
        if (typeof condition === 'boolean' ? condition : engine._evaluate(ctx, condition, 0)) break
        await engine._sleep(ctx, Math.max(LIMITS.minLoopYieldMs, Number(p.intervalMs) || 100))
      }
      for (const next of outgoing(id, 'out')) await walk(next)
      return
    }
    if (type === 'wait') await engine._stepWait(ctx, p, path)
    else if (['set', 'setVar', 'clearVar'].includes(type)) await engine._stepSet(ctx, { ...p, type }, path)
    else if (type === 'stop') await engine._stepStop(ctx, path)
    else await engine._stepFacade(ctx, { ...p, type }, type, path)
    for (const next of outgoing(id, 'out')) await walk(next)
  }
  const triggerKind = `trigger.${ctx.record.trigger}`
  const trigger = graph.nodes.find(n => !n.disabled && n.kind === triggerKind) || (ctx.record.trigger === 'manual' && graph.nodes.find(n => !n.disabled && n.kind.startsWith('trigger.')))
  if (trigger) await walk(trigger.id)
}
function triggerMacro(macro) {
  if (macro.version !== 3) return macro
  const node = (macro.nodes || []).find(n => n && !n.disabled && typeof n.kind === 'string' && n.kind.startsWith('trigger.'))
  return { ...macro, trigger: node ? { ...node.params, type: node.kind.slice(8) } : null }
}
module.exports = { runGraph, triggerMacro }
