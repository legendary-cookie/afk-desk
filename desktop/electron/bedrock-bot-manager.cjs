const path = require('node:path')
const { profilePath, validateProfileId } = require('./profile-path.cjs')
const bedrock = require('bedrock-protocol')

class BedrockBotManager {
  constructor({ profilesPath, emit, createClient = bedrock.createClient, timers = globalThis } = {}) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createClient = createClient
    this.timers = timers
    this.sessions = new Map()
    this.reconnects = new Map()
  }

  connect(account, { reconnecting = false } = {}) {
    validateProfileId(account.id)
    const profilesFolder = path.join(profilePath(this.profilesPath, account.identityId || account.id), 'bedrock')
    if (this.sessions.has(account.id)) throw new Error('This Bedrock profile is already connecting or online.')
    if (account.proxy?.enabled) throw new Error('Bedrock uses UDP/RakNet; the Java TCP proxy pool is not compatible in this beta.')
    const state = this.reconnects.get(account.id) || { attempts: 0, manual: false, timer: null }
    if (state.timer) this.timers.clearTimeout(state.timer)
    state.manual = false
    state.account = account
    this.reconnects.set(account.id, state)
    this.status(account.id, 'connecting', reconnecting ? 'Reconnecting to Bedrock server…' : 'Connecting to Bedrock server…')
    const client = this.createClient({
      host: account.host,
      port: Number(account.port) || 19132,
      username: account.username,
      version: account.version || undefined,
      offline: false,
      profilesFolder,
      raknetBackend: 'jsp-raknet',
      connectTimeout: bound(account.connectTimeoutSeconds, 5, 300, 60) * 1000,
      conLog: null,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })
    const session = { client, account: { ...account }, ready: false, closing: false, runtimeEntityId: null, position: null, yaw: 0, pitch: 0, health: 20, food: 20, players: new Map(), inventory: [], lastTelemetry: '', disconnectReason: '', connectTimer: null, resetTimer: null }
    this.sessions.set(account.id, session)
    const timeoutSeconds = bound(account.connectTimeoutSeconds, 5, 300, 60)
    session.connectTimer = this.timers.setTimeout(() => { if (!session.ready && this.sessions.get(account.id) === session) { session.disconnectReason = `Connection timed out after ${timeoutSeconds}s`; try { client.close() } catch {} } }, timeoutSeconds * 1000)

    client.on('join', () => this.status(account.id, 'connected', 'Bedrock authenticated. Waiting for spawn…'))
    client.on('spawn', () => {
      session.ready = true
      if (session.connectTimer) this.timers.clearTimeout(session.connectTimer)
      session.connectTimer = null
      session.resetTimer = this.timers.setTimeout(() => { state.attempts = 0 }, bound(account.reconnectResetDelay, 5, 3600, 60) * 1000)
      this.status(account.id, 'online', `Bedrock online as ${client.profile?.name || client.username || account.label}`)
      this.emit('identity', account.id, { username: client.profile?.name || client.username || account.label, uuid: client.profile?.id || '', edition: 'bedrock', at: Date.now() })
      this.emit('version', account.id, { version: client.version || account.version || 'auto', stable: true, edition: 'bedrock', at: Date.now() })
      this.emitTelemetry(account.id)
      if (account.joinMessage) this.timers.setTimeout(() => { try { this.sendChat(account.id, account.joinMessage) } catch {} }, Math.max(0, Number(account.messageDelay) || 0) * 1000)
    })
    client.on('start_game', (packet) => {
      session.runtimeEntityId = packet.runtime_entity_id
      session.position = vector(packet.player_position)
      session.yaw = Number(packet.yaw) || 0
      session.pitch = Number(packet.pitch) || 0
      this.emitTelemetry(account.id)
    })
    client.on('move_player', (packet) => {
      if (session.runtimeEntityId != null && String(packet.runtime_id) !== String(session.runtimeEntityId)) return
      session.position = vector(packet.position)
      session.yaw = Number(packet.yaw) || session.yaw
      session.pitch = Number(packet.pitch) || session.pitch
      this.emitTelemetry(account.id)
    })
    client.on('set_health', (packet) => { session.health = Number(packet.health) || 0; this.emitTelemetry(account.id) })
    client.on('set_hunger', (packet) => { session.food = Number(packet.hunger) || 0; this.emitTelemetry(account.id) })
    client.on('add_player', (packet) => session.players.set(String(packet.runtime_id), { id: String(packet.runtime_id), name: packet.username || 'player', position: vector(packet.position), type: 'player' }))
    client.on('remove_entity', (packet) => session.players.delete(String(packet.entity_id_self || packet.runtime_entity_id)))
    client.on('text', (packet) => {
      const message = [packet.source_name, packet.message].filter(Boolean).join(packet.source_name ? ': ' : '')
      this.emit('log', account.id, { kind: 'chat', message: String(message).slice(0, 1000), at: Date.now() })
    })
    client.on('inventory_content', (packet) => {
      if (!isPlayerInventory(packet.window_id)) return
      session.inventory = (packet.input || packet.items || []).slice(0, 46).flatMap((item, slot) => bedrockItem(item, slot))
      this.emitTelemetry(account.id)
    })
    client.on('kick', (packet) => { session.disconnectReason = String(packet.message || packet.reason || 'Disconnected'); this.emit('log', account.id, { kind: 'error', message: `Bedrock kicked: ${session.disconnectReason.slice(0, 240)}`, at: Date.now() }) })
    client.on('error', (error) => { session.disconnectReason = String(error?.message || error); this.emit('log', account.id, { kind: 'error', message: `Bedrock network error: ${session.disconnectReason.slice(0, 240)}`, at: Date.now() }) })
    client.on('close', () => {
      if (this.sessions.get(account.id) !== session) return
      if (session.connectTimer) this.timers.clearTimeout(session.connectTimer)
      if (session.resetTimer) this.timers.clearTimeout(session.resetTimer)
      this.sessions.delete(account.id)
      this.status(account.id, 'offline', 'Bedrock connection closed.')
      if (!session.closing && account.autoReconnect !== false) this.scheduleReconnect(account, session.disconnectReason)
    })
  }

  disconnect(id) {
    const reconnect = this.reconnects.get(id)
    if (reconnect) { reconnect.manual = true; if (reconnect.timer) this.timers.clearTimeout(reconnect.timer) }
    const session = this.sessions.get(id)
    if (!session) { this.status(id, 'offline', 'Disconnected'); return }
    session.closing = true
    if (session.connectTimer) this.timers.clearTimeout(session.connectTimer)
    if (session.resetTimer) this.timers.clearTimeout(session.resetTimer)
    this.sessions.delete(id)
    try { session.client.close() } catch {}
    this.status(id, 'offline', 'Disconnected')
  }

  scheduleReconnect(account, reason = '') {
    const state = this.reconnects.get(account.id) || { attempts: 0, manual: false }
    if (state.manual) return
    state.attempts += 1
    if (account.autoReconnectMaxAttempts > 0 && state.attempts > account.autoReconnectMaxAttempts) return
    const seconds = reconnectDelaySeconds(account, reason || 'bedrock disconnect', state.attempts)
    this.status(account.id, 'reconnecting', `Bedrock disconnected. Retrying in ${seconds}s…`)
    state.timer = this.timers.setTimeout(() => { state.timer = null; if (!state.manual) this.connect(account, { reconnecting: true }) }, seconds * 1000)
    this.reconnects.set(account.id, state)
  }

  sendChat(id, message) {
    const session = this.requireOnline(id)
    const text = String(message || '').trim().slice(0, 512)
    if (!text) return
    if (text.startsWith('/')) {
      const uuid = require('node:crypto').randomUUID()
      const modern = /^1\.(?:2[6-9]|[3-9]\d)/.test(String(session.client.version || ''))
      session.client.queue('command_request', { command: text, origin: { type: 'player', uuid, request_id: '', ...(modern ? { player_entity_id: 0n } : {}) }, internal: false, version: modern ? 'latest' : 52 })
    } else {
      session.client.queue('text', { type: 'chat', needs_translation: false, source_name: session.client.profile?.name || session.client.username || '', xuid: '', platform_chat_id: '', filtered_message: '', message: text })
    }
    this.emit('log', id, { kind: 'sent', message: text, at: Date.now() })
  }

  completeChat(id, input) {
    const session = this.requireOnline(id)
    const prefix = String(input || '').split(/\s/).at(-1).toLowerCase()
    return [...session.players.values()].map((player) => player.name).filter((name) => name.toLowerCase().startsWith(prefix)).slice(0, 20).map((name) => ({ value: name, label: name, source: 'player' }))
  }

  control() { throw experimental('movement') }
  setControlState() { throw experimental('held movement') }
  look() { throw experimental('camera control') }
  lookDelta() { throw experimental('camera control') }
  dropStack() { throw experimental('inventory transactions') }
  dropItems() { throw experimental('inventory transactions') }
  moveInventorySlot() { throw experimental('inventory transactions') }
  equipInventoryItem() { throw experimental('equipment transactions') }
  depositSlot() { throw experimental('container transactions') }
  clickWindowSlot() { throw experimental('server GUI interaction') }
  closeWindow() {}
  setAutoDeposit() {}
  setItemLocks() {}
  setEnvironmentalMovement() {}
  setAntiAfk() {}

  worldSnapshot(id, radius = 6) {
    const session = this.requireOnline(id)
    return { edition: 'bedrock', radius: Math.max(2, Math.min(Number(radius) || 6, 12)), position: session.position, yaw: session.yaw, pitch: session.pitch, blocks: [], entities: [...session.players.values()], limited: true, at: Date.now() }
  }

  worldAction() { throw experimental('world interaction') }

  emitTelemetry(id) {
    const session = this.sessions.get(id)
    if (!session) return
    const telemetry = { health: session.health, food: session.food, position: session.position, dimension: 'bedrock', inventory: session.inventory, selectedHotbarSlot: 0, capabilities: bedrockCapabilities(), at: Date.now() }
    const key = JSON.stringify({ ...telemetry, at: 0 })
    if (key === session.lastTelemetry) return
    session.lastTelemetry = key
    this.emit('telemetry', id, telemetry)
  }

  requireOnline(id) {
    const session = this.sessions.get(id)
    if (!session?.ready) throw new Error('This Bedrock profile is not online yet.')
    return session
  }

  status(id, status, detail) { this.emit('status', id, { status, detail, edition: 'bedrock', at: Date.now() }) }
}

