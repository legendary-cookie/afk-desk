'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function createElectronSecretBox(safeStorage) {
  return {
    available: () => Boolean(safeStorage?.isEncryptionAvailable?.()),
    encrypt(plain) {
      if (!this.available()) throw new Error('Secure credential encryption is unavailable.')
      return safeStorage.encryptString(String(plain)).toString('base64')
    },
    decrypt(cipher) {
      try { return safeStorage.decryptString(Buffer.from(String(cipher), 'base64')) }
      catch { throw new Error('Could not decrypt stored secret.') }
    }
  }
}

function createFileSecretBox({ dataDir, keyFromEnv = process.env.AFKDESK_SECRET_KEY } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required')
  let key
  if (keyFromEnv !== undefined && keyFromEnv !== '') {
    try { key = Buffer.from(keyFromEnv, 'base64') } catch { key = Buffer.alloc(0) }
    if (key.length !== 32) throw new Error('AFKDESK_SECRET_KEY must be base64-encoded 32 bytes.')
  } else {
    const file = path.join(dataDir, 'secret.key')
    fs.mkdirSync(dataDir, { recursive: true })
    try { key = fs.readFileSync(file) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      key = crypto.randomBytes(32)
      try { fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 }) }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; key = fs.readFileSync(file) }
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
    }
    if (key.length !== 32) throw new Error('Stored secret key must be exactly 32 bytes.')
  }
  return {
    available: () => true,
    encrypt(plain) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
    },
    decrypt(value) {
      if (typeof value !== 'string' || !value.startsWith('v1:')) throw new Error('Unsupported encrypted secret format.')
      const packed = Buffer.from(value.slice(3), 'base64')
      if (packed.length < 28) throw new Error('Encrypted secret is truncated.')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
      decipher.setAuthTag(packed.subarray(12, 28))
      return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}
module.exports = { createElectronSecretBox, createFileSecretBox }
