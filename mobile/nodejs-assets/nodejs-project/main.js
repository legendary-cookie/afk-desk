const path = require('node:path')
const bridge = require('rn-bridge')
const { BotManager } = require('./bot-manager.cjs')

const manager = new BotManager({
  profilesPath: path.join(bridge.app.datadir(), 'minecraft-profiles'),
  emit: (type, accountId, payload) => bridge.channel.post('engine-event', { type, accountId, payload })
})

function reply(requestId, ok, value) {
  bridge.channel.post('engine-reply', { requestId, ok, ...(ok ? { value } : { error: String(value?.message || value) }) })
}

bridge.channel.on('engine-command', async ({ requestId, action, account, accountId, value, duration }) => {
  try {
    switch (action) {
      case 'connect': manager.connect(account); break
      case 'disconnect': manager.disconnect(accountId); break
      case 'chat': manager.sendChat(accountId, value); break
      case 'move': manager.control(accountId, value, duration); break
      case 'look': manager.look(accountId, value); break
      case 'shutdown':
        for (const id of [...manager.sessions.keys()]) manager.disconnect(id)
        break
      default: throw new Error(`Unknown engine action: ${action}`)
    }
    reply(requestId, true, null)
  } catch (error) {
    reply(requestId, false, error)
  }
})

bridge.channel.post('engine-ready', { version: '0.1.0' })

bridge.app.on('pause', (pauseLock) => {
  // Android keeps the runtime alive through AFK Desk's foreground service.
  // iOS will suspend it according to the operating system's background rules.
  pauseLock?.release?.()
})
