'use strict'
const { MacroActionError, FACADE_METHODS } = require('./contract.cjs')
const { isDeepStrictEqual } = require('node:util')
const { buildTelemetry, extractText, findNearestChest } = require('../bot-manager.cjs')

const fail = (code, message) => { throw new MacroActionError(code, message) }
const clicks = { left: [0, 0], right: [1, 0], shift: [0, 1], drop: [0, 4] }
const nameMatches = (item, name) => [item.name, item.displayName].some(value => String(value || '').toLowerCase().includes(String(name).toLowerCase()))
function lore(item) {
  let raw
  try { raw = item.customLore } catch {}
  raw ??= item.componentMap?.get?.('lore')?.data ?? item.components?.find(c => c.type === 'lore')?.data
  raw ??= item.nbt?.value?.display?.value?.Lore?.value?.value
  return (Array.isArray(raw?.lines ?? raw) ? (raw.lines ?? raw) : []).map(line => extractText(line).replace(/§[0-9a-fk-or]/gi, '')).join('\n')
}

function createFacade(manager, { notify = event => manager.emit('macro-notify', event.accountId, event), timers = globalThis, now = Date.now } = {}) {
  const ids = new WeakMap(), claims = new Map()
  let sequence = 0
  const session = id => manager.sessions.get(id)
  const sessionId = id => {
    const s = session(id)
    if (!s) return null
    if (!ids.has(s)) ids.set(s, String(++sequence))
    return ids.get(s)
  }
  function check(id, ctx, online = true) {
    if (ctx.signal?.aborted) fail('ABORTED', 'Macro run was cancelled.')
    if (ctx.sessionId != null && ctx.sessionId !== sessionId(id)) fail('SESSION_CHANGED', 'Account session changed.')
    if (online && !(session(id)?.ready && session(id)?.bot?.entity)) fail('OFFLINE', 'Account is not online yet.')
  }
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new MacroActionError('ABORTED', 'Macro run was cancelled.'))
    return new Promise((resolve, reject) => {
      const abort = () => { timers.clearTimeout(timer); reject(new MacroActionError('ABORTED', 'Macro run was cancelled.')) }
      const timer = timers.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.max(0, ms))
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  async function until(id, ctx, predicate, timeout) {
    const deadline = now() + timeout
    for (;;) {
      check(id, ctx, false)
      const result = predicate()
      if (result) return result
      if (now() >= deadline) fail('TIMEOUT', 'Timed out waiting for the action.')
      await sleep(Math.min(25, deadline - now()), ctx.signal)
    }
  }
  function release(id, owner, control) {
    const entries = claims.get(id)
    if (!entries) return
    for (const entry of [...entries]) {
      if (entry.owner !== owner || (control && entry.control !== control)) continue
      entries.delete(entry)
      timers.clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.abort)
      if (session(id) !== entry.session) continue
      if ([...entries].some(other => other.control === entry.control && other.session === entry.session)) continue
      if (entry.control === 'rightClick') entry.bot.deactivateItem()
      else if (entry.control === 'leftClick') entry.bot.stopDigging?.()
      else entry.bot.setControlState(entry.control, false)
    }
    if (!entries.size) claims.delete(id)
  }
  function claim(id, control, ctx, tick) {
    if (!ctx.owner) fail('INVALID', 'An input owner is required.')
    const entries = claims.get(id) || new Set()
    if ([...entries].some(e => e.owner === ctx.owner && e.control === control)) return
    const s = session(id), bot = manager.requireOnline(id)
    const entry = { owner: ctx.owner, control, session: s, bot, signal: ctx.signal }
    entry.abort = () => release(id, ctx.owner, control)
    const repeat = async () => {
      try { check(id, ctx); if (ctx.checkStop?.()) fail('ABORTED', 'Stop condition matched.'); await tick() }
      catch { release(id, ctx.owner, control); return }
      if (entries.has(entry)) entry.timer = timers.setTimeout(repeat, 200)
    }
    if (control === 'rightClick') bot.activateItem()
    else if (control !== 'leftClick') bot.setControlState(control, true)
    entries.add(entry); claims.set(id, entries)
    ctx.signal?.addEventListener('abort', entry.abort, { once: true })
    if (tick) void repeat()
  }
  const locked = id => new Set((session(id)?.account?.lockedInventorySlots || []).map(Number))
  function pick(id, bot, select, gui = false) {
    const window = gui ? bot.currentWindow : bot.inventory
    if (!window) fail('NOT_FOUND', 'No server menu is open.')
    const slots = window.slots || []
    const start = gui ? 0 : 9, end = gui ? slots.length - 1 : 45
    const matches = []
    for (let slot = start; slot <= end; slot++) {
      const item = slots[slot]
      if (select?.slot != null ? slot !== Number(select.slot) : !item || !(select?.name ? nameMatches(item, select.name) : select?.lore && lore(item).toLowerCase().includes(String(select.lore).toLowerCase()))) continue
      if (!gui && !item) continue
      matches.push({ slot, item })
    }
    if (!matches.length) fail('NOT_FOUND', 'Selected item or slot was not found.')
    const locks = locked(id)
    const free = matches.find(({ slot }) => !locks.has(gui ? (slot < window.inventoryStart ? -1 : (bot.inventory.inventoryStart ?? 9) + slot - window.inventoryStart) : slot))
    if (!free) fail('LOCKED_SLOT', 'Selected inventory slot is locked.')
    return free
  }
  function inventory(id, ctx, action) {
    return manager.withInventoryAction(id, async bot => { check(id, ctx); return action(bot) })
  }
  async function left(id, step, ctx) {
    const bot = manager.requireOnline(id)
    const target = step.only === 'entities'
      ? Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && distance(e.position, bot.entity.position) <= 3).sort((a, b) => distance(a.position, bot.entity.position) - distance(b.position, bot.entity.position))[0]
      : step.only !== 'blocks' && bot.entityAtCursor?.(3)
    if (target) return bot.attack(target)
    const block = step.only !== 'entities' && bot.blockAtCursor?.(5)
    if (block) {
      const abort = () => bot.stopDigging?.()
      ctx.signal?.addEventListener('abort', abort, { once: true })
      try { return await bot.dig(block) } finally { ctx.signal?.removeEventListener('abort', abort) }
    }
    if (step.only) fail('NOT_FOUND', 'No matching target is in reach.')
    bot.swingArm()
  }
  const handlers = {
    chat: (id, step) => manager.sendChat(id, step.message),
    notify: (id, step) => notify({ ...step, accountId: id }),
    async move(id, step, ctx) {
      if (!['forward', 'back', 'left', 'right'].includes(step.control)) fail('INVALID', 'Invalid movement direction.')
      const bot = manager.requireOnline(id), start = { ...bot.entity.position }
      claim(id, step.control, ctx)
      try {
        if (step.distance != null) await until(id, ctx, () => distance(start, bot.entity.position) >= step.distance, 30000)
        else {
          const end = now() + (step.durationMs ?? 350)
          await until(id, ctx, () => now() >= end, (step.durationMs ?? 350) + 100)
        }
      } finally { release(id, ctx.owner, step.control) }
    },
    look(id, step) {
      const bot = manager.requireOnline(id)
      if (step.mode === 'at') {
        let target = step
        if (step.target === 'entity') {
          target = Object.values(bot.entities || {}).find(e => String(e.id) === String(step.entity) || nameMatches({ name: e.name, displayName: e.username }, step.entity))?.position
          if (!target) fail('NOT_FOUND', 'Entity not found.')
        }
        const position = bot.entity.position.offset(target.x - bot.entity.position.x, target.y - bot.entity.position.y, target.z - bot.entity.position.z)
        return bot.lookAt(position, true)
      }
      if (!['absolute', 'relative'].includes(step.mode)) fail('INVALID', 'Invalid look mode.')
      return bot.look((step.yaw || 0) + (step.mode === 'relative' ? bot.entity.yaw : 0), (step.pitch || 0) + (step.mode === 'relative' ? bot.entity.pitch : 0), true)
    },
    control(id, step, ctx) {
      if (!['sneak', 'jump', 'sprint'].includes(step.control)) fail('INVALID', 'Invalid movement control.')
      if (step.action === 'hold') claim(id, step.control, ctx)
      else if (step.action === 'release') release(id, ctx.owner, step.control)
      else fail('INVALID', 'Invalid control action.')
    },
    async leftClick(id, step, ctx) {
      if (step.action === 'hold') claim(id, 'leftClick', ctx, () => left(id, step, ctx))
      else if (step.action === 'release') release(id, ctx.owner, 'leftClick')
      else if (step.action === 'once') await left(id, step, ctx)
      else fail('INVALID', 'Invalid click action.')
    },
    async rightClick(id, step, ctx) {
      const bot = manager.requireOnline(id)
      if (step.action === 'hold') claim(id, 'rightClick', ctx)
      else if (step.action === 'release') release(id, ctx.owner, 'rightClick')
      else if (step.action === 'once') {
        const entity = bot.entityAtCursor?.(3)
        const block = bot.blockAtCursor?.(5)
        if (entity) await bot.activateEntity(entity)
        else if (block) await bot.activateBlock(block)
        else { bot.activateItem(); bot.deactivateItem() }
      } else fail('INVALID', 'Invalid click action.')
    },
    async autoclick(id, step, ctx) {
      if (!['left', 'right'].includes(step.button) || !(step.cps > 0 && step.cps <= 20)) fail('INVALID', 'Invalid autoclick settings.')
      const end = step.durationSec == null ? Infinity : now() + step.durationSec * 1000
      while (now() < end) {
        check(id, ctx)
        if (ctx.checkStop?.()) fail('ABORTED', 'Stop condition matched.')
        await handlers[step.button === 'left' ? 'leftClick' : 'rightClick'](id, { action: 'once' }, ctx)
        await sleep(Math.min(1000 / step.cps, end - now()), ctx.signal)
      }
    },
    selectHotbar(id, step, ctx) {
      if (!Number.isInteger(step.slot) || step.slot < 0 || step.slot > 8) fail('INVALID', 'Invalid hotbar slot.')
      return inventory(id, ctx, bot => bot.setQuickBarSlot(step.slot))
    },
    holdItem: (id, step, ctx) => inventory(id, ctx, bot => {
      const { item, slot } = pick(id, bot, { name: step.name })
      if (slot >= 36 && slot <= 44) return bot.setQuickBarSlot(slot - 36)
      if (locked(id).has(36 + (bot.quickBarSlot || 0))) fail('LOCKED_SLOT', 'Selected hotbar slot is locked.')
      return bot.equip(item, 'hand')
    }),
    readLore: (id, step) => lore(pick(id, manager.requireOnline(id), step.select).item),
    useInventory(id, step, ctx) {
      if (!clicks[step.click]) fail('INVALID', 'Invalid click type.')
      return inventory(id, ctx, async bot => {
        const { slot } = pick(id, bot, step.select)
        if (slot >= 36 && slot <= 44) bot.setQuickBarSlot(slot - 36)
        await bot.clickWindow(slot, ...clicks[step.click])
      })
    },
    useGui(id, step) {
      if (!clicks[step.click]) fail('INVALID', 'Invalid click type.')
      const bot = manager.requireOnline(id), { slot } = pick(id, bot, step.select, true)
      return bot.clickWindow(slot, ...clicks[step.click])
    },
    closeGui: id => manager.closeWindow(id),
    async waitForWindow(id, step, ctx) {
      const window = await until(id, ctx, () => {
        const w = session(id)?.bot?.currentWindow
        return w && (!step.title || extractText(w.title?.json ?? w.title).toLowerCase().includes(step.title.toLowerCase())) && w
      }, step.giveUpAfterMs ?? 10000)
      return { title: extractText(window.title?.json ?? window.title) }
    },
    drop: (id, step, ctx) => inventory(id, ctx, bot => {
      const { item, slot } = pick(id, bot, step.select)
      return bot.transfer({ window: bot.inventory, itemType: item.type, metadata: item.metadata ?? null, nbt: item.nbt,
        count: itemCount(item, step.count), sourceStart: slot, sourceEnd: slot + 1, destStart: -999, destEnd: -999 })
    }),
    dropAll: (id, step, ctx) => inventory(id, ctx, async bot => {
      const items = (bot.inventory.items() || []).filter(item => !step.filter || nameMatches(item, step.filter))
      if (items.length && items.every(item => locked(id).has(item.slot))) fail('LOCKED_SLOT', 'All matching inventory slots are locked.')
      for (const item of items) { check(id, ctx); if (!locked(id).has(item.slot)) await bot.tossStack(item) }
    }),
    deposit: (id, step, ctx) => inventory(id, ctx, async bot => {
      const { item, slot } = pick(id, bot, step.select)
      const block = findNearestChest(bot, session(id).account?.autoDepositRange)
      if (!block) fail('NOT_FOUND', 'No visible container is in reach.')
      let container
      const close = () => { try { container?.close() } catch {} }
      ctx.signal?.addEventListener('abort', close, { once: true })
      try {
        container = await (bot.openContainer || bot.openChest).call(bot, block)
        check(id, ctx)
        if (locked(id).has(slot)) fail('LOCKED_SLOT', 'Selected inventory slot is locked.')
        const source = container.inventoryStart + slot - (bot.inventory.inventoryStart ?? 9)
        const current = container.slots?.[source]
        if (!Number.isInteger(source) || source < container.inventoryStart || source >= container.inventoryEnd ||
          !current || current.type !== item.type || current.metadata !== item.metadata ||
          !isDeepStrictEqual(current.nbt, item.nbt) || !isDeepStrictEqual(current.components, item.components)) {
          fail('NOT_FOUND', 'Selected stack changed while opening the container.')
        }
        await bot.transfer({ window: container, itemType: item.type, metadata: item.metadata ?? null, nbt: item.nbt,
          count: Math.min(current.count, itemCount(item, step.count)), sourceStart: source, sourceEnd: source + 1, destStart: 0, destEnd: container.inventoryStart })
      } finally { ctx.signal?.removeEventListener('abort', close); close() }
    }),
    disconnect: id => manager.disconnect(id),
    async reconnect(id, step, ctx) {
      const account = session(id)?.account || manager.reconnects?.get(id)?.account
      if (!account) fail('OFFLINE', 'Account configuration unavailable.')
      const previous = sessionId(id), attempts = Math.max(1, Math.min(1000, Math.floor(step.maxAttempts || 1)))
      const nextCtx = { ...ctx, sessionId: null }
      for (let attempt = 0; attempt < attempts; attempt++) {
        manager.disconnect(id)
        try {
          await sleep(step.delaySec != null ? step.delaySec * 1000 : step.delayMs ?? 0, ctx.signal)
          check(id, nextCtx, false)
          manager.connect(account)
          await until(id, nextCtx, () => sessionId(id) !== previous && session(id)?.ready && session(id)?.bot?.entity, step.giveUpAfterMs ?? 60000)
          return
        } catch (error) {
          manager.disconnect(id)
          if (error.code === 'ABORTED' || attempt + 1 === attempts) throw error
        }
      }
    }
  }
  const facade = {
    sessionId,
    state(id) {
      const s = session(id), bot = s?.bot, telemetry = bot ? buildTelemetry(bot, s.nearestChest, s.resourcePack) : {}
      const occupied = new Set((telemetry.inventory || []).map(item => item.slot))
      return { ...telemetry, online: !!(s?.ready && bot?.entity), sessionId: sessionId(id), edition: 'java', windowOpen: !!bot?.currentWindow,
        inventoryFull: !!bot?.entity && Array.from({ length: 36 }, (_, i) => i + 9).every(slot => occupied.has(slot)),
        entities: bot?.entity?.position ? Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position).map(e => ({ id: e.id, name: e.name, username: e.username, type: e.type === 'player' ? 'player' : 'mob', distance: distance(e.position, bot.entity.position) })) : [] }
    },
    releaseOwner: (id, owner) => release(id, owner)
  }
  for (const type of FACADE_METHODS.filter(name => !facade[name])) {
    facade[type] = async (id, step = {}, ctx = {}) => {
      const lifecycle = type === 'disconnect' || type === 'reconnect'
      check(id, ctx, !lifecycle)
      try {
        const result = await handlers[type](id, step, ctx)
        if (!lifecycle) check(id, ctx)
        return result
      } catch (error) {
        if (error instanceof MacroActionError) throw error
        throw new MacroActionError('INVALID', error?.message || 'Action failed.')
      }
    }
  }
  return facade
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function itemCount(item, requested = item.count) {
  if (!Number.isInteger(requested) || requested < 1) fail('INVALID', 'Invalid item count.')
  return Math.min(item.count, requested)
}
module.exports = { createFacade }
