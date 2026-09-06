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

  disconnect(id) { return this.manager(id).disconnect(id) }
  manager(id) { return this[this.editions.get(id) || 'java'] }
}

for (const method of [
  'sendChat', 'completeChat', 'control', 'setControlState', 'look', 'lookDelta', 'dropStack', 'dropItems',
  'moveInventorySlot', 'equipInventoryItem', 'depositSlot', 'setItemLocks', 'clickWindowSlot',
  'closeWindow', 'setAutoDeposit', 'worldSnapshot', 'worldAction', 'setEnvironmentalMovement', 'setAntiAfk'
]) {
  MultiEditionBotManager.prototype[method] = function (id, ...args) { return this.manager(id)[method](id, ...args) }
}

module.exports = { MultiEditionBotManager }
