const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('Fabric reference captures vanilla water movement without account secrets', () => {
  const project = path.join(__dirname, '..', '..', 'fabric-movement-diagnostics')
  const source = fs.readFileSync(path.join(project, 'src', 'client', 'java', 'dev', 'afkdesk', 'diagnostics', 'AfkDeskMovementDiagnostics.java'), 'utf8')
  const metadata = JSON.parse(fs.readFileSync(path.join(project, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8').replace('${version}', 'test'))

  assert.equal(metadata.environment, 'client')
  assert.match(source, /ClientTickEvents\.END_CLIENT_TICK/)
  assert.match(source, /BLOCK_SNAPSHOT_INTERVAL_TICKS = 20/)
  assert.match(source, /tick % BLOCK_SNAPSHOT_INTERVAL_TICKS == 0/)
  for (const signal of ['position', 'velocity', 'touchingWater', 'submergedInWater', 'onGround', 'horizontalCollision', 'fluidHeight', 'nearbyBlocks']) {
    assert.match(source, new RegExp(signal))
  }
  assert.doesNotMatch(source, /accessToken|refreshToken|sessionToken|password/i)
})
