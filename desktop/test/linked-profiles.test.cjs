'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {apply, normalizeLink} = require('../core/linked-profiles.cjs')
test('groups join, propagate selected fields, unlink fields and leave without sharing secrets', () => {
  const link = {id:'group', name:'Friends', categories:['server', 'antiAfk'], excluded:[]}
  let accounts = [{id:'a', host:'one', port:1, version:'', antiAfk:true, username:'alice', proxy:{password:'secret'}, linkGroup:link}, {id:'b', host:'two', port:2, username:'bob', proxy:{password:'other'}}]
  accounts = apply(accounts, {...accounts[1], linkGroup:link})
  assert.equal(accounts[1].host, 'one')
  assert.equal(accounts[1].username, 'bob')
  assert.equal(accounts[1].proxy.password, 'other')
  accounts = apply(accounts, {...accounts[0], host:'three', antiAfk:false})
  assert.equal(accounts[1].host, 'three'); assert.equal(accounts[1].antiAfk, false)
  accounts = apply(accounts, {...accounts[1], linkGroup:{...accounts[1].linkGroup, excluded:['host']}})
  accounts = apply(accounts, {...accounts[0], host:'four'})
  assert.equal(accounts[1].host, 'three')
  accounts = apply(accounts, {...accounts[1], linkGroup:null})
  accounts = apply(accounts, {...accounts[0], port:9})
  assert.equal(accounts[1].port, 1)
})
test('old profiles and invalid links load without a group', () => {
  assert.equal(normalizeLink(undefined), null)
  assert.equal(normalizeLink({id:'bad id'}), null)
  assert.equal(apply([], {id:'old', username:'a'})[0].linkGroup, null)
})

test('macro targets follow linked assignments and honor field exclusions', () => {
  const {syncMacroTargets} = require('../core/linked-profiles.cjs')
  const link = {id:'g', name:'Group', categories:['macros'], excluded:[]}
  const accounts = [{id:'a', linkGroup:link}, {id:'b', linkGroup:link}, {id:'c', linkGroup:{...link, excluded:['macroTargets']}}]
  const macros = [{id:'m', targets:{mode:'accounts', accountIds:['a','c']}}, {id:'all', targets:{mode:'all'}}]
  let synced = syncMacroTargets(macros, accounts, 'a')
  assert.deepEqual(synced[0].targets.accountIds, ['a','c','b'])
  assert.deepEqual(synced[1], macros[1])
  synced = syncMacroTargets([{...synced[0], targets:{mode:'accounts', accountIds:['b','c']}}], accounts, 'a', {mode:'accounts', accountIds:['a']})
  assert.deepEqual(synced[0].targets.accountIds, ['c'])
  assert.deepEqual(syncMacroTargets(macros, accounts, 'c'), macros)
  assert.deepEqual(normalizeLink({...link, categories:['display','macros']}).categories, ['macros'])
})
