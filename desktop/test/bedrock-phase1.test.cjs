'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const os = require('node:os')
const dgram = require('node:dgram')
const bedrock = require('bedrock-protocol')
const JsRaknetClient = require('jsp-raknet').Client
const OpenConnectionRequest1 = require('jsp-raknet/js/protocol/OpenConnectionRequest1').default
const { BedrockBotManager, bedrockCapabilities } = require('../electron/bedrock-bot-manager.cjs')
const { startGamePacket } = require('../test-fixtures/bedrock/start-game.cjs')
let nativeRaknetAvailable = true
try { require('raknet-native') } catch { nativeRaknetAvailable = false }

class Timers {
  constructor () { this.items = []; this.id = 0 }
  setTimeout (fn, delay) { const item = { id: ++this.id, fn, delay }; this.items.push(item); return item.id }
  clearTimeout (id) { this.items = this.items.filter((item) => item.id !== id) }
  fire (delay) { const items = this.items.filter((item) => item.delay === delay); this.items = this.items.filter((item) => item.delay !== delay); for (const item of items) item.fn() }
}

function setup (account = {}) {
  const client = new EventEmitter(); client.queued = []; client.queue = (...args) => client.queued.push(args); client.close = () => client.emit('close'); client.username = 'Bot'
  const events = []; const timers = new Timers(); const configs = []
  const manager = new BedrockBotManager({ profilesPath: path.join(os.tmpdir(), 'bedrock-phase1-test'), emit: (...args) => events.push(args), timers, createClient: (config) => { configs.push(config); return client } })
  manager.connect({ id: 'phase1', username: 'Bot', host: 'localhost', ...account })
  return { client, events, timers, manager, config: configs[0] }
}

test('chooses a supported default version and available RakNet backend', () => {
  const { config } = setup()
  assert.equal(config.version, '1.26.30')
  assert.ok(['raknet-native', 'jsp-raknet'].includes(config.raknetBackend))
})

test('patched jsp-raknet encodes the negotiated RakNet protocol version', () => {
  const client = new JsRaknetClient('127.0.0.1', 19132, { protocolVersion: 11 })
  let encoded; client.sendBuffer = (buffer) => { encoded = buffer }
  client.sendConnectionRequest()
  const request = new OpenConnectionRequest1(); request.buffer = encoded; request.decode()
  assert.equal(request.protocol, 11)
})

test('uses start_game rotation and modern chat fields', () => {
  const { client, manager } = setup({ version: '1.26.30' })
  client.emit('start_game', { runtime_entity_id: 7, player_position: { x: 1, y: 2, z: 3 }, rotation: { x: 31, y: 123 }, yaw: 0, pitch: 0 })
  assert.equal(manager.sessions.get('phase1').yaw, 123)
  assert.equal(manager.sessions.get('phase1').pitch, 31)
  client.emit('spawn')
  manager.sendChat('phase1', 'hello')
  const [, packet] = client.queued.at(-1)
  assert.equal(packet.category, 'authored')
  assert.equal(packet.has_filtered_message, false)
})

test('text packets follow negotiated protocol fields across versions', () => {
  for (const [version, modern] of [['1.21.124', false], ['1.21.130', true]]) {
    const { client, manager } = setup({ version }); client.emit('spawn'); manager.sendChat('phase1', 'hello')
    const packet = client.queued.at(-1)[1]
    assert.equal(Object.hasOwn(packet, 'category'), modern, version)
    assert.equal(Object.hasOwn(packet, 'has_filtered_message'), modern, version)
    assert.equal(Object.hasOwn(packet, 'filtered_message'), true, version)
  }
})

test('parses health, hunger, and saturation from update_attributes and keeps set_health', () => {
  const { client, manager } = setup()
  client.emit('update_attributes', { attributes: [{ name: 'minecraft:health', value: 14 }, { name: 'minecraft:player.hunger', value: 8 }, { name: 'minecraft:player.saturation', value: 3 }] })
  let session = manager.sessions.get('phase1'); assert.equal(session.health, 14); assert.equal(session.food, 8); assert.equal(session.saturation, 3)
  client.emit('set_health', { health: 12 }); assert.equal(session.health, 12)
})

test('respawn state and death request handshake unless disabled', () => {
  const { client, events, timers, manager } = setup()
  client.emit('respawn', { state: 1, position: { x: 2, y: 3, z: 4 }, runtime_entity_id: 7 })
  timers.fire(500)
  assert.deepEqual(client.queued.slice(-2).map(([name, packet]) => [name, packet.state ?? packet.action]), [['respawn', 2], ['player_action', 'respawn']])
  client.emit('update_attributes', { attributes: [{ name: 'minecraft:health', value: 0 }] })
  assert.ok(events.some(([type, , payload]) => type === 'death' || (type === 'log' && payload.message === 'Died')))

  const entityDeath = setup(); entityDeath.client.emit('start_game', { runtime_entity_id: 9, player_position: {} }); entityDeath.client.emit('entity_event', { runtime_entity_id: 9, event_id: 'death_animation' })
  assert.ok(entityDeath.events.some(([type]) => type === 'death'))

  const disabled = setup({ autoRespawn: false }); disabled.client.emit('respawn', { state: 1 }); disabled.timers.fire(500)
  assert.equal(disabled.client.queued.length, 0)
  disabled.client.emit('update_attributes', { attributes: [{ name: 'minecraft:health', value: 0 }] }); disabled.timers.fire(500)
  assert.equal(disabled.client.queued.length, 0)

  const healthDeath = setup(); healthDeath.client.emit('update_attributes', { attributes: [{ name: 'minecraft:health', value: 0 }] }); healthDeath.timers.fire(500)
  assert.equal(healthDeath.client.queued.length, 2)
})

