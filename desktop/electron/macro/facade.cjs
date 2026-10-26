'use strict'
// Macro facade: the only code that talks to the bot managers on behalf of macros.
// Every facade method is (accountId, step, ctx) => Promise. See contract.cjs.
const { randomUUID } = require('node:crypto')
const { MacroActionError, ERROR_CODES, STEP_TYPES, assertFacade } = require('./contract.cjs')
const { buildTelemetry, lockedSlotSet, lockedGuiSlot, itemNameMatches, itemLoreMatches, windowTitleText } = require('../bot-manager.cjs')

const ATTACK_INTERVAL_MS = 200
const RECONNECT_POLL_MS = 25
const RECONNECT_DEFAULT_GIVE_UP_MS = 60000
const FIRST_MAIN_SLOT = 9
const LAST_MAIN_SLOT = 44
const CLICKS = Object.freeze({
  left: { button: 0, mode: 0 },
  right: { button: 1, mode: 0 },
  shift: { button: 0, mode: 1 },
  drop: { button: 0, mode: 4 }
})
// These steps still work when the account is offline or the session changed.
const SESSION_LIFECYCLE_STEPS = new Set(['disconnect', 'reconnect'])

function createFacade({ bots, notify = () => {}, getEdition = () => 'java', timers = globalThis }) {
  const managerFor = (id) => (typeof bots.manager === 'function' ? bots.manager(id) : bots)
  const sessionFor = (id) => managerFor(id)?.sessions?.get(id)
  // Bedrock sessions carry no id of their own; give each one a stable id.
  const generatedSessionIds = new WeakMap()
  const attackLoops = new Map()

  function sessionIdFor(id) {
    const session = sessionFor(id)
    if (!session) return null
    if (session.sessionId) return session.sessionId
    if (!generatedSessionIds.has(session)) generatedSessionIds.set(session, randomUUID())
    return generatedSessionIds.get(session)
  }

  function isOnline(id) {
    const session = sessionFor(id)
    if (getEdition(id) === 'bedrock') return Boolean(session?.ready && session?.client)
    return Boolean(session?.bot?.entity)
  }

  function state(id) {
    const session = sessionFor(id)
    const bedrock = getEdition(id) === 'bedrock'
    const online = isOnline(id)
    const telemetry = session?.bot
      ? buildTelemetry(session.bot, session.nearestChest, session.account?.environmentalMovement, session.fluidMotion)
      : {}
    const inventory = (bedrock ? session?.inventory : telemetry.inventory) || []
    return {
      online,
      sessionId: sessionIdFor(id),
      edition: getEdition(id),
      health: bedrock ? session?.health : telemetry.health,
      food: bedrock ? session?.food : telemetry.food,
      inventoryFull: online && !hasFreeInventorySlot(inventory),
      inventory: inventory.map(({ name, count, slot }) => ({ name, count, slot })),
      windowOpen: Boolean(session?.bot?.currentWindow)
    }
  }

  // ---- entity attack loop (leftClick hold with only: 'entities') ----

  const loopKey = (id, owner) => `${id}\u0000${owner}`

  function startAttackLoop(call) {
    const { id, ctx, manager } = call
    const key = loopKey(id, ctx.owner)
    if (attackLoops.has(key)) return
    const loop = { timer: null, session: sessionFor(id) }
    const tick = async () => {
      try { await manager.worldAction(id, 'attack-nearest') } catch {}
      if (attackLoops.get(key) !== loop) return
      if (sessionFor(id) !== loop.session) {
        attackLoops.delete(key)
        return
      }
      loop.timer = timers.setTimeout(tick, ATTACK_INTERVAL_MS)
    }
    attackLoops.set(key, loop)
    loop.timer = timers.setTimeout(tick, ATTACK_INTERVAL_MS)
    ctx.signal?.addEventListener('abort', () => stopAttackLoop(id, ctx.owner), { once: true })
  }

  function stopAttackLoop(id, owner) {
    const key = loopKey(id, owner)
    const loop = attackLoops.get(key)
    if (!loop) return
    timers.clearTimeout(loop.timer)
    attackLoops.delete(key)
  }

  // ---- step handlers: (call) => result ----

  const handlers = {
    chat({ id, step, manager }) {
      return manager.sendChat(id, step.message)
    },

    notify({ id, step }) {
      return notify({ accountId: id, message: step.message, desktop: step.desktop, webhook: step.webhook, macroId: step.macroId })
    },

    async move({ id, step, ctx, manager }) {
      const owner = requireOwner(ctx)
      if (step.distance != null) {
        return manager.worldAction(id, 'walk', { control: step.control, distance: step.distance, owner, signal: ctx.signal })
      }
      manager.claimInput(id, step.control, owner)
      try {
        await sleep(timers, step.durationMs, ctx.signal)
      } finally {
        manager.releaseInput(id, step.control, owner)
      }
    },

    async look({ id, step, bot, manager }) {
      if (step.mode === 'absolute') return manager.lookAbsolute(id, step.yaw, step.pitch)
      if (step.mode === 'relative') return manager.lookDelta(id, step.yaw, step.pitch)
      if (step.mode === 'at' && step.target === 'entity') return manager.lookAtEntity(id, step.entity)
      if (step.mode === 'at') return manager.worldAction(id, 'look-at', { x: step.x, y: step.y, z: step.z })
      throw invalid('Invalid look mode.')
    },

    control({ id, step, ctx, manager }) {
      if (!['sneak', 'jump', 'sprint'].includes(step.control)) throw invalid('Invalid movement control.')
      const owner = requireOwner(ctx)
      if (step.action === 'hold') manager.claimInput(id, step.control, owner)
      else if (step.action === 'release') manager.releaseInput(id, step.control, owner)
      else throw invalid('Invalid control action.')
    },

    async leftClick(call) {
      const { id, step, ctx, manager } = call
      if (step.action === 'hold') {
        const owner = requireOwner(ctx)
        if (step.only === 'entities') startAttackLoop(call)
        else manager.claimInput(id, 'leftClick', owner)
        return
      }
      if (step.action === 'release') {
        stopAttackLoop(id, requireOwner(ctx))
        manager.releaseInput(id, 'leftClick', requireOwner(ctx))
        return
      }
      if (step.action !== 'once') throw invalid('Invalid left click action.')
      if (step.only === 'entities') await manager.worldAction(id, 'attack-nearest')
      else if (step.only === 'blocks') await digCrosshair(call)
      else await digOrAttackOrSwing(call)
    },

    async rightClick({ id, step, ctx, manager }) {
      if (step.action === 'hold') manager.claimInput(id, 'rightClick', requireOwner(ctx))
      else if (step.action === 'release') manager.releaseInput(id, 'rightClick', requireOwner(ctx))
      else if (step.action === 'once') await manager.worldAction(id, 'use-crosshair')
      else throw invalid('Invalid click action.')
    },

    async selectHotbar({ id, step, manager }) {
      await manager.worldAction(id, 'select-hotbar', { slot: step.slot })
    },

    holdItem({ id, step, manager }) {
      return manager.holdItemByName(id, step.name)
    },

    async useInventory({ id, step, session, bot, manager }) {
      const click = clickFor(step.click)
      const item = pickOwnItem(bot, step.select, lockedSlotSet(session.account))
      // Keeps the draft behaviour: clicking a hotbar stack also selects it.
      if (item.slot >= 36 && item.slot <= 44) await manager.worldAction(id, 'select-hotbar', { slot: item.slot - 36 })
      await manager.clickInventorySlot(id, item.slot, click)
    },

    async useGui({ id, step, session, bot, manager }) {
      const click = clickFor(step.click)
      const window = bot.currentWindow
      if (!window) throw notFound('No server menu is open.')
      const slot = manager.findWindowSlot(id, step.select)
      if (slot < 0) throw notFound('Selected item or slot was not found.')
      const locked = lockedGuiSlot(window, slot, click.mode, lockedSlotSet(session.account), bot.inventory?.inventoryStart)
      if (locked !== null) throw lockedSlot(locked)
      await manager.clickWindowSlot(id, slot, { ...click, allowInventory: true })
    },

    async closeGui({ id, manager }) {
      await manager.closeWindow(id)
    },

    async waitForWindow({ id, step, ctx, manager }) {
      const window = await manager.waitForWindow(id, { title: step.title, giveUpAfterMs: step.giveUpAfterMs, signal: ctx.signal })
      return { title: windowTitleText(window) }
    },

    drop({ id, step, session, bot, manager }) {
      const item = pickOwnItem(bot, step.select, lockedSlotSet(session.account))
      return manager.dropItems(id, item.slot, step.count)
    },

    dropAll({ id, step, ctx, session, bot, manager }) {
      const locked = lockedSlotSet(session.account)
      const matching = ownItems(bot).filter((item) => !step.filter || itemNameMatches(item, step.filter))
      if (matching.length > 0 && matching.every((item) => locked.has(Number(item.slot)))) throw lockedSlot(matching[0].slot)
      return manager.dropAll(id, { filter: step.filter, signal: ctx.signal })
    },

    deposit({ id, step, session, bot, manager }) {
      const item = pickOwnItem(bot, step.select, lockedSlotSet(session.account))
      return manager.depositSlot(id, item.slot, step.count)
    },

    disconnect({ id, manager }) {
      return manager.disconnect(id)
    },

    // Resolves once the new session has spawned. The engine adopts the new session id itself.
    async reconnect({ id, step, ctx, manager, session }) {
      const account = manager.reconnects?.get(id)?.account || session?.account
      if (!account) throw new MacroActionError('OFFLINE', 'Account configuration unavailable.')
      const previousSessionId = sessionIdFor(id)
      const giveUpAfterMs = Number.isFinite(step.giveUpAfterMs) ? step.giveUpAfterMs : RECONNECT_DEFAULT_GIVE_UP_MS

      manager.disconnect(id)
      await sleep(timers, step.delayMs || 0, ctx.signal)
      const startedConnecting = !manager.sessions.has(id)
      if (startedConnecting) manager.connect(account)
      try {
        await waitForNewSession(id, previousSessionId, giveUpAfterMs, ctx.signal)
      } catch (error) {
        // Do not leave the account half-connected because of a step that was cancelled.
        if (startedConnecting && error.code === ERROR_CODES.ABORTED) manager.disconnect(id)
        throw error
      }
    }
  }

  async function waitForNewSession(id, previousSessionId, giveUpAfterMs, signal) {
    const deadline = Date.now() + giveUpAfterMs
    while (true) {
      const sessionId = sessionIdFor(id)
      if (sessionId && sessionId !== previousSessionId && isOnline(id)) return
      if (Date.now() >= deadline) throw new MacroActionError('TIMEOUT', 'Timed out waiting for the account to reconnect.')
      await sleep(timers, RECONNECT_POLL_MS, signal)
    }
  }

  // Left click once without a filter: dig, else hit the nearest entity, else swing.
  async function digOrAttackOrSwing(call) {
    const { id, manager } = call
    try {
      await digCrosshair(call)
      return
    } catch {}
    try {
      await manager.worldAction(id, 'attack-nearest')
      return
    } catch {}
    manager.swingArm(id)
  }

  // A dig can take seconds; cancelling the run must stop it.
  async function digCrosshair({ id, ctx, manager }) {
    const stopDig = () => { void Promise.resolve(manager.worldAction(id, 'stop-dig')).catch(() => {}) }
    ctx.signal?.addEventListener('abort', stopDig, { once: true })
    try {
      await manager.worldAction(id, 'dig-crosshair')
    } finally {
      ctx.signal?.removeEventListener('abort', stopDig)
    }
  }

  // ---- public methods ----

  async function runAction(type, id, step = {}, ctx = {}) {
    throwIfAborted(ctx.signal)
    if (!STEP_TYPES[type].editions.includes(getEdition(id))) {
      throw new MacroActionError('UNSUPPORTED', 'This action requires a Java account.')
    }
    assertSameSession(id, ctx)
    if (!SESSION_LIFECYCLE_STEPS.has(type) && !isOnline(id)) {
      throw new MacroActionError('OFFLINE', 'Account is not online.')
    }
    const session = sessionFor(id)
    const call = { id, step, ctx, manager: managerFor(id), session, bot: session?.bot }
    try {
      const result = await handlers[type](call)
      throwIfAborted(ctx.signal)
      if (!SESSION_LIFECYCLE_STEPS.has(type)) assertSameSession(id, ctx)
      return result
    } catch (error) {
      throw toMacroError(error)
    }
  }

  // A run started without a session id (account offline) is not fenced.
  function assertSameSession(id, ctx) {
    if (ctx.sessionId != null && sessionIdFor(id) !== ctx.sessionId) {
      throw new MacroActionError('SESSION_CHANGED', 'Account session changed.')
    }
  }

  const facade = {
    sessionId: sessionIdFor,
    state,
    releaseOwner(id, owner) {
      stopAttackLoop(id, owner)
      managerFor(id)?.releaseOwner?.(id, owner)
    }
  }
  for (const type of Object.keys(handlers)) {
    facade[type] = (id, step, ctx) => runAction(type, id, step, ctx)
  }
  return assertFacade(facade)
}

