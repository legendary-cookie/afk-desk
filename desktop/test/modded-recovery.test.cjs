const test = require('node:test')
const assert = require('node:assert/strict')
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
