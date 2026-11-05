'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { setup } = require('../test-fixtures/bedrock/phase2-harness.cjs')

const item = (id, count, stack) => ({ network_id: id, count, stack_id: stack, has_stack_id: 1 })
const flush = () => new Promise(setImmediate)
test('inventory requests serialize, reconcile stack ids, and reject without changing inventory', async () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 'inventory', input: [item(1, 5, 10), item(2, 2, 20)] })
  const first = h.manager.moveInventorySlot('phase2', 36, 37)
  const second = h.manager.dropItems('phase2', 37, 2)
  await flush()
  let requests = h.packets('item_stack_request'); assert.equal(requests.length, 1)
  assert.equal(requests[0].requests[0].actions[0].type_id, 'swap')
  h.client.emit('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 1, count: 5, item_stack_id: 33 }] }] }] })
  await first; await flush(); requests = h.packets('item_stack_request')
  assert.equal(requests.length, 2); assert.equal(requests[1].requests[0].request_id, -3)
  assert.equal(requests[1].requests[0].actions[0].source.stack_id, 33)
  h.client.emit('item_stack_response', { responses: [{ request_id: -3, status: 'error' }] })
  await assert.rejects(second, /rejected/); assert.equal(h.session.rawInventory[1].count, 5)
  h.manager.disconnect('phase2')
})
test('locks, timeout, synchronization and disconnect fence inventory operations', async () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  h.manager.setItemLocks('phase2', [36]); await assert.rejects(h.manager.dropStack('phase2', 36), /locked/)
  h.manager.setItemLocks('phase2', []); const pending = h.manager.dropStack('phase2', 36); await flush()
  h.timers.advance(10000); await assert.rejects(pending, /timed out/)
  await assert.rejects(h.manager.dropStack('phase2', 36), /synchronization/)
  h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  const last = h.manager.dropStack('phase2', 36); await flush(); h.manager.disconnect('phase2'); await assert.rejects(last, /closed/)
})
test('hotbar selection and use send the held item', () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10), item(2, 2, 20)] })
  h.manager.worldAction('phase2', 'select-hotbar', { slot: 1 }); h.manager.worldAction('phase2', 'use-held')
  assert.equal(h.packets('mob_equipment')[0].item.network_id, 2)
  assert.equal(h.packets('inventory_transaction')[0].transaction.transaction_data.held_item.network_id, 2)
  assert.equal(h.session.selectedHotbarSlot, 1); h.manager.disconnect('phase2')
})
test('equipping a hotbar item selects it and respects locks', async () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 1, 10)] })
  h.manager.setItemLocks('phase2', [36]); await assert.rejects(h.manager.equipInventoryItem('phase2', 36, 'hand'), /locked/)
  h.manager.setItemLocks('phase2', []); assert.deepEqual(await h.manager.equipInventoryItem('phase2', 36, 'hand'), { sourceSlot: 36, targetSlot: 36, destination: 'hand' })
  assert.equal(h.packets('mob_equipment').length, 1); h.manager.disconnect('phase2')
})
test('stack request packet matches the supported Bedrock serializer', async () => {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  const pending = h.manager.moveInventorySlot('phase2', 36, 37); await flush()
  assert.doesNotThrow(() => createSerializer(h.client.version).createPacketBuffer({ name: 'item_stack_request', params: h.packets('item_stack_request')[0] }))
  h.client.emit('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [] }] }); await pending
  h.manager.disconnect('phase2')
})

test('open chest contents transfer both ways and close is reported', async () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  h.client.emit('container_open', { window_id: 5, window_type: 'container' })
  h.client.emit('inventory_content', { window_id: 5, input: [{ network_id: 0 }, item(2, 3, 20)] })
  const deposit = h.manager.depositSlot('phase2', 36, 2); await flush()
  const action = h.packets('item_stack_request')[0].requests[0].actions[0]
  assert.equal(action.destination.slot_type.container_id, 'container'); assert.equal(action.count, 2)
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  assert.doesNotThrow(() => createSerializer(h.client.version).createPacketBuffer({ name: 'item_stack_request', params: h.packets('item_stack_request')[0] }))
  h.client.emit('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [{ slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 2, item_stack_id: 44 }] }] }] }); await deposit
  assert.equal(h.session.rawInventory[0].count, 3); assert.equal(h.session.openWindow.slots[0].stack_id, 44)
  const withdraw = h.manager.clickWindowSlot('phase2', 0); await flush()
  assert.equal(h.packets('item_stack_request')[1].requests[0].actions[0].source.stack_id, 44)
  h.client.emit('item_stack_response', { responses: [{ request_id: -3, status: 'ok', containers: [] }] }); await withdraw
  assert.equal(h.session.rawInventory[9].count, 2)
  h.manager.closeWindow('phase2'); assert.equal(h.packets('container_close').length, 1)
  assert.equal(h.events.filter(([type]) => type === 'window').at(-1)[2].open, false)
  h.manager.disconnect('phase2')
})

test('container transfer respects locks and rejects a closed window response', async () => {
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  h.client.emit('container_open', { window_id: 5, window_type: 'container' }); h.client.emit('inventory_content', { window_id: 5, input: [{ network_id: 0 }] })
  h.manager.setItemLocks('phase2', [36]); await assert.rejects(h.manager.depositSlot('phase2', 36), /locked/)
  h.manager.setItemLocks('phase2', []); const pending = h.manager.depositSlot('phase2', 36); await flush()
  h.client.emit('container_close', { window_id: 5 }); h.client.emit('item_stack_response', { responses: [{ request_id: -1, status: 'ok' }] })
  await assert.rejects(pending, /closed/); assert.equal(h.session.rawInventory[0].count, 5)
  h.manager.disconnect('phase2')
})

test('Bedrock macro deposit and close use the open container', async () => {
  const { createFacade } = require('../electron/macro/facade.cjs')
  const h = setup(); h.client.emit('inventory_content', { window_id: 0, input: [item(1, 5, 10)] })
  h.client.emit('container_open', { window_id: 5, window_type: 'container' }); h.client.emit('inventory_content', { window_id: 5, input: [{ network_id: 0 }] })
  const facade = createFacade({ bots: h.manager, getEdition: () => 'bedrock' })
  assert.equal(facade.state('phase2').windowOpen, true)
  const pending = facade.deposit('phase2', { select: { slot: 36 }, count: 2 }); await flush()
  h.client.emit('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [] }] }); await pending
  await facade.closeGui('phase2'); assert.equal(facade.state('phase2').windowOpen, false)
  h.manager.disconnect('phase2')
})
