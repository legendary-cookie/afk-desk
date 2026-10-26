'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { MacroActionError } = require('../electron/macro/contract.cjs')
const { bedrockCapabilities } = require('../electron/bedrock-bot-manager.cjs')
const { normalizeAntiAfkSettings } = require('../electron/bot-manager.cjs')
const { setup } = require('../test-fixtures/bedrock/phase2-harness.cjs')

test('starts after spawn, ticks at 20 TPS, and leaves no timers on close or disconnect', () => {
  for (const end of ['close', 'disconnect']) {
    const h = setup({}, { spawn: false })
    h.timers.advance(100); assert.equal(h.client.queued.length, 0)
    h.client.emit('spawn'); h.client.emit('spawn')
    assert.equal([...h.timers.items.values()].filter((item) => item.delay === 50).length, 1)
    h.timers.advance(150)
    const packets = h.packets('player_auth_input')
    assert.deepEqual(packets.map((p) => p.tick), [41n, 42n, 43n])
    assert.deepEqual(packets[0].position, h.startGame.player_position)
    assert.ok(Math.abs(h.session.position.y - 64) < 1e-9)
    assert.deepEqual(packets[0].move_vector, { x: 0, z: 0 })
    assert.deepEqual(packets[0].delta, { x: 0, y: 0, z: 0 })
    const stale = [...h.timers.items.values()].map((item) => item.fn)
    if (end === 'close') h.client.emit('close'); else h.manager.disconnect('phase2')
    assert.equal(h.timers.items.size, 0)
    stale.forEach((fn) => fn()); h.client.emit('spawn'); h.timers.advance(1000)
    assert.equal(h.timers.items.size, 0); assert.equal(h.packets('player_auth_input').length, 3)
  }
})

test('spawn before start_game waits for a valid position and runtime id', () => {
  const h = setup({}, { start: false }); h.timers.advance(100)
  assert.equal(h.client.queued.length, 0)
  h.client.emit('start_game', h.startGame); h.timers.advance(50)
  assert.equal(h.packets('player_auth_input').length, 1)
  h.manager.disconnect('phase2')
})

test('owners are sets, releasing one preserves held flags, and releaseOwner is scoped', () => {
  const h = setup()
  h.manager.claimInput('phase2', 'sneak', 'manual')
  h.manager.claimInput('phase2', 'sneak', 'manual')
  h.manager.claimInput('phase2', 'sneak', 'macro:one')
  h.manager.claimInput('phase2', 'sprint', 'macro:one')
  h.manager.claimInput('phase2', 'sprint', 'macro:two')
  h.timers.advance(50)
  assert.equal(h.packets('player_auth_input').at(-1).input_data.start_sneaking, true)
  h.manager.releaseInput('phase2', 'sneak', 'macro:one'); h.timers.advance(50)
  const flags = h.packets('player_auth_input').at(-1).input_data
  assert.equal(flags.sneaking, true); assert.equal(flags.sneak_down, true); assert.equal(Boolean(flags.start_sneaking), false)
  h.manager.releaseOwner('phase2', 'macro:one')
  assert.deepEqual(h.manager.inputOwners('phase2', 'sprint'), ['macro:two'])
  assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['manual'])
  h.manager.inputOwners('phase2', 'sneak').pop()
  assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['manual'])
  h.manager.releaseOwner('phase2', 'manual'); h.manager.releaseOwner('phase2', 'macro:two'); h.timers.advance(50)
  const stopped = h.packets('player_auth_input').at(-1).input_data
  assert.equal(stopped.stop_sneaking, true); assert.equal(stopped.stop_sprinting, true)
  assert.equal(Boolean(stopped.sneaking), false); assert.equal(Boolean(stopped.sprinting), false)
  h.manager.disconnect('phase2')
  assert.doesNotThrow(() => h.manager.releaseOwner('phase2', 'macro:one'))
})

