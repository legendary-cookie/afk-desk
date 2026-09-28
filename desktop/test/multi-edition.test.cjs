const test = require('node:test')
const assert = require('node:assert/strict')
const { MultiEditionBotManager } = require('../electron/multi-edition-manager.cjs')

test('a profile cannot switch edition while its existing session or retry is active', () => {
  const java = { sessions: new Map([['one', {}]]), reconnects: new Map(), disconnect: () => 'java' }
  let bedrockConnections = 0
  const bedrock = { sessions: new Map(), reconnects: new Map(), connect: () => { bedrockConnections++ } }
  const bots = new MultiEditionBotManager({ java, bedrock })
  assert.throws(() => bots.connect({ id: 'one', edition: 'bedrock' }), /already/)
  assert.equal(bedrockConnections, 0)
  assert.equal(bots.disconnect('one'), 'java')
  java.sessions.clear()
  java.reconnects.set('one', { timer: {}, manual: false })
  assert.throws(() => bots.connect({ id: 'one', edition: 'bedrock' }), /already/)
})

test('failed edition connection does not change routing', () => {
  const java = { sessions: new Map(), reconnects: new Map(), disconnect: () => 'java' }
  const bedrock = { sessions: new Map(), reconnects: new Map(), connect: () => { throw new Error('UDP unavailable') } }
  const bots = new MultiEditionBotManager({ java, bedrock })
  assert.throws(() => bots.connect({ id: 'one', edition: 'bedrock' }), /UDP/)
  assert.equal(bots.disconnect('one'), 'java')
})
