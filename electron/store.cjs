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

  write(accounts) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporaryFile = `${this.file}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(accounts, null, 2), 'utf8')
    fs.renameSync(temporaryFile, this.file)
  }
}

module.exports = { AccountStore }
