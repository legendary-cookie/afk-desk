const assert = require('node:assert/strict')
const protocol = require('minecraft-protocol')
const { resolvePingVersion } = require('../../electron/version-support.cjs')

async function main() {
  const verified = []
  for (const version of protocol.supportedVersions) {
    const server = protocol.createServer({ 'online-mode': false, host: '127.0.0.1', port: 0, version, motd: `AFK Desk ${version}`, kickTimeout: 250, keepAlive: false })
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    try {
      const port = server.socketServer.address().port
      const response = await protocol.ping({ host: '127.0.0.1', port, closeTimeout: 3000, noPongTimeout: 1000 })
      assert.equal(resolvePingVersion(response), version)
      verified.push(version)
    } finally {
      for (const client of Object.values(server.clients)) client.socket?.destroy()
      server.close()
    }
  }
  process.stdout.write(JSON.stringify(verified))
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
