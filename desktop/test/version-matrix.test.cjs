const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const protocol = require('minecraft-protocol')
const { supportedVersions } = require('../electron/version-support.cjs')

test('Auto detection recognizes every advertised version on a matching local protocol server', { timeout: 60_000 }, () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-fixtures', 'version-matrix-runner.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 55_000, windowsHide: true
  })
  assert.deepEqual(JSON.parse(output), supportedVersions().reverse())
})
