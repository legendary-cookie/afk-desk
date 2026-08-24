const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')

const mobile = process.env.AFK_DESK_ENGINE === 'mobile'
const engineRoot = mobile
  ? path.resolve(__dirname, '../../mobile/nodejs-assets/nodejs-project')
  : path.resolve(__dirname, '..')
const engineRequire = createRequire(path.join(engineRoot, 'package.json'))
const minecraftData = engineRequire('minecraft-data')
const prismarineBlock = engineRequire('prismarine-block')
const { Physics, PlayerState } = engineRequire('prismarine-physics')
const { Vec3 } = engineRequire('vec3')
const { supportedVersions } = require(path.join(engineRoot, mobile ? 'version-support.cjs' : 'electron/version-support.cjs'))

const verified = []
for (const version of supportedVersions().reverse()) {
  const registry = minecraftData(version)
  const Block = prismarineBlock(version)
  const block = (name, position, level = 0) => {
    const definition = registry.blocksByName[name]
    const value = registry.supportFeature('blockMetadata')
      ? new Block(definition.id, registry.biomesByName.plains?.id || 1, level)
      : Block.fromStateId(definition.minStateId + level, 0)
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
  assert.equal(bot.entity.isInWater, true, `${version}: water was not detected`)
  assert.ok(bot.entity.position.x > 0.5, `${version}: directional water did not move the player`)
  assert.ok(bot.entity.velocity.x > 0, `${version}: directional current produced no velocity`)
  verified.push(version)
}

process.stdout.write(JSON.stringify(verified))
