'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createElectronSecretBox, createFileSecretBox } = require('../core/secrets.cjs')

test('Electron adapter retains the safeStorage base64 byte format', () => {
  const box = createElectronSecretBox({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().slice(4) })
  const encrypted = box.encrypt('password')
  assert.equal(encrypted, Buffer.from('enc:password').toString('base64'))
  assert.equal(box.decrypt(encrypted), 'password')
})
test('file secret box round trips and detects tampering', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-secret-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const box = createFileSecretBox({ dataDir }), cipher = box.encrypt('private')
  assert.match(cipher, /^v1:/); assert.equal(box.decrypt(cipher), 'private')
  const bytes = Buffer.from(cipher.slice(3), 'base64'); bytes[bytes.length - 1] ^= 1
  assert.throws(() => box.decrypt(`v1:${bytes.toString('base64')}`))
})
test('file key uses mode 0600 on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-secret-mode-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  createFileSecretBox({ dataDir }); assert.equal(fs.statSync(path.join(dataDir, 'secret.key')).mode & 0o777, 0o600)
})
test('environment key takes precedence and malformed keys are refused', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-secret-env-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const keyFromEnv = Buffer.alloc(32, 7).toString('base64'), box = createFileSecretBox({ dataDir, keyFromEnv })
  assert.equal(fs.existsSync(path.join(dataDir, 'secret.key')), false)
  assert.throws(() => createFileSecretBox({ dataDir, keyFromEnv: Buffer.alloc(31).toString('base64') }), /32 bytes/)
  assert.equal(box.decrypt(box.encrypt('x')), 'x')
})
