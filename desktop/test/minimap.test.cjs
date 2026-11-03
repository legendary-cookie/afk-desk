'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { blockColor, sampleGrid, goalPosition, entityType } = require('../electron/minimap.cjs')

test('minimap colors classify known blocks and air', () => {
  assert.equal(blockColor('minecraft:water'), 2)
  assert.equal(blockColor('grass_block'), 1)
  assert.equal(blockColor('cave_air'), 0)
  assert.equal(blockColor('stone'), 4)
})
test('surface and cave sampling select highest block and handle unloaded columns', () => {
  const getBlock = (x, y) => x === -16 ? null : { name: y === 5 ? 'grass_block' : y === 1 ? 'stone' : 'air' }
  const opts = { position: { x: 0, y: 2, z: 0 }, radius: 16, minY: 0, maxY: 8, getBlock }
  const surface = sampleGrid({ ...opts, mode: 'surface' })
  const cave = sampleGrid({ ...opts, mode: 'cave' })
  assert.equal(surface.size, 33)
  assert.equal(surface.colors[0], 0)
  assert.equal(surface.colors[1], 1)
  assert.equal(cave.colors[1], 4)
})
test('radius is bounded and goal requires three finite coordinates', () => {
  const grid = sampleGrid({ position: { x: 0, y: 0, z: 0 }, radius: 999, minY: 0, maxY: 0, getBlock: () => null })
  assert.ok(grid.size <= 65)
  assert.deepEqual(goalPosition({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 })
  assert.equal(goalPosition({ x: 1, z: 3 }), null)
})

test('modern and legacy mobs are included without unrelated entities', () => {
  assert.equal(entityType({ type: 'hostile', kind: 'Hostile mobs' }), 'mob')
  assert.equal(entityType({ type: 'mob' }), 'mob')
  assert.equal(entityType({ type: 'player' }), 'player')
  assert.equal(entityType({ type: 'object' }), null)
})
