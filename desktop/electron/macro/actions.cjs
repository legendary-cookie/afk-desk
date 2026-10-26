'use strict'
// Action registry for the steps that run through the facade (the engine runs the rest).
// Must load on Node 18 (Android engine): no Electron, Mineflayer or newer-Node APIs.
const { STEP_TYPES, ENGINE_STEP_TYPES } = require('./contract.cjs')

const MOVE_CONTROLS = ['forward', 'back', 'left', 'right']
const HOLD_CONTROLS = ['sneak', 'jump', 'sprint']
const LOOK_MODES = ['absolute', 'relative', 'at']
const CLICK_ACTIONS = ['once', 'hold', 'release']
const GUI_CLICKS = ['left', 'right', 'shift', 'drop']

const isNonNegative = (value) => Number.isFinite(value) && value >= 0
const isText = (value) => typeof value === 'string' && value.length > 0
const ok = null

// Each validator returns null when the step is usable, else a message.
const validators = {
  chat: (step) => (isText(step.message) ? ok : 'message is required.'),
  notify: (step) => (isText(step.message) ? ok : 'message is required.'),
  move(step) {
    const hasDuration = isNonNegative(step.durationMs)
    const hasDistance = Number.isFinite(step.distance) && step.distance > 0
    return MOVE_CONTROLS.includes(step.control) && (hasDuration || hasDistance) ? ok : 'control and durationMs or distance are required.'
  },
  look: (step) => (LOOK_MODES.includes(step.mode) ? ok : 'Invalid look mode.'),
  control: (step) => (HOLD_CONTROLS.includes(step.control) && ['hold', 'release'].includes(step.action) ? ok : 'Invalid control action.'),
  leftClick(step) {
    const onlyOk = step.only == null || ['blocks', 'entities'].includes(step.only)
    return CLICK_ACTIONS.includes(step.action) && onlyOk ? ok : 'Invalid left click action.'
  },
  rightClick: (step) => (CLICK_ACTIONS.includes(step.action) ? ok : 'Invalid click action.'),
  selectHotbar: (step) => (Number.isInteger(step.slot) && step.slot >= 0 && step.slot <= 8 ? ok : 'slot must be 0..8.'),
  holdItem: (step) => (isText(step.name) ? ok : 'name is required.'),
  useInventory: validateClick,
  useGui: validateClick,
  waitForWindow: (step) => (isNonNegative(step.giveUpAfterMs) ? ok : 'giveUpAfterMs is required.'),
  drop: validateCount,
  deposit: validateCount,
  dropAll: (step) => (step.filter == null || typeof step.filter === 'string' ? ok : 'filter must be text.'),
  reconnect(step) {
    if (step.delayMs != null && !isNonNegative(step.delayMs)) return 'delayMs must be nonnegative.'
    if (step.giveUpAfterMs != null && !isNonNegative(step.giveUpAfterMs)) return 'giveUpAfterMs must be nonnegative.'
    return ok
  }
}

function validateClick(step) {
  return step.select && GUI_CLICKS.includes(step.click) ? ok : 'select and click are required.'
}

function validateCount(step) {
  return step.select && Number.isFinite(step.count) && step.count >= 1 ? ok : 'select and count are required.'
}

const registry = Object.create(null)
for (const type of Object.keys(STEP_TYPES)) {
  if (ENGINE_STEP_TYPES.includes(type)) continue
  const validate = validators[type]
  registry[type] = {
    editions: STEP_TYPES[type].editions,
    validateArgs(step) {
      if (!step || typeof step !== 'object') return 'Step must be an object.'
      return validate ? validate(step) : ok
    },
    run(facade, accountId, step, ctx) {
      return facade[type](accountId, step, ctx)
    }
  }
}

module.exports = registry
