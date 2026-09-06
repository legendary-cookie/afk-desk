const fs = require('node:fs')
const path = require('node:path')

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validAccounts(value) {
  if (!Array.isArray(value)) return false
  const ids = new Set()
  return value.every((account) => {
    if (!isObject(account) || typeof account.id !== 'string' || !account.id.trim() || ids.has(account.id)) return false
    ids.add(account.id)
    return true
  })
}

function readStore(file, validate, initial) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return initial
    throw storageError(file, error)
  }
  try {
    const parsed = JSON.parse(raw)
    if (!validate(parsed)) throw new Error('Invalid storage schema')
    return parsed
  } catch (error) {
    throw storageError(file, error)
  }
}

function storageError(file, cause) {
  const error = new Error(`Cannot safely read ${file}. Existing data is preserved; restore a valid backup or repair this file before saving.`, { cause })
  error.code = 'AFKDESK_STORAGE_UNREADABLE'
  return error
}

class AccountStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'accounts.json')
  }

  list() {
    return readStore(this.file, validAccounts, [])
  }

  save(account) {
    const accounts = this.list()
    const index = accounts.findIndex((item) => item.id === account.id)
    if (index === -1) accounts.push(account)
    else accounts[index] = account
    this.write(accounts)
    return account
  }

  delete(id) {
    this.write(this.list().filter((account) => account.id !== id))
  }

  reorder(orderedIds) {
    const accounts = this.list()
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const seen = new Set()
    const ordered = []
    for (const value of Array.isArray(orderedIds) ? orderedIds : []) {
      const id = String(value)
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      ordered.push(byId.get(id))
    }
    ordered.push(...accounts.filter((account) => !seen.has(account.id)))
    this.write(ordered)
    return ordered
  }

  write(accounts) {
    // Never turn a failed load into a destructive replacement, even for direct writes.
    this.list()
    if (!validAccounts(accounts)) throw new TypeError('Accounts must have unique, non-empty string IDs')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporaryFile = `${this.file}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(accounts, null, 2), 'utf8')
    fs.renameSync(temporaryFile, this.file)
  }
}

class SettingsStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'settings.json')
  }

  get() {
    return normalizeSettings(readStore(this.file, isObject, {}))
  }

  save(input) {
    this.get()
    if (!isObject(input)) throw new TypeError('Settings must be an object')
    const settings = normalizeSettings(input)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporaryFile = `${this.file}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), 'utf8')
    fs.renameSync(temporaryFile, this.file)
    return settings
  }
}

function normalizeSettings(input = {}) {
  const workspaceDesigns = new Set(['operations', 'community', 'command', 'hybrid', 'studio', 'telemetry'])
  const colorThemes = new Set(['obsidian', 'midnight', 'graphite', 'ember', 'arctic', 'high-contrast'])
  return {
    notificationsEnabled: input?.notificationsEnabled === true,
    staggerStartupConnections: input?.staggerStartupConnections !== false,
    startupConnectionDelay: Math.max(1, Math.min(Number(input?.startupConnectionDelay) || 3, 300)),
    uiScale: Math.max(75, Math.min(Number(input?.uiScale) || 100, 125)),
    workspaceDesign: workspaceDesigns.has(input?.workspaceDesign) ? input.workspaceDesign : 'hybrid',
    colorTheme: colorThemes.has(input?.colorTheme) ? input.colorTheme : 'obsidian',
    sidePanelWidth: Math.max(240, Math.min(Number(input?.sidePanelWidth) || 300, 520)),
    inventoryHeight: Math.max(120, Math.min(Number(input?.inventoryHeight) || 220, 360)),
    povRefreshMs: Math.max(250, Math.min(Number(input?.povRefreshMs) || 1500, 10000)),
    povFrameRate: [30, 60].includes(Number(input?.povFrameRate)) ? Number(input.povFrameRate) : 30,
    povRadius: Math.max(2, Math.min(Math.round(Number(input?.povRadius) || 6), 12)),
    povColumns: Math.max(1, Math.min(Math.round(Number(input?.povColumns) || 3), 4)),
    povMaxFeeds: Math.max(1, Math.min(Math.round(Number(input?.povMaxFeeds) || 9), 12)),
    povViewMode: input?.povViewMode === 'map' ? 'map' : 'perspective',
    povShowHud: input?.povShowHud !== false,
    macros: normalizeMacros(input?.macros)
  }
}

function normalizeMacros(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 1000).flatMap((macro) => {
    const message = String(macro?.message || '').trim().slice(0, 256)
    if (!message) return []
    const label = String(macro?.label || message).trim().slice(0, 40) || message.slice(0, 40)
    return [{ label, message }]
  })
}

function startupConnectionDelay(settings, index) {
  const base = 700
  return base + (settings?.staggerStartupConnections === false ? 0 : Math.max(1, Number(settings?.startupConnectionDelay) || 3) * 1000 * index)
}

module.exports = { AccountStore, SettingsStore, normalizeSettings, normalizeMacros, startupConnectionDelay }
