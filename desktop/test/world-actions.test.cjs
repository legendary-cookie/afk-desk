const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { BotManager } = require('../electron/bot-manager.cjs')

function fixture(t) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.inventory = new EventEmitter()
  bot.inventory.items = () => []
  bot.inventory.slots = []
  bot.setControlState = () => {}
  bot.quit = () => bot.emit('end')
  bot.quickBarSlot = 0
  const manager = new BotManager({profilesPath: 'profiles', emit: () => {}, createBot: () => bot})
  manager.connect({id: 'world', username: 'fixture', host: 'localhost', antiAfk: false, autoReconnect: false})
  bot.entity = {position: new Vec3(0, 64, 0), eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0}
  t.after(() => manager.disconnect('world'))
  return {manager, bot}
}

test('display and armor stand snapshots carry plain hologram text, never raw type labels', t => {
  const { manager, bot } = fixture(t)
  bot.registry = require('minecraft-data')('1.21.4')
  const keys = bot.registry.entitiesByName.text_display.metadataKeys
  const metadata = []
  metadata[keys.indexOf('text')] = { type: 'compound', value: { text: { type: 'string', value: '§aWelcome ' }, extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'Traveler' } }] } } } }
  bot.entities = {
    2: { id: 2, name: 'text_display', displayName: 'Text Display', type: 'other', metadata, position: new Vec3(0, 65, -2) },
    3: { id: 3, name: 'minecraft:armor_stand', customName: '{"text":"§bShop","extra":[{"text":" keeper"}]}', position: new Vec3(1, 65, -2) },
    4: { id: 4, name: 'item_display', displayName: 'Item Display', position: new Vec3(2, 65, -2) },
    5: { id: 5, name: 'text_display', displayName: 'Text Display', position: new Vec3(3, 65, -2) }
  }
  const entities = manager.worldSnapshot('world').entities
  assert.equal(entities.find(e => e.id === 2).label, 'Welcome Traveler')
  assert.equal(entities.find(e => e.id === 3).label, 'Shop keeper')
  assert.equal(entities.find(e => e.id === 4).label, '')
  assert.equal(entities.find(e => e.id === 5).label, '')
})

test('extended snapshot radius reaches eight chunks and caps dense blocks near the bot first', t => {
  const { manager, bot } = fixture(t)
  bot.blockAt = position => ({ position, name: 'stone', boundingBox: 'block' })
  const snapshot = manager.worldSnapshot('world', 128)
  assert.equal(snapshot.radius, 128)
  assert.equal(snapshot.renderDistance, 128)
  assert.equal(snapshot.blocks.length, 16000)
  for (const [x, z] of [[-2, -2], [2, 2], [-2, 2], [2, -2]]) assert.ok(snapshot.blocks.some(b => b.x === x && b.z === z && b.y === 65))
  bot.blockAt = position => Math.abs(position.x) === 100 && position.z === 0 && position.y === 64 ? { position, name: 'stone', boundingBox: 'block' } : null
  bot.emit('blockUpdate', null, { position: new Vec3(100, 64, 0) })
  assert.ok(manager.worldSnapshot('world', 128).blocks.some(b => b.x === 100))
})

test('dense snapshots include every bounded cell without one-sided truncation and carry shape/held data', t => {
  const {manager, bot} = fixture(t)
  bot.blockAt = position => ({position, name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]], stateId: 100})
  bot.quickBarSlot = 3
  bot.heldItem = {name: 'stone', displayName: 'Stone', count: 12}
  const snapshot = manager.worldSnapshot('world', 12)
  assert.equal(snapshot.blocks.length, 5625)
  assert.ok(snapshot.blocks.some(b => b.x === 12 && b.y === 68 && b.z === 12))
  assert.deepEqual(snapshot.blocks[0].shapes, [[0, 0, 0, 1, 0.5, 1]])
  assert.equal(snapshot.quickBarSlot, 3)
  assert.deepEqual(snapshot.heldItem, {name: 'stone', displayName: 'Stone', count: 12})
})

test('crosshair dig uses a bounded ray even at zero yaw/pitch and can be stopped', async t => {
  const {manager, bot} = fixture(t)
  const block = {name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3}
  bot.world = {raycast: (eye, direction, range) => {
    assert.equal(range, 5)
    assert.ok(direction.equals(new Vec3(0, 0, -1)))
    return block
  }}
  let stop
  bot.dig = async target => { assert.equal(target, block); await new Promise((resolve, reject) => { stop = () => reject(new Error('Digging aborted')) }) }
  bot.stopDigging = () => stop?.()
  const digging = manager.worldAction('world', 'dig-crosshair')
  await manager.worldAction('world', 'stop-dig')
  assert.equal((await digging).cancelled, true)
})

test('coordinate dig rejects distant and occluded targets without digging', async t => {
  const {manager, bot} = fixture(t)
  bot.blockAt = position => ({name: 'stone', position})
  bot.dig = () => { throw new Error('must not dig') }
  await assert.rejects(manager.worldAction('world', 'dig-block', {x: 100, y: 64, z: 0}), /range/i)
  bot.world = {raycast: () => ({position: new Vec3(0, 65, -1), intersect: new Vec3(0, 65, -0.5), face: 3})}
  await assert.rejects(manager.worldAction('world', 'dig-block', {x: 0, y: 65, z: -3}), /visible/i)
})