test('unsupported walking throws a facade-compatible error on every entry point', () => {
  const h = setup()
  for (const input of ['forward', 'back', 'left', 'right']) {
    for (const run of [() => h.manager.claimInput('phase2', input, 'manual'), () => h.manager.control('phase2', input), () => h.manager.setControlState('phase2', input, true)]) {
      assert.throws(run, (e) => e instanceof MacroActionError && e.code === 'UNSUPPORTED' && e.message === 'Bedrock walking is not supported yet')
    }
  }
  assert.throws(() => h.manager.claimInput('phase2', 'rightClick', 'manual'), { code: 'UNSUPPORTED' })
  assert.throws(() => h.manager.claimInput('phase2', 'jump', ''), /owner/i)
  h.manager.disconnect('phase2')
})

test('jump is edge-triggered, held for ticks, and models an arc without changing wire position or delta', () => {
  const h = setup()
  h.manager.claimInput('phase2', 'jump', 'antiAfk'); h.timers.advance(50)
  assert.equal(h.packets('player_auth_input').at(-1).input_data.start_jumping, true)
  assert.ok(h.session.jumpArc.height > 0)
  h.timers.advance(100)
  assert.equal(h.packets('player_auth_input').at(-1).input_data.jumping, true)
  assert.equal(Boolean(h.packets('player_auth_input').at(-1).input_data.start_jumping), false)
  h.manager.releaseOwner('phase2', 'antiAfk'); h.timers.advance(50)
  assert.equal(Boolean(h.packets('player_auth_input').at(-1).input_data.jumping), false)
  h.timers.advance(1000); assert.equal(h.session.jumpArc, null)
  for (const p of h.packets('player_auth_input')) {
    assert.deepEqual(p.position, h.startGame.player_position)
    assert.deepEqual(p.delta, { x: 0, y: 0, z: 0 })
  }
  h.manager.disconnect('phase2')
})

test('look APIs take radians and send degree rotations on the next tick', () => {
  const h = setup()
  h.manager.lookAbsolute('phase2', Math.PI / 2, Math.PI / 6)
  assert.equal(h.client.queued.length, 0); h.timers.advance(50)
  let p = h.packets('player_auth_input').at(-1)
  assert.ok(Math.abs(p.yaw - 90) < 1e-9); assert.ok(Math.abs(p.pitch - 30) < 1e-9); assert.equal(p.head_yaw, p.yaw)
  h.manager.lookDelta('phase2', -0.2, 0.1); h.timers.advance(50)
  p = h.packets('player_auth_input').at(-1)
  assert.ok(Math.abs(p.yaw - (90 - 0.2 * 180 / Math.PI)) < 1e-9)
  assert.ok(Math.abs(p.pitch - (30 + 0.1 * 180 / Math.PI)) < 1e-9)
  h.manager.lookAbsolute('phase2', 0, 10); h.timers.advance(50)
  assert.ok(h.packets('player_auth_input').at(-1).pitch <= 90)
  assert.throws(() => h.manager.lookAbsolute('phase2', NaN, 0), /numbers/)
  h.manager.disconnect('phase2')
})

test('adopts exact server teleports/resets and zero rotation, acknowledges once, ignores other players', () => {
  const h = setup(); h.timers.advance(50)
  h.client.emit('move_player', { runtime_id: 99n, position: { x: 99, y: 99, z: 99 }, mode: 'teleport' })
  h.timers.advance(50); assert.deepEqual(h.packets('player_auth_input').at(-1).position, h.startGame.player_position)
  for (const mode of ['teleport', 'reset']) {
    const position = { x: 11.123456, y: 90.234567, z: -5.123456 }
    h.client.emit('move_player', { runtime_id: 7n, position, yaw: 0, pitch: 0, mode })
    h.timers.advance(50)
    const p = h.packets('player_auth_input').at(-1)
    assert.deepEqual(p.position, position); assert.equal(p.yaw, 0); assert.equal(p.pitch, 0)
    assert.equal(p.input_data.handled_teleport, true)
    h.timers.advance(50); assert.equal(Boolean(h.packets('player_auth_input').at(-1).input_data.handled_teleport), false)
  }
  h.client.emit('correct_player_move_prediction', { prediction_type: 'vehicle', position: { x: 0, y: 0, z: 0 } })
  h.client.emit('correct_player_move_prediction', { prediction_type: 'player', position: { x: 4, y: 81.62, z: 6 }, rotation: { x: 5, z: 6 }, tick: 1n })
  h.timers.advance(50)
  const p = h.packets('player_auth_input').at(-1)
  assert.deepEqual(p.position, { x: 4, y: 81.62, z: 6 }); assert.equal(p.yaw, 6); assert.equal(p.pitch, 5)
  assert.ok(p.tick > 40n); assert.equal(p.input_data.handled_teleport, true)
  h.manager.disconnect('phase2')
})

