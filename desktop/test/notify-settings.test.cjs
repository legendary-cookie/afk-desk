'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { NotifySettings, classifyKickReason, crossedLowHealth } = require('../electron/notify/settings.cjs')

function fixture() {
  let value = { notificationsEnabled: false, notifyChannels: [] }
  const settingsStore = { get: () => ({ notificationsEnabled: value.notificationsEnabled }), getNotifyChannels: () => structuredClone(value.notifyChannels), raw: () => structuredClone(value), save: (input) => { value = structuredClone({ ...value, ...input }); return value } }
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`encrypted:${s}`), decryptString: (b) => { const s = b.toString(); if (!s.startsWith('encrypted:')) throw Error('bad'); return s.slice(10) } }
  return { settings: new NotifySettings(settingsStore, safeStorage), settingsStore }
}

test('notification secrets encrypt at rest and never appear in list output', () => {
  const { settings, settingsStore } = fixture()
  const item = settings.save({ type: 'discord', name: 'Alerts', webhookUrl: 'https://discord.com/api/webhooks/123/secretTOKEN', events: ['kicked'] })
  assert.equal(item.hasSecret, true); assert.equal(item.secretHint, '••••OKEN')
  assert.equal(JSON.stringify(item).includes('secretTOKEN'), false)
  assert.match(settingsStore.raw().notifyChannels[0].secretEncrypted, /ZW5jcnlwdGVk/)
  assert.equal(settings.getDecrypted()[0].webhookUrl, 'https://discord.com/api/webhooks/123/secretTOKEN')
})

test('updating channel metadata without a secret keeps the encrypted secret', () => {
  const { settings, settingsStore } = fixture()
  const saved = settings.save({ type: 'telegram', name: 'Ops', botToken: '12345:secretTOKEN123', chatId: '456' })
  settings.save({ id: saved.id, type: 'telegram', name: 'Ops 2', chatId: '456', events: [] })
  assert.equal(settings.getDecrypted()[0].botToken, '12345:secretTOKEN123')
  assert.equal(JSON.stringify(settings.list()).includes('secretTOKEN123'), false)
})

test('kick reasons map bans correctly and low health notifies only on the downward edge', () => {
  assert.equal(classifyKickReason('You are banned from this server'), 'banned')
  assert.equal(classifyKickReason('Your account was blacklisted'), 'banned')
  assert.equal(classifyKickReason('Connection lost'), 'kicked')
  assert.equal(crossedLowHealth(null, 5), true)
  assert.equal(crossedLowHealth(8, 5), true)
  assert.equal(crossedLowHealth(5, 4), false)
  assert.equal(crossedLowHealth(5, 7), false)
})
