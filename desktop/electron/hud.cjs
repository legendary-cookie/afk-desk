'use strict'
const COLORS = {black:'#000000',dark_blue:'#0000aa',dark_green:'#00aa00',dark_aqua:'#00aaaa',dark_red:'#aa0000',dark_purple:'#aa00aa',gold:'#ffaa00',gray:'#aaaaaa',dark_gray:'#555555',blue:'#5555ff',green:'#55ff55',aqua:'#55ffff',red:'#ff5555',light_purple:'#ff55ff',yellow:'#ffff55',white:'#ffffff'}
const codes = Object.keys(COLORS)
function segments(input) {
  const out = []; let remaining = 256
  function add(text, color) {
    text = String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, remaining); remaining -= text.length
    if (text) out.push({text, color: COLORS[color] || (/^#[0-9a-f]{6}$/i.test(color || '') ? color : '#ffffff')})
  }
  function walk(value, inherited = 'white', depth = 0) {
    if (depth > 12 || remaining <= 0 || value == null) return
    if (typeof value === 'string') {
      if (/^\s*[\[{]/.test(value)) { try { return walk(JSON.parse(value), inherited, depth + 1) } catch {} }
      let color = inherited, start = 0; const re = /§([0-9a-fklmnor])/ig; let m
      while ((m = re.exec(value))) { add(value.slice(start, m.index), color); const c = m[1].toLowerCase(); if ('0123456789abcdef'.includes(c)) color = codes[parseInt(c, 16)]; else if (c === 'r') color = 'white'; start = re.lastIndex }
      add(value.slice(start), color); return
    }
    if (Array.isArray(value)) { for (const v of value.slice(0, 100)) walk(v, inherited, depth + 1); return }
    if (typeof value === 'object') { if (typeof value.toJSON === 'function') { try { const v = value.toJSON(); if (v !== value) return walk(v, inherited, depth + 1) } catch {} }
      const color = value.color || inherited; walk(value.text ?? value.translate ?? '', color, depth + 1); if (value.extra) walk(value.extra, color, depth + 1)
    }
  }
  walk(input); return out
}
function roman(n) { n = Math.max(1, Math.min(255, Math.floor(Number(n) || 1))); const pairs = [[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; return pairs.map(([v,s]) => { const count = Math.floor(n/v); n %= v; return s.repeat(count) }).join('') }
function duration(seconds) { if (seconds == null) return '∞'; seconds = Math.max(0, Math.ceil(seconds)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function barModel(bar) { return {id:String(bar.entityUUID || '').slice(0,80), title:segments(bar.title), health:Math.max(0, Math.min(1, Number(bar.health) || 0)), color:['pink','blue','red','green','yellow','purple','white'].includes(bar.color) ? bar.color : 'purple', divisions:[0,6,10,12,20].includes(bar.dividers) ? bar.dividers : 0} }
// A proxy may leave Mineflayer's read-only bossBars cache populated across
// worlds. Keep a session-local view rather than trying to mutate that cache.
const BOSS_BAR_STALE_MS = 90_000
function installBossBarTracking(bot, changed = () => {}, { staleMs = BOSS_BAR_STALE_MS } = {}) {
  if (bot.__afkDeskBossBars) { bot.__afkDeskBossBars.changed = changed; return bot.__afkDeskBossBars }
  const state = { bars: new Map(), staleMs, changed, dimension: bot.game?.dimension }
  bot.__afkDeskBossBars = state
  const idOf = bar => bar?.entityUUID ?? bar?.uuid ?? bar?.id
  const update = (bar, create = false) => {
    const id = idOf(bar)
    if (id == null || !create && !state.bars.has(id)) return
    state.bars.set(id, { bar, lastUpdated: Date.now() })
    state.changed()
  }
  const remove = bar => {
    state.bars.delete(typeof bar === 'string' ? bar : idOf(bar))
    state.changed()
  }
  const clear = () => { state.bars.clear(); state.dimension = bot.game?.dimension; state.changed() }
  for (const bar of bot.bossBars || []) state.bars.set(idOf(bar), { bar, lastUpdated: Number.isFinite(bar.lastUpdated) ? bar.lastUpdated : Date.now() })
  bot.on?.('bossBarCreated', bar => update(bar, true))
  bot.on?.('bossBarUpdated', bar => update(bar))
  bot.on?.('bossBarDeleted', remove)
  for (const event of ['login', 'respawn']) bot.on?.(event, clear)
  bot.on?.('game', () => {
    const dimension = bot.game?.dimension
    if (dimension != null && dimension !== state.dimension) clear()
  })
  for (const packet of ['login', 'respawn', 'start_configuration']) bot._client?.on?.(packet, clear)
  for (const packet of ['boss_bar', 'bossbar', 'boss_bar_update']) bot._client?.on?.(packet, data => {
    const id = idOf(data)
    const action = String(data.action).toLowerCase()
    if (['1', 'remove', 'delete'].includes(action)) { remove(data); return }
    const create = ['0', 'add', 'create'].includes(action)
    const previous = state.bars.get(id)?.bar
    if (!create && !previous) return
    const bar = { entityUUID: id, title: data.title ?? previous?.title, health: data.health ?? previous?.health,
      color: typeof data.color === 'number' ? ['pink','blue','red','green','yellow','purple','white'][data.color] : data.color ?? previous?.color,
      dividers: data.dividers == null ? previous?.dividers : [0,6,10,12,20][data.dividers] }
    update(bar, true)
  })
  return state
}
function activeBossBars(bot, now = Date.now()) {
  if (!bot) return []
  const state = bot.__afkDeskBossBars || installBossBarTracking(bot)
  return [...state.bars.values()].filter(entry => now - entry.lastUpdated < state.staleMs).map(entry => entry.bar)
}

function installHud(bot, changed) {
  installBossBarTracking(bot, () => setImmediate(changed))
  const effects = new Map(); const titles = new Map(); bot.__hud = {effects, titles, sidebarName: undefined}
  bot._client?.on?.('scoreboard_objective', p => { if (p.action === 1) titles.delete(p.name); else if (p.displayText != null) titles.set(p.name, p.displayText) })
  bot._client?.on?.('scoreboard_display_objective', p => { if (p.position === 1 || p.position === 'sidebar') { bot.__hud.sidebarName = p.name || null; setImmediate(changed) } })
  bot.on('entityEffect', (entity, effect) => { if (!bot.entity || entity?.id !== bot.entity.id) return; effects.set(effect.id, { ...effect, expires: effect.duration < 0 || effect.duration >= 2147483647 ? null : Date.now() + Math.max(0,effect.duration) * 50 }); changed() })
  bot.on('entityEffectEnd', (entity, effect) => { if (!bot.entity || entity?.id !== bot.entity.id) return; effects.delete(effect.id); changed() })
  for (const event of ['scoreboardCreated','scoreboardDeleted','scoreboardTitleChanged','scoreboardPosition','scoreUpdated','scoreRemoved','teamCreated','teamRemoved','teamUpdated','teamMemberAdded','teamMemberRemoved','bossBarCreated','bossBarDeleted','bossBarUpdated']) bot.on(event, () => setImmediate(changed))
}
function snapshot(bot, now = Date.now()) {
  const selected = bot?.__hud?.sidebarName
  const board = selected === null ? null : selected === undefined ? bot?.scoreboard?.sidebar : bot?.scoreboards?.[selected]
  const scoreboard = board ? {title:segments(bot.__hud?.titles.get(board.name) ?? board.title), lines:(board.items || []).filter(i => !String(i.name).startsWith('#')).slice(0,15).map(i => ({text:segments(i.displayName ?? i.name), score:Number(i.value) || 0}))} : null
  const effects = [...(bot?.__hud?.effects?.values() || [])].filter(e => e.expires == null || e.expires > now).slice(0,64).map(e => { const info = bot.registry?.effects?.[e.id] || bot.registry?.effectsByName?.[e.id]; const name = String(info?.displayName || info?.name || e.id).replace(/[\x00-\x1f\x7f-\x9f]/g,'').slice(0,80).replace(/_/g,' '); const amplifier = Math.max(0, Math.min(254, Number(e.amplifier) || 0)); const seconds = e.expires == null ? null : Math.max(0, Math.ceil((e.expires-now)/1000)); return {name, amplifier, seconds, label:`${name}${amplifier ? ' ' + roman(amplifier+1) : ''}`, countdown:duration(seconds)} })
  return {scoreboard, effects, bossBars:activeBossBars(bot, now).slice(0,32).map(barModel)}
}
module.exports = {BOSS_BAR_STALE_MS, installBossBarTracking, activeBossBars, segments, roman, duration, barModel, installHud, snapshot}
