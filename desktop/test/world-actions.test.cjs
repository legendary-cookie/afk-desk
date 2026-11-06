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
  bot.lookAt = async () => {}
  bot.supportFeature = feature => feature === 'blockPlaceHasInsideBlock'
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

test('crosshair use places held blocks on the hit face and opens GUIs while holding blocks', async t => {
  const {manager, bot} = fixture(t)
  const block = {name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3}
  bot.world = {raycast: () => block}
  bot.heldItem = {name: 'dirt', count: 5}
  bot.registry = {blocksByName: {dirt: {id: 3}}}
  const packets = []
  bot._client.write = (name, packet) => {
    packets.push([name, packet])
    if (block.name === 'stone') bot.emit('blockUpdate', null, {name: 'dirt', position: block.position.offset(0, 0, 1)})
    else bot.emit('windowOpen', {})
  }
  assert.equal((await manager.worldAction('world', 'use-crosshair')).placed, true)
  assert.equal(packets[0][1].direction, 3)
  for (const name of ['chest', 'barrel', 'crafting_table', 'furnace']) {
    block.name = name
    const result = await manager.worldAction('world', 'use-crosshair')
    assert.equal(result.used, true)
    assert.equal(result.message, `Opened ${name.replace(/_/g, ' ')}`)
  }
  assert.deepEqual(packets.map(([, p]) => p.sequence), [1, 2, 3, 4, 5])
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

test('crosshair block placement fails visibly with nothing in reach, while held items can still be used', async t => {
  const { manager, bot } = fixture(t)
  bot.world = { raycast: () => null }
  bot.registry = { blocksByName: { dirt: { id: 3 } } }
  bot.heldItem = { name: 'dirt' }
  let uses = 0
  bot.activateItem = () => { uses++ }
  await assert.rejects(manager.worldAction('world', 'use-crosshair'), /Can't place: nothing in reach/)
  await assert.rejects(manager.worldAction('world', 'dig-crosshair'), /in reach/)
  assert.equal(uses, 0)
  bot.heldItem = { name: 'bread' }
  assert.equal((await manager.worldAction('world', 'use-crosshair')).used, true)
  assert.equal(uses, 1)
})

test('real crosshair ray hits the closest shape using live eye height, yaw and pitch and rejects beyond reach', async t => {
  const { manager, bot } = fixture(t)
  const WorldSync = require('prismarine-world/src/worldsync')
  const world = new WorldSync({})
  const blocks = []
  world.getBlock = point => blocks.find(block => block.position.equals(point)) || null
  bot.world = world
  bot.entity.position = new Vec3(.5, 64, .5)
  bot.entity.eyeHeight = 1.27
  const add = position => blocks.push({ name: 'stone', position, shapes: [[0, 0, 0, 1, 1, 1]] })
  add(new Vec3(2, 65, 0)); add(new Vec3(4, 65, 0))
  bot.entity.yaw = -Math.PI / 2
  bot.entity.pitch = 0
  let dug
  bot.dig = async (block, mode) => { dug = block; assert.equal(mode, 'ignore') }
  await manager.worldAction('world', 'dig-crosshair')
  assert.equal(dug, blocks[0], 'the nearer block occludes the farther block')
  assert.ok(Math.abs(dug.intersect.y - 65.27) < 1e-9, 'ray starts at the live crouching eye')
  assert.equal(dug.face, 4)
  blocks.length = 0
  add(new Vec3(0, 64, -1))
  bot.entity.yaw = 0; bot.entity.pitch = -Math.PI / 4
  await manager.worldAction('world', 'dig-crosshair')
  assert.equal(dug, blocks[0], 'negative pitch aims down')
  blocks.length = 0
  add(new Vec3(0, 65, -6))
  bot.entity.pitch = 0
  await assert.rejects(manager.worldAction('world', 'dig-crosshair'), /in reach/)
})


test('cursor ray chooses the clicked trapdoor over the centre chest and looks before sending hit offsets and increasing sequences', async t => {
  const { manager, bot } = fixture(t)
  const WorldSync = require('prismarine-world/src/worldsync')
  const { cameraRay } = require('../assets/pov-math.js')
  const world = new WorldSync({})
  bot.entity.position = new Vec3(.5, 64, .5)
  const blocks = [
    { name: 'chest', position: new Vec3(0, 65, -3), shapes: [[0, 0, 0, 1, 1, 1]] },
    { name: 'oak_trapdoor', stateId: 1, position: new Vec3(2, 65, -3), shapes: [[0, 0, 0, 1, 1, .1875]], getProperties: () => ({ open: false }) }
  ]
  world.getBlock = point => blocks.find(b => b.position.equals(point)) || null
  bot.world = world
  let finishLook, lookPoint
  bot.lookAt = (point, force) => {
    assert.equal(force, false, 'wait for the look packet')
    lookPoint = point
    return new Promise(resolve => { finishLook = resolve })
  }
  const packets = []
  bot._client.write = (name, packet) => {
    assert.equal(name, 'block_place')
    packets.push(packet)
    const block = blocks.find(b => b.position.equals(packet.location))
    if (block.name === 'chest') bot.emit('windowOpen', {})
    else bot.emit('blockUpdate', block, { ...block, stateId: block.stateId + 1, getProperties: () => ({ open: packets.length === 1 }) })
  }
  const snapshot = { position: bot.entity.position, yaw: 0, pitch: 0 }
  const ray = cameraRay(snapshot, .75, .5, 16 / 9)
  const use = manager.worldAction('world', 'use-crosshair', { ray })
  assert.equal(packets.length, 0, 'no interaction until the look finishes')
  assert.ok(lookPoint.x > 2)
  finishLook()
  const opened = await use
  assert.equal(opened.block, 'oak_trapdoor')
  assert.equal(opened.message, 'Opened trapdoor')
  assert.equal(packets[0].direction, 3)
  assert.ok(Math.abs(packets[0].cursorX - (lookPoint.x - 2)) < 1e-10)
  assert.ok(Math.abs(packets[0].cursorY - .62) < 1e-10)
  assert.ok(Math.abs(packets[0].cursorZ - .1875) < 1e-10)
  const close = manager.worldAction('world', 'use-crosshair', { ray })
  finishLook()
  assert.equal((await close).message, 'Closed trapdoor')
  const centre = manager.worldAction('world', 'use-crosshair')
  finishLook()
  assert.equal((await centre).block, 'chest')
  assert.deepEqual(packets.map(p => p.sequence), [1, 2, 3])
})

test('block state feedback covers doors, buttons and levers and ignores unrelated and unchanged updates', async t => {
  const { manager, bot } = fixture(t)
  const block = { name: 'oak_door', position: new Vec3(0, 65, -2), intersect: new Vec3(.25, 65.5, -1), face: 3, stateId: 10 }
  bot.world = { raycast: () => block }
  for (const name of ['oak_door', 'stone_button', 'lever']) {
    block.name = name
    bot._client.write = () => {
      bot.emit('blockUpdate', block, block)
      bot.emit('blockUpdate', block, { ...block, position: new Vec3(1, 65, -2), stateId: 11 })
      bot.emit('blockUpdate', block, { ...block, stateId: 11, getProperties: () => ({ open: true }) })
    }
    const result = await manager.worldAction('world', 'use-crosshair')
    assert.match(result.message, /^Opened /)
    assert.equal(bot.listenerCount('windowOpen'), 1, 'response listeners are removed')
  }
})

test('a use with no server state change reports no response after 500ms and cleans up', async t => {
  const { manager, bot } = fixture(t)
  const block = { name: 'oak_trapdoor', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3, stateId: 1 }
  bot.world = { raycast: () => block }
  let sent
  const packetSent = new Promise(resolve => { sent = resolve })
  bot._client.write = () => { bot.emit('blockUpdate', block, block); sent() }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = manager.worldAction('world', 'use-crosshair')
  await packetSent
  let done = false
  pending.then(() => { done = true })
  t.mock.timers.tick(499)
  await Promise.resolve()
  assert.equal(done, false)
  t.mock.timers.tick(1)
  assert.equal((await pending).message, 'No response from server')
  assert.equal(bot.listenerCount('windowOpen'), 1)
})

test('sneaking snapshots and world rays lower eye height without subtracting twice; dig progress exists only during the hold', async t => {
  const { manager, bot } = fixture(t)
  const standing = manager.worldSnapshot('world', 2)
  assert.equal(standing.sneaking, false)
  assert.ok(Math.abs(standing.eyeHeight - 1.62) < 1e-9)
  bot.controlState = { sneak: true }
  const crouch = manager.worldSnapshot('world', 2)
  assert.equal(crouch.sneaking, true)
  assert.ok(Math.abs(standing.eyeHeight - crouch.eyeHeight - .3) < 1e-9)
  bot.entity.eyeHeight = 1.27
  assert.ok(Math.abs(manager.worldSnapshot('world', 2).eyeHeight - 1.27) < 1e-9)
  const block = { name: 'stone', position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.27, -1), face: 3 }
  bot.world = { raycast: eye => { assert.equal(eye.y, 65.27); return block } }
  let finish
  bot.digTime = () => 1000
  bot.dig = () => new Promise(resolve => { finish = resolve })
  bot.stopDigging = () => finish()
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const digging = manager.worldAction('world', 'dig-crosshair')
  assert.equal(manager.worldSnapshot('world', 2).digging.progress, 0)
  t.mock.timers.tick(400)
  assert.deepEqual(manager.worldSnapshot('world', 2).digging, { block: 'stone', progress: .4 })
  await manager.worldAction('world', 'stop-dig')
  assert.equal(manager.worldSnapshot('world', 2).digging, null)
  assert.equal((await digging).cancelled, true)
})

test('cursor rays reject forged distant eyes and malformed vectors before interacting', async t => {
  const { manager, bot } = fixture(t)
  bot.world = { raycast: () => assert.fail('invalid ray must not reach raycast') }
  for (const ray of [null, { origin: { x: 100, y: 65, z: 0 }, direction: { x: 0, y: 0, z: -1 } }, { origin: { x: 0, y: 65.62, z: 0 }, direction: { x: NaN, y: 0, z: -1 } }]) {
    await assert.rejects(manager.worldAction('world', 'use-crosshair', { ray }), /Invalid cursor ray/)
  }
})


test('using a held block also observes target state changes for interactions such as composters', async t => {
  const { manager, bot } = fixture(t)
  const block = { name: 'composter', stateId: 1, position: new Vec3(0, 65, -2), intersect: new Vec3(0, 65.62, -1), face: 3 }
  bot.world = { raycast: () => block }
  bot.registry = { blocksByName: { wheat_seeds: {} } }
  bot.heldItem = { name: 'wheat_seeds' }
  bot._client.write = () => bot.emit('blockUpdate', block, { ...block, stateId: 2 })
  assert.equal((await manager.worldAction('world', 'use-crosshair')).message, 'Used composter')
})

for (const version of ['1.21.1', '1.21.11']) {
  test(`${version}: native Mineflayer look packet precedes serializable block_place with per-session sequences`, async t => {
    const { manager, bot } = fixture(t)
    const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module')
    bot.registry = require('minecraft-data')(version)
    bot.supportFeature = feature => bot.registry.supportFeature(feature)
    bot.entity.velocity = new Vec3(0, 0, 0)
    bot.game = { gameMode: 'survival' }
    bot.isAlive = true
    bot.swingArm = () => {}
    const serializer = require('minecraft-protocol').createSerializer({ state: 'play', isServer: false, version })
    const packets = []
    bot._client.write = (name, params) => {
      assert.ok(serializer.createPacketBuffer({ name, params }).length > 0)
      packets.push({ name, params: { ...params } })
      if (name === 'block_place') bot.emit('windowOpen', {})
    }
    let now = 0, tick
    const physicsPath = require.resolve('mineflayer/lib/plugins/physics')
    const nativeRequire = createRequire(physicsPath)
    const context = { module: { exports: {} }, require: name => name === 'perf_hooks' ? { performance: { now: () => now } } : nativeRequire(name),
      setInterval: fn => { tick = fn; return 1 }, clearInterval() {}, setTimeout, clearTimeout, console }
    vm.runInNewContext(fs.readFileSync(physicsPath, 'utf8'), context)
    context.module.exports(bot, { physicsEnabled: false })
    const block = { name: 'chest', position: new Vec3(1, 65, -2), intersect: new Vec3(1.25, 65.5, -1), face: 3 }
    bot.world = { raycast: () => block }
    bot.blockAt = () => block
    bot.emit('login')
    bot._client.emit('position', { x: 0, y: 64, z: 0, yaw: 180, pitch: 0, flags: 0, teleportId: 1 })
    packets.length = 0
    const first = manager.worldAction('world', 'use-crosshair')
    assert.equal(packets.length, 0, 'look has not reached the wire before a movement tick')
    now += 50; tick()
    assert.ok(packets.some(p => /look$/.test(p.name)), 'the native tick sends a look packet')
    assert.equal((await first).message, 'Opened chest')
    assert.ok(packets.findIndex(p => /look$/.test(p.name)) < packets.findIndex(p => p.name === 'block_place'))
    const second = manager.worldAction('world', 'use-crosshair')
    now += 50; tick()
    await second
    const uses = packets.filter(p => p.name === 'block_place').map(p => p.params)
    assert.deepEqual(uses.map(p => p.sequence), [1, 2])
    assert.equal(uses[0].cursorX, .25)
    assert.equal(uses[0].cursorY, .5)
    assert.equal(uses[0].cursorZ, 1)
  })
}
