const fs = require('node:fs')
const mineflayer = require('../desktop/node_modules/mineflayer')
const { installMovementPacketCompatibility } = require('../desktop/electron/movement-compatibility.cjs')

const account = JSON.parse(fs.readFileSync(process.env.AFKDESK_ACCOUNTS, 'utf8'))
  .find((entry) => entry.id === process.env.AFKDESK_ACCOUNT_ID)
const targets = process.argv.slice(2)
if (!account || !targets.length) throw new Error('Account fixture and at least one server are required.')

async function checkServer(host) {
  return await new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let login = false
    let spawn = false
    let kicked = ''
    let error = ''
    let ended = ''
    let spawnCount = 0
    let configurationStarts = 0
    let configurationFinishes = 0
    const suppressedPackets = []
    let commandSent = false
    const bot = mineflayer.createBot({
      host,
      port: 25565,
      username: account.username,
      auth: 'microsoft',
      version: '1.21.11',
      profilesFolder: process.env.AFKDESK_TEST_PROFILE,
      hideErrors: true,
      checkTimeoutInterval: 20_000,
      physicsEnabled: false,
      onMsaCode: () => { error = 'authentication cache miss' }
    })
    installMovementPacketCompatibility(bot)
    const finish = () => {
      if (settled) return
      settled = true
      try { bot.end('AFK Desk compatibility test complete') } catch {}
      resolve({ host, version: '1.21.11', login, spawn, spawnCount, configurationStarts, configurationFinishes, suppressedPackets, commandSent, kicked: kicked.slice(0, 120), error: error.slice(0, 120), ended: ended.slice(0, 120), durationMs: Date.now() - started })
    }
    bot.on('login', () => { login = true })
    bot.__afkDeskPacketDiagnostic = (entry) => {
      if (entry.event === 'protocol_packet_suppressed') suppressedPackets.push(entry.name)
    }
    bot._client.on('start_configuration', () => { configurationStarts++ })
    bot._client.on('finish_configuration', () => {
      configurationFinishes++
      if (commandSent && configurationStarts > 0) setTimeout(finish, 2500)
    })
    bot.on('spawn', () => {
      spawn = true
      spawnCount++
      if (!process.env.AFKDESK_TEST_COMMAND) return setTimeout(finish, 1500)
      if (!commandSent) {
        commandSent = true
        return setTimeout(() => bot.chat(process.env.AFKDESK_TEST_COMMAND), 6000)
      }
      if (configurationStarts > 0) setTimeout(finish, 2500)
    })
    bot.on('kicked', (reason) => { kicked = typeof reason === 'string' ? reason : JSON.stringify(reason) })
    bot.on('error', (cause) => { error = String(cause.code || cause.message || cause) })
    bot.on('end', (reason) => { ended = String(reason || ''); setTimeout(finish, 100) })
    setTimeout(() => { if (!error) error = 'timeout'; finish() }, process.env.AFKDESK_TEST_COMMAND ? 45_000 : 25_000)
  })
}

;(async () => {
  for (const host of targets) console.log(JSON.stringify(await checkServer(host)))
})()
