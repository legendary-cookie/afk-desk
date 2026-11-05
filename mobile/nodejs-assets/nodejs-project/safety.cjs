'use strict'

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
  const candidates = (bot.inventory?.items?.() || []).filter(item => item.slot >= 9 && item.slot <= 44 && !locks.has(Number(item.slot))).map(item => ({ item, stats: armorStats(item, suffix, bot.registry) })).filter(entry => entry.stats)
  if (currentStats) candidates.push({ item: current, stats: currentStats })
  candidates.sort((a, b) => {
    const healthy = x => x.durability >= threshold ? 1 : 0
    return healthy(b.stats) - healthy(a.stats) || b.stats.tier - a.stats.tier || b.stats.protection - a.stats.protection || b.stats.durability - a.stats.durability
  })
  return candidates[0]?.item === current ? null : candidates[0]?.item || null
}
function shouldEat(account, bot) {
  return account.autoEat === true && Number.isFinite(bot.food) && bot.food <= (account.autoEatThreshold ?? 14) && !bot.currentWindow
}
function pickFood(items, foods, locked = [], priority = 'hotbar', allowGoldenApples = false) {
  const locks = new Set(locked.map(Number))
  return (items || []).filter(item => !locks.has(Number(item.slot)) && foods?.[item.name] && (allowGoldenApples || !['golden_apple', 'enchanted_golden_apple'].includes(item.name))).sort((a, b) => {
    const hot = (item) => item.slot >= 36 && item.slot <= 44 ? 1 : 0
    const value = (item) => Number(foods[item.name].foodPoints || 0) + Number(foods[item.name].saturation || 0)
    return priority === 'nutrition' ? value(b) - value(a) || hot(b) - hot(a) : hot(b) - hot(a) || value(b) - value(a)
  })[0] || null
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
    if (state.safetyPause === 'health' && current.autoReconnect === false) { manager.reconnects.delete(account.id); manager.status(account.id, 'offline', 'Auto-reconnect disabled.'); return }
    if (Date.now() < (state.cooldownUntil || 0) || !isWithinSchedule(current)) return deferSafety(manager, current, state)
    try { manager.connect(current, { reconnecting: true }) } catch (error) { manager.scheduleReconnect(current, error.message) }
  }, 30000)
  state.timer?.unref?.()
}
function installSafety(manager, account, session, state) {
  const bot = session.bot
  const tick = async () => {
    if (manager.sessions.get(account.id) !== session || session.safetyBusy) return
    const config = session.account
    if (!isWithinSchedule(config)) { state.safetyPause = 'schedule'; bot.end('Outside online hours'); return }
    if (!session.ready) return
    session.safetyBusy = true
    try {
      if (config.autoTotem || shouldLowHealthAct(config, bot.health)) {
        if ((config.autoTotem || config.lowHealthTotem && shouldLowHealthAct(config, bot.health)) && !bot.currentWindow && !session.depositing && !session.inputClaims?.get('rightClick')?.size) {
          await manager.withInventoryAction(account.id, async () => {
            const current = session.account
            const locks = new Set((current.lockedInventorySlots || []).map(Number))
            if (manager.sessions.get(account.id) !== session || bot.currentWindow || session.depositing || session.inputClaims?.get('rightClick')?.size || !(current.autoTotem || current.lowHealthTotem && shouldLowHealthAct(current, bot.health)) || locks.has(45) || bot.inventory?.slots?.[45]?.name === 'totem_of_undying') return
            const totem = bot.inventory?.items?.().find(item => item.name === 'totem_of_undying' && !locks.has(Number(item.slot)))
            if (totem) await bot.equip(totem, 'off-hand')
          })
        }
        if (config.lowHealthDisconnect && shouldLowHealthAct(config, bot.health)) {
          state.cooldownUntil = Date.now() + (config.lowHealthCooldownMinutes ?? 10) * 60000
          state.safetyPause = 'health'
          manager.emit('safety-disconnect', account.id, { health: bot.health, cooldownUntil: state.cooldownUntil })
          bot.end('Low health protection')
          return
        }
      }
      if (config.autoArmor && !bot.currentWindow && !session.depositing && !session.inputClaims?.get('rightClick')?.size) {
        await manager.withInventoryAction(account.id, async () => {
          for (const [destination, slot, suffix] of armorSlots) {
            const current = session.account
            if (manager.sessions.get(account.id) !== session || !session.ready || !current.autoArmor || bot.currentWindow || session.depositing || session.inputClaims?.get('rightClick')?.size) return
            const item = chooseArmor(bot, current, destination, slot, suffix)
            if (item) await bot.equip(item, destination)
          }
        })
      }
      if (shouldEat(config, bot) && !session.depositing && !session.inputClaims?.get('rightClick')?.size) {
        await manager.withInventoryAction(account.id, async () => {
          const current = session.account
          if (manager.sessions.get(account.id) !== session || session.depositing || !shouldEat(current, bot) || session.inputClaims?.get('rightClick')?.size) return
          const locks = new Set((current.lockedInventorySlots || []).map(Number))
          const food = pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, [...locks], current.autoEatPriority, current.autoEatAllowGoldenApples)
          if (!food) return
          const source = Number(food.slot)
          const target = source >= 36 && source <= 44 ? source : Array.from({ length: 9 }, (_, i) => i + 36).find(slot => !locks.has(slot))
          if (target === undefined) return
          const previous = bot.quickBarSlot
          let swapped = false
          let release
          session.safetyInputDone = new Promise(resolve => { release = resolve })
          try {
            if (source !== target) { await bot.moveSlotItem(source, target); swapped = true }
            bot.setQuickBarSlot(target - 36)
            if (!bot.currentWindow && !session.depositing && manager.sessions.get(account.id) === session) await bot.consume()
          } finally {
            try {
              while (swapped && manager.sessions.get(account.id) === session && bot.currentWindow) await new Promise(resolve => setTimeout(resolve, 50))
              if (swapped && manager.sessions.get(account.id) === session) {
                if (bot.inventory?.slots?.[target]) await bot.moveSlotItem(target, source)
                else if (bot.inventory?.slots?.[source]) await bot.moveSlotItem(source, target)
              }
              if (Number.isInteger(previous) && manager.sessions.get(account.id) === session) bot.setQuickBarSlot(previous)
            } finally { session.safetyInputDone = null; release() }
          }
        })
      }
    } catch (error) { manager.emit('log', account.id, { kind: 'error', message: `Safety action failed: ${error.message}`, at: Date.now() }) }
    finally { session.safetyBusy = false }
  }
  session.safetyTimer = setInterval(tick, 2000)
  session.safetyTimer.unref?.()
  bot.on('health', tick)
  bot.inventory?.on?.('updateSlot', tick)
}
module.exports = { chooseArmor, armorStats, shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule, deferSafety, installSafety }
