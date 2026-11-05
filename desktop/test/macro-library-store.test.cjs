'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MacroLibraryStore, writeBackV1 } = require('../electron/macro/library-store.cjs')
const { AccountStore } = require('../electron/store.cjs')
const model = require('../electron/macro/model.cjs')

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-library-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const accounts = [{ id: 'a', automations: [{ id: 'legacy', name: 'Legacy', trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'hi' }] }] }]

test('v3 graph survives store reload and JSON export and import', (t) => {
  const dir = temp(t), store = new MacroLibraryStore(dir)
  store.load([])
  const graph = { id: 'graph', name: 'Graph', version: 3, targets: { mode: 'all' },
    nodes: [{ id: 'start', kind: 'trigger.manual', params: {}, position: { x: 20, y: 40 } }, { id: 'say', kind: 'chat', params: { message: 'hello' }, position: { x: 240, y: 40 }, disabled: true }],
    edges: [{ id: 'edge', from: { node: 'start', port: 'out' }, to: { node: 'say', port: 'in' } }], vars: [{ name: 'x', value: 3 }], migration: { hadVersion: false } }
  const saved = store.save(graph)
  const reopened = new MacroLibraryStore(dir)
  reopened.load([])
  assert.deepEqual(reopened.get('graph'), saved)
  const exported = JSON.parse(model.exportMacros([saved])).macros[0]
  assert.deepEqual(exported.nodes, graph.nodes)
  assert.deepEqual(exported.edges, graph.edges)
  assert.deepEqual(exported.vars, graph.vars)
  assert.deepEqual(exported.migration, graph.migration)
  const imported = model.importMacros(JSON.stringify({ macros: [exported] }), { accountIds: ['a'] })
  assert.deepEqual(imported.errors, [])
  assert.deepEqual(imported.macros[0].nodes, graph.nodes)
  assert.deepEqual(imported.macros[0].edges, graph.edges)
  assert.deepEqual(model.importMacros(JSON.stringify(exported), { accountIds: ['a'] }).macros[0].nodes, graph.nodes)
  assert.deepEqual(model.validateMacro({ ...saved, edges: [{ id: 'bad', from: { node: 'missing', port: 'out' }, to: { node: 'say', port: 'in' } }] }).map(e => e.path), ['/edges/0'])
})

test('library writes atomically and normalizes read data', (t) => {
  const dir = temp(t), store = new MacroLibraryStore(dir); store.load([])
  const macro = model.normalizeMacro({ id: 'm', name: 'Hello', targets: { mode: 'all' }, trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'hi' }] })
  store.save(macro)
  assert.equal(store.get('m').name, 'Hello')
  assert.equal(fs.existsSync(path.join(dir, 'macros.json.tmp')), false)
  assert.equal(store.setEnabled('m', false).enabled, false)
})

test('corrupt library is moved aside and rebuilt from account v1 automations', (t) => {
  const dir = temp(t), file = path.join(dir, 'macros.json'); fs.writeFileSync(file, '{broken')
  const store = new MacroLibraryStore(dir); store.load(accounts)
  assert.ok(store.list().some((m) => m.id === 'legacy'))
  assert.ok(store.warnings.length)
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('macros.json.corrupt-')))
})

test('v1 migration remains idempotent across repeated startup', (t) => {
  const dir = temp(t), store = new MacroLibraryStore(dir); store.load(accounts)
  const first = model.migrateV1(accounts, store.library); store.write(first.library)
  const reopened = new MacroLibraryStore(dir); reopened.load(accounts)
  const second = model.migrateV1(accounts, reopened.library)
  assert.deepEqual(second.migratedAccountIds, [])
  assert.equal(second.library.macros.length, 1)
})

test('rollback write-back replaces and deletes migrated v1 rows but leaves v2-only rows untouched', (t) => {
  const dir = temp(t), accountsStore = new AccountStore(dir)
  accountsStore.save({ id: 'a', automations: [{ id: 'legacy-id', name: 'Old', enabled: true, trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'old' }] }] })
  const macro = model.normalizeMacro({ id: 'collision-safe-id', name: 'Changed', targets: { mode: 'accounts', accountIds: ['a'] }, trigger: { type: 'manual' }, steps: [{ type: 'chat', message: 'new' }], origin: { fromV1: { accountId: 'a', automationId: 'legacy-id' } } })
  assert.equal(writeBackV1(accountsStore, macro), true)
  assert.equal(accountsStore.list()[0].automations[0].name, 'Changed')
  const legacy = accountsStore.list()[0].automations[0]
  assert.equal(legacy.id, 'legacy-id')
  assert.equal(writeBackV1(accountsStore, { ...macro, origin: { ...macro.origin, v2Only: true } }), false)
  assert.equal(accountsStore.list()[0].automations[0].name, 'Changed')
  assert.equal(writeBackV1(accountsStore, macro, true), true)
  assert.deepEqual(accountsStore.list()[0].automations, [])
})

