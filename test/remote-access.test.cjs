const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AccessStore } = require('../electron/remote/access-store.cjs')
const { RemoteAccessServer } = require('../electron/remote/server.cjs')

test('browser access enforces authentication, account scope, permissions, and revocation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-remote-'))
  const accessStore = new AccessStore(directory)
  const actions = []
  const accounts = [
    { id: 'allowed', label: 'Allowed', host: 'one.example', port: 25565, minecraftName: 'Player', skinUrl: 'https://textures.minecraft.net/texture/abcdef123' },
    { id: 'private', label: 'Private', host: 'two.example', port: 25565 }
  ]
  const server = new RemoteAccessServer({
    accessStore,
    getAccounts: () => accounts,
    getRuntime: () => ({ status: 'offline', detail: 'Ready', logs: [] }),
    handleAction: (...args) => actions.push(args)
  })
  await server.start(0)
  t.after(() => {
    server.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const base = server.status().localUrl
  const unauthorized = await fetch(`${base}/api/state`)
  assert.equal(unauthorized.status, 401)

  const created = server.createGrant({ label: 'Friend', accountIds: ['allowed'], permissions: ['view', 'chat'] })
  const session = await fetch(`${base}/session?token=${encodeURIComponent(created.token)}`, { redirect: 'manual' })
  assert.equal(session.status, 302)
  const cookie = session.headers.get('set-cookie').split(';')[0]

  const state = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })
  assert.equal(state.status, 200)
  const visibleAccounts = (await state.json()).accounts
  assert.deepEqual(visibleAccounts.map((account) => account.id), ['allowed'])
  assert.equal(visibleAccounts[0].skinUrl, 'https://textures.minecraft.net/texture/abcdef123')

  const deniedAccount = await postAction(base, cookie, { accountId: 'private', action: 'chat', payload: { message: 'no' } })
  assert.equal(deniedAccount.status, 403)
  const deniedPermission = await postAction(base, cookie, { accountId: 'allowed', action: 'connect', payload: {} })
  assert.equal(deniedPermission.status, 403)
  const allowed = await postAction(base, cookie, { accountId: 'allowed', action: 'chat', payload: { message: 'hello' } })
  assert.equal(allowed.status, 200)
  assert.equal(actions.length, 1)

  accessStore.revoke(created.grant.id)
  const revoked = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })
  assert.equal(revoked.status, 401)
})

function postAction(base, cookie, body) {
  return fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-AFKDesk-Request': '1' },
    body: JSON.stringify(body)
  })
}
