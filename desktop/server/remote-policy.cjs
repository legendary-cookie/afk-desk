'use strict'
const { auditActor } = require('../core/audit-identity.cjs')
// Remote contracts are intentionally closed: new desktop fields/channels require review here.
const text = (max = 128) => v => typeof v === 'string' && v.length <= max
const number = (min, max) => v => Number.isFinite(v) && v >= min && v <= max
const integer = (min, max) => v => Number.isInteger(v) && v >= min && v <= max
const bool = v => typeof v === 'boolean'
const oneOf = (...values) => v => values.includes(v)
const array = (rule, max = 500) => v => Array.isArray(v) && v.length <= max && v.every(rule)
const object = fields => v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, x]) => Object.hasOwn(fields, k) && fields[k](x))
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const slot = integer(0, 44)
const controls = oneOf('forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'swing')
const proxy = object({ enabled: bool, type: oneOf('http', 'socks5'), host: text(255), port: integer(1, 65535), username: text(128), password: text(512), clearPassword: bool, hasPassword: bool })
const accountFields = {
  id, username: text(254), profileName: text(60), label: text(50), host: text(255), port: integer(1, 65535), edition: oneOf('java', 'bedrock'),
  minecraftName: text(16), minecraftUuid: text(36), skinUrl: text(2048), version: text(80), tags: array(text(24), 10), proxy,
  antiAfk: bool, antiAfkJump: bool, antiAfkLook: bool, antiAfkSneak: bool, antiAfkSwing: bool, antiAfkWalk: bool,
  antiAfkInterval: number(2, 3600), antiAfkMinDelay: number(2, 3600), antiAfkMaxDelay: number(2, 3600), antiAfkActionDuration: number(.1, 10), antiAfkWalkDistance: number(.1, 8), antiAfkLookDegrees: number(5, 180),
  environmentalMovement: bool, autoReconnect: bool, autoReconnectDelay: number(1, 3600), autoConnect: bool, messageDelay: number(0, 3600),
  autoDepositToChest: bool, autoDepositRange: number(1, 6), lockedInventorySlots: array(slot, 45), modLoader: text(32), modHandshake: text(32), clientBrand: text(64)
}
const settingsFields = {
  startWithWindows: bool, uiScale: number(75, 125), notificationsEnabled: bool,
  staggerStartupConnections: bool, startupConnectionDelay: number(1, 300),
  workspaceDesign: oneOf('operations', 'community', 'command', 'hybrid', 'studio', 'telemetry'),
  colorTheme: oneOf('obsidian', 'midnight', 'graphite', 'ember', 'arctic', 'high-contrast'),
  sidePanelWidth: number(240, 520), inventoryHeight: number(120, 360), povRefreshMs: number(250, 10000),
  povFrameRate: oneOf(30, 60), povRadius: integer(2, 12), povColumns: integer(1, 4), povMaxFeeds: integer(1, 12),
  povViewMode: oneOf('map', 'perspective'), povShowHud: bool,
  macros: array(object({ label: text(40), message: text(256) }), 1000)
}
// Macro models are independently validated by AppCore before persistence; constrain the entire
// JSON tree here too, so nested objects cannot smuggle unbounded values or prototype keys.
function boundedTree(v, depth = 0) {
  if (depth > 12) return false
  if (v === null || typeof v === 'boolean') return true
  if (typeof v === 'string') return v.length <= 4096
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e9
  if (Array.isArray(v)) return v.length <= 500 && v.every(x => boundedTree(x, depth + 1))
  return v && typeof v === 'object' && Object.keys(v).length <= 64 && Object.entries(v).every(([k, x]) => !['__proto__', 'constructor', 'prototype', 'remoteAccess'].includes(k) && k.length <= 80 && boundedTree(x, depth + 1))
}
const macroFields = Object.fromEntries(['id', 'name', 'enabled', 'description', 'version', 'trigger', 'triggers', 'steps', 'targets', 'cooldownMs', 'cooldown', 'concurrency', 'origin', 'createdAt', 'updatedAt', 'stopWhen', 'onError', 'defaultDelayMs', 'maxRuntimeMs', 'notify'].map(k => [k, boundedTree]))
const shapes = {
  'accounts:save': accountFields,
  'settings:save': settingsFields,
  'logs:list': { id, limit: integer(1, 500), kinds: array(oneOf('audit', 'chat', 'status', 'log', 'error', 'telemetry', 'macro'), 7) },
  'audit:recent': { limit: integer(1, 200) },
  'bot:connect': { id }, 'bot:disconnect': { id },
  'bot:chat': { id, message: text(256) }, 'bot:complete-chat': { id, text: text(256) },
  'bot:control': { id, control: controls, duration: number(0, 5000) },
  'bot:control-state': { id, control: controls, active: bool },
  'bot:look': { id, direction: oneOf('left', 'right') },
  'bot:look-delta': { id, yawDelta: number(-Math.PI * 2, Math.PI * 2), pitchDelta: number(-Math.PI, Math.PI) },
  'bot:drop-stack': { id, slot }, 'bot:drop-items': { id, slot, count: integer(1, 64) },
  'bot:deposit-slot': { id, slot, count: integer(1, 64) }, 'bot:item-lock': { id, slot, locked: bool },
  'bot:inventory-move': { id, sourceSlot: slot, destinationSlot: slot },
  'bot:equip-item': { id, slot, destination: oneOf('hand', 'head', 'torso', 'legs', 'feet', 'off-hand') },
  'bot:window-click': { id, slot: integer(0, 255) }, 'bot:window-close': { id },
  'bot:world-snapshot': { id, radius: integer(1, 16), blockRefreshMs: integer(100, 60000) },
  'bot:world-action': { id, action: oneOf('walk', 'stop-dig', 'stop-use', 'select-hotbar', 'dig-crosshair', 'use-crosshair', 'attack-nearest', 'use-held', 'look-at', 'dig', 'place', 'use'), target: object({ x: number(-3e7, 3e7), y: number(-2048, 2048), z: number(-3e7, 3e7), slot: integer(0, 8), distance: number(0, 8), direction: text(16) }) },
  'bot:auto-deposit': { id, enabled: bool },
  'macros:run': { accountId: id, macroId: id }, 'macros:stop': { accountId: id },
  'macros:save': macroFields, 'macros:set-enabled': { macroId: id, enabled: bool },
  'notify:save': { id, type: oneOf('discord', 'telegram'), name: text(40), enabled: bool, events: array(text(40), 20), accountIds: v => v === null || array(id)(v), includeTimestamp: bool, chatId: text(100), webhookUrl: text(2048), botToken: text(256) }
}
const noArgs = new Set(['accounts:list', 'app:version', 'app:supported-versions', 'app:capabilities', 'macros:list', 'proxy:health', 'settings:get', 'notify:list'])
const idArgs = new Set(['accounts:delete', 'accounts:duplicate-profile', 'logs:clear', 'macros:delete', 'macros:runs', 'notify:delete', 'notify:test'])
const arrays = new Set(['accounts:reorder', 'macros:export'])
const required = {
  'accounts:save': ['username', 'host'], 'bot:chat': ['message'], 'bot:complete-chat': ['text'],
  'bot:control': ['control'], 'bot:control-state': ['control', 'active'], 'bot:look': ['direction'],
  'bot:look-delta': ['yawDelta', 'pitchDelta'], 'bot:drop-stack': ['slot'], 'bot:drop-items': ['slot'],
  'bot:deposit-slot': ['slot'], 'bot:item-lock': ['slot', 'locked'],
  'bot:inventory-move': ['sourceSlot', 'destinationSlot'], 'bot:equip-item': ['slot', 'destination'],
  'bot:window-click': ['slot'], 'bot:world-action': ['action'], 'bot:auto-deposit': ['enabled'],
  'macros:run': ['accountId', 'macroId'], 'macros:stop': ['accountId'],
  'macros:set-enabled': ['macroId', 'enabled'], 'notify:save': ['type', 'name']
}
function invalid() { throw Object.assign(new Error('Invalid arguments.'), { code: 'INVALID_ARGS' }) }
function validateInvoke(channel, args) {
  if (noArgs.has(channel)) { if (args != null && !(Array.isArray(args) && args.length === 0) && !(object({})(args))) invalid(); return undefined }
  if (arrays.has(channel)) {
    if (args && !Array.isArray(args) && !object({ orderedIds: array(id), ids: array(id) })(args)) invalid()
    let value = args?.orderedIds || args?.ids || args
    if (Array.isArray(value) && Array.isArray(value[0]) && value.length === 1) value = value[0]
    if (!array(id)(value)) invalid()
    return value
  }
  if (idArgs.has(channel)) {
    const value = Array.isArray(args) && args.length === 1 ? args[0] : args
    const result = typeof value === 'object' && object({ id })(value) ? value.id : value
    if (!id(result)) invalid()
    return result
  }
  if (channel === 'macros:import') {
    const value = Array.isArray(args) && args.length === 1 ? args[0] : args
    if (!text(128 * 1024)(value)) invalid()
    let parsed; try { parsed = JSON.parse(value) } catch { invalid() }
    if (!boundedTree(parsed)) invalid()
    return value
  }
  const fields = Object.hasOwn(shapes, channel) ? shapes[channel] : null
  if (!fields) invalid()
  let value = args
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === 'object') value = value[0]
    else if (channel === 'logs:list' && value.length <= 2) {
      if (value[1] !== undefined && !object({ limit: fields.limit, kinds: fields.kinds })(value[1])) invalid()
      value = { id: value[0], ...(value[1] || {}) }
    }
    else {
      const keys = Object.keys(fields)
      if (value.length > keys.length) invalid()
      value = Object.fromEntries(value.map((x, i) => [keys[i], x]))
    }
  }
  if (typeof value === 'string' && Object.hasOwn(fields, 'id')) value = { id: value }
  if (typeof value === 'number' && channel === 'audit:recent') value = { limit: value }
  if (channel === 'audit:recent' && value == null) value = {}
  if (!object(fields)(value) || !boundedTree(value)) invalid()
  if ((required[channel] || []).some(k => !Object.hasOwn(value, k))) invalid()
  if (Object.hasOwn(fields, 'id') && !['accounts:save', 'notify:save', 'macros:save'].includes(channel) && !id(value.id)) invalid()
  return value
}
function commandInvocation(channel, a) {
  const name = {
    'bot:connect': 'account.connect', 'bot:disconnect': 'account.disconnect', 'bot:chat': 'chat.send',
    'bot:drop-stack': 'inventory.drop', 'bot:drop-items': 'inventory.drop', 'macros:list': 'macro.list',
    'macros:run': 'macro.run', 'macros:stop': 'macro.stop', 'notify:test': 'notify.test', 'audit:recent': 'audit.recent'
  }[channel]
  if (!name) return null
  let args = a || {}
  if (channel === 'notify:test') args = { channelId: a }
  else if (channel.startsWith('bot:')) {
    const { id, ...rest } = a
    args = { accountId: id, ...rest, ...(channel === 'bot:drop-stack' ? { count: 64 } : {}) }
  }
  return { name, args }
}
function pick(value, keys) {
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]))
}
const outputKeys = new Set(('id name profileName label server host edition status state detail at type kind message timestamp health food uptimeSec position x y z yaw pitch dimension inventory slot count displayName itemId metadata nbt slots title windowId windowType heldItem selectedSlot blocks entities block entityId radius enabled ok success error code reason result value lockedInventorySlots sourceSlot targetSlot destinationSlot moved dropped deposited equipped used placed stopped mode headless isolatedLoginWindow openExternal autoLaunch fileDialogs windowControls deviceCodeSignIn bedrock macros macroId accountId accountIds targets steps trigger triggers description runs runId startedAt endedAt durationMs stepIndex version versions protocol supported stable healthy latencyMs failures lastFailureAt lastSuccessAt hasPassword hasSecret secretHint includeTimestamp events chatId action validation path scope command targetAccount ip range environmentalMovement autoDepositToChest autoDepositRange').split(' '))
function outputTree(value, depth = 0) {
  if (depth > 12) return null
  if (Array.isArray(value)) return value.slice(0, 500).map(v => outputTree(v, depth + 1))
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 4096) : value
  return Object.fromEntries(Object.entries(value).filter(([k]) => outputKeys.has(k)).map(([k, v]) => [k, outputTree(v, depth + 1)]))
}
function remoteAccount(a, core) {
  return { id: a.id, name: a.profileName || a.minecraftName || a.label || 'Minecraft account', server: a.host || a.server || '', edition: a.edition || 'java', status: core.status?.(a.id)?.status || 'offline' }
}
// Each result/event has an explicit top-level contract; nested values use the
// bounded field projection above. Unknown channels/fields fail closed.
const statusKeys = ['id', 'name', 'server', 'state', 'status', 'detail', 'health', 'food', 'uptimeSec']
const logKeys = ['at', 'timestamp', 'type', 'kind', 'message', 'status', 'detail', 'level', 'accountId']
const auditKeys = ['at', 'timestamp', 'type', 'kind', 'scope', 'command', 'accountId', 'targetAccount', 'result', 'code', 'detail', 'ip']
const actionKeys = ['ok', 'success', 'status', 'detail', 'error', 'code', 'reason', 'lockedInventorySlots', 'sourceSlot', 'targetSlot', 'destinationSlot', 'moved', 'dropped', 'deposited', 'equipped', 'used', 'placed', 'stopped', 'runId', 'accountId', 'macroId']
const macroKeys = Object.keys(macroFields)
const schemas = {
  status: statusKeys, 'account.info': statusKeys, 'chat.recent': logKeys,
  'inventory.view': ['slot', 'name', 'displayName', 'count', 'itemId', 'metadata', 'nbt'],
  'macro.list': ['id', 'name'], 'macros:list': ['id', 'name'],
  'app:capabilities': ['mode', 'headless', 'isolatedLoginWindow', 'openExternal', 'autoLaunch', 'fileDialogs', 'windowControls', 'deviceCodeSignIn', 'bedrock'],
  'app:supported-versions': ['version', 'label', 'protocol', 'supported', 'stable'],
  'proxy:health': ['id', 'label', 'host', 'port', 'healthy', 'latencyMs', 'failures', 'lastFailureAt', 'lastSuccessAt'],
  'bot:complete-chat': ['value', 'label'],
  'bot:world-snapshot': ['id', 'position', 'yaw', 'pitch', 'dimension', 'blocks', 'entities', 'radius', 'inventory', 'heldItem', 'selectedSlot'],
  'macros:save': macroKeys, 'macros:set-enabled': macroKeys,
  'macros:import': ['macros', 'errors', 'warnings'],
  'macros:runs': ['runId', 'macroId', 'accountId', 'status', 'reason', 'startedAt', 'endedAt', 'steps', 'error'],
  'notify:list': ['id', 'type', 'name', 'enabled', 'events', 'accountIds', 'includeTimestamp', 'chatId', 'hasSecret', 'secretHint'],
  'notify:save': ['id', 'type', 'name', 'enabled', 'events', 'accountIds', 'includeTimestamp', 'chatId', 'hasSecret', 'secretHint']
}
const actions = new Set(['accounts:delete', 'logs:clear', 'macros:delete', 'notify:delete', 'bot:connect', 'bot:disconnect', 'bot:chat', 'bot:control', 'bot:control-state', 'bot:look', 'bot:look-delta', 'bot:drop-stack', 'bot:drop-items', 'bot:deposit-slot', 'bot:item-lock', 'bot:inventory-move', 'bot:equip-item', 'bot:window-click', 'bot:window-close', 'bot:world-action', 'bot:auto-deposit', 'macros:run', 'macros:stop', 'notify:test', 'account.connect', 'account.disconnect', 'account.reconnect', 'chat.send', 'inventory.drop', 'macro.run', 'macro.stop', 'connectAll', 'disconnectAll', 'notify.test'])
function project(value, keys) {
  if (Array.isArray(value)) return value.slice(0, 500).map(v => project(v, keys))
  const selected = pick(value, keys)
  if (!selected || typeof selected !== 'object') return outputTree(selected)
  return Object.fromEntries(Object.entries(selected).map(([key, child]) => [key, outputTree(child)]))
}
function remoteLog(entry, admin) {
  const audit = entry?.type === 'audit' || entry?.kind === 'audit'
  if (audit) {
    if (!admin) return null
    return { ...project(entry, auditKeys), actor: auditActor(entry.actor) }
  }
  if (!admin && !(['chat', 'status'].includes(entry?.kind) || entry?.type === 'status')) return null
  return project(entry, logKeys)
}
function remoteResult(channel, value, core, adminSession) {
  if (['accounts:list', 'accounts:save', 'accounts:duplicate-profile', 'accounts:reorder', 'antiAfk.set'].includes(channel)) return Array.isArray(value) ? value.map(a => remoteAccount(a, core)) : value ? remoteAccount(value, core) : null
  if (channel === 'settings:get' || channel === 'settings:save') return pick(value, Object.keys(settingsFields))
  if (['logs:list', 'audit:recent', 'audit.recent'].includes(channel)) return Array.isArray(value) ? value.slice(0, 500).map(e => remoteLog(e, adminSession)).filter(Boolean) : []
  if (channel === 'macros:export') {
    try { const parsed = JSON.parse(value); return JSON.stringify({ version: parsed.version, macros: project(parsed.macros, macroKeys) }) } catch { return null }
  }
  if (channel === 'app:version') return typeof value === 'string' ? value.slice(0, 80) : ''
  const keys = schemas[channel] || (actions.has(channel) ? actionKeys : null)
  return keys ? project(value, keys) : null
}
function remoteEvent(channel, event, actor) {
  const admin = actor?.kind === 'session' && actor.scope === 'admin'
  if (channel === 'macro-run') return project(event, schemas['macros:runs'])
  if (channel !== 'bot:event') return null
  if (!['status', 'telemetry', 'log', 'identity', 'version', 'login-code', 'storage-warning'].includes(event?.type)) return null
  if (event.type === 'login-code') {
    if (!admin) return null
    return { type: event.type, id: event.id, payload: pick(event.payload, ['userCode', 'verificationUri', 'expiresIn', 'message']) }
  }
  if (event.type === 'log' && (!admin && !['chat', 'status'].includes(event.payload?.kind) || event.payload?.kind === 'audit')) return null
  const eventKeys = {
    status: statusKeys, log: logKeys, identity: ['id', 'name', 'profileName', 'minecraftName', 'minecraftUuid', 'skinUrl'],
    version: ['version', 'protocol', 'status', 'detail'], 'storage-warning': ['message', 'code'],
    telemetry: ['health', 'food', 'position', 'yaw', 'pitch', 'dimension', 'inventory', 'window', 'heldItem', 'selectedSlot', 'uptimeSec']
  }
  return { type: event.type, id: event.id, payload: project(event.payload, eventKeys[event.type]) }
}
module.exports = { validateInvoke, commandInvocation, remoteResult, remoteEvent, shapes }
