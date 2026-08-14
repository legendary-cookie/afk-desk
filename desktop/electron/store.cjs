const fs = require('node:fs')
const path = require('node:path')

class AccountStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'accounts.json')
  }

  list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read accounts:', error)
      return []
    }
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
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read settings:', error)
      return normalizeSettings()
    }
  }

  save(input) {
    const settings = normalizeSettings(input)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporaryFile = `${this.file}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), 'utf8')
    fs.renameSync(temporaryFile, this.file)
    return settings
  }
}

function normalizeSettings(input = {}) {
  return {
    staggerStartupConnections: input?.staggerStartupConnections !== false,
    startupConnectionDelay: Math.max(1, Math.min(Number(input?.startupConnectionDelay) || 3, 300)),
    uiScale: Math.max(75, Math.min(Number(input?.uiScale) || 100, 125)),
    sidePanelWidth: Math.max(240, Math.min(Number(input?.sidePanelWidth) || 300, 520)),
    inventoryHeight: Math.max(240, Math.min(Number(input?.inventoryHeight) || 400, 480)),
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
