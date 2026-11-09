'use strict'
const { boundedAction, INVENTORY_TIMEOUT_MS } = require('./inventory-action.cjs')

// Inventory slots 5–8 are the player's equipped armor.
const armorSlots = [['head', 5, 'helmet'], ['torso', 6, 'chestplate'], ['legs', 7, 'leggings'], ['feet', 8, 'boots']]
const armorTiers = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
function armorStats(item, suffix, registry) {
  const match = /^(leather|golden|chainmail|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(item?.name || '')
  if (!match || match[2] !== suffix) return null
  const maximum = Number(item.maxDurability)
  const durability = maximum > 0 ? Math.max(0, Math.min(100, 100 * (maximum - (Number(item.durabilityUsed) || 0)) / maximum)) : 100
  let enchants = []
  try { enchants = item.enchants || [] } catch {}
  const levels = enchants?.levels || enchants
  const entries = Array.isArray(levels) ? levels : levels instanceof Map ? [...levels].map(([name, level]) => ({ name, level })) : Object.entries(levels || {}).map(([name, level]) => ({ name, level }))
  const protection = entries.reduce((best, e) => {
    const id = e.name ?? e.id
    const name = registry?.enchantments?.[id]?.name ?? id
    return String(name).replace(/^minecraft:/, '') === 'protection' ? Math.max(best, Number(e.lvl ?? e.level) || 0) : best
  }, 0)
  return { tier: armorTiers[match[1]], protection, durability }
}
function chooseArmor(bot, account, destination, slot, suffix) {
  const locks = new Set((account.lockedInventorySlots || []).map(Number))
  if (locks.has(slot)) return null
  const threshold = Math.max(0, Math.min(100, Number(account.autoArmorThreshold ?? 5) || 0))
  const current = bot.inventory?.slots?.[slot]
  // Do not displace non-armor equipment such as elytra, or binding-cursed armor.
  const currentStats = armorStats(current, suffix, bot.registry)
  if (current && !currentStats) return null
  try {
    const enchants = current?.enchants || []
    const levels = enchants.levels || enchants
    if (Array.isArray(levels) ? levels.some(e => /(?:binding_curse|curse_of_binding)$/.test(String(e.name ?? e.id))) : Object.keys(levels || {}).some(key => /(?:binding_curse|curse_of_binding)$/.test(key))) return null
  } catch { return null }
  const candidates = (bot.inventory?.items?.() || []).filter(item => item.slot >= 9 && item.slot <= 44).map(item => ({ item, stats: armorStats(item, suffix, bot.registry) })).filter(entry => entry.stats)
  if (currentStats) candidates.push({ item: current, stats: currentStats })
  candidates.sort((a, b) => {
    const healthy = x => x.durability >= threshold ? 1 : 0
    return healthy(b.stats) - healthy(a.stats) || b.stats.tier - a.stats.tier || b.stats.protection - a.stats.protection || b.stats.durability - a.stats.durability
  })
  return candidates[0]?.item === current ? null : candidates[0]?.item || null
}
function shouldEat(account, bot, ignoreWindow = false) {
  return account.autoEat === true && Number.isFinite(bot.food) && bot.food <= (account.autoEatThreshold ?? 14) && (ignoreWindow || !bot.currentWindow)
}
function pickFood(items, foods, locked = [], priority = 'hotbar', allowGoldenApples = false) {
  return (items || []).filter(item => item.slot >= 9 && item.slot <= 44 && foods?.[item.name] && (allowGoldenApples || !['golden_apple', 'enchanted_golden_apple'].includes(item.name))).sort((a, b) => {
    const hot = (item) => item.slot >= 36 && item.slot <= 44 ? 1 : 0
    const value = (item) => Number(foods[item.name].foodPoints || 0) + Number(foods[item.name].saturation || 0)
    return priority === 'nutrition' ? value(b) - value(a) || hot(b) - hot(a) : hot(b) - hot(a) || value(b) - value(a)
  })[0] || null
}
function hasEffect(bot, name) {
  const effects = bot.entity?.effects || {}
  const id = bot.registry?.effectsByName?.[name]?.id
  return (id != null && effects[id] != null) || Object.keys(effects).some(key => key.replace(/[^a-z]/gi, '').toLowerCase() === name.toLowerCase())
}
function hasRaid(bot, now = Date.now()) {
  return require('./hud.cjs').activeBossBars(bot, now).some(bar => {
    const parts = require('./hud.cjs').segments(bar.title).map(part => part.text)
    return /^Raid/.test(parts.join('')) || parts.some(text => /^event\.minecraft\.raid(?:\.(?:victory|defeat))?$/.test(text))
  })
}
function bottleAmplifier(item) {
  const component = item.components?.find(c => String(c.type ?? c.name).replace('minecraft:', '') === 'ominous_bottle_amplifier')
  let value = component?.data ?? component?.value ?? item.nbt?.value?.OminousBottleAmplifier?.value ?? item.nbt?.OminousBottleAmplifier
  while (value && typeof value === 'object') value = value.value
  return Number.isInteger(Number(value)) && value != null ? Number(value) : 0
}
function pickConsumable(account, bot, lastDamage, lastBottle, now = Date.now(), ignoreWindow = false) {
  if ((!ignoreWindow && bot.currentWindow) || !(bot.health > 0)) return null
  const items = (bot.inventory?.items?.() || []).filter(item => item.slot >= 9 && item.slot <= 44)
  if (account.autoGoldenApple && (bot.health <= (Number(account.autoGoldenAppleHealth ?? 10)) || (lastDamage != null && now - lastDamage < 10000 && (!hasEffect(bot, 'Absorption') || !hasEffect(bot, 'Regeneration'))))) {
    const preferred = account.autoGoldenApplePreference === 'enchanted' ? 'enchanted_golden_apple' : 'golden_apple'
    const apple = items.find(item => item.name === preferred) || items.find(item => ['golden_apple', 'enchanted_golden_apple'].includes(item.name))
    if (apple) return apple
  }
  if (account.autoOminousBottle && !hasEffect(bot, 'BadOmen') && !hasEffect(bot, 'RaidOmen') && !hasEffect(bot, 'TrialOmen') && !hasRaid(bot, now) && (lastBottle == null || now - lastBottle >= (Number(account.autoOminousCooldown ?? 0) * 1000))) {
    const bottles = items.filter(item => item.name === 'ominous_bottle')
    const order = account.autoOminousOrder ?? (account.autoOminousAmplifier == null || Number(account.autoOminousAmplifier) >= 4 ? 'highest' : 'lowest')
    return bottles.sort((a, b) => (order === 'lowest' ? 1 : -1) * (bottleAmplifier(a) - bottleAmplifier(b)))[0] || null
  }
  return null
}
async function consumeItem(bot, item, signal) {
  if (item.name !== 'ominous_bottle') return bot.consume()
  // Mineflayer's consume() rejects bottles at full hunger, though the game allows them.
  const type = item.type, count = item.count
  await new Promise((resolve, reject) => {
    let finished = false
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer); bot.removeListener('heldItemChanged', changed); signal?.removeEventListener('abort', aborted)
      try { bot.deactivateItem() } catch (failure) { error ||= failure }
      error ? reject(error) : resolve()
    }
    const aborted = () => finish(signal.reason)
    const changed = held => { if (!held || held.type !== type || held.count !== count) finish() }
    const timer = setTimeout(() => finish(new Error('Bottle consumption timed out')), 5000)
    bot.on('heldItemChanged', changed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) { aborted(); return }
    try { bot.activateItem() } catch (error) { finish(error) }
  })
}
function shouldLowHealthAct(account, health) {
  return Number.isFinite(health) && health > 0 && health <= (account.lowHealthThreshold ?? 6) && (account.lowHealthTotem === true || account.lowHealthDisconnect === true)
}
function isWithinSchedule(account, date = new Date()) {
  if (!account.scheduleEnabled) return true
  const parse = value => { const m = /^(\d{2}):(\d{2})$/.exec(value || ''); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null }
  const start = parse(account.scheduleStart), end = parse(account.scheduleEnd)
  if (start === null || end === null) return false
  const days = account.scheduleDays || [0, 1, 2, 3, 4, 5, 6]
  const now = date.getHours() * 60 + date.getMinutes(), day = date.getDay()
  if (start === end) return days.includes(day)
  if (start < end) return days.includes(day) && now >= start && now < end
  return now >= start ? days.includes(day) : now < end && days.includes((day + 6) % 7)
}
function deferSafety(manager, account, state) {
  if (state.timer) manager.clearReconnectTimer(state.timer)
  state.account = account
  manager.reconnects.set(account.id, state)
  manager.status(account.id, 'reconnecting', 'Waiting for safety cooldown or online hours.')
  state.timer = manager.scheduleReconnectTimer(() => {
    state.timer = null
    if (manager.reconnects.get(account.id) !== state || state.manual) return
    const current = state.account
    if (state.safetyPause === 'health' && current.autoReconnect === false) { if (!(state.cooldownUntil > Date.now())) manager.reconnects.delete(account.id); manager.status(account.id, 'offline', 'Auto-reconnect disabled.'); return }
    if (Date.now() < (state.cooldownUntil || 0) || !isWithinSchedule(current)) return deferSafety(manager, current, state)
    try { manager.connect(current, { reconnecting: true }) } catch (error) { manager.scheduleReconnect(current, error.message) }
  }, 30000)
  state.timer?.unref?.()
}
function installSafety(manager, account, session, state, { actionTimeoutMs = INVENTORY_TIMEOUT_MS, cleanupTimeoutMs = 2000 } = {}) {
  const bot = session.bot
  require('./hud.cjs').installBossBarTracking(bot)
  let previousHealth = bot.health, lastDamage = null, lastBottle = null
  let popPending = false, popTimer = null, disconnecting = false
  const disconnect = reason => {
    if (disconnecting || manager.sessions.get(account.id) !== session || !session.ready) return
    disconnecting = true
    state.cooldownUntil = Date.now() + (Number(session.account.lowHealthCooldownMinutes ?? 10) * 60000)
    state.safetyPause = 'health'
    manager.emit('safety-disconnect', account.id, { reason, health: bot.health, cooldownUntil: state.cooldownUntil, notify: session.account.safetyDisconnectNotify === true })
    bot.end('Safety protection: ' + reason)
  }
  const equipmentWanted = () => {
    const current = session.account
    const locks = new Set((current.lockedInventorySlots || []).map(Number))
    const totem = (current.autoTotem || current.lowHealthTotem && shouldLowHealthAct(current, bot.health)) && !locks.has(45) && bot.inventory?.slots?.[45]?.name !== 'totem_of_undying' && bot.inventory?.items?.().some(item => item.name === 'totem_of_undying' && item.slot >= 9 && item.slot <= 44)
    return Boolean(totem || current.autoArmor && armorSlots.some(([destination, slot, suffix]) => chooseArmor(bot, current, destination, slot, suffix)))
  }
  const consumableWanted = () => {
    const current = session.account
    return Boolean(pickConsumable(current, bot, lastDamage, lastBottle, Date.now(), true) || shouldEat(current, bot, true) && pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, current.lockedInventorySlots, current.autoEatPriority, current.autoEatAllowGoldenApples))
  }
  const waits = new Map()
  let activeAction = null
  const status = message => {
    if (session.safetyStatus === message) return
    session.safetyStatus = message
    manager.emitTelemetry?.(account.id)
  }
  const waiting = (label, reason) => {
    const message = `${label} waiting: ${reason}`
    status(message)
    const now = Date.now()
    if (!waits.has(message) || now - waits.get(message) >= 60000) {
      waits.set(message, now)
      manager.emit('log', account.id, { kind: 'info', message, at: now })
    }
  }
  const wanted = () => {
    const config = session.account
    if (config.autoOminousBottle) return 'Ominous Bottle'
    if (config.autoGoldenApple) return 'Golden Apple'
    if (shouldEat(config, bot)) return 'Auto eat'
    if (config.autoTotem || config.lowHealthTotem && shouldLowHealthAct(config, bot.health)) return 'Auto totem'
    if (config.autoArmor) return 'Auto armor'
    return null
  }
  const blocked = () => !session.ready || session.switching ? 'server not ready'
    : session.depositing ? 'deposit in progress'
      : bot.currentWindow ? 'server menu open'
        : session.inputClaims?.get('rightClick')?.size ? 'right click owned by another action' : null
  const run = async (label, action) => {
    activeAction = label
    const previousStatus = session.safetyStatus
    status(`${label}: waiting for inventory`)
    try {
      await boundedAction(scope => manager.withInventoryAction(account.id, async () => {
        scope.check()
        if (manager.sessions.get(account.id) !== session) return
        const reason = blocked()
        if (reason) { waiting(label, reason); return }
        status(`${label}: in progress`)
        await action(scope)
        if (session.safetyStatus === `${label}: in progress`) status(previousStatus || 'Idle')
      }, { timeoutMs: actionTimeoutMs }), actionTimeoutMs, label)
    } catch (error) {
      waiting(label, String(error.message || error))
      // The wait log above is rate limited, including repeated timeouts.
    } finally { activeAction = null }
  }
  const tick = async () => {
    if (Number.isFinite(bot.health)) {
      if (Number.isFinite(previousHealth) && bot.health < previousHealth) lastDamage = Date.now()
      previousHealth = bot.health
    }
    if (manager.sessions.get(account.id) !== session) return
    const config = session.account
    const label = wanted()
    // Reserve the next free inventory turn before auto-deposit can start again.
    const consumablePending = consumableWanted()
    session.safetyPending = consumablePending || equipmentWanted()
    if (session.safetyBusy) { if (label) waiting(label, `${activeAction || 'another safety action'} in progress`); return }
    if (!isWithinSchedule(config)) { state.safetyPause = 'schedule'; bot.end('Outside online hours'); return }
    if (!session.ready || session.switching) { if (label) waiting(label, 'server not ready'); return }
    if (config.lowHealthDisconnect && Number.isFinite(bot.health) && bot.health >= 0 && bot.health <= Number(config.lowHealthThreshold ?? 6)) { disconnect('low health'); return }
    if (config.armorDisconnect && armorSlots.some(([, slot]) => {
      const item = bot.inventory?.slots?.[slot], max = Number(item?.maxDurability), used = Number(item?.durabilityUsed ?? 0)
      return Number.isFinite(max) && max > 0 && Number.isFinite(used) && 100 * (max - used) / max <= Number(config.armorDisconnectThreshold ?? 5)
    })) { disconnect('low armor durability'); return }
    const reason = blocked()
    if (reason) { if (label) waiting(label, reason); return }
    session.safetyBusy = true
    try {
      // Consumables must not sit behind an armor/totem equip that the server
      // never acknowledges. Each action also gets its own bounded queue wait.
      if (consumablePending) {
        const food = pickConsumable(config, bot, lastDamage, lastBottle) || pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, config.lockedInventorySlots, config.autoEatPriority, config.autoEatAllowGoldenApples)
        const actionLabel = food?.name === 'ominous_bottle' ? 'Ominous Bottle' : food?.name?.includes('golden_apple') ? 'Golden Apple' : 'Auto eat'
        await run(actionLabel, async scope => {
          const current = session.account
          const locks = new Set((current.lockedInventorySlots || []).map(Number))
          const food = pickConsumable(current, bot, lastDamage, lastBottle) || (shouldEat(current, bot) && pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, [...locks], current.autoEatPriority, current.autoEatAllowGoldenApples))
          if (!food) return
          const source = Number(food.slot)
          const hotbar = Array.from({ length: 9 }, (_, i) => i + 36).filter(slot => !locks.has(slot))
          const target = source >= 36 && source <= 44 ? source : (locks.has(source) ? hotbar.find(slot => !bot.inventory?.slots?.[slot]) : undefined) ?? hotbar[0]
          if (target === undefined) { waiting(actionLabel, 'all hotbar slots locked'); return }
          const previous = bot.quickBarSlot
          const lockedSource = locks.has(source) && source !== target
          const staging = lockedSource && bot.inventory?.slots?.[target] ? Array.from({ length: 36 }, (_, i) => i + 9).find(slot => slot !== source && slot !== target && !locks.has(slot) && !bot.inventory?.slots?.[slot]) : undefined
          if (lockedSource && bot.inventory?.slots?.[target] && staging === undefined) { waiting(actionLabel, 'no empty unlocked slot'); return }
          let staged = false
          let swapped = false
          let release
          session.safetyInputDone = new Promise(resolve => { release = resolve })
          try {
            if (staging !== undefined) { await scope.wait(() => bot.moveSlotItem(target, staging)); staged = true }
            if (source !== target) { await scope.wait(() => bot.moveSlotItem(source, target)); swapped = true }
            scope.check()
            if (blocked()) { waiting(actionLabel, blocked()); return }
            bot.setQuickBarSlot(target - 36)
            if (food.name === 'ominous_bottle' && (hasRaid(bot) || ['BadOmen', 'RaidOmen', 'TrialOmen'].some(effect => hasEffect(bot, effect)))) return
            await scope.wait(() => consumeItem(bot, food, scope.signal))
            if (food.name === 'ominous_bottle') lastBottle = Date.now()
            if (food.name === 'golden_apple' || food.name === 'enchanted_golden_apple') lastDamage = null
            status(`${actionLabel}: consumed`)
          } finally {
            try {
              // Never wait indefinitely for a GUI to close or a stack to return.
              if (swapped && !scope.signal.aborted) await scope.wait(() => boundedAction(async cleanup => {
                while (manager.sessions.get(account.id) === session && bot.currentWindow) await cleanup.wait(() => new Promise(resolve => setTimeout(resolve, 50)))
                if (manager.sessions.get(account.id) !== session) return
                const remaining = bot.inventory?.slots?.[target]
                if (remaining && (!lockedSource || remaining.name === food.name)) await cleanup.wait(() => bot.moveSlotItem(target, source))
                else if (!lockedSource && bot.inventory?.slots?.[source]) await cleanup.wait(() => bot.moveSlotItem(source, target))
                if (staged && !bot.inventory?.slots?.[target]) await cleanup.wait(() => bot.moveSlotItem(staging, target))
              }, cleanupTimeoutMs, 'Inventory restoration', scope.signal))
            } finally {
              try {
                if (Number.isInteger(previous) && manager.sessions.get(account.id) === session) bot.setQuickBarSlot(previous)
                if (scope.signal.aborted) { try { bot.deactivateItem?.() } catch {} }
              } finally { session.safetyInputDone = null; release() }
            }
          }
        })
      } else if (config.autoOminousBottle) {
        const bottle = bot.inventory?.items?.().some(item => item.name === 'ominous_bottle' && item.slot >= 9 && item.slot <= 44)
        waiting('Ominous Bottle', !(bot.health > 0) ? 'player not alive' : !bottle ? 'no bottles' : hasRaid(bot) ? 'raid active' : ['BadOmen', 'RaidOmen', 'TrialOmen'].some(effect => hasEffect(bot, effect)) ? 'omen effect active' : 'cooldown')
      }
      if (config.autoTotem || config.lowHealthTotem && shouldLowHealthAct(config, bot.health)) {
        await run('Auto totem', async scope => {
          const current = session.account
          const locks = new Set((current.lockedInventorySlots || []).map(Number))
          if (!(current.autoTotem || current.lowHealthTotem && shouldLowHealthAct(current, bot.health)) || locks.has(45) || bot.inventory?.slots?.[45]?.name === 'totem_of_undying') return
          const totem = bot.inventory?.items?.().find(item => item.name === 'totem_of_undying' && item.slot >= 9 && item.slot <= 44)
          if (totem) {
            if (locks.has(Number(totem.slot)) && bot.inventory?.slots?.[45]) {
              const empty = Array.from({ length: 36 }, (_, i) => i + 9).find(slot => !locks.has(slot) && !bot.inventory?.slots?.[slot])
              if (empty === undefined) { waiting('Auto totem', 'no empty unlocked slot'); return }
              await scope.wait(() => bot.moveSlotItem(45, empty))
            }
            await scope.wait(() => bot.equip(totem, 'off-hand')); status('Auto totem: equipped')
          }
        })
      }
      if (config.autoArmor) {
        await run('Auto armor', async scope => {
          for (const [destination, slot, suffix] of armorSlots) {
            scope.check()
            const current = session.account
            if (manager.sessions.get(account.id) !== session || blocked() || !current.autoArmor) return
            const item = chooseArmor(bot, current, destination, slot, suffix)
            if (item) {
              const locks = new Set((current.lockedInventorySlots || []).map(Number))
              if (locks.has(Number(item.slot)) && bot.inventory?.slots?.[slot]) {
                const empty = Array.from({ length: 36 }, (_, i) => i + 9).find(candidate => !locks.has(candidate) && !bot.inventory?.slots?.[candidate])
                if (empty === undefined) { waiting('Auto armor', 'no empty unlocked slot'); continue }
                await scope.wait(() => bot.moveSlotItem(slot, empty))
              }
              await scope.wait(() => bot.equip(item, destination)); status('Auto armor: equipped')
            }
          }
        })
      }
    } catch (error) { waiting(label || 'Safety', String(error.message || error)) }
    finally {
      session.safetyBusy = false
      session.safetyPending = consumableWanted() || equipmentWanted()
    }
  }
  session.safetyTimer = setInterval(tick, 2000)
  session.safetyTimer.unref?.()
  bot._client?.on('entity_status', packet => {
    if (packet.entityStatus !== 35 || packet.entityId !== bot.entity?.id || !session.account.totemDisconnect || manager.sessions.get(account.id) !== session || !session.ready) return
    popPending = true
    clearTimeout(popTimer)
    // The status packet can precede the inventory packet that consumes the totem.
    popTimer = setTimeout(() => {
      if (!popPending) return
      popPending = false
      if (session.account.totemDisconnect && !(bot.inventory?.slots || []).some(item => item?.name === 'totem_of_undying' && (item.count ?? 1) > 0)) disconnect('totems exhausted')
    }, 500)
    popTimer.unref?.()
  })
  bot.on('health', tick)
  bot.inventory?.on?.('updateSlot', tick)
}
module.exports = { hasRaid, consumeItem, hasEffect, bottleAmplifier, pickConsumable, chooseArmor, armorStats, shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule, deferSafety, installSafety }
