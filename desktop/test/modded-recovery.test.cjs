const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installModdedCompatibility } = require('../electron/modded-compatibility.cjs')

test('manual mods wait for negotiated Minecraft version before choosing FML generation', () => {
  const client = {}
  const calls = []
  installModdedCompatibility(client, { modLoader: 'forge', mods: 'example@1.0', version: '' }, () => {}, {
    handshakes: Object.fromEntries(['fml1', 'fml2', 'fml3'].map(name => [name, (_client, options) => calls.push([name, options])]))
  })
  assert.deepEqual(calls, [])
  client.version = '1.12.2'
  for (const hook of client.autoVersionHooks) hook({}, client, {version: '1.12.2'})
  assert.equal(calls[0][0], 'fml1')
  assert.deepEqual(calls[0][1].forgeMods, [{modid: 'example', version: '1.0'}])
})

test('fixed-version Forge waits for server mod detection through the configured proxy', async () => {
  const client = new EventEmitter()
  let finishPing, pingOptions, released = 0
  const proxyConnect = () => {}
  const proxy = { enabled: true, type: 'socks5', host: 'proxy.example', port: 1080 }
  client.on('connect_allowed', () => { released++ })
  installModdedCompatibility(client, { modLoader: 'forge', version: '1.12.2', host: 'server.example', port: 25565, proxy }, () => {}, {
    ping: options => { pingOptions = options; return new Promise(resolve => { finishPing = resolve }) },
    createProxyConnect: (actualProxy, destination) => {
      assert.equal(actualProxy, proxy)
      assert.deepEqual(destination, { host: 'server.example', port: 25565 })
      return proxyConnect
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.wait_connect, true)
  assert.equal(pingOptions.connect, proxyConnect)
  assert.equal(pingOptions.version, '1.12.2')
  assert.ok(pingOptions.closeTimeout <= 15000)
  finishPing({ modinfo: { type: 'FML', modList: [{ modid: 'example', version: '1.0' }] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.tagHost, '\0FML\0')
  assert.equal(client.wait_connect, false)
  assert.equal(released, 1)
})

test('failed fixed-version mod detection ends the held connection without allowing login', async () => {
  const client = new EventEmitter()
  const errors = []
  let released = 0, ended = false
  client.on('error', error => errors.push(error.message))
  client.on('connect_allowed', () => { released++ })
  client.end = () => { ended = true; client.emit('end') }
  installModdedCompatibility(client, { modLoader: 'forge', version: '1.12.2', host: 'server.example' }, () => {}, {
    ping: async () => { throw new Error('ETIMEDOUT') }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended, true)
  assert.equal(released, 0)
  assert.match(errors[0] || '', /mod detection.*ETIMEDOUT/i)
})

test('late mod detection cannot resume a connection that has ended', async () => {
  const client = new EventEmitter()
  let finishPing, released = 0
  client.on('connect_allowed', () => { released++ })
  installModdedCompatibility(client, { modLoader: 'forge', version: '1.12.2', host: 'server.example' }, () => {}, {
    ping: () => new Promise(resolve => { finishPing = resolve })
  })
  await new Promise(resolve => setImmediate(resolve))
  client.emit('end')
  finishPing({ modinfo: { type: 'FML', modList: [] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, 0)
  assert.equal(client.tagHost, undefined)
})
