'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeChange, bulkChange, changeAccount } = require('../electron/appearance.cjs')

test('appearance validates inputs and accepts PNG and HTTPS skins', () => {
  assert.throws(() => normalizeChange({}), /skin and\/or cape/)
  assert.throws(() => normalizeChange({ skin: { variant: 'slim', url: 'http://example.com/a' } }), /HTTPS/)
  assert.throws(() => normalizeChange({ skin: { variant: 'slim', data: 'YWJj' } }), /PNG/)
  assert.equal(normalizeChange({ skin: { variant: 'classic', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') } }).skin.data.length, 8)
})

test('bulk appearance skips unsupported accounts, deduplicates and continues after failures sequentially', async () => {
  const accounts = [{ id: 'a' }, { id: 'b', edition: 'bedrock' }, { id: 'c' }, { id: 'd' }]
  const calls = []
  const results = await bulkChange(accounts, ['a', 'b', 'c', 'c', 'missing', 'd'], { cape: '12345678-1234-1234-1234-123456789abc' }, {
    delay: async ms => calls.push(`delay:${ms}`),
    changeAccount: async a => { calls.push(a.id); if (a.id === 'c') throw Error('denied'); return 'cape: applied' }
  })
  assert.deepEqual(calls, ['a', 'delay:500', 'c', 'delay:500', 'd'])
  assert.deepEqual(results.map(r => r.status), ['success', 'skipped', 'failed', 'skipped', 'success'])
})

test('per-account changes use Minecraft service endpoints and report partial failure', async () => {
  const requests = []
  const message = await changeAccount({ id: 'a' }, normalizeChange({ skin: { url: 'https://example.com/skin.png', variant: 'slim' }, cape: '12345678-1234-1234-1234-123456789abc' }), {
    getToken: async () => 'token', fetch: async (url, options) => { requests.push({ url, options }); return { ok: requests.length === 1, status: 403 } }
  })
  assert.match(requests[0].url, /profile\/skins$/)
  assert.equal(requests[0].options.method, 'POST')
  assert.match(requests[1].url, /capes\/active$/)
  assert.equal(requests[1].options.method, 'PUT')
  assert.equal(message, 'skin: applied; cape: Minecraft service returned 403.')
})
