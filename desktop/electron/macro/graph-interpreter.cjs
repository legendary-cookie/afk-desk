'use strict'
const { validateGraph, expandGroups } = require('./graph-model.cjs')
const { NODE_KINDS } = require('./graph-contract.cjs')
const { LIMITS, MacroActionError } = require('./contract.cjs')
const { safeRegex } = require('./safe-regex.cjs')
const { actionParamErrors } = require('./graph-model.cjs')

// Runs inside MacroEngine's run context, reusing its budgets, facade and ownership.
async function runGraph(engine, ctx) {
  const errors = validateGraph(ctx.macro), graph = errors.length ? ctx.macro : expandGroups(ctx.macro)
  if (errors.length) throw new MacroActionError('INVALID', `${errors[0].code}: ${errors[0].message}`)
  const nodes = new Map(graph.nodes.map((node, index) => [node.id, { node, index }]))
  const outgoing = (id, port) => graph.edges.filter(e => e.from.node === id && e.from.port === port).map(e => { emit({ status: 'graphValue', edgeId: e.id, value: 'flow' }); return e.to.node })
  const incoming = (id, port) => graph.edges.find(e => e.to.node === id && e.to.port === port)
  const counts = new Map(), loopItems = new Map(), reportedErrors = new WeakSet()
  const emit = data => engine._emit?.({ runId: ctx.runId, macroId: ctx.macroId, accountId: ctx.accountId, ...data, ...(data.nodeId ? { nodeId: nodes.get(data.nodeId)?.node._groupId || data.nodeId } : {}) })
  function displayValue(value) {
    try { return String(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, 500) } catch { return '[Unserializable value]' }
  }
  const budget = Number.isFinite(graph.nodeStepBudget) ? Math.max(1, Math.floor(graph.nodeStepBudget)) : 10000
  async function value(id, port, evaluation) {
    const { cache, activeValues } = evaluation
    const key = `${id}:${port}`
    if (cache.has(key)) return cache.get(key)
    if (++evaluation.count > 10000) throw new MacroActionError('INVALID', 'Data evaluation budget exceeded.')
    if (evaluation.count % 64 === 0) { await new Promise(resolve => setImmediate(resolve)); engine._throwIfAborted(ctx) }
    if (activeValues.has(key)) throw new MacroActionError('INVALID', 'Value cycle detected.')
    const entry = nodes.get(id), node = entry.node
    activeValues.add(key)
    try {
      const p = await params(node, evaluation), state = engine._state(ctx.accountId)
      const result = (() => { switch (node.kind) {
        case 'inventoryCount': return (state.inventory || []).filter(i => String(i.name || '').includes(p.name || '')).reduce((n, i) => n + (Number(i.count) || 0), 0)
        case 'entityCount': return (state.entities || []).length
        case 'nearestEntity': return (state.entities || []).filter(e => !p.entityType || p.entityType === 'any' || e.type === p.entityType).slice().sort((a, b) => a.distance - b.distance)[0]
        case 'position': return state.position
        case 'health': return state.health
        case 'food': return state.food
        case 'heldDurability': return state.heldDurability ?? 0
        case 'getVar': return p.scope === 'persistent' ? engine.getPersistentVariables(ctx.accountId)[p.variable] : p.scope === 'account' ? (engine.graphAccountVariables?.get(ctx.accountId) || {})[p.variable] : ctx.variables[p.variable]
        case 'random': return (Number(p.min) || 0) + engine._unit() * ((p.max === undefined ? 1 : Number(p.max)) - (Number(p.min) || 0))
        case 'forEach': return loopItems.get(id)
        case 'regexExtract': {
          if (!safeRegex(p.pattern)) throw new MacroActionError('INVALID', 'Unsafe regular expression.')
          const match = new RegExp(p.pattern).exec(String(p.text).slice(0, 4096))
          return match ? (match[Number(p.group) || 0] || '') : ''
        }
        case 'textFormat': return String(p.text).replace(/\{(\w+)\}/g, (s, k) => ctx.variables[k] === undefined ? s : String(ctx.variables[k]))
        case 'math': switch (p.operation) { case 'subtract': return p.a - p.b; case 'multiply': return p.a * p.b; case 'divide': return p.a / p.b; default: return Number(p.a) + Number(p.b) }
        case 'compare': switch (p.operator) { case '!=': return p.a !== p.b; case '<': return p.a < p.b; case '<=': return p.a <= p.b; case '>': return p.a > p.b; case '>=': return p.a >= p.b; default: return p.a === p.b }
        default: throw new MacroActionError('UNSUPPORTED', `Unsupported value node ${node.kind}.`)
      } })()
      cache.set(key, result)
      return result
    } catch (error) {
      if (error instanceof Error && !reportedErrors.has(error)) {
        reportedErrors.add(error)
        emit({ status: 'graphError', nodeId: id, error: { message: String(error.message).slice(0, 500) } })
      }
      throw error
    } finally { activeValues.delete(key) }
  }
  async function params(node, evaluation = { cache: new Map(), activeValues: new Set(), count: 0 }) {
    const result = { ...node.params }
    for (const [name, spec] of Object.entries(NODE_KINDS[node.kind].inputs)) {
      if (spec.type === 'control') continue
      const edge = incoming(node.id, name)
      if (edge) {
        result[name] = await value(edge.from.node, edge.from.port, evaluation)
        emit({ status: 'graphValue', edgeId: edge.id, value: displayValue(result[name]) })
      }
    }
    return result
  }
  async function walk(id, options = {}) {
    try { return await walkNode(id, options) } catch (error) {
      if (error instanceof Error && !ctx.signal.aborted && error.code !== 'ABORTED' && !reportedErrors.has(error)) {
        reportedErrors.add(error)
        emit({ status: 'graphError', nodeId: id, error: { message: String(error.message).slice(0, 500) } })
      }
      throw error
    }
  }
  async function walkNode(id, options = {}) {
    if (!id) return
    engine._throwIfAborted(ctx)
    const { node, index } = nodes.get(id), path = [index]
    if (node.kind === 'merge' && options.joins) { options.joins.add(id); return }
    const visits = (counts.get(id) || 0) + 1
    counts.set(id, visits)
    if (visits > budget) throw new MacroActionError('INVALID', `Node ${id} exceeded its step budget.`)
    if (node.disabled) { for (const next of outgoing(id, 'out')) await walk(next, options); return }
    emit({ status: 'graphNode', nodeId: id })
    const p = await params(node), type = node.kind
    const paramErrors = actionParamErrors(node.kind, p)
    if (paramErrors.length) throw new MacroActionError('INVALID', paramErrors[0].message)
    if (type.startsWith('trigger.')) { for (const next of outgoing(id, 'out')) await walk(next, options); return }
    if (type === 'if') {
      await engine._gate(ctx, path, type)
      const branch = (typeof p.condition === 'boolean' ? p.condition : engine._evaluate(ctx, p.condition, 0)) ? 'true' : 'false'
      for (const next of outgoing(id, branch)) await walk(next, options)
      for (const next of outgoing(id, 'out')) await walk(next, options)
      return
    }
    if (type === 'repeat') {
      await engine._gate(ctx, path, type)
      const limit = Math.max(0, Math.floor(Number(p.while ? p.maxIterations ?? 10000 : p.times) || 0))
      for (let i = 0; i < limit; i++) {
        engine._throwIfAborted(ctx)
        if (p.while && !engine._evaluate(ctx, p.while, 0)) break
        const start = engine.now()
        for (const next of outgoing(id, 'each')) await walk(next, options)
        const elapsed = engine.now() - start
        if (elapsed < LIMITS.minLoopYieldMs) await engine._sleep(ctx, LIMITS.minLoopYieldMs - elapsed)
      }
      for (const next of outgoing(id, 'done')) await walk(next, options)
      return
    }
    if (type === 'switch') {
      await engine._gate(ctx, path, type)
      const index = (Array.isArray(p.cases) ? p.cases : []).findIndex(item => item === p.value)
      for (const next of outgoing(id, index >= 0 && index < 4 ? `case${index}` : 'default')) await walk(next, options)
      for (const next of outgoing(id, 'out')) await walk(next, options)
      return
    }
    if (type === 'parallel') {
      await engine._gate(ctx, path, type)
      const joins = new Set()
      const results = await Promise.allSettled(outgoing(id, 'out').map(next => walk(next, { ...options, joins })))
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
      for (const join of joins) await walk(join, options)
      return
    }
    if (type === 'merge') {
      await engine._gate(ctx, path, type)
      for (const next of outgoing(id, 'out')) await walk(next, options)
      return
    }
    if (type === 'tryCatch') {
      await engine._gate(ctx, path, type)
      try {
        for (const next of outgoing(id, 'try')) await walk(next, { ...options, catchErrors: true })
      } catch (error) {
        if (ctx.signal.aborted || !(error instanceof Error) || error.code === 'ABORTED') throw error
        ctx.variables.error = error.message
        for (const next of outgoing(id, 'error')) await walk(next, options)
      }
      for (const next of outgoing(id, 'out')) await walk(next, options)
      return
    }
    if (type === 'while' || type === 'forEach') {
      await engine._gate(ctx, path, type)
      const state = engine._state(ctx.accountId)
      const source = p.source === 'items' ? state.inventory : p.source === 'players' ? (state.players || (state.entities || []).filter(e => e.type === 'player')) : p.source === 'entities' ? state.entities : p.items
      const items = type === 'forEach' && Array.isArray(source) ? source : []
      const previous = loopItems.get(id)
      const limit = type === 'forEach' ? items.length : Math.max(0, Math.floor(Number(p.maxIterations) || 10000))
      for (let i = 0; i < limit; i++) {
        engine._throwIfAborted(ctx)
        if (type === 'while') {
          const current = (await params(node)).condition
          if (!(typeof current === 'boolean' ? current : engine._evaluate(ctx, current, 0))) break
        } else loopItems.set(id, items[i])
        const start = engine.now()
        for (const next of outgoing(id, 'each')) await walk(next, options)
        if (engine.now() - start < LIMITS.minLoopYieldMs) await engine._sleep(ctx, LIMITS.minLoopYieldMs - (engine.now() - start))
      }
      if (type === 'forEach') { if (previous === undefined) loopItems.delete(id); else loopItems.set(id, previous) }
      for (const next of outgoing(id, 'done')) await walk(next, options)
      return
    }
    if (type === 'waitUntil') {
      await engine._gate(ctx, path, type)
      while (true) {
        const condition = (await params(node)).condition
        if (typeof condition === 'boolean' ? condition : engine._evaluate(ctx, condition, 0)) break
        await engine._sleep(ctx, Math.max(LIMITS.minLoopYieldMs, Number(p.intervalMs) || 100))
      }
      for (const next of outgoing(id, 'out')) await walk(next, options)
      return
    }
    if (['fish', 'screenshot', 'safetySettings'].includes(type)) {
      await engine._gate(ctx, path, type)
      engine._checkFence(ctx)
      if (!engine.facade.graphAction) throw new MacroActionError('UNSUPPORTED', `Unsupported graph action ${type}.`)
      await engine._awaitOp(ctx, () => engine.facade.graphAction(ctx.accountId, { ...p, type }, { signal: ctx.signal, owner: ctx.owner, sessionId: ctx.sessionId }))
    } else if (type === 'wait') await engine._stepWait(ctx, p, path)
    else if (type === 'setVar' && p.scope === 'account') {
      await engine._gate(ctx, path, type)
      if (!engine.graphAccountVariables) engine.graphAccountVariables = new Map()
      if (!engine.graphAccountVariables.has(ctx.accountId)) engine.graphAccountVariables.set(ctx.accountId, Object.create(null))
      engine.graphAccountVariables.get(ctx.accountId)[p.variable] = p.value
    } else if (['set', 'setVar', 'clearVar'].includes(type)) await engine._stepSet(ctx, { ...p, persist: p.scope === 'persistent' || p.persist, type }, path)
    else if (type === 'stop') await engine._stepStop(ctx, path)
    else await engine._stepFacade(ctx, { ...p, type }, type, path, options.catchErrors)
    for (const next of outgoing(id, 'out')) await walk(next, options)
  }
  const triggerKind = `trigger.${ctx.record.trigger}`
  const triggers = graph.nodes.filter(n => !n.disabled && n.kind === triggerKind && (!ctx.triggerNodeId || n.id === ctx.triggerNodeId))
  if (!triggers.length && ctx.record.trigger === 'manual') {
    const first = graph.nodes.find(n => !n.disabled && n.kind.startsWith('trigger.'))
    if (first) triggers.push(first)
  }
  for (const trigger of triggers) await walk(trigger.id)
}
function triggerMacro(macro) {
  if (macro.version !== 3) return macro
  const node = (macro.nodes || []).find(n => n && !n.disabled && typeof n.kind === 'string' && n.kind.startsWith('trigger.'))
  return { ...macro, trigger: node ? { ...node.params, type: node.kind.slice(8) } : null }
}
module.exports = { runGraph, triggerMacro }
