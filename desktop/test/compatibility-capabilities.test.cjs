const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { describeCompatibility } = require('../assets/compatibility-capabilities.js')
const { installModdedCompatibility, installCustomChannels, moddedBotOptions } = require('../electron/modded-compatibility.cjs')

test('capabilities separate legacy Forge from modern NeoForge configuration requirements', () => {
  assert.equal(describeCompatibility({ modLoader: 'forge', version: '1.12.2' }).mode, 'legacy-fml')
  assert.equal(describeCompatibility({ modLoader: 'neoforge', version: '1.20.2' }).mode, 'legacy-fml')
  assert.equal(describeCompatibility({ modLoader: 'neoforge', version: '1.21.1' }).mode, 'vanilla-only')
  assert.throws(() => moddedBotOptions({ modLoader: 'neoforge', version: '1.21.1', modHandshake: 'fml3' }), /configuration.*not implemented/i)
})

test('Fabric Quilt Sponge and Custom expose bounded protocol capabilities', () => {
  for (const loader of ['fabric', 'quilt', 'sponge', 'custom']) {
    const description = describeCompatibility({ modLoader: loader })
    assert.equal(description.mode, 'brand-and-channels')
    assert.ok(description.limitations.some(line => /client.*mod|payload/i.test(line)))
    assert.deepEqual(description.handshakes, ['off'])
    assert.equal(installModdedCompatibility(new EventEmitter(), { modLoader: loader }), false)
  }
  assert.equal(moddedBotOptions({ modLoader: 'fabric' }).brand, 'fabric')
  assert.equal(moddedBotOptions({ modLoader: 'quilt' }).brand, 'quilt')
})

test('explicit handshake selection without mods installs that handler with reflection options', () => {
  const calls = []
  installModdedCompatibility(new EventEmitter(), { modLoader: 'forge', version: '1.19.4', modHandshake: 'fml2' }, () => {}, {
    autoVersionForge: () => { throw new Error('Explicit override ignored') },
    handshakes: { fml2: (_client, options) => calls.push(options) }
  })
  assert.deepEqual(calls, [{}])
})

test('custom channels announce only in PLAY and reannounce after server transfer', () => {
  const client = new EventEmitter()
  const registrations = [], announcements = []
  client.state = 'login'
  client.version = '1.21.1'
  client.registerChannel = (...args) => registrations.push(args)
  client.writeChannel = (...args) => announcements.push(args)
  installCustomChannels(client, { modLoader: 'fabric', modChannels: ['example:optional'] })
  assert.deepEqual(registrations, [])
  client.state = 'play'; client.emit('state', 'play')
  assert.deepEqual(registrations.map(args => [args[0], args[2]]), [['example:optional', true]])
  client.state = 'configuration'; client.emit('state', 'configuration')
  client.state = 'play'; client.emit('state', 'play')
  assert.deepEqual(announcements, [['minecraft:register', ['example:optional']]])
  client.emit('end')
  assert.equal(client.listenerCount('state'), 0)
})

test('modern NeoForge does not receive an incompatible FML tag or fabricated acknowledgements', () => {
  const client = new EventEmitter()
  let installed = false
  const messages = []
  assert.equal(installModdedCompatibility(client, { modLoader: 'neoforge', version: '1.21.1' }, message => messages.push(message), {
    autoVersionForge: () => { installed = true }
  }), false)
  assert.equal(installed, false)
  assert.ok(messages.some(message => /configuration/i.test(message)))
})

test('forced FML1 with no manual mods uses server metadata without changing generation', async () => {
  const client = new EventEmitter()
  const calls = []
  installModdedCompatibility(client, { modLoader: 'forge', version: '1.12.2', modHandshake: 'fml1' }, () => {}, {
    ping: async () => ({ modinfo: { type: 'FML', modList: [{ modid: 'legacy', version: '2' }] } }),
    handshakes: { fml1: (_client, options) => calls.push(options) }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{ forgeMods: [{ modid: 'legacy', version: '2' }] }])
})

test('NeoForge Automatic checks negotiated version before running legacy handlers', () => {
  const client = new EventEmitter()
  let legacyCalls = 0
  installModdedCompatibility(client, { modLoader: 'neoforge' }, () => {}, {
    autoVersionForge: target => { target.autoVersionHooks = [() => { legacyCalls++ }] }
  })
  client.autoVersionHooks[0]({}, client, { version: '1.21.1' })
  assert.equal(legacyCalls, 0)
  client.autoVersionHooks[0]({}, client, { version: '1.20.2' })
  assert.equal(legacyCalls, 1)
})

test('unknown Fabric login requests keep the upstream negative response and bounded diagnostics', () => {
  const client = new EventEmitter()
  const writes = [], diagnostics = []
  // Match minecraft-protocol's normal unsupported-request response contract.
  const unsupported = packet => writes.push(['login_plugin_response', { messageId: packet.messageId }])
  client.on('login_plugin_request', unsupported)
  installCustomChannels(client, { modLoader: 'fabric' }, message => diagnostics.push(message))
  client.emit('login_plugin_request', { channel: 'example:required', messageId: 5 })
  client.emit('login_plugin_request', { channel: 'example:required', messageId: 6 })
  assert.deepEqual(writes, [['login_plugin_response', { messageId: 5 }], ['login_plugin_response', { messageId: 6 }]])
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /dedicated compatible adapter/)
  client.emit('end')
  assert.deepEqual(client.listeners('login_plugin_request'), [unsupported])
})

test('raw channels cannot replace built-in brand registration or handshake codecs', () => {
  const client = new EventEmitter()
  const registered = [], diagnostics = []
  client.state = 'play'
  client.registerChannel = name => registered.push(name)
  installCustomChannels(client, { modChannels: ['minecraft:brand', 'minecraft:register', 'fml:loginwrapper', 'example:optional'] }, message => diagnostics.push(message))
  assert.deepEqual(registered, ['example:optional'])
  assert.equal(diagnostics.filter(message => /reserved/i.test(message)).length, 3)
})
