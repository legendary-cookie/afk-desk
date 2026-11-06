const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { installMovementPacketCompatibility, installModernPlayerInputCompatibility } = require('../electron/movement-compatibility.cjs')

for (const version of ['1.21.1', '1.21.4', '1.21.11']) {
  test(`${version}: delayed native physics injection sends and preserves held sneak, including paused physics/unloaded chunks`, () => {
    const bot = new EventEmitter()
    bot.registry = require('minecraft-data')(version)
    bot.supportFeature = feature => bot.registry.supportFeature(feature)
    bot._client = new EventEmitter()
    bot._client.state = 'play'
    const writes = []
    const serializer = require('minecraft-protocol').createSerializer({ state: 'play', isServer: false, version })
    bot._client.write = (name, params) => {
      // Use the real version's serializer too: numeric legacy action vs modern bit flags.
      assert.ok(serializer.createPacketBuffer({ name, params }).length > 0)
      writes.push({ name, params })
    }
    const plugins = []
    bot.loadPlugin = plugin => plugins.push(plugin)
    installMovementPacketCompatibility(bot)
    installModernPlayerInputCompatibility(bot)
    installModernPlayerInputCompatibility(bot)
    assert.equal(plugins.length, 1)
    assert.equal(bot.setControlState, undefined, 'real createBot has not injected physics yet')

    let now = 0, tick
    const physicsPath = require.resolve('mineflayer/lib/plugins/physics')
    const nativeRequire = createRequire(physicsPath)
    const context = {
      module: { exports: {} },
      require: name => name === 'perf_hooks' ? { performance: { now: () => now } } : nativeRequire(name),
      setInterval: fn => { tick = fn; return 1 }, clearInterval() {}, setTimeout, clearTimeout, console
    }
    vm.runInNewContext(fs.readFileSync(physicsPath, 'utf8'), context)
    context.module.exports(bot, { physicsEnabled: false })
    plugins.forEach(plugin => plugin(bot))
    bot.entity = { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0 }
    bot.blockAt = () => null
    bot.emit('login')
    bot.setControlState('sneak', true)
    const modern = bot.supportFeature('newPlayerInputPacket')
    const input = () => writes.filter(p => p.name === (modern ? 'player_input' : 'entity_action'))
    assert.equal(modern ? input().at(-1).params.inputs.shift : input().at(-1).params.actionId === 0, true)
    for (let i = 0; i < 20; i++) {
      if (i === 10) bot.blockAt = () => ({}) // loaded chunk: native input ticks also preserve the key
      now += 50; tick()
    }
    assert.equal(bot.getControlState('sneak'), true)
    assert.equal(input().length, 1, 'ticks do not release or resend held sneak')
    bot.setControlState('sneak', false)
    assert.equal(modern ? input().at(-1).params.inputs.shift : input().at(-1).params.actionId === 0, false)
    assert.equal(input().length, 2)
    bot.emit('end')
  })
}