test('older client-authoritative versions send move_player at low rate only on changes', () => {
  const h = setup({ version: '1.16.201' })
  h.timers.advance(1000)
  assert.equal(h.packets('player_auth_input').length, 0); assert.equal(h.packets('move_player').length, 1)
  h.manager.lookAbsolute('phase2', Math.PI / 2, 0)
  h.timers.advance(249); assert.equal(h.packets('move_player').length, 1)
  h.timers.advance(1); assert.equal(h.packets('move_player').length, 2)
  h.timers.advance(1000); assert.equal(h.packets('move_player').length, 2)
  h.manager.disconnect('phase2'); assert.equal(h.timers.items.size, 0)
})

test('movement authority follows the negotiated schema and older server choice', () => {
  const h = setup({ version: '1.16.201' }, { spawn: false })
  h.client.emit('start_game', { ...h.startGame, movement_authority: 'server' }); h.client.emit('spawn'); h.timers.advance(50)
  assert.equal(h.packets('player_auth_input').length, 1)
  h.manager.disconnect('phase2')
  const negotiated = setup({ version: '1.16.201' }, { clientVersion: '1.26.30' })
  negotiated.timers.advance(50); assert.equal(negotiated.packets('player_auth_input').length, 1)
  negotiated.manager.disconnect('phase2')
})

test('swing once and owned leftClick only emit swing_arm, and stop when the last owner releases', () => {
  const h = setup()
  h.manager.swingArm('phase2'); assert.equal(h.packets('animate').length, 1)
  assert.equal(h.packets('animate')[0].action_id, 'swing_arm')
  h.manager.claimInput('phase2', 'leftClick', 'manual'); h.manager.claimInput('phase2', 'leftClick', 'macro:a')
  h.timers.advance(250); assert.ok(h.packets('animate').length >= 2)
  h.manager.releaseOwner('phase2', 'manual'); const held = h.packets('animate').length
  h.timers.advance(250); assert.ok(h.packets('animate').length > held)
  h.manager.releaseOwner('phase2', 'macro:a'); const stopped = h.packets('animate').length
  h.timers.advance(1000); assert.equal(h.packets('animate').length, stopped)
  assert.equal(h.packets('inventory_transaction').length, 0)
  h.manager.disconnect('phase2')
})

test('anti-AFK mirrors Java normalization, random delays, skips walk with one log, and toggles cleanly', () => {
  const account = { antiAfk: true, antiAfkMinDelay: 2, antiAfkMaxDelay: 4, antiAfkJump: false, antiAfkLook: false, antiAfkSneak: true, antiAfkWalk: true }
  const h = setup(account, { random: () => 0.5 })
  assert.deepEqual(h.session.antiAfkSettings, normalizeAntiAfkSettings(account))
  h.timers.advance(2999); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), [])
  h.timers.advance(1); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['antiAfk'])
  h.timers.advance(250); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), [])
  h.manager.setAntiAfk('phase2', account)
  assert.equal(h.events.filter(([type, , p]) => type === 'log' && /walk.*ignor|ignor.*walk/i.test(p.message)).length, 1)
  h.manager.claimInput('phase2', 'sneak', 'manual')
  h.manager.setAntiAfk('phase2', { ...account, antiAfk: false })
  h.timers.advance(10_000); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['manual'])
  h.manager.disconnect('phase2'); assert.equal(h.timers.items.size, 0)
})

