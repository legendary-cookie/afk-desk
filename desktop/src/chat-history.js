'use strict'
;(function (root) {
  class ChatHistory {
    constructor() { this.accounts = new Map() }
    get(id) {
      if (!this.accounts.has(id)) this.accounts.set(id, { entries: [], index: 0, draft: '' })
      return this.accounts.get(id)
    }
    add(id, message) {
      const h = this.get(id)
      h.entries.push(message)
      if (h.entries.length > 50) h.entries.shift()
      h.index = h.entries.length
      h.draft = ''
    }
    reset(id) { const h = this.get(id); h.index = h.entries.length }
    navigate(id, direction, current) {
      const h = this.get(id)
      if (!h.entries.length) return current
      if (direction === 'up') {
        if (h.index === h.entries.length) h.draft = current
        h.index = Math.max(0, h.index - 1)
      } else h.index = Math.min(h.entries.length, h.index + 1)
      return h.index === h.entries.length ? h.draft : h.entries[h.index]
    }
  }
  if (typeof module !== 'undefined') module.exports = { ChatHistory }
  else root.ChatHistory = ChatHistory
})(typeof window === 'undefined' ? globalThis : window)
