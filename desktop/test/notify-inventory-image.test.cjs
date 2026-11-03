'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { inventoryLayout } = require('../electron/notify/inventory-image.cjs')
test('inventory layout includes main slots and equipment with names and counts', () => {
  const cells = inventoryLayout([{ slot: 9, name: 'stone', count: 64 }, { slot: 45, displayName: 'Shield', count: 1 }])
  assert.equal(cells.length, 41)
  assert.deepEqual(cells[0], { slot: 9, x: 0, y: 0, name: 'stone', count: 64 })
  assert.deepEqual(cells[40], { slot: 45, x: 4, y: 4, name: 'Shield', count: 1 })
})