function bedrockCapabilities() { return { chat: true, reconnect: true, position: true, players: true, movement: false, inventoryActions: false, worldBlocks: false, macros: 'chat/wait/notify only' } }
function bound(value, minimum, maximum, fallback) { return Number.isFinite(Number(value)) ? Math.max(minimum, Math.min(Number(value), maximum)) : fallback }
function reconnectDelaySeconds(account, reason, attempts) {
  const base = bound(account?.autoReconnectDelay, 1, 3600, 5)
  const multiplier = bound(account?.autoReconnectBackoffMultiplier, 1, 10, 2)
  const maximum = Math.max(base, bound(account?.autoReconnectMaxDelay, 1, 86400, 300))
  const delay = Math.min(base * (multiplier ** Math.min(Math.max(0, Number(attempts) - 1), 12)), maximum)
  const rateLimit = bound(account?.autoReconnectRateLimitDelay, 1, 86400, 30)
  return Math.max(1, Math.round((/logging in too fast|too many connection attempts|rate.?limit/i.test(String(reason || '')) ? Math.max(delay, rateLimit) : delay) * 10) / 10)
}
function experimental(feature) { return new Error(`Bedrock ${feature} is visible but not enabled in this beta.`) }
function vector(value) { return value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: round(value.x), y: round(value.y), z: round(value.z) } : null }
function round(value) { return Math.round(Number(value) * 10) / 10 }
function isPlayerInventory(value) { return value === 'inventory' || value === 0 || value === 255 }
function bedrockItem(item, slot) {
  const network = item?.network_id ?? item?.item?.network_id
  const count = item?.count ?? item?.item?.count
  if (!network || !count) return []
  return [{ slot, slotType: 'inventory', name: `bedrock_item_${network}`, displayName: `Bedrock item ${network}`, count: Number(count), networkId: Number(network) }]
}
function normalizeLoginCode(code = {}) { return { code: String(code.user_code || code.device_code || ''), verificationUri: String(code.verification_uri || code.verification_uri_complete || 'https://microsoft.com/link'), expiresIn: Number(code.expires_in) || 0 } }

module.exports = { BedrockBotManager, bedrockCapabilities }
