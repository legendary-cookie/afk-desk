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
      if (shouldLowHealthAct(config, bot.health)) {
        if (config.lowHealthTotem && !bot.currentWindow && !session.depositing && !session.inputClaims?.get('rightClick')?.size) {
          await manager.withInventoryAction(account.id, async () => {
            const current = session.account
            const locks = new Set((current.lockedInventorySlots || []).map(Number))
            if (manager.sessions.get(account.id) !== session || bot.currentWindow || session.depositing || session.inputClaims?.get('rightClick')?.size || !shouldLowHealthAct(current, bot.health) || !current.lowHealthTotem || locks.has(45) || bot.inventory?.slots?.[45]?.name === 'totem_of_undying') return
            const totem = bot.inventory?.items?.().find(item => item.name === 'totem_of_undying' && !locks.has(Number(item.slot)))
            if (totem) await bot.equip(totem, 'off-hand')
          })
        }
        if (config.lowHealthDisconnect) {
          state.cooldownUntil = Date.now() + (config.lowHealthCooldownMinutes ?? 10) * 60000
          state.safetyPause = 'health'
          manager.emit('safety-disconnect', account.id, { health: bot.health, cooldownUntil: state.cooldownUntil })
          bot.end('Low health protection')
          return
        }
      }
      if (shouldEat(config, bot) && !session.depositing && !session.inputClaims?.get('rightClick')?.size) {
        await manager.withInventoryAction(account.id, async () => {
          const current = session.account
          if (manager.sessions.get(account.id) !== session || session.depositing || !shouldEat(current, bot) || session.inputClaims?.get('rightClick')?.size) return
          const locks = new Set((current.lockedInventorySlots || []).map(Number))
          const food = pickFood(bot.inventory?.items?.(), bot.registry?.foodsByName, [...locks])
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
}
module.exports = { shouldEat, pickFood, shouldLowHealthAct, isWithinSchedule, deferSafety, installSafety }
