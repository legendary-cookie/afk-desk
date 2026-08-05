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
