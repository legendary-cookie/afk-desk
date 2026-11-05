'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { BotManager } = require('../bot-manager.cjs')
const { getUpcomingRuns } = require('../bridge-command.cjs')

test('upcoming runs include active timers in time order and clear with session', () => {
  const manager = new BotManager({ profilesPath: '/tmp/profiles', emit() {} })
  const session = { account: { autoDepositToChest: true }, upcomingMessages: new Map(), messageTimers: new Set(), containerScanTimer: true, nextContainerScan: 30, serverChangeRetryTimer: true, nextServerChangeRetry: 20, antiAfkChatTimer: true, nextAntiAfkChat: 10 }
  manager.sessions.set('one', session)
  assert.deepEqual(getUpcomingRuns(manager, 'one').map(run => run.kind), ['timed message', 'server-change retry', 'auto-deposit check'])
  manager.sessions.delete('one')
  assert.deepEqual(getUpcomingRuns(manager, 'one'), [])
  assert.throws(() => getUpcomingRuns(manager, ''), /Account id/)
})

test('scheduled messages disappear after execution', async () => {
  const manager = new BotManager({ profilesPath: '/tmp/profiles', emit() {} })
  const session = { account: {}, upcomingMessages: new Map(), messageTimers: new Set() }
  manager.sessions.set('one', session)
  let sent = ''
  manager.sendChat = (_id, value) => { sent = value }
  manager.scheduleMessage('one', 'hello', 0)
  assert.equal(manager.getUpcomingRuns('one')[0].kind, 'message')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sent, 'hello')
  assert.deepEqual(manager.getUpcomingRuns('one'), [])
})
