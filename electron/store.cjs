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

module.exports = { AccountStore }
