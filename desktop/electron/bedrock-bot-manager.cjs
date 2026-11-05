const path = require('node:path')
const { profilePath, validateProfileId } = require('./profile-path.cjs')
const bedrock = require('bedrock-protocol')
const minecraftData = require('minecraft-data')
const { MacroActionError } = require('./macro/contract.cjs')
const SUPPORTED_VERSION = minecraftData.versions.bedrock.filter((entry) => entry.releaseType === 'release').sort((a, b) => b.version - a.version)[0].minecraftVersion
const EYE_HEIGHT = 1.62
const STATIONARY_INPUTS = new Set(['jump', 'sneak', 'sprint', 'leftClick'])

function raknetBackend () {
  try { require('raknet-native'); return 'raknet-native' } catch { return 'jsp-raknet' }
}

class BedrockBotManager {
  constructor({ profilesPath, emit, createClient = bedrock.createClient, timers = globalThis, random = Math.random } = {}) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createClient = createClient
    this.timers = timers
    this.random = random
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
      version: account.version || SUPPORTED_VERSION,
      offline: false,
      profilesFolder,
      raknetBackend: raknetBackend(),
      skipPing: true,
      useRaknetWorkers: false,
      connectTimeout: bound(account.connectTimeoutSeconds, 5, 300, 60) * 1000,
      conLog: null,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })
    const session = { client, account: { ...account }, ready: false, closing: false, runtimeEntityId: null, position: null, yaw: 0, pitch: 0, health: 20, food: 20, saturation: 5, players: new Map(), inventory: [], itemNames: new Map(), itemLocks: new Set(), forms: new Map(), lastForm: null, lastTelemetry: '', disconnectReason: '', connectTimer: null, resetTimer: null }
    Object.assign(session, { movementTimer: null, tick: 0n, inputClaims: new Map(), previousInputs: {}, jumpArc: null, swingTicks: 0, handledTeleport: false, lastMovement: null, rawInventory: [], selectedHotbarSlot: 0, inventoryQueue: Promise.resolve(), nextRequestId: -1, pendingRequest: null, inventoryUncertain: false, antiAfkTimer: null, antiAfkActionTimers: new Set(), manualControlTimers: new Map() })
    this.sessions.set(account.id, session)
    const timeoutSeconds = bound(account.connectTimeoutSeconds, 5, 300, 60)
    session.connectTimer = this.timers.setTimeout(() => { if (!session.ready && this.sessions.get(account.id) === session) { session.disconnectReason = `Connection timed out after ${timeoutSeconds}s`; try { client.close() } catch {} } }, timeoutSeconds * 1000)

    client.on('join', () => this.status(account.id, 'connected', 'Bedrock authenticated. Waiting for spawn…'))
    client.on('spawn', () => {
      if (this.sessions.get(account.id) !== session || session.closing || session.ready) return
      session.ready = true
      if (session.connectTimer) this.timers.clearTimeout(session.connectTimer)
      session.connectTimer = null
      session.resetTimer = this.timers.setTimeout(() => { state.attempts = 0 }, bound(account.reconnectResetDelay, 5, 3600, 60) * 1000)
      this.status(account.id, 'online', `Bedrock online as ${client.profile?.name || client.username || account.label}`)
      this.emit('spawn', account.id, { dimension: 'bedrock', at: Date.now() })
      this.emit('identity', account.id, { username: client.profile?.name || client.username || account.label, uuid: client.profile?.id || '', edition: 'bedrock', at: Date.now() })
      this.emit('version', account.id, { version: client.version || account.version || 'auto', stable: true, edition: 'bedrock', at: Date.now() })
      this.emitTelemetry(account.id)
      this.startMovementLoop(account.id, session)
      session.joinedAt = Date.now()
      this.setAutoDeposit(account.id, session.account.autoDepositToChest, null, session.account)
      this.setAntiAfk(account.id, session.account)
      const joinMessage = session.account.joinMessage
      if (joinMessage) {
        if (session.joinTimer) this.timers.clearTimeout(session.joinTimer)
        const joinTimer = this.timers.setTimeout(() => {
          // A stale timer must never chat on behalf of a replacement session.
          if (session.joinTimer !== joinTimer || this.sessions.get(account.id) !== session || session.closing) return
          session.joinTimer = null
          try { this.sendChat(account.id, joinMessage) } catch {}
        }, Math.max(0, Number(session.account.messageDelay) || 0) * 1000)
        session.joinTimer = joinTimer
      }
    })
    client.on('start_game', (packet) => {
      if (this.sessions.get(account.id) !== session || session.closing) return
      session.runtimeEntityId = packet.runtime_entity_id
      session.position = feetPosition(packet.player_position)
      session.yaw = Number(packet.rotation?.z ?? packet.rotation?.y) || 0
      session.pitch = Number(packet.rotation?.x) || 0
      session.protocol = minecraftData('bedrock_' + (client.version || session.account.version || SUPPORTED_VERSION)).protocol.types
      // 1.21.90+ dropped the start_game authority choice. Older servers choose it.
      session.canChooseAuthority = packetFields(session.protocol, 'start_game').has('movement_authority')
      session.serverAuthoritative = !session.canChooseAuthority || serverAuthority(packet.movement_authority)
      session.tick = newerTick(session.tick, packet.current_tick)
      session.lastMovement = null
      this.rememberItems(session, packet.itemstates)
      this.emitTelemetry(account.id)
      this.startMovementLoop(account.id, session)
    })
    client.on('move_player', (packet) => {
      if (session.runtimeEntityId == null || String(packet.runtime_id) !== String(session.runtimeEntityId)) return
      this.adoptCorrection(account.id, session, packet.position, packet.yaw, packet.pitch, ['teleport', 'reset', 1, 2].includes(packet.mode))
    })
    client.on('correct_player_move_prediction', (packet) => {
      if (packet.prediction_type === 'vehicle' || packet.prediction_type === 1) return
      this.adoptCorrection(account.id, session, packet.position, packet.rotation?.z ?? packet.rotation?.y, packet.rotation?.x, true)
    })
    client.on('set_movement_authority', (packet) => {
      if (!session.canChooseAuthority || this.sessions.get(account.id) !== session || session.closing) return
      session.serverAuthoritative = serverAuthority(packet.movement_authority)
      if (session.movementTimer != null) this.timers.clearTimeout(session.movementTimer)
      session.movementTimer = null
      session.lastMovement = null
      session.previousInputs = {}
      if (!session.serverAuthoritative) for (const input of ['jump', 'sneak', 'sprint']) if (session.inputClaims.get(input)?.size) this.sendLegacyControl(session, input, true)
      this.startMovementLoop(account.id, session)
    })
    client.on('set_health', (packet) => { this.updateHealth(account.id, session, packet.health) })
    client.on('update_attributes', (packet) => {
      for (const attribute of packet.attributes || []) {
        if (attribute.name === 'minecraft:health') this.updateHealth(account.id, session, attribute.value)
        else if (attribute.name === 'minecraft:player.hunger') session.food = finite(attribute.value, session.food)
        else if (attribute.name === 'minecraft:player.saturation') session.saturation = finite(attribute.value, session.saturation)
      }
      this.emitTelemetry(account.id)
    })
    client.on('entity_event', (packet) => {
      if (packet.runtime_entity_id != null && session.runtimeEntityId != null && String(packet.runtime_entity_id) === String(session.runtimeEntityId) && /death/i.test(String(packet.event_id ?? packet.event))) this.requestRespawn(account.id, session)
    })
    client.on('respawn', (packet) => {
      if (Number(packet.state) !== 1) return
      this.requestRespawn(account.id, session, packet)
    })
    client.on('respawn', (packet) => {
      if (Number(packet.state) === 3) { session.dead = false; this.emit('respawn', account.id, { dimension: 'bedrock', at: Date.now() }) }
    })
    // The event adapter maps this status event directly to BotEvent serverSwitch.
    client.on('transfer', (packet) => this.emit('serverSwitch', account.id, { dimension: 'bedrock', backend: String(packet.server_address || ''), port: Number(packet.port) || 0, at: Date.now() }))
    client.on('add_player', (packet) => session.players.set(String(packet.runtime_id), { id: String(packet.runtime_id), name: packet.username || 'player', position: vector(packet.position), type: 'player' }))
    client.on('remove_entity', (packet) => session.players.delete(String(packet.entity_id_self || packet.runtime_entity_id)))
    client.on('text', (packet) => {
      const message = [packet.source_name, packet.message].filter(Boolean).join(packet.source_name ? ': ' : '')
      this.emit('log', account.id, { kind: 'chat', message: String(message).slice(0, 1000), at: Date.now() })
    })
    client.on('inventory_content', (packet) => {
      if (session.openWindow && String(packet.window_id) === String(session.openWindow.windowId)) {
        session.openWindow.slots = (packet.input || packet.items || []).slice(0, 256)
        this.emitContainer(account.id, session)
        return
      }
      if (!isPlayerInventory(packet.window_id)) return
      session.rawInventory = (packet.input || packet.items || []).slice(0, 41)
      session.inventoryUncertain = false
      this.refreshInventory(account.id, session)
      this.emitTelemetry(account.id)
    })
    client.on('item_registry', (packet) => this.rememberItems(session, packet.itemstates))
    client.on('inventory_slot', (packet) => {
      if (session.openWindow && String(packet.window_id) === String(session.openWindow.windowId)) {
        const slot = Number(packet.slot)
        if (Number.isInteger(slot) && slot >= 0 && slot < session.openWindow.slots.length) session.openWindow.slots[slot] = packet.item
        this.emitContainer(account.id, session)
        return
      }
      if (!isPlayerInventory(packet.window_id)) return
      const slot = mapPlayerSlot(Number(packet.slot))
      if (slot < 0) return
      session.rawInventory[Number(packet.slot)] = packet.item
      this.refreshInventory(account.id, session)
      this.emitTelemetry(account.id)
    })
    client.on('item_stack_response', (packet) => this.handleStackResponse(account.id, session, packet))
    client.on('modal_form_request', (packet) => this.openForm(account.id, session, packet))
    client.on('container_open', (packet) => {
      session.openWindow = { windowId: packet.window_id, windowType: packet.window_type, slots: [], position: packet.coordinates }
      this.emit('window', account.id, { open: true, kind: 'container', title: String(packet.window_type || 'container'), windowId: packet.window_id, at: Date.now() })
    })
    client.on('container_close', (packet) => {
      if (session.openWindow && String(session.openWindow.windowId) === String(packet.window_id)) session.openWindow = null
      this.emit('window', account.id, { open: false, kind: 'container', windowId: packet.window_id, at: Date.now() })
    })
    client.on('kick', (packet) => { session.disconnectReason = String(packet.message || packet.reason || 'Disconnected'); this.emit('log', account.id, { kind: 'error', message: `Bedrock kicked: ${session.disconnectReason.slice(0, 240)}`, at: Date.now() }) })
    client.on('error', (error) => { session.disconnectReason = String(error?.message || error); this.emit('log', account.id, { kind: 'error', message: `Bedrock network error: ${session.disconnectReason.slice(0, 240)}`, at: Date.now() }) })
    client.on('close', () => {
      if (this.sessions.get(account.id) !== session) return
      this.clearSessionTimers(session)
      this.sessions.delete(account.id)
      this.status(account.id, 'offline', 'Bedrock connection closed.')
      const latest = session.account
      if (!session.closing && latest.autoReconnect !== false) this.scheduleReconnect(latest, session.disconnectReason)
    })
  }

  clearSessionTimers(session) {
    session.ready = false
    if (session.pendingRequest) { const pending = session.pendingRequest; session.pendingRequest = null; this.timers.clearTimeout(pending.timer); pending.reject(new Error('Bedrock connection closed.')) }
    for (const name of ['connectTimer', 'resetTimer', 'joinTimer', 'respawnTimer', 'movementTimer', 'antiAfkTimer', 'depositTimer']) {
      if (session[name] != null) this.timers.clearTimeout(session[name])
      session[name] = null
    }
    for (const timer of session.antiAfkActionTimers) this.timers.clearTimeout(timer)
    for (const timer of session.manualControlTimers.values()) this.timers.clearTimeout(timer)
    session.antiAfkActionTimers.clear()
    session.manualControlTimers.clear()
    session.inputClaims.clear()
    session.jumpArc = null
  }

  startMovementLoop(id, session) {
    if (this.sessions.get(id) !== session || !session.ready || session.closing || !session.protocol || session.movementTimer != null) return
    // Recursive timeouts also work with the Phase 1 injected timer interface. There
    // is exactly one outstanding movement callback, fenced to this session and handle.
    const timer = this.timers.setTimeout(() => {
      if (this.sessions.get(id) !== session || session.closing || !session.ready || session.movementTimer !== timer) return
      session.movementTimer = null
      try { this.sendMovementTick(id, session) } catch (error) {
        session.disconnectReason = `Bedrock movement failed: ${error.message}`
        this.clearSessionTimers(session)
        this.emit('log', id, { kind: 'error', message: session.disconnectReason, at: Date.now() })
        try { session.client.close() } catch {}
        return
      }
      this.startMovementLoop(id, session)
    }, session.serverAuthoritative ? 50 : 250)
    session.movementTimer = timer
  }

  sendMovementTick(id, session) {
    if (!session.position || session.runtimeEntityId == null) return
    const held = Object.fromEntries(['jump', 'sneak', 'sprint'].map((input) => [input, Boolean(session.inputClaims.get(input)?.size)]))
    const previous = session.previousInputs
    const startJump = held.jump && !previous.jump
    if (startJump) session.jumpArc = { height: 0, velocity: 0.42 }
    if (session.jumpArc) {
      session.jumpArc.height += session.jumpArc.velocity
      session.jumpArc.velocity = (session.jumpArc.velocity - 0.08) * 0.98
      if (session.jumpArc.height <= 0) session.jumpArc = null
    }
    const inputData = {
      jump_down: held.jump, jumping: held.jump, start_jumping: startJump,
      sneaking: held.sneak, sneak_down: held.sneak,
      start_sneaking: held.sneak && !previous.sneak, stop_sneaking: !held.sneak && Boolean(previous.sneak),
      sprinting: held.sprint, sprint_down: held.sprint,
      start_sprinting: held.sprint && !previous.sprint, stop_sprinting: !held.sprint && Boolean(previous.sprint),
      handled_teleport: session.handledTeleport
    }
    const move = { x: 0, z: 0 }
    const delta = { x: 0, y: 0, z: 0 }
    const position = eyePosition(session.position)
    const rotation = { yaw: session.yaw, pitch: session.pitch, head_yaw: session.yaw }
    session.tick += 1n
    if (session.serverAuthoritative) {
      // Only input flags request a jump: this arc is bookkeeping, never a guessed
      // position/delta. Without chunk collision, the server owns vertical motion.
      session.client.queue('player_auth_input', {
        ...rotation, position, move_vector: move,
        input_data: inputData, input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair',
        interact_rotation: { x: session.pitch, z: session.yaw },
        tick: session.tick, delta,
        analogue_move_vector: move, raw_move_vector: move,
        camera_orientation: cameraDirection(session.yaw, session.pitch)
      })
    } else {
      const key = JSON.stringify({ position, ...rotation })
      if (key !== session.lastMovement) {
        session.client.queue('move_player', { runtime_id: Number(session.runtimeEntityId), position, ...rotation, mode: 'normal', on_ground: true, ridden_runtime_id: 0, tick: session.tick })
        session.lastMovement = key
      }
    }
    if (session.inputClaims.get('leftClick')?.size && session.swingTicks <= 0) {
      this.swingArm(id)
      session.swingTicks = session.serverAuthoritative ? 4 : 1
    }
    session.swingTicks = Math.max(0, session.swingTicks - 1)
    session.previousInputs = held
    session.handledTeleport = false
  }

  adoptCorrection(id, session, position, yaw, pitch, teleport) {
    if (this.sessions.get(id) !== session || session.closing) return
    const feet = feetPosition(position)
    if (feet) session.position = feet
    session.yaw = finite(yaw, session.yaw)
    session.pitch = finite(pitch, session.pitch)
    if (teleport && feet) { session.handledTeleport = true; session.jumpArc = null; session.lastMovement = null }
    this.emitTelemetry(id)
  }

  // Replaces the config used by retry/reconnect for this profile after a settings save.
  updateAccountConfig(account) {
    validateProfileId(account.id)
    const state = this.reconnects.get(account.id)
    const session = this.sessions.get(account.id)
    if (!state && !session) return
    if (session) session.account = { ...account }
    if (state) {
      state.account = account
      if (account.autoReconnect === false && state.timer) {
        this.timers.clearTimeout(state.timer)
        state.timer = null
        if (!session) this.status(account.id, 'offline', 'Auto-reconnect disabled')
      }
    }
  }

  disconnect(id) {
    const reconnect = this.reconnects.get(id)
    if (reconnect) { reconnect.manual = true; if (reconnect.timer) this.timers.clearTimeout(reconnect.timer) }
    const session = this.sessions.get(id)
    if (!session) { this.status(id, 'offline', 'Disconnected'); return }
    session.closing = true
    this.clearSessionTimers(session)
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
    state.timer = this.timers.setTimeout(() => { state.timer = null; if (!state.manual) this.connect(state.account || account, { reconnecting: true }) }, seconds * 1000)
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
      const fields = textFields(String(session.client.version || session.account.version || SUPPORTED_VERSION))
      session.client.queue('text', { type: 'chat', needs_translation: false, ...(fields.has('category') ? { category: 'authored' } : {}), source_name: session.client.profile?.name || session.client.username || '', xuid: '', platform_chat_id: '', ...(fields.has('filtered_message') ? { filtered_message: '' } : {}), ...(fields.has('has_filtered_message') ? { has_filtered_message: false } : {}), message: text })
    }
    this.emit('log', id, { kind: 'sent', message: text, at: Date.now() })
  }

  completeChat(id, input) {
    const session = this.requireOnline(id)
    const prefix = String(input || '').split(/\s/).at(-1).toLowerCase()
    return [...session.players.values()].map((player) => player.name).filter((name) => name.toLowerCase().startsWith(prefix)).slice(0, 20).map((name) => ({ value: name, label: name, source: 'player' }))
  }

  claimInput(id, input, owner) {
    const session = this.requireOnline(id)
    assertStationaryInput(input)
    if (typeof owner !== 'string' || !owner) throw new MacroActionError('INVALID', 'Input owner is required.')
    const owners = session.inputClaims.get(input) || new Set()
    if (owners.has(owner)) return
    const firstClaim = owners.size === 0
    owners.add(owner)
    session.inputClaims.set(input, owners)
    if (firstClaim) this.sendLegacyControl(session, input, true)
    // Any macro input (including swing) pauses autonomous actions immediately.
    if (owner.startsWith('macro:')) this.clearAntiAfkActions(id, session)
  }

  releaseInput(id, input, owner) {
    const session = this.sessions.get(id)
    const owners = session?.inputClaims.get(input)
    if (!owners?.delete(owner) || owners.size > 0) return
    session.inputClaims.delete(input)
    if (input === 'leftClick') session.swingTicks = 0
    this.sendLegacyControl(session, input, false)
  }

  releaseOwner(id, owner) {
    const session = this.sessions.get(id)
    if (!session) return
    for (const input of [...session.inputClaims.keys()]) this.releaseInput(id, input, owner)
  }

  inputOwners(id, input) { return [...(this.sessions.get(id)?.inputClaims.get(input) || [])] }

  sendLegacyControl(session, input, enabled) {
    if (!session.protocol || session.serverAuthoritative || session.runtimeEntityId == null || !session.ready || session.closing) return
    const action = input === 'jump' ? (enabled ? 'jump' : null) : ['sneak', 'sprint'].includes(input) ? `${enabled ? 'start' : 'stop'}_${input}` : null
    if (!action) return
    const position = blockPosition(session.position || {})
    const entityType = session.protocol.packet_player_action[1].find((field) => field.name === 'runtime_entity_id').type
    session.client.queue('player_action', { runtime_entity_id: entityType === 'varint' ? Number(session.runtimeEntityId) : session.runtimeEntityId, action, position, result_position: position, face: 0 })
  }

  setControlState(id, input, enabled) {
    const session = this.requireOnline(id)
    assertStationaryInput(input)
    const timer = session.manualControlTimers.get(input)
    if (timer != null) this.timers.clearTimeout(timer)
    session.manualControlTimers.delete(input)
    if (enabled) this.claimInput(id, input, 'manual')
    else this.releaseInput(id, input, 'manual')
  }

  control(id, input, duration = 350) {
    this.setControlState(id, input, true)
    const session = this.sessions.get(id)
    const timer = this.timers.setTimeout(() => {
      if (this.sessions.get(id) !== session || session.manualControlTimers.get(input) !== timer) return
      session.manualControlTimers.delete(input)
      this.releaseInput(id, input, 'manual')
    }, bound(duration, 100, 3000, 350))
    session.manualControlTimers.set(input, timer)
  }

  // Like Java, the public camera API takes radians. Bedrock stores/sends degrees:
  // minecraft-data data/bedrock/latest/proto.yml:629-636; protocol.json uses lf32
  // directly (bedrock-protocol's serializer does no angular conversion).
  lookAbsolute(id, yaw, pitch) {
    const session = this.requireOnline(id)
    if (!Number.isFinite(Number(yaw)) || !Number.isFinite(Number(pitch))) throw new MacroActionError('INVALID', 'Yaw and pitch must be numbers.')
    session.yaw = Number(yaw) * 180 / Math.PI
    session.pitch = Math.max(-1.45, Math.min(1.45, Number(pitch))) * 180 / Math.PI
  }

  lookDelta(id, yawDelta = 0, pitchDelta = 0) {
    const session = this.requireOnline(id)
    return this.lookAbsolute(id, session.yaw * Math.PI / 180 + bound(yawDelta, -0.7, 0.7, 0), session.pitch * Math.PI / 180 + bound(pitchDelta, -0.5, 0.5, 0))
  }

  look(id, direction) { return this.lookDelta(id, direction === 'left' ? -0.45 : 0.45, 0) }

  swingArm(id) {
    const session = this.requireOnline(id)
    if (session.runtimeEntityId == null) return
    session.client.queue('animate', { action_id: 'swing_arm', runtime_entity_id: session.runtimeEntityId, data: 0, has_swing_source: false })
  }
  refreshInventory(id, session) {
    session.inventory = session.rawInventory.flatMap((item, slot) => bedrockItem(session, item, mapPlayerSlot(slot)))
  }

  queueInventory(id, build, allowWindow = false) {
    const session = this.requireOnline(id)
    const run = () => {
      if (this.sessions.get(id) !== session || !session.ready || session.closing) throw new Error('Bedrock connection closed.')
      if (session.inventoryUncertain) throw new Error('Inventory is awaiting server synchronization.')
      if (session.openWindow && !allowWindow) throw new Error('Close the server menu before managing player inventory.')
      const { action, predict, result } = build(session)
      const requestId = session.nextRequestId
      session.nextRequestId = requestId <= -2147483647 ? -1 : requestId - 2
      return new Promise((resolve, reject) => {
        const timer = this.timers.setTimeout(() => {
          if (session.pendingRequest?.requestId !== requestId) return
          session.pendingRequest = null; session.inventoryUncertain = true
          reject(new Error('Bedrock inventory request timed out.'))
        }, 10000)
        session.pendingRequest = { requestId, predict, result, resolve, reject, timer, window: allowWindow ? session.openWindow : null }
        try { session.client.queue('item_stack_request', { requests: [{ request_id: requestId, actions: [action], custom_names: [], cause: 'chat_public' }] }) }
        catch (error) { this.timers.clearTimeout(timer); session.pendingRequest = null; reject(error) }
      })
    }
    const queued = session.inventoryQueue.then(run, run)
    session.inventoryQueue = queued.catch(() => {})
    return queued
  }

  handleStackResponse(id, session, packet) {
    if (this.sessions.get(id) !== session || session.closing) return
    const pending = session.pendingRequest
    if (!pending) return
    const response = (packet.responses || []).find((entry) => Number(entry.request_id) === pending.requestId)
    if (!response) return
    session.pendingRequest = null
    this.timers.clearTimeout(pending.timer)
    if (response.status !== 'ok' && response.status !== 0) { pending.reject(new Error('Bedrock inventory request rejected.')); return }
    if (pending.window && session.openWindow !== pending.window) { session.inventoryUncertain = true; pending.reject(new Error('Container closed during inventory request.')); return }
    pending.predict(session.rawInventory)
    for (const container of response.containers || []) {
      const type = container.slot_type?.container_id ?? container.slot_type
      if (pending.window && ['container', 'barrel', 7, 58].includes(type)) {
        for (const entry of container.slots || []) {
          const slot = Number(entry.slot); const item = pending.window.slots[slot]
          if (!Number.isInteger(slot) || slot < 0 || slot >= pending.window.slots.length) continue
          if (!entry.count) pending.window.slots[slot] = { network_id: 0 }
          else if (item?.network_id) pending.window.slots[slot] = { ...item, count: entry.count, stack_id: entry.item_stack_id, has_stack_id: 1 }
        }
        continue
      }
      if (!['hotbar_and_inventory', 'hotbar', 'inventory', 12, 28, 29].includes(type)) continue
      for (const entry of container.slots || []) {
        const slot = Number(entry.slot)
        if (slot < 0 || slot > 35 || !Number.isInteger(slot)) continue
        const item = session.rawInventory[slot]
        if (!entry.count) session.rawInventory[slot] = { network_id: 0 }
        else if (item?.network_id) session.rawInventory[slot] = { ...item, count: entry.count, stack_id: entry.item_stack_id, has_stack_id: 1 }
      }
    }
    this.refreshInventory(id, session); this.emitTelemetry(id); if (pending.window) this.emitContainer(id, session); pending.resolve(pending.result)
  }

  dropStack(id, slot) { return this.dropItems(id, slot, Infinity) }
  dropItems(id, slot, requestedCount = 1) {
    return this.queueInventory(id, (session) => {
      const rawSlot = inventoryWireSlot(slot); assertUnlocked(session, Number(slot))
      const item = session.rawInventory[rawSlot]
      if (!item?.network_id || !item.count) throw new Error('That inventory stack is no longer available.')
      const count = Math.min(item.count, Math.max(1, Math.floor(Number(requestedCount) || 1)))
      return { action: { type_id: 'drop', count, source: stackSlot(rawSlot, item), randomly: false }, result: { slot: Number(slot), count }, predict: (slots) => { const current = slots[rawSlot]; if (current === item) slots[rawSlot] = count === item.count ? { network_id: 0 } : { ...item, count: item.count - count } } }
    })
  }
  moveInventorySlot(id, sourceSlot, destinationSlot) {
    return this.queueInventory(id, (session) => {
      const source = inventoryWireSlot(sourceSlot); const destination = inventoryWireSlot(destinationSlot)
      if (source === destination) throw new Error('Choose a different destination slot.')
      assertUnlocked(session, Number(sourceSlot)); assertUnlocked(session, Number(destinationSlot))
      const item = session.rawInventory[source]; const target = session.rawInventory[destination]
      if (!item?.network_id || !item.count) throw new Error('The source inventory slot is empty.')
      const occupied = Boolean(target?.network_id && target.count)
      return { action: { type_id: occupied ? 'swap' : 'place', ...(occupied ? {} : { count: item.count }), source: stackSlot(source, item), destination: stackSlot(destination, target) }, result: { sourceSlot: Number(sourceSlot), targetSlot: Number(destinationSlot) }, predict: (slots) => { if (slots[source] === item && slots[destination] === target) { slots[source] = target || { network_id: 0 }; slots[destination] = item } } }
    })
  }
  async equipInventoryItem(id, slot, destination) {
    if (destination && destination !== 'hand') throw experimental('equipment transactions')
    const source = Number(slot); inventoryWireSlot(source)
    const session = this.requireOnline(id); assertUnlocked(session, source)
    if (!session.rawInventory[inventoryWireSlot(source)]?.network_id) throw new Error('That inventory stack is no longer available.')
    const targetSlot = source >= 36 ? source : 36 + session.selectedHotbarSlot
    if (targetSlot !== source) await this.moveInventorySlot(id, source, targetSlot)
    this.worldAction(id, 'select-hotbar', { slot: targetSlot - 36 })
    return { sourceSlot: source, targetSlot, destination: 'hand' }
  }
  emitContainer(id, session) {
    const window = session.openWindow
    if (!window) return
    this.emit('window', id, { open: true, kind: 'container', title: String(window.windowType || 'container'), windowId: window.windowId, size: window.slots.length, slots: window.slots.flatMap((item, slot) => bedrockItem(session, item, slot)), at: Date.now() })
  }
  transferContainer(id, playerSlot, containerSlot, count = 64, intoContainer = true) {
    return this.queueInventory(id, (session) => {
      const window = session.openWindow
      if (!window || !['container', 0].includes(window.windowType)) throw new Error('An open chest container is required.')
      const player = inventoryWireSlot(playerSlot); assertUnlocked(session, Number(playerSlot))
      const chest = Number(containerSlot)
      if (!Number.isInteger(chest) || chest < 0 || chest >= window.slots.length) throw new Error('Invalid container slot.')
      const sourceSlots = intoContainer ? session.rawInventory : window.slots
      const targetSlots = intoContainer ? window.slots : session.rawInventory
      const source = intoContainer ? player : chest; const target = intoContainer ? chest : player
      const item = sourceSlots[source]; const dest = targetSlots[target]
      if (!item?.network_id || !item.count) throw new Error('The source slot is empty.')
      if (dest?.network_id && dest.count) throw new Error('The destination slot must be empty.')
      const amount = Math.min(item.count, Math.max(1, Math.floor(Number(count) || 1)))
      const containerInfo = (slot, value) => ({ ...stackSlot(slot, value), slot_type: { container_id: 'container' } })
      return { action: { type_id: intoContainer ? 'place' : 'take', count: amount, source: intoContainer ? stackSlot(source, item) : containerInfo(source, item), destination: intoContainer ? containerInfo(target, dest) : stackSlot(target, dest) }, result: { slot: Number(playerSlot), count: amount }, predict: () => {
        if (sourceSlots[source] === item && targetSlots[target] === dest) { sourceSlots[source] = amount === item.count ? { network_id: 0 } : { ...item, count: item.count - amount }; targetSlots[target] = { ...item, count: amount } }
      } }
    }, true)
  }
  depositSlot(id, slot, count = 64) {
    const session = this.requireOnline(id); const window = session.openWindow
    const target = window?.slots.findIndex((item) => !item?.network_id || !item.count) ?? -1
    if (target < 0) return Promise.reject(new Error('No open container with an empty slot.'))
    return this.transferContainer(id, slot, target, count, true)
  }
  clickWindowSlot(id, slot) {
    const session = this.requireOnline(id)
    const target = Array.from({ length: 36 }, (_, n) => n + 9).find((uiSlot) => !session.rawInventory[inventoryWireSlot(uiSlot)]?.network_id && !session.itemLocks.has(uiSlot) && !(session.account.lockedInventorySlots || []).map(Number).includes(uiSlot))
    if (target == null) return Promise.reject(new Error('No empty unlocked inventory slot.'))
    return this.transferContainer(id, target, slot, 64, false)
  }
  closeWindow(id) {
    const session = this.requireOnline(id)
    if (!session.openWindow) return
    session.client.queue('container_close', { window_id: session.openWindow.windowId, window_type: session.openWindow.windowType, server: false })
    session.openWindow = null
    this.emit('window', id, { open: false, kind: 'container', at: Date.now() })
  }
  setAutoDeposit(id, enabled, range, account) {
    const session = this.sessions.get(id); const state = this.reconnects.get(id)
    if (state) state.account = { ...state.account, ...(account || {}), autoDepositToChest: enabled === true }
    if (!session) return
    session.account = { ...session.account, ...(account || {}), autoDepositToChest: enabled === true }
    session.depositRevision = (session.depositRevision || 0) + 1
    if (session.depositTimer != null) this.timers.clearTimeout(session.depositTimer)
    session.depositTimer = null
    this.releaseOwner(id, 'autoDeposit')
    if (enabled && session.ready) this.scheduleDeposit(id, session, 0)
  }
  scheduleDeposit(id, session, delay = 5000) {
    if (!session.ready || session.closing || !session.account.autoDepositToChest || this.sessions.get(id) !== session || session.depositTimer != null || session.depositActive) return
    const revision = session.depositRevision
    const timer = this.timers.setTimeout(async () => {
      if (session.depositTimer !== timer || session.depositRevision !== revision || this.sessions.get(id) !== session) return
      session.depositTimer = null
      session.depositActive = true
      try { if (bedrockShouldDeposit(session)) await this.autoDeposit(id, session) }
      catch (error) { if (session.depositRevision === revision && session.account.autoDepositToChest && session.ready) this.emit('log', id, { kind: 'error', message: `Auto-deposit failed: ${error.message}`, at: Date.now() }) }
      finally {
        session.depositActive = false
        this.scheduleDeposit(id, session, session.depositRevision === revision ? 5000 : 0)
      }
    }, delay)
    session.depositTimer = timer
  }
  async autoDeposit(id, session) {
    const revision = session.depositRevision
    const active = () => this.sessions.get(id) === session && session.ready && !session.closing && session.account.autoDepositToChest && session.depositRevision === revision
    const check = () => { if (!active()) throw new Error('Auto-deposit cancelled.') }
    const wait = ms => new Promise(resolve => this.timers.setTimeout(resolve, ms))
    const target = session.account.bedrockDepositTarget
    if (!target || !['x', 'y', 'z'].every(k => Number.isInteger(target[k]))) throw new Error('Set a Bedrock deposit target in account settings.')
    if (!session.position) throw new Error('Current position is unavailable.')
    if (session.openWindow) throw new Error('Close the current window before auto-deposit.')
    if (!session.inventory.some(item => item.slot >= 9 && item.slot <= 44 && !session.itemLocks.has(item.slot) && !(session.account.lockedInventorySlots || []).includes(item.slot))) return
    const distance = () => Math.hypot(target.x + 0.5 - session.position.x, target.y + 0.5 - (session.position.y + EYE_HEIGHT), target.z + 0.5 - session.position.z)
    let requestedWindow = false
    try {
      if (distance() > 4.5) throw new Error('Deposit target must already be within reach; move closer.')
      check()
      const item = session.rawInventory[session.selectedHotbarSlot] || { network_id: 0 }
      requestedWindow = true
      session.client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [], transaction_data: { action_type: 'click_block', trigger_type: 'player_input', block_position: target, face: 1, hotbar_slot: session.selectedHotbarSlot, held_item: item, player_pos: eyePosition(session.position), click_pos: { x: 0.5, y: 0.5, z: 0.5 }, block_runtime_id: 0, client_prediction: 'failure', client_cooldown_state: 'off' } } })
      for (let i = 0; i < 50 && (!session.openWindow || !session.openWindow.slots.length); i++) { await wait(100); check() }
      if (!session.openWindow || !session.openWindow.slots.length) throw new Error('No container window opened at the Bedrock deposit target.')
      if (!['container', 0].includes(session.openWindow.windowType)) throw new Error('The target did not open a chest or barrel.')
      for (const item of [...session.inventory]) {
        check()
        if (item.slot < 9 || item.slot > 44 || session.itemLocks.has(item.slot) || (session.account.lockedInventorySlots || []).includes(item.slot)) continue
        await this.depositSlot(id, item.slot, item.count)
      }
      session.lastDepositAt = Date.now()
    } finally {
      this.releaseOwner(id, 'autoDeposit')
      if (requestedWindow && this.sessions.get(id) === session && session.ready && session.openWindow) this.closeWindow(id)
    }
  }
  setItemLocks(id, slots) { const session = this.sessions.get(id); if (session) session.itemLocks = new Set((Array.isArray(slots) ? slots : []).map(Number).filter(Number.isInteger)) }
  respondForm(id, formId, response) {
    const session = this.requireOnline(id); const form = session.forms.get(Number(formId))
    if (!form) throw new Error('Bedrock form is no longer available.')
    const cancelled = response == null
    session.client.queue('modal_form_response', { form_id: Number(formId), has_response_data: !cancelled, data: cancelled ? undefined : JSON.stringify(response), has_cancel_reason: cancelled, ...(cancelled ? { cancel_reason: 'closed' } : {}) })
    session.forms.delete(Number(formId)); if (session.lastForm?.id === Number(formId)) session.lastForm = null
  }

  rememberItems(session, items = []) {
    for (const item of items || []) if (item?.name && Number.isInteger(Number(item.runtime_id ?? item.id))) session.itemNames.set(Number(item.runtime_id ?? item.id), String(item.name).replace(/^minecraft:/, ''))
  }
  updateHealth(id, session, value) { session.health = finite(value, session.health); if (session.health <= 0 && !session.dead) this.requestRespawn(id, session); if (session.health > 0) session.dead = false; this.emitTelemetry(id) }
  // `death` uses the adapter's existing event shape; telemetry health is also set to zero.
  emitDeath(id) { const session = this.sessions.get(id); if (session?.dead) return; if (session) { session.dead = true; session.health = 0 } this.emit('death', id, { at: Date.now() }); this.emit('log', id, { kind: 'system', message: 'Died', at: Date.now() }); if (session) this.emitTelemetry(id) }
  requestRespawn(id, session, packet = {}) {
    this.emitDeath(id)
    if (session.account.autoRespawn === false || session.respawnTimer) return
    const timer = this.timers.setTimeout(() => {
      session.respawnTimer = null
      if (this.sessions.get(id) !== session || session.closing) return
      const position = packet.position || (session.position && eyePosition(session.position)) || { x: 0, y: 0, z: 0 }
      const entityId = packet.runtime_entity_id ?? session.runtimeEntityId ?? 0n
      session.client.queue('respawn', { position, state: 2, runtime_entity_id: entityId })
      session.client.queue('player_action', { runtime_entity_id: entityId, action: 'respawn', position: blockPosition(position), result_position: blockPosition(position), face: 0 })
    }, 500)
    session.respawnTimer = timer
  }
  openForm(id, session, packet) {
    let form; try { form = JSON.parse(packet.data) } catch { return }
    const formId = Number(packet.form_id); const type = String(form.type || 'form'); const buttons = Array.isArray(form.buttons) ? form.buttons.map((button) => String(button?.text ?? button ?? '')) : form.button1 !== undefined || form.button2 !== undefined ? [String(form.button1 ?? ''), String(form.button2 ?? '')] : []
    const stored = { id: formId, type, title: String(form.title || ''), content: typeof form.content === 'string' ? form.content : '', buttons, elements: Array.isArray(form.controls) ? form.controls : Array.isArray(form.elements) ? form.elements : Array.isArray(form.content) ? form.content : [] }
    session.forms.set(formId, stored); session.lastForm = stored
    this.emit('window', id, { open: true, kind: 'form', title: stored.title, buttons, formId, formType: type, content: stored.content, elements: stored.elements, at: Date.now() })
  }
  setEnvironmentalMovement() {}
  setAntiAfk(id, account) {
    const session = this.sessions.get(id)
    if (!session) return
    Object.assign(session.account, account)
    if (session.antiAfkTimer != null) this.timers.clearTimeout(session.antiAfkTimer)
    session.antiAfkTimer = null
    this.clearAntiAfkActions(id, session)
    session.antiAfkSettings = normalizeAntiAfkSettings(account)
    if (session.account.antiAfk !== false && session.ready) this.scheduleAntiAfk(id, session)
  }

  clearAntiAfkActions(id, session) {
    for (const timer of session.antiAfkActionTimers) this.timers.clearTimeout(timer)
    session.antiAfkActionTimers.clear()
    this.releaseOwner(id, 'antiAfk')
  }

  scheduleAntiAfk(id, session) {
    const settings = session.antiAfkSettings
    const seconds = settings.minDelay + this.random() * (settings.maxDelay - settings.minDelay)
    const timer = this.timers.setTimeout(() => {
      if (this.sessions.get(id) !== session || session.closing || !session.ready || session.antiAfkTimer !== timer) return
      session.antiAfkTimer = null
      this.runAntiAfkCycle(id)
      if (this.sessions.get(id) === session && session.ready && !session.closing && session.account.antiAfk !== false) this.scheduleAntiAfk(id, session)
    }, Math.round(seconds * 1000))
    session.antiAfkTimer = timer
  }

  runAntiAfkCycle(id) {
    const session = this.sessions.get(id)
    if (!session?.ready || session.closing || !session.position || session.account.antiAfk === false) return
    for (const owners of session.inputClaims.values()) if ([...owners].some((owner) => owner.startsWith('macro:'))) return
    const settings = session.antiAfkSettings
    const actions = ['jump', 'look', 'sneak'].filter((action) => settings[action])
    if (!actions.length) return
    const action = actions[Math.min(actions.length - 1, Math.floor(this.random() * actions.length))]
    if (action === 'look') this.lookAbsolute(id, (session.yaw + (this.random() < 0.5 ? -1 : 1) * settings.lookDegrees) * Math.PI / 180, session.pitch * Math.PI / 180)
    else {
      const input = action
      this.claimInput(id, input, 'antiAfk')
      const timer = this.timers.setTimeout(() => {
        if (!session.antiAfkActionTimers.delete(timer) || this.sessions.get(id) !== session || session.closing) return
        this.releaseInput(id, input, 'antiAfk')
      }, Math.round(settings.duration * 1000))
      session.antiAfkActionTimers.add(timer)
    }
  }

  minimapSnapshot(id) {
    const session = this.requireOnline(id)
    return { position: session.position, yaw: session.yaw || 0, entities: [...session.players.values()], grid: null, goal: null }
  }

  worldSnapshot(id, radius = 6) {
    const session = this.requireOnline(id)
    return { edition: 'bedrock', radius: Math.max(2, Math.min(Number(radius) || 6, 12)), position: session.position, yaw: session.yaw, pitch: session.pitch, blocks: [], entities: [...session.players.values()], limited: true, at: Date.now() }
  }

  worldAction(id, action, target = {}) {
    const session = this.requireOnline(id)
    if (action === 'select-hotbar') {
      const slot = target.slot
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('Hotbar slot must be an integer from 0 to 8.')
      session.client.queue('mob_equipment', { runtime_entity_id: session.runtimeEntityId, item: session.rawInventory[slot] || { network_id: 0 }, slot, selected_slot: slot, window_id: 'inventory' })
      session.selectedHotbarSlot = slot; this.emitTelemetry(id); return { slot }
    }
    if (action === 'use-held' || action === 'use-crosshair') {
      const item = session.rawInventory[session.selectedHotbarSlot] || { network_id: 0 }
      session.client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [], transaction_data: { action_type: 'click_air', trigger_type: 'player_input', block_position: { x: 0, y: 0, z: 0 }, face: 0, hotbar_slot: session.selectedHotbarSlot, held_item: item, player_pos: session.position ? eyePosition(session.position) : { x: 0, y: 0, z: 0 }, click_pos: { x: 0, y: 0, z: 0 }, block_runtime_id: 0, client_prediction: 'failure', client_cooldown_state: 'off' } } })
      return { used: true }
    }
    throw experimental('world interaction')
  }

  emitTelemetry(id) {
    const session = this.sessions.get(id)
    if (!session) return
    const telemetry = { health: session.health, food: session.food, saturation: session.saturation, position: session.position, dimension: 'bedrock', inventory: session.inventory, selectedHotbarSlot: session.selectedHotbarSlot, capabilities: bedrockCapabilities(), at: Date.now() }
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

function bedrockShouldDeposit(session, now = Date.now()) {
  const account = session.account
  const locked = new Set([...(account.lockedInventorySlots || []), ...session.itemLocks])
  let free = 0
  for (let slot = 9; slot <= 44; slot++) if (!locked.has(slot) && !session.rawInventory[inventoryWireSlot(slot)]?.network_id) free++
  const full = free <= bound(account.autoDepositFullThreshold, 0, 35, 0)
  const interval = now - (session.lastDepositAt || session.joinedAt || now) >= bound(account.autoDepositInterval, 1, 86400, 300) * 1000
  if (account.autoDepositMode === 'interval') return interval
  if (account.autoDepositMode === 'inventoryFull') return full
  if (account.autoDepositMode === 'intervalOrFull') return interval || full
  return true
}
function inventoryWireSlot(value) { const slot = Number(value); if (!Number.isInteger(slot) || slot < 9 || slot > 44) throw new Error('Invalid player inventory slot.'); return slot >= 36 ? slot - 36 : slot }
function assertUnlocked(session, slot) { if (session.itemLocks.has(slot) || (session.account.lockedInventorySlots || []).map(Number).includes(slot)) throw new Error('That inventory stack is locked.') }
function stackSlot(slot, item) { const id = item?.stack_id; return { slot_type: { container_id: 'hotbar_and_inventory' }, slot, stack_id: Number(typeof id === 'object' ? id?.id : id) || 0 } }
function bedrockCapabilities() { return { chat: true, reconnect: true, position: true, players: true, health: true, hunger: true, death: true, autoRespawn: true, serverSwitch: true, inventoryView: true, itemLocksStored: true, forms: true, containerWindows: true, movement: 'stationary', antiAfk: ['look', 'jump', 'sneak'], inventoryActions: false, worldBlocks: false, macros: 'chat/wait/notify only' } }
function assertStationaryInput(input) {
  if (!STATIONARY_INPUTS.has(input)) throw new MacroActionError('UNSUPPORTED', `Bedrock input ${input} is not supported yet`)
}
function packetFields(protocol, name) { return new Set((protocol['packet_' + name]?.[1] || []).map((field) => field.name)) }
function serverAuthority(value) { return value === 1 || value === 2 || ['server', 'server_with_rewind', 'server_v2_rewind'].includes(value) }
function newerTick(current, value) { try { const tick = BigInt(value); return tick > current ? tick : current } catch { return current } }
// Movement packet positions are eyes; telemetry/session coordinates are feet.
// Keep full precision here: the Phase 1 display vector() rounds to 0.1 blocks.
function feetPosition(value) { return value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: value.x, y: value.y - EYE_HEIGHT, z: value.z } : null }
function eyePosition(value) { return { x: value.x, y: value.y + EYE_HEIGHT, z: value.z } }
function cameraDirection(yaw, pitch) {
  const y = yaw * Math.PI / 180; const p = pitch * Math.PI / 180
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) }
}
// Mirror bot-manager.cjs without loading Java physics and protocol patches here.
function normalizeAntiAfkSettings(input) {
  const legacyInterval = typeof input === 'number' ? input : input?.antiAfkInterval
  const minDelay = bound(input?.antiAfkMinDelay ?? legacyInterval, 2, 3600, 45)
  const maxDelay = Math.max(minDelay, bound(input?.antiAfkMaxDelay ?? legacyInterval, 2, 3600, minDelay))
  return { minDelay, maxDelay, duration: bound(input?.antiAfkActionDuration, 0.1, 10, 0.25), walkDistance: bound(input?.antiAfkWalkDistance, 0.1, 8, 0.5), lookDegrees: bound(input?.antiAfkLookDegrees, 5, 180, 12), jump: input?.antiAfkJump !== false, look: input?.antiAfkLook !== false, sneak: input?.antiAfkSneak === true, swing: input?.antiAfkSwing === true, walk: input?.antiAfkWalk === true }
}
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
function bedrockItem(session, item, slot) {
  const network = item?.network_id ?? item?.item?.network_id
  const count = item?.count ?? item?.item?.count
  if (!network || !count) return []
  const raw = session.itemNames.get(Number(network)) || minecraftData('bedrock_' + (session.client.version || SUPPORTED_VERSION))?.items?.[Number(network)]?.name || `bedrock_item_${network}`
  const name = String(raw).replace(/^minecraft:/, '')
  return [{ slot, name, displayName: name.split('_').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' '), count: Number(count) }]
}
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback }
// Bedrock player slots 0-8 are the hotbar, 9-35 main inventory, 36-39 armor,
// and 40 offhand. The UI follows Java's 0-44 layout: hotbar 36-44, main 9-35,
// armor 5-8; crafting slots 0-4 and offhand 45 are outside this Phase 1 view.
function mapPlayerSlot(slot) { if (slot >= 0 && slot <= 8) return slot + 36; if (slot >= 9 && slot <= 35) return slot; if (slot >= 36 && slot <= 39) return slot - 31; return -1 }
function blockPosition(position) { return { x: Math.floor(Number(position.x) || 0), y: Math.floor(Number(position.y) || 0), z: Math.floor(Number(position.z) || 0) } }
function textFields(version) {
  try { return new Set(minecraftData('bedrock_' + version).protocol.types.packet_text[1].map((field) => field.name).filter(Boolean)) } catch { return new Set(['needs_translation', 'type', 'source_name', 'message', 'xuid', 'platform_chat_id', 'filtered_message']) }
}
function normalizeLoginCode(code = {}) { return { code: String(code.user_code || code.device_code || ''), verificationUri: String(code.verification_uri || code.verification_uri_complete || 'https://microsoft.com/link'), expiresIn: Number(code.expires_in) || 0 } }

module.exports = { BedrockBotManager, bedrockCapabilities }
