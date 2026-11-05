'use strict'

const INVENTORY_TIMEOUT_MS = 8000

// Bound the promise, and also invalidate its continuation. A plain Promise.race
// leaves a timed-out queue callback free to change inventory much later.
async function boundedAction(action, milliseconds = INVENTORY_TIMEOUT_MS, label = 'Inventory action', parentSignal) {
  const controller = new AbortController()
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason }
  const scope = {
    signal: controller.signal,
    check,
    async wait(start) {
      check()
      let aborted
      const cancellation = new Promise((_, reject) => {
        aborted = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', aborted, { once: true })
      })
      try { const result = await Promise.race([start(), cancellation]); check(); return result }
      finally { controller.signal.removeEventListener('abort', aborted) }
    },
  }
  let timer
  let parentAborted
  const timeout = new Promise((_, reject) => {
    const abort = error => { controller.abort(error); reject(error) }
    parentAborted = () => abort(parentSignal.reason)
    parentSignal?.addEventListener('abort', parentAborted, { once: true })
    if (parentSignal?.aborted) parentAborted()
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out`)
      abort(error)
    }, milliseconds)
  })
  let operation
  try { check(); operation = action(scope) }
  catch (error) { operation = Promise.reject(error) }
  try { return await Promise.race([operation, timeout]) }
  finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', parentAborted) }
}

function queueInventoryAction(manager, id, action, milliseconds = INVENTORY_TIMEOUT_MS) {
  const session = manager.sessions.get(id)
  const bot = manager.requireOnline(id)
  if (bot.currentWindow) throw new Error('Close the server menu before managing player inventory.')
  const execute = () => boundedAction(async scope => {
    while (session.depositing) {
      if (manager.sessions.get(id) !== session) throw new Error('This account is no longer online.')
      await scope.wait(() => new Promise(resolve => setTimeout(resolve, 50)))
    }
    if (manager.sessions.get(id) !== session || bot.currentWindow) throw new Error('Inventory is no longer available.')
    session.inventoryAction = true
    return scope.wait(() => action(bot, session, scope))
  }, milliseconds).finally(() => {
    session.inventoryAction = false
    manager.emitTelemetry(id)
  })
  const queued = (session.inventoryQueue || Promise.resolve()).then(execute, execute)
  session.inventoryQueue = queued.catch(() => {})
  return queued
}

module.exports = { boundedAction, queueInventoryAction, INVENTORY_TIMEOUT_MS }
