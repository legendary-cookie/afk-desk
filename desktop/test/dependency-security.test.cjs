const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const path = require('node:path')

for (const [name, manifest] of [
  ['desktop', '../package.json'],
  ['mobile engine', '../../mobile/nodejs-assets/nodejs-project/package.json']
]) {
  const engineRequire = createRequire(path.resolve(__dirname, manifest))
  for (const consumer of ['@azure/msal-node', 'yggdrasil']) {
    const uuid = createRequire(engineRequire.resolve(consumer))('uuid')
    test(`${name} ${consumer} UUID rejects undersized destination buffers`, () => {
      for (const method of ['v3', 'v5']) {
        assert.throws(() => uuid[method]('afk-desk-regression', uuid[method].DNS, Buffer.alloc(15)), RangeError)
        assert.throws(() => uuid[method]('afk-desk-regression', uuid[method].DNS, Buffer.alloc(16), -1), RangeError)
      }
      assert.match(uuid.v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
  }
  test(`${name} authentication consumers construct and generate IDs without network access`, () => {
    const { PublicClientApplication, CryptoProvider } = engineRequire('@azure/msal-node')
    const application = new PublicClientApplication({ auth: { clientId: '00000000-0000-0000-0000-000000000001' } })
    assert.equal(typeof application.getTokenCache().getAllAccounts, 'function')
    assert.match(new CryptoProvider().createNewGuid(), /^[0-9a-f-]{36}$/)
    const client = engineRequire('yggdrasil')()
    assert.equal(typeof client.auth, 'function')
    assert.equal(typeof client.refresh, 'function')
  })
}
