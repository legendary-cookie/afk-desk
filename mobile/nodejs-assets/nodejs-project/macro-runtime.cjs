'use strict'
const { createBotEventAdapter } = require('./macro/bot-events.cjs')
const { MacroEngine } = require('./macro/engine.cjs')
const { TriggerMatcher, nextScheduleTime } = require('./macro/triggers.cjs')
const { createFacade } = require('./macro/facade.cjs')
const { normalizeGraph, validateGraph } = require('./macro/graph-model.cjs')

function createMacroRuntime(manager, emit = () => {}, options = {}) {
  const facade = createFacade(manager, options)
  const sessionId = facade.sessionId
  const engine = new MacroEngine({ ...options, facade, matcher: new TriggerMatcher(), nextScheduleTime, emit, resolveTargets: macro => macro.targets?.mode === 'accounts' ? macro.targets.accountIds || [] : [...manager.sessions.keys()] })
  const library = () => [...engine.macros.values()].map(entry => entry.macro)
  function setLibrary(macros) {
    engine.setLibrary(macros)
    // Storage can finish loading after a bot has already spawned.
    for (const [id, session] of manager.sessions) if (session.ready) event(id, 'spawn')
  }
  const adapt = createBotEventAdapter({ sessionId })
  function event(id, type, payload) {
    // Resolve all-account targets again when a newly connected account appears.
    if (type === 'spawn') engine.setLibrary(library())
    engine.onBotEvent({ accountId: id, sessionId: sessionId(id), type, payload })
  }
  return {
    engine,
    setLibrary,
    runGraph(id, input) {
      if (!manager.sessions.get(id)?.ready) throw new Error('Account is not online yet.')
      if (!input || input.version !== 3) throw new Error('Expected a version 3 graph.')
      const graph = normalizeGraph(input); const errors = validateGraph(graph)
      if (errors.length) throw new Error(errors[0].message)
      graph.id = typeof graph.id === 'string' && graph.id ? graph.id : 'mobile-graph'
      graph.enabled = true; graph.targets = { mode: 'accounts', accountIds: [id] }
      const library = [...engine.macros.values()].map(entry => entry.macro).filter(item => item.id !== graph.id)
      setLibrary([...library, graph]); void engine.run(id, graph.id)
    },
    stop: id => engine.stop(id),
    event,
    forward(type, id, payload) { for (const e of adapt(type, id, payload)) { if (e.type === 'spawn') engine.setLibrary(library()); engine.onBotEvent(e) } },
    upcoming(id) { return [...(engine.timed.get(id)?.values() || [])].filter(item => Number.isFinite(item.at)).map(item => ({ kind: 'macro timer', at: item.at })) }
  }
}
module.exports = { createMacroRuntime }