test('transfer emits server switch status', () => {
  const { client, events } = setup(); client.emit('transfer', { server_address: 'next.example', port: 19132 })
  assert.ok(events.some(([type, , payload]) => type === 'serverSwitch' && payload.backend === 'next.example'))
})

test('resolves item names, maps inventory slots, handles incremental slots, and stores locks', () => {
  const { client, manager } = setup()
  client.emit('start_game', { runtime_entity_id: 4, itemstates: [{ name: 'minecraft:stone', runtime_id: 1 }] })
  client.emit('inventory_content', { window_id: 'inventory', input: Array.from({ length: 41 }, (_, index) => index === 0 ? { network_id: 1, count: 3 } : {}) })
  let inventory = manager.sessions.get('phase1').inventory
  assert.deepEqual(inventory[0], { slot: 36, name: 'stone', displayName: 'Stone', count: 3 })
  client.emit('inventory_slot', { window_id: 'inventory', slot: 1, item: { network_id: 1, count: 2 } })
  inventory = manager.sessions.get('phase1').inventory
  assert.ok(inventory.some((item) => item.slot === 37 && item.count === 2))
  manager.setItemLocks('phase1', [37, 42]); assert.deepEqual([...manager.sessions.get('phase1').itemLocks].sort(), [37, 42])
})

test('surfaces modal forms and responds or cancels them', () => {
  const { client, manager, events } = setup()
  client.emit('spawn')
  client.emit('modal_form_request', { form_id: 5, data: JSON.stringify({ type: 'form', title: 'Choose', content: 'Pick one', buttons: [{ text: 'A' }, { text: 'B' }] }) })
  assert.ok(events.some(([type, , payload]) => type === 'window' && payload.kind === 'form' && payload.buttons.length === 2))
  manager.respondForm('phase1', 5, 1)
  assert.deepEqual(client.queued.at(-1), ['modal_form_response', { form_id: 5, has_response_data: true, data: '1', has_cancel_reason: false }])
  client.emit('modal_form_request', { form_id: 6, data: JSON.stringify({ type: 'form', title: 'Choose', buttons: [] }) })
  manager.respondForm('phase1', 6, null)
  assert.deepEqual(client.queued.at(-1), ['modal_form_response', { form_id: 6, has_response_data: false, data: undefined, has_cancel_reason: true, cancel_reason: 'closed' }])
})

test('surfaces Bedrock container windows and can close the open container', () => {
  const { client, manager, events } = setup(); client.emit('spawn')
  client.emit('container_open', { window_id: 3, window_type: 'chest' })
  assert.ok(events.some(([type, , payload]) => type === 'window' && payload.kind === 'container' && payload.title === 'chest'))
  manager.closeWindow('phase1')
  assert.deepEqual(client.queued.at(-1), ['container_close', { window_id: 3, window_type: 'chest', server: false }])
})

test('keeps Phase 1 capabilities (movement is extended by Phase 2)', () => {
  const capabilities = bedrockCapabilities()
  assert.equal(capabilities.forms, true)
  assert.equal(capabilities.containerWindows, true)
  assert.equal(capabilities.inventoryView, true)
  assert.equal(capabilities.inventoryActions, false)
  assert.equal(capabilities.movement, 'stationary') // Phase 2; walking still unsupported
})

test('offline Bedrock server and client exchange spawn, text, chat, and disconnect', { timeout: 25_000, skip: nativeRaknetAvailable ? false : 'raknet-native is unavailable; loopback requires the native backend' }, async (t) => {
  const probe = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(0, '127.0.0.1', resolve) })
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve))
  const server = bedrock.createServer({ host: '127.0.0.1', port, version: '1.16.201', offline: true, raknetBackend: 'raknet-native', conLog: () => {} })
  let client; let serverPlayer; let gotStart = false; let gotMessage = false; let gotChat = false; let disconnected = false
  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`loopback timeout: ${JSON.stringify({ gotStart, gotMessage, gotChat, disconnected })}`)), 20_000)
    const check = () => { if (gotStart && gotMessage && gotChat && disconnected) { clearTimeout(timer); resolve() } }
    server.on('connect', (player) => {
      serverPlayer = player
      player.on('join', () => {
        player.queue('start_game', startGamePacket('1.16.201'))
        player.queue('text', { type: 'system', needs_translation: false, xuid: '', platform_chat_id: '', message: 'loopback ready' })
        player.queue('play_status', { status: 'player_spawn' })
      })
      player.on('text', (packet) => { if (packet.message === 'client says hi') { gotChat = true; player.disconnect('test complete'); check() } })
    })
    client = bedrock.createClient({ host: '127.0.0.1', port, username: 'Loopback', version: '1.16.201', offline: true, skipPing: true, raknetBackend: 'raknet-native', connectTimeout: 8_000, conLog: null })
    client.on('start_game', () => { gotStart = true; check() })
    client.on('text', (packet) => { if (packet.message === 'loopback ready') { gotMessage = true; check() } })
    client.on('spawn', () => client.queue('text', { type: 'chat', needs_translation: false, source_name: 'Loopback', xuid: '', platform_chat_id: '', filtered_message: '', message: 'client says hi' }))
    client.on('close', () => { disconnected = true; check() })
    client.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
  t.after(async () => { try { client?.close() } catch {} try { if (serverPlayer) serverPlayer.disconnect('test cleanup', true) } catch {} await server.close() })
  await complete
})
