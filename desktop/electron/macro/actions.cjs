'use strict'
const { STEP_TYPES, ENGINE_STEP_TYPES } = require('./contract.cjs')
const registry = Object.create(null)
for (const type of Object.keys(STEP_TYPES)) {
  if (ENGINE_STEP_TYPES.includes(type)) continue
  registry[type] = {
    validateArgs(step) {
      if (!step || typeof step !== 'object') return 'Step must be an object.'
      switch (type) {
        case 'chat': case 'notify': return typeof step.message === 'string' && step.message.length ? null : 'message is required.'
        case 'move': return ['forward','back','left','right'].includes(step.control) && (Number.isFinite(step.durationMs) && step.durationMs >= 0 || Number.isFinite(step.distance) && step.distance > 0) ? null : 'control and durationMs or distance are required.'
        case 'look': return ['absolute','relative','at'].includes(step.mode) ? null : 'Invalid look mode.'
        case 'control': return ['sneak','jump','sprint'].includes(step.control) && ['hold','release'].includes(step.action) ? null : 'Invalid control action.'
        case 'leftClick': return ['once','hold','release'].includes(step.action) && (step.only == null || ['blocks','entities'].includes(step.only)) ? null : 'Invalid left click action.'
        case 'rightClick': return ['once','hold','release'].includes(step.action) ? null : 'Invalid click action.'
        case 'selectHotbar': return Number.isInteger(step.slot) && step.slot >= 0 && step.slot <= 8 ? null : 'slot must be 0..8.'
        case 'holdItem': return typeof step.name === 'string' && step.name ? null : 'name is required.'
        case 'useInventory': case 'useGui': return step.select && ['left','right','shift','drop'].includes(step.click) ? null : 'select and click are required.'
        case 'waitForWindow': return Number.isFinite(step.giveUpAfterMs) && step.giveUpAfterMs >= 0 ? null : 'giveUpAfterMs is required.'
        case 'drop': case 'deposit': return step.select && Number.isFinite(step.count) && step.count >= 1 ? null : 'select and count are required.'
        case 'dropAll': return step.filter == null || typeof step.filter === 'string' ? null : 'filter must be text.'
        case 'reconnect': return step.delayMs == null || Number.isFinite(step.delayMs) && step.delayMs >= 0 ? null : 'delayMs must be nonnegative.'
        default: return null
      }
    },
    run(facade, accountId, step, ctx) { return facade[type](accountId, step, ctx) }
  }
}
module.exports = registry