test('block updates invalidate a cached world before its refresh deadline', t => {
  const {manager, bot} = fixture(t)
  let name = 'stone'
  bot.blockAt = position => ({position, name, boundingBox: 'block'})
  const before = manager.worldSnapshot('world', 2, 10000)
  name = 'dirt'
  bot.emit('blockUpdate', null, {position: new Vec3(0, 64, 0)})
  const after = manager.worldSnapshot('world', 2, 10000)
  assert.equal(after.blocks[0].name, 'dirt')
  assert.ok(after.blockRevision > before.blockRevision)
})

test('walking into a new snapshot anchor changes its revision even without block events', t => {
  const {manager, bot} = fixture(t)
  bot.blockAt = position => ({position, name: 'stone', boundingBox: 'block'})
  const before = manager.worldSnapshot('world', 2, 10000)
  bot.entity.position = new Vec3(1, 64, 0)
  const after = manager.worldSnapshot('world', 2, 10000)
  assert.notEqual(after.blockRevision, before.blockRevision)
  assert.ok(after.blocks.some(block => block.x === 3))
})

test('crosshair use places held blocks on the hit face but opens interactive blocks', async t => {
  const {manager, bot} = fixture(t)
  const block = {name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3}
  bot.world = {raycast: () => block}
  bot.heldItem = {name: 'dirt', count: 5}
  bot.registry = {blocksByName: {dirt: {id: 3}}}
  const placements = []
  bot.placeBlock = async (target, face) => placements.push([target.name, face])
  bot.activateBlock = async target => { bot.opened = target.name }
  assert.equal((await manager.worldAction('world', 'use-crosshair')).placed, true)
  assert.deepEqual(placements, [['stone', new Vec3(0, 0, 1)]])
  block.name = 'chest'
  await manager.worldAction('world', 'use-crosshair')
  assert.equal(bot.opened, 'chest')
  assert.equal(placements.length, 1)
})

test('hotbar validates exact indices, stop-use releases held items and missing raycast fails closed', async t => {
  const {manager, bot} = fixture(t)
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot }
  for (const slot of [-1, 9, 1.5, '2', null]) await assert.rejects(manager.worldAction('world', 'select-hotbar', {slot}), /integer/)
  await manager.worldAction('world', 'select-hotbar', {slot: 8})
  assert.equal(bot.quickBarSlot, 8)
  bot.deactivateItem = () => { bot.released = true }
  await manager.worldAction('world', 'stop-use')
  assert.equal(bot.released, true)
  await assert.rejects(manager.worldAction('world', 'use-crosshair'), /raycasting/)
})

test('disconnect cancels pending digging and late completion reports cancellation', async t => {
  const {manager, bot} = fixture(t)
  const block = {name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3}
  bot.world = {raycast: () => block}
  let complete
  bot.dig = () => new Promise(resolve => { complete = resolve })
  let stopped = false
  bot.stopDigging = () => { stopped = true }
  const digging = manager.worldAction('world', 'dig-crosshair')
  manager.disconnect('world')
  assert.equal(stopped, true)
  complete()
  assert.equal((await digging).cancelled, true)
})

test('stop during a coordinate look prevents a delayed dig from starting', async t => {
  const {manager, bot} = fixture(t)
  const block = {name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3}
  bot.blockAt = () => block
  bot.world = {raycast: () => block}
  let finishLook
  bot.lookAt = () => new Promise(resolve => { finishLook = resolve })
  bot.dig = () => { assert.fail('cancelled look must not start digging') }
  const pending = manager.worldAction('world', 'dig-block', {x: 0, y: 65, z: -2})
  await manager.worldAction('world', 'stop-dig')
  finishLook()
  assert.equal((await pending).cancelled, true)
})

test('snapshot geometry rejects malformed boxes and bounds each block to eight shapes', t => {
  const {manager, bot} = fixture(t)
  bot.blockAt = position => ({position, name: 'custom', boundingBox: 'block', shapes: [[0, 0, 0, NaN, 1, 1], ...Array.from({length: 20}, () => [-10, 0, 0, 10, 1, 1])]})
  const snapshot = manager.worldSnapshot('world', 2)
  assert.ok(snapshot.blocks.every(block => block.shapes.length <= 8))
  assert.deepEqual(snapshot.blocks[0].shapes[0], [0, 0, 0, 1, 1, 1])
})

test('nearest attack cannot target an entity through an occluding block', async t => {
  const {manager, bot} = fixture(t)
  bot.entities = {2: {id: 2, position: new Vec3(0, 64, -2), height: 1.8}}
  bot.world = {raycast: () => ({position: new Vec3(0, 65, -1)})}
  bot.attack = () => assert.fail('occluded entity must not be attacked')
  await assert.rejects(manager.worldAction('world', 'attack-nearest'), /not visible/)
})
