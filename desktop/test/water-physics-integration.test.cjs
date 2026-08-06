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
