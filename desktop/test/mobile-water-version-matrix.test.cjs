const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { supportedVersions } = require('../electron/version-support.cjs')

test('Android patched physics follows directional water on every advertised version', { timeout: 30_000 }, () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-fixtures', 'water-version-matrix-runner.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 25_000, windowsHide: true,
    env: { ...process.env, AFK_DESK_ENGINE: 'mobile' }
  })
  assert.deepEqual(JSON.parse(output), supportedVersions().reverse())
})
