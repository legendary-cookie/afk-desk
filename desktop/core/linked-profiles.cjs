'use strict'
const categories = {
  server: ['host', 'port', 'version'],
  deposit: ['autoDepositToChest', 'autoDepositRange', 'autoDepositMode', 'autoDepositInterval', 'autoDepositFullThreshold'],
  antiAfk: ['antiAfk', 'antiAfkInterval', 'antiAfkMinDelay', 'antiAfkMaxDelay', 'antiAfkActionDuration', 'antiAfkWalkDistance', 'antiAfkLookDegrees', 'antiAfkChatEnabled', 'antiAfkChatMessage', 'antiAfkChatIntervalSec', 'antiAfkJump', 'antiAfkLook', 'antiAfkSneak', 'antiAfkSwing', 'antiAfkWalk', 'environmentalMovement'],
  macros: ['automations', 'macroTargets'],
  messages: ['joinMessage', 'serverChangeMessage', 'messageDelay', 'serverChangeRetryMinutes'],
  notifications: ['alerts'],
  reconnect: ['autoReconnect', 'autoReconnectDelay', 'autoReconnectBackoffMultiplier', 'autoReconnectMaxDelay', 'autoReconnectRateLimitDelay', 'autoReconnectMaxAttempts', 'connectTimeoutSeconds', 'reconnectResetDelay'],
  safety: ['autoEat', 'autoEatThreshold', 'lowHealthTotem', 'lowHealthDisconnect', 'lowHealthThreshold', 'lowHealthCooldownMinutes', 'scheduleEnabled', 'scheduleStart', 'scheduleEnd', 'scheduleDays'],
}
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const fields = new Set(Object.values(categories).flat())
function normalizeLink(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) return null
  return { id: value.id, name: String(value.name || 'Link group').slice(0, 60), categories: [...new Set((Array.isArray(value.categories) ? value.categories : []).filter(x => Object.hasOwn(categories, x)))], excluded: [...new Set((Array.isArray(value.excluded) ? value.excluded : []).filter(x => fields.has(x)))] }
}
function apply(accounts, account) {
  const old = accounts.find(a => a.id === account.id)
  const link = normalizeLink(account.linkGroup)
  account = {...account, linkGroup: link}
  if (!link) return accounts.some(a => a.id === account.id) ? accounts.map(a => a.id === account.id ? account : a) : [...accounts, account]
  const peers = accounts.filter(a => a.id !== account.id && normalizeLink(a.linkGroup)?.id === link.id)
  const joining = old?.linkGroup?.id !== link.id
  if (joining && peers.length) {
    const source = peers[0]
    link.name = source.linkGroup.name
    link.categories = normalizeLink(source.linkGroup).categories
    for (const category of link.categories) for (const key of categories[category]) if (!link.excluded.includes(key) && !source.linkGroup.excluded?.includes(key) && Object.hasOwn(source, key)) account[key] = clone(source[key])
  }
  const result = accounts.map(peer => {
    if (peer.id === account.id) return account
    const target = normalizeLink(peer.linkGroup)
    if (!target || target.id !== link.id) return peer
    const next = {...peer, linkGroup: {...target, name: link.name, categories: [...link.categories]}}
    if (!joining) for (const category of link.categories) for (const key of categories[category]) {
      if (!link.excluded.includes(key) && !target.excluded.includes(key) && Object.hasOwn(account, key) && (!old || JSON.stringify(old[key]) !== JSON.stringify(account[key]) || !normalizeLink(old.linkGroup)?.categories.includes(category))) next[key] = clone(account[key])
    }
    return next
  })
  if (!old) result.push(account)
  return result
}
// Explicit account targets are shared; tag and all-account targets remain dynamic.
function syncMacroTargets(macros, accounts, sourceId, previousTargets = null) {
  const source = accounts.find(a => a.id === sourceId)
  const link = normalizeLink(source?.linkGroup)
  if (!link?.categories.includes('macros') || link.excluded.includes('macroTargets')) return macros
  const peers = accounts.filter(a => a.id !== sourceId && normalizeLink(a.linkGroup)?.id === link.id && !normalizeLink(a.linkGroup).excluded.includes('macroTargets'))
  return macros.map(macro => {
    if (macro.targets?.mode !== 'accounts') return macro
    const assigned = macro.targets.accountIds.includes(sourceId)
    if (previousTargets && previousTargets.mode === 'accounts' && previousTargets.accountIds.includes(sourceId) === assigned) return macro
    const ids = new Set(macro.targets.accountIds)
    for (const peer of peers) assigned ? ids.add(peer.id) : ids.delete(peer.id)
    return {...macro, targets: {...macro.targets, accountIds: [...ids]}}
  })
}
module.exports = {categories, normalizeLink, apply, syncMacroTargets}
