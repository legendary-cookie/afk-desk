'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { COMMANDS } = require('../core/command-contract.cjs')
const { createCommandLayer } = require('../core/commands.cjs')

function fixture() {
  const audits = [], calls = [], account = { id: 'a', label: 'Steve', profileName: 'Steve', host: 'server.test', username: 'private@example.com' }
  const core = {
    accounts: { list: () => [account], setAntiAfk: async (...a) => calls.push(['antiAfk', ...a]) },
    bots: { connect: async (...a) => calls.push(['connect', ...a]), disconnect: async (...a) => calls.push(['disconnect', ...a]), reconnect: async (...a) => calls.push(['reconnect', ...a]), sendChat: async (...a) => calls.push(['chat', ...a]), inventory: async () => [], dropItems: async (...a) => calls.push(['drop', ...a]), connectAll: async () => {}, disconnectAll: async () => {} },
    macros: { list: () => ({ macros: [{ id: 'm', name: 'Patrol' }] }), run: async (x) => calls.push(['macro-run', x]), stop: async (x) => calls.push(['macro-stop', x]) },
    notify: { test: async (x) => calls.push(['notify', x]) }, logs: { recent: async (x) => calls.push(['audit', x]) },
    status: () => ({ status: 'online', telemetry: { health: 20, food: 18 }, uptimeSec: 42 }), recentChat: () => [{ message: '§ahello' }]
  }
  let time = 0
  const layer = createCommandLayer({ core, audit: (entry) => audits.push(entry), now: () => time, timers: globalThis })
  return { layer, audits, calls, setTime: (n) => { time = n } }
}
const actor = (scope = 'admin') => ({ kind: 'discord', id: 'u', scope, ip: '127.0.0.1' })
const validArgs = {
  status: {}, 'account.info': { accountId: 'a' }, 'account.connect': { accountId: 'a' }, 'account.disconnect': { accountId: 'a' }, 'account.reconnect': { accountId: 'a' }, 'chat.send': { accountId: 'a', message: 'hello' }, 'chat.recent': { accountId: 'a' }, 'inventory.view': { accountId: 'a' }, 'inventory.drop': { accountId: 'a', slot: 9 }, 'macro.list': {}, 'macro.run': { accountId: 'a', macroId: 'm' }, 'macro.stop': { accountId: 'a' }, 'antiAfk.set': { accountId: 'a', enabled: true }, connectAll: {}, disconnectAll: {}, 'notify.test': { channelId: 'x' }, 'audit.recent': {}
}
test('each contract command validates, enforces scopes/confirmation, rate limits and audits', async (t) => {
  for (const [name, spec] of Object.entries(COMMANDS)) await t.test(name, async () => {
    const f = fixture(), args = validArgs[name]
    const ok = await f.layer.execute(actor('admin'), name, args, { confirmed: true })
    assert.equal(ok.ok, true)
    assert.equal(f.audits.length, 1); assert.equal(f.audits[0].command, name)
    const forbidden = await f.layer.execute(actor('read'), name, args, { confirmed: true })
    if (spec.scope !== 'read') assert.equal(forbidden.error.code, 'FORBIDDEN')
    const invalid = await f.layer.execute(actor('admin'), name, { ...args, invalidExtra: true }, { confirmed: true })
    assert.equal(invalid.error.code, 'INVALID')
    if (spec.danger === 'confirm') { const c = fixture(); assert.equal((await c.layer.execute(actor(), name, args)).error.code, 'CONFIRM_REQUIRED') }
    const limited = fixture(); for (let i = 0; i < 60; i++) await limited.layer.execute(actor(), name, args, { confirmed: true })
    assert.equal((await limited.layer.execute(actor(), name, args, { confirmed: true })).error.code, 'RATE_LIMITED')
    assert.ok(f.audits.every((a) => a.at === 0 && a.actor.id === 'u'))
  })
})
test('command responses omit email and chat formatting is stripped', async () => {
  const f = fixture()
  assert.equal((await f.layer.execute(actor(), 'account.info', { accountId: 'a' })).result.name, 'Steve')
  assert.equal(JSON.stringify((await f.layer.execute(actor(), 'status')).result).includes('private@example.com'), false)
  assert.equal((await f.layer.execute(actor(), 'chat.recent', { accountId: 'a' })).result[0].message, 'hello')
})
