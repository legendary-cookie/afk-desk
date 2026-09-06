class MultiEditionBotManager {
  constructor({ java, bedrock }) {
    this.java = java
    this.bedrock = bedrock
    this.editions = new Map()
  }

  connect(account, options) {
    const edition = account?.edition === 'bedrock' ? 'bedrock' : 'java'
    this.editions.set(account.id, edition)
    return this[edition].connect(account, options)
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
