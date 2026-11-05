'use strict'
const { runGraph } = require('../../electron/macro/graph-interpreter.cjs')
// Execute the real interpreter using the same engine gates/actions with a small
// deterministic harness. State is read lazily for every group invocation.
async function interpret(graph, options = {}) {
  const calls = [], events = [], controller = new AbortController()
  let ticks = 0
  const engine = {
    now: () => ticks, _state: () => ({ health: 6, heldDurability: options.durability ?? 10, ...options.state }),
    _emit: event => events.push(event), _unit: () => 0.5,
    _throwIfAborted() { if (controller.signal.aborted) throw new Error('aborted') }, _checkFence() {},
    _gate: async () => { if (++ticks > (options.budget || 10000)) throw new Error('budget') },
    _sleep: async (_, ms) => { ticks += ms }, _evaluate: (_, condition) => condition.type === 'always',
    _awaitOp: async (_, fn) => fn(),
    _stepWait: async (_, p) => { calls.push(['wait', p.ms]); ticks += p.ms },
    _stepFacade: async (_, p, type) => { calls.push([type, p]); if (options.fail === type) throw new Error('failed') },
    facade: { graphAction: async (_, p) => { calls.push([p.type, p]); if (options.fail === p.type) throw new Error('failed') } }
  }
  const ctx = { macro: graph, signal: controller.signal, accountId: 'account', record: { trigger: 'manual' }, variables: {} }
  await runGraph(engine, ctx)
  return { calls, events }
}

module.exports = { interpret }
