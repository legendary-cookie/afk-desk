const test = require('node:test')
const assert = require('node:assert/strict')
const { viewBasis, projectHorizontal, mouseLookDelta } = require('../assets/pov-math.js')

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
