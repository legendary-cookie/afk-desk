'use strict'

function stripFormatting(text) { return String(text || '').replace(/§[0-9a-fk-or]/gi, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') }
function inventorySignature(items) { return (Array.isArray(items) ? items : []).map((item) => `${Number(item?.slot) || 0}:${String(item?.name || '')}:${Number(item?.count) || 0}`).join('|') }
function createBotEventAdapter({ sessionId = () => null, isManualDisconnect = () => false, now = Date.now } = {}) {
  const spawned = new Map(), world = new Map(), lastSession = new Map(), lastHealth = new Map()
  return function adapt(type, accountId, payload = {}) {
    const sid = sessionId(accountId) || (type === 'status' && ['offline', 'reconnecting'].includes(payload.status) ? lastSession.get(accountId) : null)
    if (!sid) return []
    if (type !== 'status' || payload.status !== 'offline') lastSession.set(accountId, sid)
    const at = Number(payload.at) || now()
    const make = (eventType, data = {}) => ({ type: eventType, accountId, sessionId: sid, at, ...(Object.keys(data).length ? { payload: data } : {}) })
    if (type === 'status') {
      if (payload.status === 'connected') return [make('login')]
      if (payload.status === 'online') {
        const events = []
        if (spawned.get(accountId) !== sid) { spawned.set(accountId, sid); events.push(make('connected'), make('spawn')) }
        else events.push(make('serverSwitch'))
        return events
      }
      if (payload.status === 'offline') { spawned.delete(accountId); world.delete(accountId); lastHealth.delete(accountId); return [make('disconnected', { reason: String(payload.detail || 'Disconnected'), manual: isManualDisconnect(accountId, payload) })] }
      if (payload.status === 'reconnecting') return [make('disconnected', { reason: String(payload.detail || 'Reconnecting'), manual: false })]
      return []
    }
    if (type === 'spawn') { if (spawned.get(accountId) === sid) return []; spawned.set(accountId, sid); return [make('spawn')] }
    if (type === 'log' && payload.kind === 'chat') return [make('chat', { text: stripFormatting(payload.message), source: 'chat' })]
    if (type === 'log' && payload.kind === 'sent') return [make('sentChat', { text: stripFormatting(payload.message) })]
    if (type === 'telemetry') {
      const inventory = Array.isArray(payload.inventory) ? payload.inventory : []
      const occupied = new Set(inventory.map((item) => Number(item?.slot)))
      let full = true; for (let slot = 9; slot <= 44; slot++) if (!occupied.has(slot)) { full = false; break }
      const data = { health: Number(payload.health), food: Number(payload.food), inventoryFull: full, inventorySignature: inventorySignature(inventory), dimension: payload.dimension, world: payload.world || payload.environment?.world }
      const previousHealth = lastHealth.get(accountId); lastHealth.set(accountId, data.health)
      const old = world.get(accountId); world.set(accountId, { dimension: data.dimension, world: data.world })
      return [make('telemetry', data), ...(previousHealth > 0 && data.health <= 0 ? [make('death')] : []), ...(old && (old.dimension !== data.dimension || old.world !== data.world) ? [make('serverSwitch', { dimension: data.dimension, world: data.world, backend: data.world })] : [])]
    }
    if (type === 'window' && payload.open === false) return [make('windowClose')]
    if (type === 'window') return [make('windowOpen', { title: stripFormatting(payload.title || payload.name || '') })]
    if (type === 'log' && payload.kind === 'error' && /kicked:/i.test(payload.message || '')) return []
    if (type === 'death') return [make('death')]
    if (type === 'respawn' || type === 'login' || type === 'serverSwitch') return [make(type, { dimension: payload.dimension, world: payload.world, backend: payload.backend })]
    return []
  }
}
module.exports = { createBotEventAdapter, stripFormatting, inventorySignature }
