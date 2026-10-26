class MultiEditionBotManager {
  constructor({ java, bedrock }) {
    this.java = java
    this.bedrock = bedrock
    this.editions = new Map()
  }

  connect(account, options) {
    const edition = account?.edition === 'bedrock' ? 'bedrock' : 'java'
    const other = this[edition === 'java' ? 'bedrock' : 'java']
    const retry = other.reconnects?.get(account.id)
    if (other.sessions?.has(account.id) || (retry?.timer && !retry.manual)) {
      throw new Error('This profile is already active in another edition. Disconnect it before changing edition.')
    }
    const result = this[edition].connect(account, options)
    this.editions.set(account.id, edition)
    return result
  }

  // Routes a saved profile to the manager that owns its live session/retry state (else by edition).
  updateAccountConfig(account) {
    const edition = this.editions.get(account?.id) || (account?.edition === 'bedrock' ? 'bedrock' : 'java')
    const manager = this[edition]
    if (typeof manager?.updateAccountConfig === 'function') return manager.updateAccountConfig(account)
  }

  disconnect(id) { return this.manager(id).disconnect(id) }
  manager(id) { return this[this.editions.get(id) || 'java'] }
}

for (const method of [
  'sendChat', 'completeChat', 'control', 'setControlState', 'look', 'lookDelta', 'dropStack', 'dropItems',
  'moveInventorySlot', 'equipInventoryItem', 'depositSlot', 'setItemLocks', 'clickWindowSlot',
  'closeWindow', 'respondForm', 'setAutoDeposit', 'worldSnapshot', 'worldAction', 'setEnvironmentalMovement', 'setAntiAfk'
]) {
  MultiEditionBotManager.prototype[method] = function (id, ...args) { return this.manager(id)[method](id, ...args) }
}

module.exports = { MultiEditionBotManager }
