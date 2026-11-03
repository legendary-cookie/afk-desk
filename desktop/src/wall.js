;(function (root) {
  'use strict'
  function liveIds(accounts, maximum) {
    const count = Number.isFinite(Number(maximum)) && maximum != null ? Math.max(0, Math.min(12, Math.round(Number(maximum)))) : 4
    return accounts.slice(0, count).map(account => account.id)
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { liveIds }
  if (root) root.afkWall = { liveIds }
})(typeof window !== 'undefined' ? window : null)
