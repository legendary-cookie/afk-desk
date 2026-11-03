;(function (root) {
  'use strict'
  function label(account) {
    const id = String(account?.id || account?.identityId || '')
    let hash = 2166136261
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
    return `Acc•••${(hash >>> 0).toString(36)}`
  }
  function displayAccount(account, enabled) {
    return enabled ? label(account) : (account?.profileName || account?.label || account?.username || 'Account')
  }
  function maskText(value, accounts, enabled) {
    const text = String(value ?? '')
    if (!enabled) return text
    const names = new Map()
    for (const account of accounts || []) {
      for (const name of [account.username, account.minecraftName, account.label, account.profileName]) {
        if (typeof name === 'string' && name.trim()) names.set(name.toLowerCase(), label(account))
      }
    }
    const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!alternatives.length) return text
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])(${alternatives.join('|')})(?![a-zA-Z0-9_])`, 'gi')
    return text.replace(pattern, (_, prefix, name) => prefix + names.get(name.toLowerCase()))
  }
  const exported = { label, displayAccount, maskText }
  if (typeof module !== 'undefined' && module.exports) module.exports = exported
  if (root) root.afkStreamerMask = exported
})(typeof window !== 'undefined' ? window : null)
