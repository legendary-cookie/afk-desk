const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')
const prismarineBlock = require('prismarine-block')
const { Physics, PlayerState } = require('prismarine-physics')

for (const version of ['1.21.1', '1.21.8', '1.21.11']) {
  test(`the installed ${version} physics stack moves a player in directional water`, () => {
    const registry = minecraftData(version)
    const Block = prismarineBlock(version)
    const block = (name, position, level = 0) => {
      const definition = registry.blocksByName[name]
      const value = Block.fromStateId(definition.minStateId + level, 0)
      value.position = position.clone()
      return value
    }
    const world = {
      getBlock(position) {
        const point = position.floored()
        if (point.y === 64 && point.z === 0 && (point.x === 0 || point.x === 1)) {
          return block('water', point, point.x === 1 ? 2 : 1)
        }
        return block(point.y < 64 ? 'stone' : 'air', point)
      }
    }
    const bot = {
      version,
      registry,
      inventory: { slots: [] },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      entity: {
        position: new Vec3(0.5, 64, 0.5),
        velocity: new Vec3(0, 0, 0),
        onGround: false,
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: false,
        elytraFlying: false,
        yaw: 0,
        pitch: 0,
        effects: {},
        attributes: {}
      }
    }
    const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

    Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

    assert.equal(bot.entity.isInWater, true)
    assert.ok(bot.entity.position.x > 0.5)
    assert.ok(bot.entity.velocity.x > 0)
  })
}

