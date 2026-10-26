'use strict'

const { EventEmitter } = require('node:events')
const { BedrockBotManager } = require('../../electron/bedrock-bot-manager.cjs')

// A deterministic clock, including cancellation and callbacks already queued at close.
class Timers {
  constructor () { this.now = 0; this.nextId = 0; this.items = new Map() }
  setTimeout (fn, delay) { const id = ++this.nextId; this.items.set(id, { fn, at: this.now + delay, delay }); return id }
  clearTimeout (id) { this.items.delete(id) }
  advance (ms) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.items].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > end) break
      this.now = next[1].at; this.items.delete(next[0]); next[1].fn()
    }
    this.now = end
  }
}

function setup (account = {}, { random = () => 0, start = true, spawn = true, clientVersion } = {}) {
  const timers = new Timers(); const events = []; const clients = []
  const manager = new BedrockBotManager({ profilesPath: __dirname, timers, random, emit: (...args) => events.push(args), createClient: (config) => {
    const client = new EventEmitter()
    client.version = clientVersion || config.version
    client.queued = []
    client.queue = (name, params) => client.queued.push([name, params])
    client.close = () => client.emit('close')
    clients.push(client)
    return client
  } })
  manager.connect({ id: 'phase2', host: 'localhost', antiAfk: false, autoReconnect: false, ...account })
  const client = clients[0]
  const startGame = { runtime_entity_id: 7n, player_position: { x: 1.1234, y: 65.62, z: 3.4567 }, rotation: { x: 10, z: 20 }, current_tick: 40n }
  if (start) client.emit('start_game', startGame)
  if (spawn) client.emit('spawn')
  return { manager, client, clients, timers, events, startGame, session: manager.sessions.get('phase2'), packets: (name) => client.queued.filter(([type]) => type === name).map(([, packet]) => packet) }
}

module.exports = { Timers, setup }