test('anti-AFK pauses for any macro input, cancels its current hold, and resumes when released', () => {
  const h = setup({ antiAfk: true, antiAfkInterval: 2, antiAfkJump: false, antiAfkLook: false, antiAfkSneak: true, antiAfkActionDuration: 1 })
  h.timers.advance(2000); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['antiAfk'])
  h.manager.claimInput('phase2', 'leftClick', 'macro:busy')
  assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), [])
  h.timers.advance(4000); assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), [])
  h.manager.releaseOwner('phase2', 'macro:busy'); h.timers.advance(2000)
  assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['antiAfk'])
  h.manager.disconnect('phase2'); assert.equal(h.timers.items.size, 0)
})

test('anti-AFK jump, swing, and look execute only the selected enabled action', () => {
  for (const action of ['Jump', 'Swing', 'Look']) {
    const h = setup({ antiAfk: true, antiAfkInterval: 2, antiAfkJump: false, antiAfkLook: false, ['antiAfk' + action]: true })
    h.timers.advance(2050)
    if (action === 'Jump') assert.equal(h.packets('player_auth_input').some((p) => p.input_data.start_jumping), true)
    if (action === 'Swing') assert.equal(h.packets('animate').length, 1)
    if (action === 'Look') assert.notEqual(h.packets('player_auth_input').at(-1).yaw, 20)
    h.manager.disconnect('phase2'); assert.equal(h.timers.items.size, 0)
  }
})

test('packets round-trip through installed schemas across all supported versions and authority modes', () => {
  const versions = Object.keys(require('bedrock-protocol/src/options').Versions)
  for (const version of versions) {
    const h = setup({ version }, { spawn: false })
    h.client.emit('start_game', { ...h.startGame, movement_authority: 'server' }); h.client.emit('spawn')
    h.manager.claimInput('phase2', 'jump', 'manual'); h.manager.claimInput('phase2', 'sneak', 'manual'); h.manager.swingArm('phase2'); h.timers.advance(50)
    const serializer = createSerializer(version); const parser = createDeserializer(version)
    assert.ok(h.packets('player_auth_input').length > 0, version)
    for (const [name, params] of h.client.queued) {
      const buffer = serializer.createPacketBuffer({ name, params })
      const decoded = parser.parsePacketBuffer(buffer).data
      assert.equal(decoded.name, name, version)
      if (name === 'player_auth_input') {
        assert.equal(decoded.params.input_data.jumping, true, version)
        assert.equal(decoded.params.tick, params.tick, version)
        assert.equal(decoded.params.yaw, params.yaw, version)
        assert.deepEqual(decoded.params.interact_rotation, Object.hasOwn(decoded.params, 'interact_rotation') ? { x: params.pitch, z: params.yaw } : undefined, version)
      }
    }
    h.manager.disconnect('phase2')
    const legacy = setup({ version }, { spawn: false })
    legacy.client.emit('start_game', { ...legacy.startGame, movement_authority: 'client' }); legacy.client.emit('spawn')
    if (legacy.session.canChooseAuthority) {
      legacy.manager.claimInput('phase2', 'sneak', 'manual'); legacy.manager.releaseOwner('phase2', 'manual')
      legacy.manager.claimInput('phase2', 'jump', 'manual'); legacy.manager.claimInput('phase2', 'sprint', 'manual')
      legacy.timers.advance(250)
      for (const [name, params] of legacy.client.queued) {
        const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data
        assert.equal(decoded.name, name, version)
        if (name === 'move_player') assert.equal(decoded.params.yaw, params.yaw, version)
      }
    }
    legacy.manager.disconnect('phase2')
  }
})

test('legacy stationary controls send action edges only for first claim and last release', () => {
  const h = setup({ version: '1.16.201' })
  h.manager.claimInput('phase2', 'sneak', 'manual'); h.manager.claimInput('phase2', 'sneak', 'macro:a')
  h.manager.releaseOwner('phase2', 'manual'); h.manager.releaseOwner('phase2', 'macro:a')
  assert.deepEqual(h.packets('player_action').map((p) => p.action), ['start_sneak', 'stop_sneak'])
  h.manager.disconnect('phase2')
})