test('the installed physics stack averages intersecting player fluid vectors like vanilla', () => {
  const version = '1.21.1'
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const block = (name, position, level = 0) => {
    const definition = registry.blocksByName[name]
    const value = Block.fromStateId(definition.minStateId + level, 0)
    value.position = position.clone()
    return value
  }
  const world = {
    getBlock(position) {
      const point = position.floored()

      // The lower water layer flows east and the upper layer flows south.
      // Vanilla averages the two intersecting vectors before applying 0.014.
      if (point.y === 64 && point.z === 0 && (point.x === 0 || point.x === 1)) {
        return block('water', point, point.x === 0 ? 0 : 1)
      }
      if (point.y === 65 && point.x === 0 && (point.z === 0 || point.z === 1)) {
        return block('water', point, point.z === 0 ? 0 : 1)
      }
      if (point.y === 64 || point.y === 65) return block('stone', point)
      return block(point.y < 64 ? 'stone' : 'air', point)
    }
  }
  const bot = {
    version,
    registry,
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

  assert.equal(bot.entity.isInWater, true)
  assert.ok(Math.abs(bot.entity.position.x - 0.507) < 1e-9, `expected vanilla X current, got ${bot.entity.position.x}`)
  assert.ok(Math.abs(bot.entity.position.z - 0.507) < 1e-9, `expected vanilla Z current, got ${bot.entity.position.z}`)
})

test('solid walls block fluid from sampling water beneath them', () => {
  const version = '1.21.1'
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const block = (name, position, level = 0) => {
    const definition = registry.blocksByName[name]
    const value = Block.fromStateId(definition.minStateId + level, 0)
    value.position = position.clone()
    return value
  }
  const world = {
    getBlock(position) {
      const point = position.floored()
      if (point.equals(new Vec3(0, 64, 0))) return block('water', point, 0)
      if (point.equals(new Vec3(1, 64, 0))) return block('water', point, 1)
      if (point.equals(new Vec3(0, 64, 1))) return block('stone', point)
      if (point.equals(new Vec3(0, 63, 1))) return block('water', point, 1)
      return block(point.y < 64 ? 'stone' : 'air', point)
    }
  }
  const bot = {
    version,
    registry,
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

  assert.ok(Math.abs(bot.entity.position.x - 0.514) < 1e-9, `expected east-only current, got ${bot.entity.position.x}`)
  assert.ok(Math.abs(bot.entity.position.z - 0.5) < 1e-9, `solid south wall leaked current, got ${bot.entity.position.z}`)
})

test('a zero-collision wall sign still blocks fluid flow from water beneath it', () => {
  const version = '1.21.1'
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const block = (name, position, level = 0) => {
    const definition = registry.blocksByName[name]
    const value = Block.fromStateId(definition.minStateId + level, 0)
    value.position = position.clone()
    return value
  }
  const world = {
    getBlock(position) {
      const point = position.floored()
      if (point.equals(new Vec3(0, 64, 0))) return block('water', point, 0)
      if (point.equals(new Vec3(1, 64, 0))) return block('water', point, 1)
      // State offset 1 is a dry north-facing wall sign. Offset 0 is waterlogged
      // and would hide the incorrect "look through the sign" branch entirely.
      if (point.equals(new Vec3(0, 64, 1))) return block('spruce_wall_sign', point, 1)
      if (point.equals(new Vec3(0, 63, 1))) return block('water', point, 1)
      return block(point.y < 64 ? 'stone' : 'air', point)
    }
  }
  const bot = {
    version,
    registry,
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

  assert.ok(Math.abs(bot.entity.position.x - 0.514) < 1e-9, `expected east-only current, got ${bot.entity.position.x}`)
  assert.ok(Math.abs(bot.entity.position.z - 0.5) < 1e-9, `wall sign leaked current, got ${bot.entity.position.z}`)
})

test('diagonal water current slides along the open axis beside a chest wall', () => {
  const version = '1.21.1'
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const block = (name, position, stateOffset = 0) => {
    const definition = registry.blocksByName[name]
    const value = Block.fromStateId(definition.minStateId + stateOffset, 0)
    value.position = position.clone()
    return value
  }
  const blocks = new Map()
  const place = (x, y, z, name, stateOffset = 0) => {
    blocks.set(`${x},${y},${z}`, { name, stateOffset })
  }

  // Reduced from StarrySea's captured block snapshot. The current points
  // northwest: stone/chests stop northward motion, but the west lane is water.
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) place(x, 127, z, 'stone')
  }
  place(-1, 128, -1, 'water', 8)
  place(-1, 128, 0, 'spruce_wall_sign', 7)
  place(-1, 128, 1, 'stone')
  place(0, 128, -1, 'stone')
  place(0, 128, 0, 'water', 5)
  place(0, 128, 1, 'stone')
  place(1, 128, -1, 'stone')
  place(1, 128, 0, 'water', 4)
  place(1, 128, 1, 'stone')
  place(-1, 129, -1, 'water', 1)
  place(-1, 129, 0, 'water', 0)
  place(-1, 129, 1, 'stone')
  place(0, 129, -1, 'chest')
  place(0, 129, 0, 'spruce_wall_sign', 1)
  place(0, 129, 1, 'stone')
  place(1, 129, -1, 'chest')
  place(1, 129, 1, 'stone')

  const world = {
    getBlock(position) {
      const point = position.floored()
      const entry = blocks.get(`${point.x},${point.y},${point.z}`)
      return entry ? block(entry.name, point, entry.stateOffset) : block('air', point)
    }
  }
  const start = new Vec3(0.116625, 128, 0.3)
  const bot = {
    version,
    registry,
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: start.clone(),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

  assert.equal(bot.entity.isInWater, true)
  const outcome = JSON.stringify({ position: bot.entity.position, velocity: bot.entity.velocity, horizontalCollision: bot.entity.isCollidedHorizontally })
  assert.ok(bot.entity.position.x < start.x, `expected westward slide, got ${outcome}`)
  assert.ok(bot.entity.velocity.x < 0, `expected preserved westward velocity, got ${outcome}`)
})

test('StarrySea corner current matches the next vanilla client tick', () => {
  const version = '1.21.1'
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const blocks = new Map()
  const place = (x, y, z, name, stateOffset = 0) => blocks.set(`${x},${y},${z}`, { name, stateOffset })
  const makeBlock = (name, position, stateOffset = 0) => {
    const definition = registry.blocksByName[name]
    const value = Block.fromStateId(definition.minStateId + stateOffset, 0)
    value.position = position.clone()
    return value
  }

  // Captured by the Fabric reference client at tick 699. The player overlaps
  // three flowing-water blocks beside a dry wall sign and a chest.
  for (let x = -523; x <= -520; x++) {
    for (let z = 8917; z <= 8920; z++) place(x, 127, z, 'stone')
  }
  place(-523, 128, 8918, 'stone')
  place(-522, 128, 8918, 'water', 2)
  place(-521, 128, 8918, 'water', 3)
  place(-523, 128, 8919, 'stone')
  place(-522, 128, 8919, 'water', 1)
  place(-521, 128, 8919, 'stone')
  place(-523, 129, 8918, 'stone')
  place(-521, 129, 8918, 'spruce_wall_sign')
  place(-523, 129, 8919, 'stone')
  place(-521, 129, 8919, 'chest')

  const world = {
    getBlock(position) {
      const point = position.floored()
      const entry = blocks.get(`${point.x},${point.y},${point.z}`)
      return entry ? makeBlock(entry.name, point, entry.stateOffset) : makeBlock('air', point)
    }
  }
  const bot = {
    version,
    registry,
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(-521.3432810627405, 128, 8918.835461879318),
      velocity: new Vec3(0.015646523432557017, -0.005, -0.04881204373758585),
      onGround: true,
      isInWater: true,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: true,
      elytraFlying: false,
      yaw: 6.773926,
      pitch: 83.400024,
      effects: {},
      attributes: {}
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  Physics(registry, world).simulatePlayer(new PlayerState(bot, controls), world).apply(bot)

  const expected = {
    position: { x: -521.3226847918396, y: 128, z: 8918.774700088112 },
    velocity: { x: 0.01647701696621696, y: -0.005, z: -0.048609433689050345 }
  }
  const actual = { position: bot.entity.position, velocity: bot.entity.velocity }
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(actual.position[axis] - expected.position[axis]) < 1e-6, `position ${axis}: ${JSON.stringify(actual)}`)
    assert.ok(Math.abs(actual.velocity[axis] - expected.velocity[axis]) < 1e-6, `velocity ${axis}: ${JSON.stringify(actual)}`)
  }
})
