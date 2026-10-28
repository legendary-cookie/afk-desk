const path = require('node:path')
const bridge = require('rn-bridge')
const { BotManager } = require('./bot-manager.cjs')
const { validateCommand, isRequestId } = require('./bridge-command.cjs')

const manager = new BotManager({
  profilesPath: path.join(bridge.app.datadir(), 'minecraft-profiles'),
  emit: (type, accountId, payload) => bridge.channel.post('engine-event', { type, accountId, payload })
})

function reply(requestId, ok, value) {
  bridge.channel.post('engine-reply', { requestId, ok, ...(ok ? { value } : { error: String(value?.message || value) }) })
}

bridge.channel.on('engine-command', async (rawCommand) => {
  let requestId
  try {
    const command = validateCommand(rawCommand)
    ;({ requestId } = command)
    const { action, account, accountId, value, duration, enabled, range, slot, config } = command
    let result = null
    switch (action) {
      case 'connect': manager.connect(account); break
      case 'disconnect': manager.disconnect(accountId); break
      case 'chat': manager.sendChat(accountId, value); break
      case 'complete-chat': result = await manager.completeChat(accountId, value); break
      case 'move': manager.control(accountId, value, duration); break
      case 'look': manager.look(accountId, value); break
      case 'drop-stack': await manager.dropStack(accountId, slot); break
      case 'window-click': await manager.clickWindowSlot(accountId, slot); break
      case 'window-close': manager.closeWindow(accountId); break
      case 'set-auto-deposit': manager.setAutoDeposit(accountId, enabled, range, config); break
      case 'update-account-config': manager.updateAccountConfig(account); break
      case 'shutdown':
        for (const id of [...manager.sessions.keys()]) manager.disconnect(id)
        break
      default: throw new Error(`Unknown engine action: ${action}`)
    }
    reply(requestId, true, result)
  } catch (error) {
    // Echo a usable id even when validation failed, so the app's waiter rejects
    // promptly instead of timing out after 10 seconds.
    const echoId = isRequestId(requestId) ? requestId : (isRequestId(rawCommand?.requestId) ? rawCommand.requestId : null)
    reply(echoId, false, error)
  }
})

bridge.channel.post('engine-ready', { version: '0.9.2' })

bridge.app.on('pause', (pauseLock) => {
  // Android keeps the runtime alive through AFK Desk's foreground service.
  // iOS will suspend it according to the operating system's background rules.
  pauseLock?.release?.()
})
