'use strict'

function shouldEat(account, bot) {
  return account.autoEat === true && Number.isFinite(bot.food) && bot.food <= (account.autoEatThreshold ?? 14) && !bot.currentWindow
}
function pickFood(items, foods, locked = []) {
  const locks = new Set(locked.map(Number))
  return (items || []).filter(item => !locks.has(Number(item.slot)) && foods?.[item.name]).sort((a, b) => {
    const hot = (item) => item.slot >= 36 && item.slot <= 44 ? 1 : 0
    const value = (item) => Number(foods[item.name].foodPoints || 0) + Number(foods[item.name].saturation || 0)
    return hot(b) - hot(a) || value(b) - value(a)
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
  manager.status(account.id, 'offline', 'Waiting for safety cooldown or online hours.')
  state.timer = manager.scheduleReconnectTimer(() => {
    state.timer = null
    if (manager.reconnects.get(account.id) !== state || state.manual) return
    const current = state.account
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
      if (shouldLowHealthAct(config, bot.health)) {
        if (config.lowHealthTotem && !bot.currentWindow && !(config.lockedInventorySlots || []).includes(45) && bot.inventory?.slots?.[45]?.name !== 'totem_of_undying') {
          const totem = bot.inventory?.items?.().find(item => item.name === 'totem_of_undying' && !(config.lockedInventorySlots || []).includes(item.slot))
          if (totem) {
            try { await bot.equip(totem, 'off-hand') } catch (error) { manager.emit('log', account.id, { kind: 'error', message: `Totem equip failed: ${error.message}`, at: Date.now() }) }
          }
        }
        if (config.lowHealthDisconnect) {
          state.cooldownUntil = Date.now() + (config.lowHealthCooldownMinutes ?? 10) * 60000
          state.safetyPause = 'health'
          manager.emit('safety-disconnect', account.id, { health: bot.health, cooldownUntil: state.cooldownUntil })
          bot.end('Low health protection')
          return
        }
      }
      if (shouldEat(config, bot) && !session.inventoryAction && !session.depositing) {
        const food = pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, config.lockedInventorySlots || [])
        if (food) {
          const previous = bot.quickBarSlot
          const target = food.slot >= 36 && food.slot <= 44 ? food.slot - 36 : Array.from({ length: 9 }, (_, slot) => slot).find(slot => !(config.lockedInventorySlots || []).includes(slot + 36))
          if (target === undefined) return
          session.inventoryAction = true
          try { bot.setQuickBarSlot(target); await bot.equip(food, 'hand'); if (!bot.currentWindow) await bot.consume() } finally { if (Number.isInteger(previous)) bot.setQuickBarSlot(previous); session.inventoryAction = false }
        }
      }
    } catch (error) { manager.emit('log', account.id, { kind: 'error', message: `Safety action failed: ${error.message}`, at: Date.now() }) }
    finally { session.safetyBusy = false }
  }
  session.safetyTimer = setInterval(tick, 2000)
  session.safetyTimer.unref?.()
  bot.on('health', tick)
}
module.exports = { shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule, deferSafety, installSafety }
