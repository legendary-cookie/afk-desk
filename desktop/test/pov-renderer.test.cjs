const test = require('node:test')
const assert = require('node:assert/strict')
const { VoxelRenderer, surfaceColor } = require('../assets/pov-renderer.js')

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