// ---- helpers ----

const invalid = (message) => new MacroActionError('INVALID', message)
const notFound = (message) => new MacroActionError('NOT_FOUND', message)
const lockedSlot = (slot) => new MacroActionError('LOCKED_SLOT', `slot ${slot} is locked`)

function requireOwner(ctx) {
  if (typeof ctx.owner !== 'string' || !ctx.owner) throw invalid('An input owner is required.')
  return ctx.owner
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new MacroActionError('ABORTED', 'Macro run was aborted.')
}

// Manager errors carry a contract code when the facade should report it as such.
function toMacroError(error) {
  if (error instanceof MacroActionError) return error
  if (error?.code && ERROR_CODES[error.code]) return new MacroActionError(error.code, error.message)
  return new MacroActionError('INVALID', error?.message || 'Action failed.')
}

function clickFor(name) {
  const click = CLICKS[name]
  if (!click) throw invalid('Invalid click type.')
  return click
}

function sleep(timers, ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MacroActionError('ABORTED', 'Macro run was aborted.'))
      return
    }
    const onAbort = () => {
      timers.clearTimeout(timer)
      reject(new MacroActionError('ABORTED', 'Macro run was aborted.'))
    }
    const timer = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, Number(ms) || 0))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function hasFreeInventorySlot(inventory) {
  const occupied = new Set(inventory.map((item) => Number(item.slot)))
  for (let slot = FIRST_MAIN_SLOT; slot <= LAST_MAIN_SLOT; slot += 1) {
    if (!occupied.has(slot)) return true
  }
  return false
}

const ownItems = (bot) => bot.inventory?.items?.() || []

// Picks the stack a step selects. A name or lore selector skips locked stacks; an
// explicit slot, or every match being locked, is rejected.
function pickOwnItem(bot, select, locked) {
  const matches = ownItems(bot).filter(selectorFor(select))
  if (matches.length === 0) throw notFound('Selected item or slot was not found.')
  const free = matches.find((item) => !locked.has(Number(item.slot)))
  if (!free) throw lockedSlot(matches[0].slot)
  return free
}

function selectorFor(select) {
  if (select?.slot != null) return (item) => Number(item.slot) === Number(select.slot)
  if (select?.name) return (item) => itemNameMatches(item, select.name)
  if (select?.lore) return (item) => itemLoreMatches(item, select.lore)
  return () => false
}

module.exports = { createFacade }
