const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { VoxelRenderer, surfaceColor, material } = require('../assets/pov-renderer.js')

test('entity overlay draws hologram content with pitch projection and skips unnamed display entities', () => {
  const labels = []
  const context = vm.createContext({ povMath: require('../assets/pov-math.js'), maskText: (text) => text })
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function drawPovEntities('), source.indexOf('function drawPovHud(')), context)
  const canvas = { width: 960, height: 540 }
  const draw = { save() {}, restore() {}, fillText: (...args) => labels.push(args) }
  const position = { x: 0, y: 64, z: 0 }
  const entities = [
    { entityType: 'text_display', label: 'Welcome\nTraveler', x: 0, y: 65.62, z: -5 },
    { entityType: 'armor_stand', label: 'Shop', x: 0, y: 65.62, z: -8 },
    ...['text_display', 'item_display', 'block_display', 'armor_stand'].map(name => ({ name, x: 0, y: 65.62, z: -5 }))
  ]
  context.drawPovEntities(draw, { position, yaw: 0, pitch: 0, renderDistance: 16, entities }, canvas)
  assert.deepEqual(labels.map(args => args[0]), ['Welcome', 'Traveler', 'Shop'])
  assert.ok(Math.abs(labels[0][2] - 270) < 1e-8)
  labels.length = 0
  context.drawPovEntities(draw, { position, yaw: 0, pitch: .2, renderDistance: 16, entities }, canvas)
  assert.ok(labels[0][2] > 270, 'looking up moves a level label below the crosshair')
})

test('common block names, variants and shapes keep their base material', () => {
  const cases = {
    grass_block: 'grass', grass: 'leaves', short_grass: 'leaves', moss_block: 'leaves', mossy_cobblestone: 'stone',
    oak_log: 'log', birch_log: 'log', spruce_log: 'log', dark_oak_log: 'log', stripped_birch_log: 'log',
    crimson_stem: 'log', warped_hyphae: 'log', oak_wood: 'log', oak_planks: 'planks',
    oak_stairs: 'planks', birch_slab: 'planks', spruce_fence: 'planks', dark_oak_fence_gate: 'planks',
    stone_slab: 'stone', stone_brick_stairs: 'stone', cobblestone_wall: 'stone', deepslate_tiles: 'stone',
    brick_stairs: 'bricks', red_sandstone_slab: 'sand', sandstone_wall: 'sand',
    oak_leaves: 'leaves', azalea_leaves: 'leaves', mangrove_leaves: 'leaves', glass_pane: 'glass',
    red_stained_glass_pane: 'glass', blue_wool: 'wool', red_concrete: 'concrete',
    light_blue_concrete_powder: 'concrete', orange_terracotta: 'terracotta', black_wool: 'wool',
    white_concrete: 'concrete', terracotta: 'terracotta', snow_block: 'snow', quartz_stairs: 'snow',
    dirt: 'dirt', water: 'water', diamond_ore: 'ore', 'minecraft:oak_stairs[facing=east]': 'planks'
  }
  for (const [name, kind] of Object.entries(cases)) assert.equal(material(name), kind, name)
  for (const [variant, base] of [['oak_stairs', 'oak_planks'], ['birch_slab', 'birch_planks'], ['spruce_fence', 'spruce_planks'], ['stone_brick_stairs', 'stone_bricks'], ['glass_pane', 'glass']]) {
    assert.deepEqual(surfaceColor(variant, 'side', 4, 4), surfaceColor(base, 'side', 4, 4), variant)
  }
  assert.deepEqual(surfaceColor('minecraft:birch_log[axis=y]', 'side', 4, 4), surfaceColor('birch_log', 'side', 4, 4))
  assert.notDeepEqual(surfaceColor('oak_log', 'side', 4, 4), surfaceColor('birch_log', 'side', 4, 4))
  assert.notDeepEqual(surfaceColor('oak_planks', 'side', 4, 4), surfaceColor('spruce_planks', 'side', 4, 4))
  for (const family of ['wool', 'concrete', 'terracotta', 'stained_glass_pane']) {
    assert.notDeepEqual(surfaceColor(`red_${family}`, 'side', 4, 4), surfaceColor(`blue_${family}`, 'side', 4, 4), family)
  }
})

test('chunk draw distance reaches distant blocks in both directions beyond the old 64 cell index', () => {
  const renderer = new VoxelRenderer()
  const snapshot = { position: { x: 0, y: 0, z: 0 }, radius: 128, renderDistance: 128, blockRevision: 1,
    blocks: [{ x: -100, y: 1, z: -80, name: 'stone', solid: true }, { x: 0, y: 1, z: -80, name: 'red_wool', solid: true }] }
  renderer.update(snapshot)
  assert.ok(renderer.trace({ x: .5, y: 1.62, z: 0 }, { x: 0, y: 0, z: -1 }, 128))
  const far = Uint8Array.from(renderer.render(snapshot, 17, 9).data)
  const near = renderer.render({ ...snapshot, renderDistance: 16 }, 17, 9).data
  assert.notDeepEqual(far, Uint8Array.from(near))
})

test('original textures distinguish grass faces, planks, stone and water', () => {
  assert.notDeepEqual(surfaceColor('grass_block', 'top', 4, 4), surfaceColor('grass_block', 'side', 4, 4))
  assert.notDeepEqual(surfaceColor('oak_planks', 'side', 4, 4), surfaceColor('stone', 'side', 4, 4))
  assert.notDeepEqual(surfaceColor('stone', 'side', 4, 4), surfaceColor('stone', 'side', 7, 9))
  assert.notDeepEqual(surfaceColor('water', 'top', 4, 4), surfaceColor('glass', 'top', 4, 4))
})

test('shape tracing passes above a slab and hits its lower half', () => {
  const renderer = new VoxelRenderer()
  renderer.update({ blockRevision: 1, blocks: [{ x: 0, y: 0, z: -2, name: 'stone_slab', solid: true, shapes: [[0, 0, 0, 1, .5, 1]] }] })
  assert.equal(renderer.trace({ x: .5, y: .75, z: 0 }, { x: 0, y: 0, z: -1 }, 6), null)
  assert.equal(renderer.trace({ x: .5, y: .25, z: 0 }, { x: 0, y: 0, z: -1 }, 6).block.name, 'stone_slab')
})

test('renderer reuses frame and block index, invalidating only on revision changes', () => {
  const renderer = new VoxelRenderer()
  const snapshot = { position: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: -.2, radius: 6, blockRevision: 1, blocks: [{ x: 0, y: 0, z: -2, name: 'grass_block', solid: true }] }
  const first = renderer.render(snapshot, 96, 54)
  const second = renderer.render({ ...snapshot, blocks: [...snapshot.blocks] }, 96, 54)
  assert.equal(first, second)
  assert.equal(renderer.indexBuilds, 1)
  renderer.render({ ...snapshot, blockRevision: 2 }, 96, 54)
  assert.equal(renderer.indexBuilds, 2)
  assert.equal(first.data.length, 96 * 54 * 4)
  assert.equal(first.data[3], 255)
})

test('render dimensions and snapshot input remain bounded', () => {
  const renderer = new VoxelRenderer()
  const frame = renderer.render({ position: { x: 0, y: 0, z: 0 }, blocks: [] }, 9999, 9999)
  assert.ok(frame.width <= 320 && frame.height <= 180)
})


test('voxel renderer and cursor targeting share camera rays and the sneaking eye offset', () => {
  const { cameraRay } = require('../assets/pov-math.js')
  const renderer = new VoxelRenderer()
  const snapshot = { position: { x: 2, y: 64, z: -1 }, yaw: 1.2, pitch: -.4, blocks: [] }
  const origins = [], rays = []
  renderer.trace = (origin, ray) => { origins.push({ ...origin }); rays.push({ ...ray }); return null }
  renderer.render(snapshot, 17, 9)
  const standing = origins[0].y
  origins.length = 0; rays.length = 0
  renderer.render({ ...snapshot, sneaking: true }, 17, 9)
  assert.ok(Math.abs(standing - origins[0].y - .3) < 1e-9)
  for (const [x, y] of [[8, 4], [15, 2], [1, 7]]) {
    const expected = cameraRay({ ...snapshot, sneaking: true }, (x + .5) / 17, (y + .5) / 9, 17 / 9)
    assert.deepEqual(origins[y * 17 + x], expected.origin)
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(rays[y * 17 + x][axis] - expected.direction[axis]) < 1e-10)
  }
})

test('POV and Wall action HUD show a persistent sneak badge and masked digging progress', () => {
  const labels = [], bars = []
  const context = vm.createContext({ maskText: text => text.replace('PrivatePlayer', 'Masked') })
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function drawPovActionHud('), source.indexOf('function showPovStatus(')), context)
  const draw = { save() {}, restore() {}, measureText: () => ({ width: 60 }), fillText: text => labels.push(text), fillRect: (...args) => bars.push(args) }
  const canvas = { width: 960, height: 540 }
  context.drawPovActionHud(draw, canvas, { sneaking: true, digging: { block: 'PrivatePlayer_stone', progress: .4 } })
  assert.deepEqual(labels, ['Sneaking', 'Breaking Masked stone · 40%'])
  assert.equal(bars.at(-1)[2], 88)
  labels.length = 0; bars.length = 0
  context.drawPovActionHud(draw, canvas, { sneaking: false, digging: null })
  assert.equal(labels.length, 0)
  assert.equal(bars.length, 0)
})


test('held item custom names are masked before drawing the POV HUD', () => {
  const labels = []
  const context = vm.createContext({ state: { telemetry: new Map(), settings: {} }, povSnapshots: new Map(), window: {}, maskText: text => text.replace('PrivatePlayer', 'Masked') })
  const source = fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8')
  vm.runInContext(source.slice(source.indexOf('function drawPovHud('), source.indexOf('function drawPovActionHud(')), context)
  const draw = { fillRect() {}, strokeRect() {}, fillText: text => labels.push(text) }
  context.state.telemetry.set('pov', { inventory: [{ slot: 36, customName: '<PrivatePlayer>', count: 1 }] })
  context.drawPovHud(draw, { width: 960, height: 540 }, { id: 'pov' })
  assert.equal(labels.at(-1), '<Masked>')
})
