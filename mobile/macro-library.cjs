'use strict'
const { normalizeGraph, validateGraph } = require('./nodejs-assets/nodejs-project/macro/graph-model.cjs')
const MACRO_STORAGE_KEY = 'afkdesk.mobile.sharedMacros.v1'
async function loadMacroLibrary(storage) {
  const raw = await storage.getItem(MACRO_STORAGE_KEY)
  const macros = raw === null ? [] : JSON.parse(raw)
  if (!Array.isArray(macros)) throw new Error('Invalid macro storage')
  return macros
}
async function saveMacroLibrary(storage, macros) {
  await storage.setItem(MACRO_STORAGE_KEY, JSON.stringify(macros))
}
const syncMacroLibrary = (command, macros) => command({ action: 'macro-set-library', macros })
// Shared links omit account identities. Enabling an import binds it to the
// account selected on this phone.
function toggleMacro(macros, index, accountId) {
  return macros.map((macro, i) => i !== index ? macro : {
    ...macro, enabled: macro.enabled === false,
    ...(macro.enabled === false ? { targets: { mode: 'accounts', accountIds: [accountId] } } : {})
  })
}
function storeGraph(macros, input, accountId) {
  if (!accountId) throw new Error('Select an account.')
  if (!input || input.version !== 3) throw new Error('Expected a version 3 graph.')
  const graph = normalizeGraph(input), errors = validateGraph(graph)
  if (errors.length) throw new Error(errors[0].message)
  graph.id = typeof graph.id === 'string' && graph.id ? graph.id : `phone-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`
  graph.enabled = true
  graph.targets = { mode: 'accounts', accountIds: [accountId] }
  return [...macros.filter(macro => macro.id !== graph.id), graph]
}
module.exports = { loadMacroLibrary, saveMacroLibrary, syncMacroLibrary, toggleMacro, storeGraph }
