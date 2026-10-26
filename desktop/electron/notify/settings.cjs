'use strict'
const crypto = require('node:crypto')
const { CHANNEL_TYPES, EVENT_KINDS, LIMITS, ALLOWED_HOSTS } = require('./contract.cjs')

class NotifySettings {
  constructor(settingsStore, secretBox) {
    this.settingsStore = settingsStore
    // Keep the historical constructor shape working for existing integrations/tests.
    this.secretBox = secretBox?.encryptString ? {
      available: () => Boolean(secretBox.isEncryptionAvailable?.()),
      encrypt: (value) => secretBox.encryptString(value).toString('base64'),
      decrypt: (value) => secretBox.decryptString(Buffer.from(value, 'base64'))
    } : secretBox
  }
  _all() { return this.settingsStore.getNotifyChannels?.() || [] }
  _decrypt(value) { if (!value) return ''; try { return this.secretBox.decrypt(value) } catch { throw new Error('Could not decrypt notification secret. Re-enter it in notification settings.') } }
  _encrypt(value) { if (!this.secretBox?.available?.()) throw new Error('Secure credential encryption is unavailable.'); return this.secretBox.encrypt(value) }
  list() { return this._all().map((c) => { const secret = this._decrypt(c.secretEncrypted); return { id: c.id, type: c.type, name: c.name, enabled: c.enabled, events: [...c.events], accountIds: c.accountIds, includeTimestamp: c.includeTimestamp, chatId: c.chatId || '', hasSecret: Boolean(secret), secretHint: secret ? `••••${secret.slice(-4)}` : '' } }) }
  getDecrypted() { return this._all().map((c) => ({ ...c, ...(c.type === 'discord' ? { webhookUrl: this._decrypt(c.secretEncrypted) } : { botToken: this._decrypt(c.secretEncrypted) }) })) }
  save(input) {
    if (!input || !CHANNEL_TYPES.includes(input.type)) throw new Error('Invalid notification channel type.')
    const previous = this._all().find((c) => c.id === input.id)
    const id = previous?.id || crypto.randomUUID()
    const name = String(input.name || '').trim().slice(0, 40)
    if (!name) throw new Error('Channel name is required.')
    const requestedEvents = Array.isArray(input.events) ? input.events : []
    if (requestedEvents.some((event) => !EVENT_KINDS.includes(event))) throw new Error('Channel contains an unsupported event kind.')
    const events = [...new Set(requestedEvents)].slice(0, EVENT_KINDS.length)
    const ids = Array.isArray(input.accountIds) ? [...new Set(input.accountIds.filter((x) => typeof x === 'string'))].slice(0, 500) : null
    const supplied = input.type === 'discord' ? String(input.webhookUrl || '') : String(input.botToken || '')
    if (supplied && input.type === 'discord') {
      let url
      try { url = new URL(supplied) } catch { throw new Error('Enter a valid Discord webhook URL.') }
      if (url.protocol !== 'https:' || !ALLOWED_HOSTS.discord.includes(url.hostname) || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)) throw new Error('Enter an allowlisted Discord webhook URL.')
    }
    if (supplied && input.type === 'telegram' && !/^\d{5,15}:[A-Za-z0-9_-]{10,}$/.test(supplied)) throw new Error('Enter a valid Telegram bot token.')
    const chatId = input.type === 'telegram' ? String(input.chatId || previous?.chatId || '').slice(0, 100) : ''
    if (input.type === 'telegram' && chatId && !/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) throw new Error('Enter a valid Telegram chat ID.')
    const secretEncrypted = supplied ? this._encrypt(supplied) : previous?.secretEncrypted || ''
    const channel = { id, type: input.type, name, enabled: input.enabled !== false, events, accountIds: ids, includeTimestamp: input.includeTimestamp === true, chatId, secretEncrypted }
    const list = this._all(); const index = list.findIndex((c) => c.id === id); if (index < 0 && list.length >= LIMITS.maxChannels) throw new Error('Maximum notification channel count reached.')
    if (index < 0) list.push(channel); else list[index] = channel
    this._save(list); return this.list().find((c) => c.id === id)
  }
  delete(id) { this._save(this._all().filter((c) => c.id !== id)) }
  _save(notifyChannels) { this.settingsStore.save({ ...this.settingsStore.get(), notifyChannels }) }
}
function classifyKickReason(reason) { return /\bbann?ed\b|blacklist/i.test(String(reason || '')) ? 'banned' : 'kicked' }
function crossedLowHealth(previous, current, threshold = 6) { return Number.isFinite(Number(current)) && Number(current) < threshold && (previous == null || Number(previous) >= threshold) }
module.exports = { NotifySettings, classifyKickReason, crossedLowHealth }