test('authority changes replace the movement timer and modern versions ignore the deprecated authority packet', () => {
  const h = setup({ version: '1.21.50' }); h.timers.advance(250)
  h.client.emit('set_movement_authority', { movement_authority: 'server_with_rewind' })
  assert.equal([...h.timers.items.values()].filter((item) => [50, 250].includes(item.delay)).length, 1)
  h.timers.advance(100); assert.equal(h.packets('player_auth_input').length, 2)
  h.client.emit('set_movement_authority', { movement_authority: 'client' }); h.timers.advance(500)
  assert.equal(h.packets('player_auth_input').length, 2); assert.equal(h.packets('move_player').length, 2)
  h.manager.disconnect('phase2')
  const modern = setup(); modern.client.emit('set_movement_authority', { movement_authority: 'client' }); modern.timers.advance(50)
  assert.equal(modern.packets('player_auth_input').length, 1); modern.manager.disconnect('phase2')
})

test('anti-AFK normalization matches Java defaults, legacy values, clamps, and disabled actions', () => {
  for (const settings of [{}, { antiAfkInterval: 1 }, { antiAfkMinDelay: 8, antiAfkMaxDelay: 2, antiAfkLookDegrees: 300, antiAfkActionDuration: 0 }, { antiAfkJump: false, antiAfkLook: false, antiAfkSneak: false, antiAfkSwing: false, antiAfkWalk: true }]) {
    const h = setup(settings)
    assert.deepEqual(h.session.antiAfkSettings, normalizeAntiAfkSettings(settings))
    h.manager.disconnect('phase2')
  }
  const h = setup({ antiAfk: true, antiAfkInterval: 2, antiAfkJump: false, antiAfkLookDegrees: 180 })
  h.timers.advance(2050); assert.equal(h.packets('player_auth_input').at(-1).yaw, -160)
  h.manager.disconnect('phase2')
})

test('cancelled control/anti-AFK callbacks and old clients cannot affect replacement sessions', () => {
  const h = setup({ antiAfk: true, antiAfkInterval: 2, antiAfkJump: false, antiAfkLook: false, antiAfkSneak: true })
  h.timers.advance(2000); h.manager.control('phase2', 'jump', 300)
  const callbacks = [...h.timers.items.values()].map((item) => item.fn)
  h.manager.disconnect('phase2')
  h.manager.connect({ id: 'phase2', host: 'localhost', antiAfk: false, autoReconnect: false })
  const replacement = h.clients[1]; replacement.emit('start_game', h.startGame); replacement.emit('spawn')
  h.manager.claimInput('phase2', 'sneak', 'antiAfk'); h.manager.claimInput('phase2', 'jump', 'manual')
  callbacks.forEach((fn) => fn())
  h.client.emit('start_game', { ...h.startGame, current_tick: 9999n }); h.client.emit('spawn')
  h.client.emit('move_player', { runtime_id: 7n, position: { x: 99, y: 99, z: 99 }, mode: 'teleport' })
  assert.deepEqual(h.manager.inputOwners('phase2', 'sneak'), ['antiAfk'])
  assert.deepEqual(h.manager.inputOwners('phase2', 'jump'), ['manual'])
  h.timers.advance(50); assert.equal(replacement.queued.at(-1)[1].tick, 41n)
  h.manager.disconnect('phase2'); assert.equal(h.timers.items.size, 0)
})

test('a movement send failure clears all session timers and closes the client', () => {
  const h = setup({ antiAfk: true }); h.manager.control('phase2', 'jump')
  h.client.queue = () => { throw new Error('closed transport') }
  assert.doesNotThrow(() => h.timers.advance(50))
  assert.equal(h.manager.sessions.size, 0); assert.equal(h.timers.items.size, 0)
  assert.ok(h.events.some(([type, , p]) => type === 'log' && /closed transport/.test(p.message)))
})

test('health-triggered respawn keeps the Phase 1 wire position after storing feet internally', () => {
  const h = setup()
  h.client.emit('set_health', { health: 0 }); h.timers.advance(500)
  assert.deepEqual(h.packets('respawn')[0].position, h.startGame.player_position)
  h.manager.disconnect('phase2')
})

test('advertises stationary movement and the four supported anti-AFK actions', () => {
  assert.equal(bedrockCapabilities().movement, 'stationary')
  assert.deepEqual(bedrockCapabilities().antiAfk, ['look', 'jump', 'sneak', 'swing'])
})
