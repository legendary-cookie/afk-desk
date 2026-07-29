const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

class AccessStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'browser-access.json')
  }

  list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read browser access:', error)
      return []
    }
  }

  create({ label, accountIds, permissions }) {
    const token = crypto.randomBytes(32).toString('base64url')
    const grant = {
      id: crypto.randomUUID(),
      label,
      tokenHash: hashToken(token),
      accountIds,
      permissions,
      createdAt: Date.now()
    }
    const grants = this.list()
    grants.push(grant)
    this.write(grants)
    return { grant: publicGrant(grant), token }
  }

  revoke(id) {
    const grants = this.list()
    const grant = grants.find((item) => item.id === id)
    if (!grant) return false
    grant.revokedAt = Date.now()
    this.write(grants)
    return true
  }

  publicList() {
    return this.list().map(publicGrant)
  }

  write(grants) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporaryFile = `${this.file}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(grants, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryFile, this.file)
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function publicGrant(grant) {
  const { tokenHash, ...safe } = grant
  return safe
}

module.exports = { AccessStore, hashToken, publicGrant }
