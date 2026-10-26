const test = require('node:test')
const assert = require('node:assert/strict')
const { viewBasis, projectHorizontal, mouseLookDelta, entityLabel, snapshotRadius } = require('../assets/pov-math.js')

test('perspective chunk settings become bounded block radii while map radius stays independent', () => {
  assert.equal(snapshotRadius({}, 'perspective', 6), 16)
  for (const [value, radius] of [[1, 16], [4, 64], [8, 128], [999, 128], [-1, 16], ['bad', 16]]) {
    assert.equal(snapshotRadius({ povRenderDistance: value }, 'perspective', 6), radius)
  }
  assert.equal(snapshotRadius({ povRenderDistance: 8 }, 'map', 6), 6)
})

test('display types never become generic labels, including old snapshots', () => {
  for (const name of ['minecraft:text_display', 'text_display', 'Text Display', 'item_display', 'block_display', 'armor_stand']) {
    assert.equal(entityLabel({ name, type: 'other' }), '', name)
  }
  assert.equal(entityLabel({ entityType: 'text_display', name: 'Text Display', label: 'Welcome' }), 'Welcome')
  assert.equal(entityLabel({ entityType: 'armor_stand', label: 'Shop' }), 'Shop')
  assert.equal(entityLabel({ entityType: 'item_display', label: 'Item Display' }), '')
  assert.equal(entityLabel({ type: 'player', username: 'Steve' }), 'Steve')
})

test('POV projects blocks in front and behind the player correctly', () => {
  assert.equal(projectHorizontal(0, -5, 0).depth, 5)
  assert.equal(projectHorizontal(0, 5, 0).depth, -5)
  assert.equal(projectHorizontal(3, -5, 0).side, 3)
  assert.ok(Math.abs(projectHorizontal(-5, 0, Math.PI / 2).depth - 5) < 1e-10)
})

test('POV mouse look follows Minecraft yaw and pitch directions', () => {
  assert.deepEqual(mouseLookDelta(100, -100), {yaw: -0.25, pitch: 0.25})
  const basis = viewBasis(0, 999)
  assert.equal(basis.pitch, 1.45)
  assert.ok(basis.forward.y > 0)
})
