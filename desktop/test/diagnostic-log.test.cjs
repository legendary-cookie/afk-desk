const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DiagnosticLog } = require('../electron/diagnostic-log.cjs')

test('movement diagnostics are bounded and redact credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-diagnostics-'))
  const log = new DiagnosticLog(directory, { maxBytes: 120 })
  log.write({ event: 'movement', username: 'private@example.com', message: 'private@example.com', position: { x: 1, y: 2, z: 3 } })
  log.write({ event: 'movement', message: 'safe', padding: 'x'.repeat(200) })
  log.write({ event: 'latest', message: 'still safe' })

  const contents = fs.readFileSync(log.file, 'utf8')
  assert.doesNotMatch(contents, /private@example\.com/)
  assert.match(contents, /"event":"latest"/)
  assert.ok(fs.statSync(log.file).size < 1000)
})
