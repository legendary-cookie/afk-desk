const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { supportedVersions } = require('../electron/version-support.cjs')

test('every advertised version spawns and performs movement, chat, held-item, and arm actions', { timeout: 150_000 }, () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-fixtures', 'functional-version-matrix-runner.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 140_000, windowsHide: true
  })
  const verified = JSON.parse(output)
  assert.deepEqual(verified.map(result => result.version), supportedVersions().reverse())
  for (const result of verified) {
    for (const distance of Object.values(result.movementDistances)) assert.ok(distance > 0.03)
    assert.ok(result.jumpHeight > 0.1)
    assert.ok(result.packets.length >= 5)
  }
})

test('Android engine performs the same movement and action matrix for every advertised version', { timeout: 150_000 }, () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-fixtures', 'functional-version-matrix-runner.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 140_000, windowsHide: true,
    env: { ...process.env, AFK_DESK_ENGINE: 'mobile' }
  })
  const verified = JSON.parse(output)
  assert.deepEqual(verified.map(result => result.version), supportedVersions().reverse())
  for (const result of verified) {
    for (const distance of Object.values(result.movementDistances)) assert.ok(distance > 0.03)
    assert.ok(result.jumpHeight > 0.1)
    assert.ok(result.packets.length >= 5)
  }
})
