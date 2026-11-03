'use strict'

const PALETTE = ['#242a30', '#688b49', '#527fa3', '#a89a70', '#777b80', '#70513d', '#e7e9e7', '#ad603a', '#506f3d']
function blockColor(name) {
  name = String(name || '').replace(/^minecraft:/, '')
  if (!name || /^(air|cave_air|void_air)$/.test(name)) return 0
  if (/water|ice/.test(name)) return 2
  if (/sand|gravel|sandstone/.test(name)) return 3
  if (/snow|quartz/.test(name)) return 6
  if (/lava|magma/.test(name)) return 7
  if (/leaves|grass_block|moss|grass|fern/.test(name)) return 1
  if (/log|wood|dirt|mud|farmland/.test(name)) return 5
  if (/plant|vine|crop|wheat|kelp/.test(name)) return 8
  return 4
}
function sampleGrid({ position, radius, mode, minY, maxY, getBlock }) {
  radius = Math.max(16, Math.min(96, Math.round(Number(radius) || 32)))
  const step = Math.ceil((radius * 2 + 1) / 65)
  const size = Math.ceil((radius * 2 + 1) / step)
  const x = Math.floor(position.x) - radius, z = Math.floor(position.z) - radius
  const colors = []
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let color = 0
    const top = mode === 'cave' ? Math.min(maxY, Math.floor(position.y)) : maxY
    const bottom = mode === 'cave' ? Math.max(minY, top - 16) : minY
    for (let y = top; y >= bottom; y--) {
      const block = getBlock(x + col * step, y, z + row * step)
      if (!block) break // unloaded column
      color = blockColor(block.name)
      if (color) break
    }
    colors.push(color)
  }
  return { x, z, step, size, colors }
}
function entityType(entity) {
  if (entity?.type === 'player') return 'player'
  if (entity?.type === 'mob' || /mobs/i.test(entity?.kind || '') || ['hostile', 'animal', 'ambient', 'water', 'passive'].includes(entity?.type)) return 'mob'
  return null
}
function goalPosition(goal) {
  if (!goal || ![goal.x, goal.y, goal.z].every(Number.isFinite)) return null
  return { x: goal.x, y: goal.y, z: goal.z }
}
module.exports = { PALETTE, blockColor, sampleGrid, goalPosition, entityType }
