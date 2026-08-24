const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const { createRequire } = require('node:module')

const mobile = process.env.AFK_DESK_ENGINE === 'mobile'
const engineRoot = mobile
  ? path.resolve(__dirname, '../../mobile/nodejs-assets/nodejs-project')
  : path.resolve(__dirname, '..')
const engineRequire = createRequire(path.join(engineRoot, 'package.json'))
const protocol = engineRequire('minecraft-protocol')
const mineflayer = engineRequire('mineflayer')
const registryFactory = engineRequire('prismarine-registry')
const { Vec3 } = engineRequire('vec3')
const { supportedVersions } = require(path.join(engineRoot, mobile ? 'version-support.cjs' : 'electron/version-support.cjs'))
const { installMovementPacketCompatibility, installModernPlayerInputCompatibility } = require(path.join(engineRoot, mobile ? 'movement-compatibility.cjs' : 'electron/movement-compatibility.cjs'))

const MOVEMENT_PACKETS = new Set(['position', 'look', 'position_look', 'flying'])
const CHAT_PACKETS = new Set(['chat', 'chat_message', 'chat_command', 'chat_command_signed'])

function waitFor(emitter, event, timeout = 5000) {
  return Promise.race([
    once(emitter, event),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout))
  ])
}

function buildChunk(version, registry) {
  const Chunk = require('prismarine-chunk')(version)
  const chunk = registry.supportFeature('tallWorld')
    ? new Chunk({ minY: -64, worldHeight: 384 })
    : new Chunk()
  const floor = registry.blocksByName.stone.id
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) chunk.setBlockType(new Vec3(x, 64, z), floor)
  }
  return chunk
}

function chunkPacket(chunk) {
  const lights = chunk.dumpLight()
  return {
    x: 0,
    z: 0,
    groundUp: true,
    biomes: chunk.dumpBiomes?.(),
    heightmaps: {
      type: 'compound',
      name: '',
      value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } }
    },
    bitMap: chunk.getMask(),
    chunkData: chunk.dump(),
    blockEntities: [],
    trustEdges: false,
    skyLightMask: lights?.skyLightMask,
    blockLightMask: lights?.blockLightMask,
    emptySkyLightMask: lights?.emptySkyLightMask,
    emptyBlockLightMask: lights?.emptyBlockLightMask,
    skyLight: lights?.skyLight,
    blockLight: lights?.blockLight
  }
}

function loginPacket(registry) {
  if (registry.supportFeature('usesLoginPacket')) return { ...registry.loginPacket, entityId: 1 }
  return {
    entityId: 1,
    levelType: 'default',
    gameMode: 0,
    previousGameMode: 255,
    worldNames: ['minecraft:overworld'],
    dimension: 0,
    worldName: 'minecraft:overworld',
    hashedSeed: [0, 0],
    difficulty: 0,
    maxPlayers: 20,
    reducedDebugInfo: 1,
    enableRespawnScreen: true
  }
}

async function verifyVersion(version) {
  const registry = registryFactory(version)
  const server = protocol.createServer({ 'online-mode': false, host: '127.0.0.1', port: 0, version, keepAlive: false })
  await waitFor(server, 'listening')
  const port = server.socketServer.address().port
  const received = []
  let joinedClient
  server.on('playerJoin', client => {
    joinedClient = client
    client.on('packet', (_data, meta) => received.push(meta.name))
    client.write('login', loginPacket(registry))
    client.write('map_chunk', chunkPacket(buildChunk(version, registry)))
    client.write('position', {
      x: 8.5,
      y: 65,
      z: 8.5,
      yaw: 0,
      pitch: 0,
      flags: registry.version['>=']('1.21.3') ? {} : 0,
      teleportId: 1
    })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
  })

  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'AFKDeskMatrix', auth: 'offline', version })
  installMovementPacketCompatibility(bot)
  installModernPlayerInputCompatibility(bot)
  const errors = []
  bot.on('error', error => errors.push(error))
  try {
    await waitFor(bot, 'spawn', 7000)
    await bot.waitForTicks(4)
    const movementDistances = {}
    for (const control of ['forward', 'back', 'left', 'right']) {
      bot.entity.velocity.set(0, 0, 0)
      const before = bot.entity.position.clone()
      bot.setControlState(control, true)
      await bot.waitForTicks(4)
      bot.setControlState(control, false)
      await bot.waitForTicks(1)
      movementDistances[control] = Math.hypot(bot.entity.position.x - before.x, bot.entity.position.z - before.z)
      assert.ok(movementDistances[control] > 0.03, `${version}: ${control} control did not move the bot`)
    }

    bot.entity.velocity.set(0, 0, 0)
    const jumpStartY = bot.entity.position.y
    let jumpPeakY = jumpStartY
    const recordJump = () => { jumpPeakY = Math.max(jumpPeakY, bot.entity.position.y) }
    bot.on('move', recordJump)
    bot.setControlState('jump', true)
    await bot.waitForTicks(6)
    bot.setControlState('jump', false)
    bot.removeListener('move', recordJump)
    assert.ok(jumpPeakY > jumpStartY + 0.1, `${version}: jump control did not raise the bot`)

    bot.setControlState('sprint', true)
    bot.setControlState('sneak', true)
    await bot.waitForTicks(1)
    bot.setControlState('sneak', false)
    bot.setControlState('sprint', false)

    bot.chat('afkdesk matrix')
    bot.setQuickBarSlot(1)
    bot.swingArm('right')
    await bot.look(bot.entity.yaw + 0.25, bot.entity.pitch, true)
    await bot.waitForTicks(3)

    assert.ok(received.some(name => MOVEMENT_PACKETS.has(name)), `${version}: no movement packet reached the server`)
    assert.ok(received.some(name => CHAT_PACKETS.has(name)), `${version}: no chat packet reached the server`)
    assert.ok(received.includes('held_item_slot'), `${version}: no hotbar selection packet reached the server`)
    assert.ok(received.includes('arm_animation'), `${version}: no arm animation packet reached the server`)
    if (bot.supportFeature('newPlayerInputPacket')) {
      assert.ok(received.includes('player_input'), `${version}: modern player input packet was missing`)
    } else {
      assert.ok(received.includes('entity_action'), `${version}: legacy sneak/sprint action packet was missing`)
    }
    assert.equal(errors.length, 0, `${version}: ${errors[0]?.message || 'unexpected client error'}`)
    return { version, movementDistances, jumpHeight: jumpPeakY - jumpStartY, packets: [...new Set(received)].filter(name => MOVEMENT_PACKETS.has(name) || CHAT_PACKETS.has(name) || ['held_item_slot', 'arm_animation', 'player_input', 'entity_action'].includes(name)) }
  } finally {
    try { bot.end() } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
    try { joinedClient?.socket?.end() } catch {}
    server.close()
  }
}

async function main() {
  const verified = []
  for (const version of supportedVersions().reverse()) {
    process.stderr.write(`Checking Minecraft ${version}\n`)
    verified.push(await verifyVersion(version))
  }
  process.stdout.write(JSON.stringify(verified))
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
