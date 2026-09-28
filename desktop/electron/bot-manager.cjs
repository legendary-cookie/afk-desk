const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { profilePath, validateProfileId } = require('./profile-path.cjs')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
const { ResourcePackLoader, normalizePackEvent } = require('./resource-pack.cjs')
const {
  CONFIGURATION_PACKET_NAMES,
  installMovementPacketCompatibility,
  installModernPlayerInputCompatibility,
  roundDiagnostic,
  vectorSnapshot,
  vectorDelta,
  safeMovementFlags,
  snapshotNearbyBlocks,
  snapshotNearbyEntities
} = require('./movement-compatibility.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { normalizeVersionSelection } = require('./version-support.cjs')
const { moddedBotOptions, installModdedCompatibility, installCustomChannels, normalizeModdedProfile } = require('./modded-compatibility.cjs')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const ARMOR_SLOT_TYPES = new Map([[5, 'helmet'], [6, 'chestplate'], [7, 'leggings'], [8, 'boots'], [45, 'off-hand']])
const EQUIPMENT_DESTINATION_SLOTS = new Map([['head', 5], ['torso', 6], ['legs', 7], ['feet', 8], ['off-hand', 45]])
const WATER_NAMES = new Set(['water', 'flowing_water'])
const WATERLIKE_NAMES = new Set(['bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const FLOW_DIRECTIONS = [[0, 1], [-1, 0], [0, -1], [1, 0]]
const FLUID_CONTACT_GRACE_MS = 750
const CHEST_SCAN_INTERVAL = 5000
const DEFAULT_AUTO_DEPOSIT_RANGE = 5
const MAX_AUTO_DEPOSIT_RANGE = 16
class BotManager {
  constructor({
    profilesPath,
    emit,
    createBot = mineflayer.createBot,
    scheduleReconnectTimer = setTimeout,
    clearReconnectTimer = clearTimeout,
    scheduleNetworkTimer = setTimeout,
    clearNetworkTimer = clearTimeout,
    scheduleAntiAfkTimer = setTimeout,
    clearAntiAfkTimer = clearTimeout,
    random = Math.random,
    diagnose = () => {},
    resourcePackLoader
  }) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createBot = createBot
    this.scheduleReconnectTimer = scheduleReconnectTimer
    this.clearReconnectTimer = clearReconnectTimer
    this.scheduleNetworkTimer = scheduleNetworkTimer
    this.clearNetworkTimer = clearNetworkTimer
    this.scheduleAntiAfkTimer = scheduleAntiAfkTimer
    this.clearAntiAfkTimer = clearAntiAfkTimer
    this.random = random
    this.diagnose = diagnose
    this.resourcePackLoader = resourcePackLoader || new ResourcePackLoader({ cacheDir: path.join(path.dirname(profilesPath), 'resource-packs') })
    this.sessions = new Map()
    this.reconnects = new Map()
    this.nextAutomaticServerSwitchAt = 0
    this.nextWorldBlockRevision = 0
  }

  connect(account, { reconnecting = false } = {}) {
    validateProfileId(account?.id)
    const profilesFolder = profilePath(this.profilesPath, account.identityId || account.id)
    if (this.sessions.has(account.id)) throw new Error('This account is already connecting or online.')
    const reconnectState = this.reconnects.get(account.id) || { attempts: 0, timer: null, manual: false }
    if (reconnectState.timer) this.clearReconnectTimer(reconnectState.timer)
    reconnectState.timer = null
    reconnectState.manual = false
    reconnectState.account = account
    this.reconnects.set(account.id, reconnectState)

    const explicitVersion = normalizeVersionSelection(account.version)
    // Auto must negotiate against the current server. A previously successful
    // version (including one from a peer account) can become stale after an update.
    const connectionVersion = explicitVersion
    const modLog = (message) => this.emit('log', account.id, { kind: 'system', message, at: Date.now() })
    const bot = this.createBot({
      host: account.host,
      port: Number(account.port) || 25565,
      username: account.username,
      auth: 'microsoft',
      version: connectionVersion || false,
      profilesFolder,
      connect: createProxyConnect(account.proxy, { host: account.host, port: Number(account.port) || 25565 }),
      hideErrors: true,
      checkTimeoutInterval: 45_000,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code)),
      ...moddedBotOptions(account, modLog)
    })
    installModdedCompatibility(bot._client, { ...account, version: connectionVersion }, modLog)
    installCustomChannels(bot._client, account, modLog)
    bot.loadPlugin?.(pathfinder)
    installMovementPacketCompatibility(bot)
    installModernPlayerInputCompatibility(bot)

    const session = {
      bot,
      account: { ...account },
      moddedProfile: normalizeModdedProfile(account),
      antiAfkTimer: null,
      telemetryTimer: null,
      chestScanTimer: null,
      connectionTimer: null,
      reconnectResetTimer: null,
      networkRecoveryTimer: null,
      physicsRestoreTimer: null,
      manualControls: new Set(),
      manualControlTimers: new Map(),
      antiAfkActionTimers: new Set(),
      messageTimers: new Set(),
      automaticServerSwitches: new Set(),
      ready: false,
      switching: false,
      depositing: false,
      depositRevision: 0,
      activeDepositContainer: null,
      inventoryAction: false,
      inventoryQueue: Promise.resolve(),
      joinMessageSent: false,
      worldReadyAt: 0,
      nearestChest: null,
      fluidMotion: {
        status: account.environmentalMovement === false ? 'disabled' : 'checking',
        serverCorrections: 0,
        stalledCorrections: 0
      },
      pendingServerPosition: null,
      lastMovementDiagnosticAt: 0,
      identityKey: '',
      telemetryKey: '',
      resourcePack: null,
      worldBlockCache: null,
      versionReported: false,
      versionConfirmed: false
    }
    bot.__afkDeskEnchantmentsById = new Map()
    bot._client?.on?.('registry_data', (packet) => {
      if (String(packet?.id || '').replace(/^minecraft:/, '') !== 'enchantment' || !Array.isArray(packet?.entries)) return
      bot.__afkDeskEnchantmentsById = new Map(packet.entries.map((entry, id) => [id, String(entry?.key || '').replace(/^minecraft:/, '')]).filter(([, name]) => name))
      this.diagnose({ event: 'enchantment_registry', accountId: account.id, version: bot.version || account.version || 'auto', entries: [...bot.__afkDeskEnchantmentsById.entries()] })
    })
    bot.__afkDeskPacketDiagnostic = (entry) => this.diagnose({ ...entry, accountId: account.id, version: bot.version || account.version || 'auto' })
    bot._client?.on?.('packet', (_data, meta) => {
      if (CONFIGURATION_PACKET_NAMES.has(meta?.name)) {
        bot.__afkDeskPacketDiagnostic({ event: 'protocol_packet', direction: 'in', name: meta.name, at: Date.now() })
      }
    })
    bot.physicsEnabled = account.environmentalMovement !== false
    this.sessions.set(account.id, session)
    for (const event of ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload', 'respawn']) {
      bot.on(event, () => this.invalidateWorldSnapshot(account.id, session))
    }
    this.status(account.id, 'connecting', reconnecting ? `Reconnect attempt ${reconnectState.attempts}…` : `Connecting to ${account.host}…`)
    session.connectionTimer = this.scheduleNetworkTimer(() => {
      session.connectionTimer = null
      if (!this.sessions.has(account.id) || session.ready) return
      const seconds = boundedNumber(account.connectTimeoutSeconds, 5, 300, 60)
      session.lastNetworkReason = `ETIMEDOUT: The connection did not finish within ${seconds} seconds.`
      this.emit('log', account.id, { kind: 'error', message: `Network error (ETIMEDOUT): The connection did not finish within ${seconds} seconds. Auto-reconnect will retry.`, at: Date.now() })
      bot.end('connectTimeout')
    }, boundedNumber(account.connectTimeoutSeconds, 5, 300, 60) * 1000)

    bot._client?.on?.('start_configuration', () => {
      session.switching = true
      session.worldReadyAt = 0
      // A server transfer re-enters the configuration state without emitting a
      // new login packet. Mineflayer normally sends client settings on login,
      // so resend them here as vanilla does for the new configuration session.
      queueMicrotask(() => {
        if (this.sessions.get(account.id) !== session || !session.switching) return
        try { bot.setSettings?.({}) } catch {}
      })
      this.status(account.id, 'connected', 'Switching servers…')
    })

    const markReady = () => {
      if (!this.sessions.has(account.id)) return
      const completedSwitch = session.switching
      if (session.ready && !completedSwitch) return
      const firstReady = !session.ready
      session.ready = true
      session.switching = false
      if (session.connectionTimer) this.clearNetworkTimer(session.connectionTimer)
      session.connectionTimer = null
      if (session.reconnectResetTimer) this.clearNetworkTimer(session.reconnectResetTimer)
      session.reconnectResetTimer = this.scheduleNetworkTimer(() => {
        session.reconnectResetTimer = null
        if (this.sessions.get(account.id) === session && session.ready && !session.switching) {
          reconnectState.attempts = 0
          if (!session.versionConfirmed && bot.version) {
            session.versionConfirmed = true
            this.emit('version', account.id, { version: String(bot.version).slice(0, 32), automatic: !account.version, stable: true })
          }
        }
      }, boundedNumber(account.reconnectResetDelay, 5, 3600, 60) * 1000)
      this.status(account.id, 'online', `Online as ${bot.username}`)
      if (!session.versionReported && bot.version) {
        session.versionReported = true
        this.emit('version', account.id, { version: String(bot.version).slice(0, 32), automatic: !account.version, stable: false })
      }
      emitIdentity()
      emitTelemetry()
      if (!session.telemetryTimer) session.telemetryTimer = setInterval(emitTelemetry, 2000)
      if (!session.chestScanTimer) {
        void this.refreshChest(account.id)
        session.chestScanTimer = setInterval(() => { void this.refreshChest(account.id) }, CHEST_SCAN_INTERVAL)
      }
      if (firstReady && account.antiAfk !== false) this.enableAntiAfk(account.id, account)
      if (firstReady && account.joinMessage && !session.joinMessageSent) {
        session.joinMessageSent = true
        this.scheduleMessage(account.id, account.joinMessage, account.messageDelay)
      }
    }

    bot._client?.on?.('finish_configuration', () => {
      if (session.switching) this.status(account.id, 'connected', 'Joining world…')
    })

    // Mineflayer applies this packet before emitting forcedMove. Prepending lets
    // diagnostics retain the client position and velocity that caused a server
    // correction without recording credentials, chat, or inventory contents.
    bot._client?.prependListener?.('position', (packet) => {
      session.pendingServerPosition = {
        at: Date.now(),
        clientPosition: vectorSnapshot(bot.entity?.position),
        serverPosition: vectorSnapshot(packet),
        velocity: vectorSnapshot(bot.entity?.velocity),
        onGround: bot.entity?.onGround === true,
        collidedHorizontally: bot.entity?.isCollidedHorizontally === true,
        collidedVertically: bot.entity?.isCollidedVertically === true,
        flags: safeMovementFlags(packet?.flags),
        teleportId: Number.isFinite(Number(packet?.teleportId)) ? Number(packet.teleportId) : null,
        lastSent: bot.__afkDeskMovementTrace?.lastSent || null
      }
    })

    const emitIdentity = () => {
      const player = bot.player || bot.players?.[bot.username]
      const identity = {
        username: String(bot.username || bot._client?.username || '').slice(0, 16),
        uuid: String(bot.uuid || bot._client?.uuid || player?.uuid || '').replace(/-/g, '').toLowerCase(),
        skinUrl: normalizeSkinUrl(player?.skinData?.url)
      }
      const key = JSON.stringify(identity)
      if (!identity.username || key === session.identityKey) return
      session.identityKey = key
      this.emit('identity', account.id, identity)
    }

    const emitTelemetry = () => {
      if (!this.sessions.has(account.id)) return
      const snapshot = buildTelemetry(bot, session.nearestChest, session.account.environmentalMovement, session.fluidMotion, session.resourcePack)
      const { at: _at, ...stableSnapshot } = snapshot
      const key = JSON.stringify(stableSnapshot)
      if (key === session.telemetryKey) return
      session.telemetryKey = key
      this.emit('telemetry', account.id, snapshot)
    }

    bot.on('login', () => {
      if (session.switching) markReady()
      else if (!session.ready) this.status(account.id, 'connected', 'Authenticated. Joining world…')
      emitIdentity()
    })
    const markWorldReady = () => { session.worldReadyAt ||= Date.now() }
    bot.on('playerJoined', (player) => { if (player?.username === bot.username) { markWorldReady(); emitIdentity() } })
    bot.on('playerUpdated', (player) => { if (player?.username === bot.username) { markWorldReady(); emitIdentity() } })
    bot.on('health', () => { markWorldReady(); emitTelemetry() })
    bot.on('physicsTick', () => {
      if (session.account.environmentalMovement !== false) inspectFluidCurrent(bot, session.fluidMotion)
    })
    bot.inventory?.on?.('updateSlot', emitTelemetry)
    bot.on('windowOpen', (window) => {
      if (session.depositing) return
      const emitWindow = () => this.emit('window', account.id, buildWindowSnapshot(window, bot.registry, bot.__afkDeskEnchantmentsById, session.resourcePack))
      emitWindow()
      const snapshot = buildWindowSnapshot(window, bot.registry, bot.__afkDeskEnchantmentsById, session.resourcePack)
      this.diagnose({
        event: 'server_window_open',
        accountId: account.id,
        title: snapshot.title,
        size: snapshot.size,
        resourceArt: Boolean(snapshot.resourceTitle),
        resourceModels: snapshot.slots.filter((item) => item.resourceModel).slice(0, 54).map((item) => ({ slot: item.slot, model: item.resourceModel }))
      })
      window?.on?.('updateSlot', emitWindow)
    })
    bot.on('resourcePack', async (first, second) => {
      const pack = normalizePackEvent(first, second)
      if (!pack.url) {
        this.emit('log', account.id, { kind: 'error', message: 'The server offered a resource pack without a usable HTTP address.', at: Date.now() })
        rejectResourcePack(bot, first, second, pack.hash)
        return
      }
      const host = safeUrlHost(pack.url)
      this.emit('log', account.id, { kind: 'system', message: `Loading server resource pack from ${host}…`, at: Date.now() })
      try {
        session.resourcePack = await this.resourcePackLoader.load(pack.url, pack.hash)
        bot.acceptResourcePack?.()
        session.telemetryKey = ''
        emitTelemetry()
        if (bot.currentWindow && !session.depositing) this.emit('window', account.id, buildWindowSnapshot(bot.currentWindow, bot.registry, bot.__afkDeskEnchantmentsById, session.resourcePack))
        this.emit('log', account.id, { kind: 'system', message: 'Server resource pack loaded. Custom menu art is enabled.', at: Date.now() })
        this.diagnose({ event: 'resource_pack_loaded', accountId: account.id, source: session.resourcePack.source, sha1: session.resourcePack.sha1 })
      } catch (error) {
        rejectResourcePack(bot, first, second, pack.hash)
        this.emit('log', account.id, { kind: 'error', message: `Server resource pack failed: ${String(error?.message || error).slice(0, 180)}`, at: Date.now() })
        this.diagnose({ event: 'resource_pack_failed', accountId: account.id, host, message: String(error?.message || error).slice(0, 180) })
      }
    })
    bot.on('windowClose', () => {
      if (!session.depositing) this.emit('window', account.id, { open: false })
    })
    bot.on('spawn', markReady)
    bot.on('forcedMove', () => {
      const wasReady = session.ready
      markReady()
      if (wasReady && session.fluidMotion.status === 'flowing') {
        recordFluidCorrection(session.fluidMotion, session.pendingServerPosition?.serverPosition)
      }
      if (wasReady && session.account.environmentalMovement !== false) {
        this.emitMovementDiagnostic(account.id, session)
      }
    })
    bot.on('respawn', () => {
      session.worldReadyAt = 0
      markReady()
      if (account.serverChangeMessage) this.scheduleMessage(account.id, account.serverChangeMessage, account.messageDelay)
    })
    bot.on('messagestr', (message, _position, originalMessage) => {
      markWorldReady()
      markReady()
      const formatted = originalMessage?.toMotd?.() || message
      this.emit('log', account.id, { kind: 'chat', message, segments: parseInteractiveChat(originalMessage, message, formatted), at: Date.now() })
    })
    bot.on('kicked', (reason) => {
      session.lastKickReason = formatReason(reason)
      this.emit('log', account.id, { kind: 'error', message: `Kicked: ${session.lastKickReason}`, at: Date.now() })
    })
    bot.on('error', (error) => {
      const diagnostic = describeNetworkError(error)
      if (!diagnostic.retryable) {
        this.emit('log', account.id, { kind: 'error', message: String(error?.message || error).slice(0, 180), at: Date.now() })
        return
      }
      session.lastNetworkReason = `${diagnostic.code}: ${diagnostic.message}`
      const key = `${diagnostic.code}:${diagnostic.message}`
      const now = Date.now()
      if (key !== session.lastNetworkKey || now - (session.lastNetworkAt || 0) > 2000) {
        this.emit('log', account.id, { kind: 'error', message: `Network error (${diagnostic.code}): ${diagnostic.message} Auto-reconnect will retry.`, at: now })
        session.lastNetworkKey = key
        session.lastNetworkAt = now
      }
      if (account.autoReconnect !== false && !reconnectState.manual && !session.networkRecoveryTimer) {
        session.networkRecoveryTimer = this.scheduleNetworkTimer(() => {
          session.networkRecoveryTimer = null
          if (this.sessions.get(account.id) === session) bot.end('networkError')
        }, 1000)
      }
    })
    bot.on('end', (reason) => {
      if (this.sessions.get(account.id) !== session) return
      this.clearSession(account.id, session)
      if (account.autoReconnect !== false && !reconnectState.manual) {
        this.scheduleReconnect(account, session.lastKickReason || session.lastNetworkReason || reason)
      } else {
        this.reconnects.delete(account.id)
        this.status(account.id, 'offline', reason ? `Disconnected: ${reason}` : 'Disconnected')
      }
    })
  }

  disconnect(id) {
    const reconnectState = this.reconnects.get(id)
    if (reconnectState) {
      reconnectState.manual = true
      if (reconnectState.timer) this.clearReconnectTimer(reconnectState.timer)
      this.reconnects.delete(id)
    }
    const session = this.sessions.get(id)
    if (!session) {
      this.status(id, 'offline', 'Disconnected')
      return
    }
    // Detach before quit: its end event may be synchronous or arrive after a new connection.
    this.clearSession(id, session)
    try {
      session.bot.quit('Disconnected from AFK Desk')
    } finally {
      if (!this.sessions.has(id)) this.status(id, 'offline', 'Disconnected')
    }
  }

  scheduleReconnect(account, reason) {
    const state = this.reconnects.get(account.id) || { attempts: 0, timer: null, manual: false, account }
    state.attempts += 1
    const maximum = Math.max(0, Number(account.autoReconnectMaxAttempts) || 0)
    if (maximum > 0 && state.attempts > maximum) {
      this.reconnects.delete(account.id)
      this.status(account.id, 'offline', `Auto-reconnect stopped after ${maximum} attempts.`)
      return
    }
    const delay = reconnectDelaySeconds(account, reason, state.attempts)
    state.manual = false
    state.account = account
    this.status(account.id, 'reconnecting', `Disconnected${reason ? `: ${String(reason).slice(0, 90)}` : ''}. Retrying in ${delay}s…`)
    state.timer = this.scheduleReconnectTimer(() => {
      state.timer = null
      if (state.manual || this.sessions.has(account.id)) return
      try { this.connect(state.account, { reconnecting: true }) }
      catch (error) {
        this.emit('log', account.id, { kind: 'error', message: `Reconnect failed: ${error.message}`, at: Date.now() })
        this.scheduleReconnect(state.account, error.message)
      }
    }, delay * 1000)
    this.reconnects.set(account.id, state)
  }

  sendChat(id, message) {
    const bot = this.requireOnline(id)
    const trimmed = String(message || '').trim()
    if (!trimmed) return
    // minecraft-protocol's chat path adds the version-specific timestamp,
    // acknowledgement, session, and checksum fields required by modern
    // Velocity backends. A hand-written command-only packet is incomplete.
    bot.chat(trimmed)
    this.emit('log', id, { kind: 'sent', message: trimmed, at: Date.now() })
  }

  async completeChat(id, input) {
    const bot = this.requireOnline(id)
    const text = String(input || '').slice(0, 256)
    if (!text) return []
    if (!text.startsWith('/')) return playerNameSuggestions(bot, text)
    try {
      const matches = await bot.tabComplete(text, true, false, 2500)
      return normalizeChatSuggestions(matches, text)
    } catch {
      return playerNameSuggestions(bot, text)
    }
  }

  control(id, control, duration = 350) {
    const session = this.sessions.get(id)
    const holdFor = Math.max(100, Math.min(Number(duration) || 350, 3000))
    this.setControlState(id, control, true)
    const timer = this.scheduleAntiAfkTimer(() => {
      if (this.sessions.get(id) !== session || session.manualControlTimers.get(control) !== timer) return
      session.manualControlTimers.delete(control)
      this.setControlState(id, control, false)
    }, holdFor)
    session.manualControlTimers.set(control, timer)
  }

  setControlState(id, control, active) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
    if (!allowed.has(control)) throw new Error('Unknown movement control.')
    if (typeof active !== 'boolean') throw new Error('Movement state must be true or false.')

    const oldTimer = session.manualControlTimers.get(control)
    if (oldTimer) this.clearAntiAfkTimer(oldTimer)
    session.manualControlTimers.delete(control)
    if (active) {
      session.manualControls.add(control)
      if (session.physicsRestoreTimer) this.clearAntiAfkTimer(session.physicsRestoreTimer)
      session.physicsRestoreTimer = null
      session.bot.physicsEnabled = true
    } else {
      session.manualControls.delete(control)
      if (session.manualControls.size === 0) {
        this.temporarilyEnablePhysics(session, 200)
      }
    }
    bot.setControlState(control, active)
    this.diagnose({
      event: 'manual_control', accountId: id, control, active,
      position: vectorSnapshot(bot.entity?.position), velocity: vectorSnapshot(bot.entity?.velocity), at: Date.now()
    })
  }

  look(id, direction) {
    const bot = this.requireOnline(id)
    const delta = direction === 'left' ? -0.45 : 0.45
    bot.look(bot.entity.yaw + delta, bot.entity.pitch, true)
  }

  lookDelta(id, yawDelta = 0, pitchDelta = 0) {
    const bot = this.requireOnline(id)
    const yawChange = Math.max(-0.7, Math.min(0.7, Number(yawDelta) || 0))
    const pitchChange = Math.max(-0.5, Math.min(0.5, Number(pitchDelta) || 0))
    const yaw = bot.entity.yaw + yawChange
    const pitch = Math.max(-1.45, Math.min(1.45, bot.entity.pitch + pitchChange))
    return bot.look(yaw, pitch, true)
  }

  async dropStack(id, slot) {
    return this.withInventoryAction(id, async (bot, session) => {
      const safeSlot = playerInventorySlot(slot)
      if (lockedSlotSet(session.account).has(safeSlot)) throw new Error('That inventory stack is locked. Unlock it before dropping it.')
      const item = bot.inventory?.slots?.[safeSlot] || bot.inventory?.items?.().find((entry) => entry.slot === safeSlot)
      if (!item) throw new Error('That inventory stack is no longer available.')
      await bot.tossStack(item)
      this.emit('log', id, { kind: 'sent', message: `Dropped ${item.count} × ${item.displayName || item.name}`, at: Date.now() })
    })
  }

  async dropItems(id, slot, requestedCount = 1) {
    return this.withInventoryAction(id, async (bot, session) => {
      const safeSlot = playerInventorySlot(slot)
      if (lockedSlotSet(session.account).has(safeSlot)) throw new Error('That inventory stack is locked.')
      const item = bot.inventory?.slots?.[safeSlot]
      if (!item) throw new Error('That inventory stack is no longer available.')
      const count = Math.max(1, Math.min(Number(requestedCount) || 1, Number(item.count) || 1))
      if (typeof bot.transfer !== 'function') throw new Error('Exact-slot inventory transfer is unavailable.')
      await bot.transfer({ window: bot.inventory, itemType: item.type, metadata: item.metadata ?? null,
        nbt: item.nbt, count, sourceStart: safeSlot, sourceEnd: safeSlot + 1,
        destStart: -999, destEnd: -999 })
      this.emit('log', id, { kind: 'sent', message: `Dropped ${count} × ${item.displayName || item.name}`, at: Date.now() })
      return { slot: safeSlot, count }
    })
  }

  async depositSlot(id, slot, requestedCount = 64) {
    return this.withInventoryAction(id, async (bot, session) => {
      const safeSlot = playerInventorySlot(slot)
      if (lockedSlotSet(session.account).has(safeSlot)) throw new Error('That inventory stack is locked.')
      const item = bot.inventory?.slots?.[safeSlot]
      if (!item) throw new Error('That inventory stack is no longer available.')
      const block = findNearestChest(bot, session.account.autoDepositRange)
      if (!block) throw new Error('No visible chest or barrel is in range.')
      const count = Math.max(1, Math.min(Number(requestedCount) || item.count, Number(item.count) || 1))
      const container = await (bot.openContainer || bot.openChest).call(bot, block)
      let transferred
      try {
        if (lockedSlotSet(session.account).has(safeSlot)) throw new Error('That inventory stack is locked.')
        transferred = await transferPlayerSlot(bot, container, safeSlot, count)
      }
      finally { try { container.close() } catch {} }
      const location = chestLocation(bot, block)
      this.emit('log', id, { kind: 'sent', message: `Deposited ${transferred} × ${item.displayName || item.name} at ${location.x}, ${location.y}, ${location.z}.`, at: Date.now() })
      return { slot: safeSlot, count: transferred, location }
    })
  }

  async moveInventorySlot(id, sourceSlot, destinationSlot) {
    return this.withInventoryAction(id, async (bot) => {
      const source = playerInventorySlot(sourceSlot)
      const destination = playerInventorySlot(destinationSlot)
      if (source === destination) throw new Error('Choose a different destination slot.')
      if (!bot.inventory?.slots?.[source]) throw new Error('The source inventory slot is empty.')
      await bot.moveSlotItem(source, destination)
      return { sourceSlot: source, targetSlot: destination }
    })
  }

  async equipInventoryItem(id, slot, requestedDestination) {
    return this.withInventoryAction(id, async (bot) => {
      const sourceSlot = playerInventorySlot(slot)
      const item = bot.inventory?.slots?.[sourceSlot]
      if (!item) throw new Error('That inventory stack is no longer available.')
      const destination = resolveEquipmentDestination(item, requestedDestination)
      if (destination === 'hand' && sourceSlot >= 36 && sourceSlot <= 44) bot.setQuickBarSlot(sourceSlot - 36)
      else await bot.equip(item, destination)
      const targetSlot = destination === 'hand'
        ? 36 + Math.max(0, Math.min(Number(bot.quickBarSlot) || 0, 8))
        : EQUIPMENT_DESTINATION_SLOTS.get(destination)
      return { sourceSlot, targetSlot, destination }
    })
  }

  async withInventoryAction(id, action) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    if (bot.currentWindow) throw new Error('Close the server menu before managing player inventory.')
    const execute = async () => {
      if (!this.sessions.has(id)) throw new Error('This account is no longer online.')
      while (session.depositing) await delay(50)
      session.inventoryAction = true
      try { return await action(bot, session) }
      finally { session.inventoryAction = false; this.emitTelemetry(id) }
    }
    const queued = session.inventoryQueue.then(execute, execute)
    session.inventoryQueue = queued.catch(() => {})
    return queued
  }

  worldSnapshot(id, radius = 6, blockRefreshMs = 1000) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    const center = bot.entity?.position
    if (!center) throw new Error('World position is not available yet.')
    const safeRadius = Math.max(2, Math.min(Math.round(Number(radius) || 6), 12))
    const anchor = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
    const cached = session?.worldBlockCache
    const cacheLifetime = Math.max(100, Math.min(Number(blockRefreshMs) || 1000, 10000))
    let blocks = cached && cached.radius === safeRadius && cached.x === anchor.x && cached.y === anchor.y && cached.z === anchor.z && Date.now() - cached.at < cacheLifetime ? cached.blocks : null
    if (!blocks) {
      blocks = []
      for (let y = -4; y <= 4; y += 1) {
        for (let x = -safeRadius; x <= safeRadius; x += 1) {
          for (let z = -safeRadius; z <= safeRadius; z += 1) {
            const block = bot.blockAt?.(new Vec3(anchor.x + x, anchor.y + y, anchor.z + z), false)
            if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue
            blocks.push({ x: block.position.x, y: block.position.y, z: block.position.z, name: String(block.name).slice(0, 80), solid: block.boundingBox === 'block', water: WATER_NAMES.has(block.name) || WATERLIKE_NAMES.has(block.name), shapes: boundedBlockShapes(block), stateId: Number.isSafeInteger(block.stateId) ? block.stateId : null })
          }
        }
      }
      // The radius/height loops already cap the volume at 5,625 cells. Slicing
      // by scan order erased the upper/eastern half of dense nearby worlds.
      if (session) {
        session.worldBlockRevision = ++this.nextWorldBlockRevision
        session.worldBlockCache = { ...anchor, radius: safeRadius, blocks, at: Date.now() }
      }
    }
    const entities = Object.values(bot.entities || {}).filter((entity) => entity?.position && entity !== bot.entity && entity.position.distanceTo(center) <= safeRadius * 2).slice(0, 100).map((entity) => ({
      id: Number(entity.id), name: String(entity.username || entity.displayName || entity.name || entity.type || 'entity').slice(0, 80), type: String(entity.type || ''),
      x: roundDiagnostic(entity.position.x), y: roundDiagnostic(entity.position.y), z: roundDiagnostic(entity.position.z), distance: roundDiagnostic(entity.position.distanceTo(center))
    }))
    return { edition: 'java', radius: safeRadius, position: vectorSnapshot(center), yaw: Number(bot.entity.yaw) || 0, pitch: Number(bot.entity.pitch) || 0, blocks, entities,
      blockRevision: session.worldBlockRevision || 0,
      quickBarSlot: Math.max(0, Math.min(Number(bot.quickBarSlot) || 0, 8)),
      heldItem: bot.heldItem ? { name: String(bot.heldItem.name || '').slice(0, 80), displayName: String(bot.heldItem.displayName || bot.heldItem.name || '').slice(0, 100), count: Math.max(0, Math.min(Number(bot.heldItem.count) || 0, 999)) } : null,
      at: Date.now() }
  }

  async worldAction(id, action, target = {}) {
    const bot = this.requireOnline(id)
    const session = this.sessions.get(id)
    if (action === 'stop-dig') {
      if (session.worldDigging) session.worldDigging.cancelled = true
      bot.stopDigging?.()
      session.worldDigging = null
      return { stopped: true }
    }
    if (action === 'stop-use') {
      bot.deactivateItem?.()
      return { stopped: true }
    }
    if (action === 'select-hotbar') {
      const slot = target?.slot
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('Hotbar slot must be an integer from 0 to 8.')
      if (session.worldDigging) {
        session.worldDigging.cancelled = true
        bot.stopDigging?.()
        session.worldDigging = null
      }
      bot.setQuickBarSlot(slot)
      this.emitTelemetry(id)
      return { slot }
    }
    if (bot.currentWindow) throw new Error('Close the server menu before interacting with the world.')
    if (action === 'dig-crosshair') return this.digWorldBlock(id, session, crosshairBlock(bot))
    if (action === 'use-crosshair') {
      if (session.worldUsing) throw new Error('A world interaction is already running.')
      const block = crosshairBlock(bot, false)
      if (!block) { bot.activateItem(); return { used: true } }
      const face = blockFaceVector(block.face)
      session.worldUsing = true
      try {
        const heldName = bot.heldItem?.name
        const heldBlock = heldName && bot.registry?.blocksByName?.[heldName]
        if (heldBlock && (!isInteractiveBlock(block.name) || bot.controlState?.sneak)) {
          await bot.placeBlock(block, face)
          return { placed: true, position: block.position.plus(face), block: heldName }
        }
        await bot.activateBlock(block, face)
        return { used: true, position: block.position, block: block.name }
      } finally {
        session.worldUsing = false
        this.invalidateWorldSnapshot(id, session)
      }
    }
    if (action === 'attack-nearest') {
      const entity = Object.values(bot.entities || {}).filter((entry) => entry?.position && entry !== bot.entity).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!entity || entity.position.distanceTo(bot.entity.position) > 3.5) throw new Error('No nearby entity is in attack range.')
      const aim = entity.position.offset(0, Number(entity.height || 1) / 2, 0)
      const eye = worldEye(bot)
      if (!bot.world?.raycast) throw new Error('World raycasting is not available yet.')
      const obstacle = bot.world.raycast(eye, aim.minus(eye).normalize(), eye.distanceTo(aim))
      if (obstacle) throw new Error('The nearby entity is not visible.')
      await bot.lookAt(aim, true)
      if (this.sessions.get(id) !== session) throw new Error('This account is no longer online.')
      bot.attack(entity)
      return { entityId: entity.id }
    }
    if (action === 'use-held') { bot.activateItem(); return { used: true } }
    const point = new Vec3(Math.floor(Number(target.x)), Math.floor(Number(target.y)), Math.floor(Number(target.z)))
    if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Enter valid target coordinates.')
    const block = bot.blockAt(point, false)
    if (action === 'look-at') { await bot.lookAt(point.offset(0.5, 0.5, 0.5), true); return { position: point } }
    if (action === 'activate-block') { validateVisibleBlock(bot, block); await bot.activateBlock(block); this.invalidateWorldSnapshot(id, session); return { position: point, block: block.name } }
    if (action === 'dig-block') { validateVisibleBlock(bot, block); return this.digWorldBlock(id, session, block, true) }
    if (action === 'walk-to') {
      if (!bot.pathfinder) throw new Error('Pathfinder is not loaded.')
      bot.pathfinder.setMovements(new Movements(bot))
      await bot.pathfinder.goto(new goals.GoalNear(point.x, point.y, point.z, Math.max(0, Math.min(Number(target.range) || 1, 8))))
      return { position: point }
    }
    throw new Error('Unknown world action.')
  }

  async digWorldBlock(id, session, block, turnToTarget = false) {
    if (session.worldDigging) throw new Error('Digging is already running.')
    if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) throw new Error('No visible block is in reach.')
    const operation = { cancelled: false }
    session.worldDigging = operation
    try {
      if (turnToTarget) {
        await session.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
        if (operation.cancelled || this.sessions.get(id) !== session) return { cancelled: true }
        validateVisibleBlock(session.bot, block)
      }
      // Keep the validated crosshair direction. Mineflayer's ignore mode also
      // installs cancellation synchronously instead of awaiting a look turn.
      await session.bot.dig(block, 'ignore')
      return operation.cancelled ? { cancelled: true } : { position: block.position, block: block.name }
    } catch (error) {
      if (operation.cancelled) return { cancelled: true }
      throw error
    } finally {
      if (session.worldDigging === operation) session.worldDigging = null
      this.invalidateWorldSnapshot(id, session)
    }
  }

  invalidateWorldSnapshot(id, session) {
    if (this.sessions.get(id) !== session) return
    session.worldBlockCache = null
    session.worldBlockRevision = ++this.nextWorldBlockRevision
  }

  setItemLocks(id, slots) {
    const session = this.sessions.get(id)
    if (!session) return
    session.account.lockedInventorySlots = normalizeLockedSlots(slots)
    this.emitTelemetry(id)
  }

  async clickWindowSlot(id, slot) {
    const bot = this.requireOnline(id)
    const window = bot.currentWindow
    if (!window) throw new Error('The server menu is no longer open.')
    const requestedSlot = Number(slot)
    if (!Number.isInteger(requestedSlot) || requestedSlot < 0 || requestedSlot > 255) throw new Error('Invalid server-menu slot.')
    const safeSlot = requestedSlot
    const inventoryStart = Math.max(0, Number(window.inventoryStart) || window.slots?.length || 0)
    if (safeSlot >= inventoryStart) throw new Error('Only server-menu slots can be clicked here.')
    await bot.clickWindow(safeSlot, 0, 0)
  }

  closeWindow(id) {
    const bot = this.requireOnline(id)
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  }

  setAutoDeposit(id, enabled, range) {
    const session = this.sessions.get(id)
    if (!session) return
    const nextEnabled = enabled === true
    const nextRange = normalizeAutoDepositRange(range ?? session.account.autoDepositRange)
    const changed = session.account.autoDepositToChest !== nextEnabled || session.account.autoDepositRange !== nextRange
    session.account.autoDepositToChest = nextEnabled
    session.account.autoDepositRange = nextRange
    if (changed) session.depositRevision += 1
    if (!nextEnabled) {
      try { session.activeDepositContainer?.close() } catch {}
      session.activeDepositContainer = null
      this.emitTelemetry(id)
      if (!session.depositing) void this.refreshChest(id)
      return
    }
    if (!session.depositing) void this.refreshChest(id)
  }

  async refreshChest(id) {
    const session = this.sessions.get(id)
    if (!session?.bot?.entity || session.depositing || session.inventoryAction || session.bot.currentWindow) return
    const block = findNearestChest(session.bot, session.account.autoDepositRange)
    session.nearestChest = block ? chestLocation(session.bot, block) : null
    this.emitTelemetry(id)
    if (!session.account.autoDepositToChest || !block) return
    const lockedSlots = lockedSlotSet(session.account)
    const items = (session.bot.inventory?.items?.() || []).filter((item) => !lockedSlots.has(Number(item.slot)))
    if (!items.length) return
    session.depositing = true
    const depositRevision = session.depositRevision
    let chest
    let deposited = 0
    try {
      chest = await (session.bot.openContainer || session.bot.openChest).call(session.bot, block)
      session.activeDepositContainer = chest
      for (const item of items) {
        if (!isDepositActive(session, depositRevision)) break
        const slot = Number(item.slot)
        if (lockedSlotSet(session.account).has(slot)) continue
        const current = session.bot.inventory?.slots?.[slot]
        if (!current) continue
        deposited += await transferPlayerSlot(session.bot, chest, slot, current.count)
      }
      if (deposited > 0) {
        const { x, y, z } = chestLocation(session.bot, block)
        this.emit('log', id, { kind: 'sent', message: `Deposited ${deposited} items into ${containerLabel(block)} at ${x}, ${y}, ${z}.`, at: Date.now() })
      }
    } catch (error) {
      if (isDepositActive(session, depositRevision)) {
        this.emit('log', id, { kind: 'error', message: `Auto-deposit failed: ${String(error?.message || error).slice(0, 160)}`, at: Date.now() })
      }
    } finally {
      if (session.activeDepositContainer === chest) session.activeDepositContainer = null
      try { chest?.close() } catch {}
      session.depositing = false
      this.emitTelemetry(id)
      if (session.depositRevision !== depositRevision) void this.refreshChest(id)
    }
  }

  emitTelemetry(id) {
    const session = this.sessions.get(id)
    if (!session) return
    const snapshot = buildTelemetry(session.bot, session.nearestChest, session.account.environmentalMovement, session.fluidMotion)
    const { at: _at, ...stableSnapshot } = snapshot
    const key = JSON.stringify(stableSnapshot)
    if (key === session.telemetryKey) return
    session.telemetryKey = key
    this.emit('telemetry', id, snapshot)
  }

  scheduleMessage(id, message, delaySeconds = 2) {
    const session = this.sessions.get(id)
    if (!session) return
    const automaticSwitch = automaticServerSwitchKey(message)
    if (automaticSwitch && session.automaticServerSwitches.has(automaticSwitch)) return
    if (automaticSwitch) session.automaticServerSwitches.add(automaticSwitch)
    const delay = Math.max(0, Math.min(Number(delaySeconds) || 0, 30)) * 1000
    const startedAt = Date.now()
    const schedule = (callback, wait) => {
      const timer = setTimeout(() => {
        session.messageTimers.delete(timer)
        callback()
      }, wait)
      session.messageTimers.add(timer)
    }
    const send = () => {
      if (!this.sessions.has(id)) return
      if (automaticSwitch && !session.worldReadyAt && Date.now() - startedAt < 20_000) {
        schedule(send, 500)
        return
      }
      if (automaticSwitch) {
        const now = Date.now()
        const readyAt = session.worldReadyAt || startedAt + 20_000
        const readyDelayEndsAt = readyAt + delay
        if (readyDelayEndsAt > now) {
          schedule(send, readyDelayEndsAt - now)
          return
        }
        const sendAt = Math.max(now, this.nextAutomaticServerSwitchAt)
        this.nextAutomaticServerSwitchAt = sendAt + 3000
        if (sendAt > now) {
          schedule(sendNow, sendAt - now)
          return
        }
      }
      sendNow()
    }
    const sendNow = () => {
      if (!this.sessions.has(id)) return
      try { this.sendChat(id, String(message).slice(0, 256)) }
      catch (error) { this.emit('log', id, { kind: 'error', message: `Automatic message failed: ${error.message}`, at: Date.now() }) }
    }
    schedule(send, delay)
  }

  enableAntiAfk(id, input = {}) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.antiAfkTimer) this.clearAntiAfkTimer(session.antiAfkTimer)
    for (const timer of session.antiAfkActionTimers) this.clearAntiAfkTimer(timer)
    session.antiAfkActionTimers.clear()
    session.antiAfkSettings = normalizeAntiAfkSettings(input)
    this.scheduleAntiAfk(id)
  }

  emitMovementDiagnostic(accountId, session) {
    const pending = session.pendingServerPosition
    session.pendingServerPosition = null
    if (!pending) return
    const now = Date.now()
    if (now - session.lastMovementDiagnosticAt < 250) return
    session.lastMovementDiagnosticAt = now
    const appliedPosition = vectorSnapshot(session.bot?.entity?.position)
    const clientPosition = pending.clientPosition
    const delta = clientPosition && appliedPosition ? vectorDelta(appliedPosition, clientPosition) : null
    const entry = {
      event: 'movement_correction',
      at: now,
      accountId: String(accountId || '').slice(0, 80),
      version: String(session.bot?.version || session.account?.version || 'auto').slice(0, 32),
      clientPosition,
      serverPosition: pending.serverPosition,
      appliedPosition,
      delta,
      velocity: pending.velocity,
      serverFlags: pending.flags,
      teleportId: pending.teleportId,
      lastSent: pending.lastSent,
      preCorrection: {
        onGround: pending.onGround,
        collidedHorizontally: pending.collidedHorizontally,
        collidedVertically: pending.collidedVertically
      },
      onGround: session.bot?.entity?.onGround === true,
      collidedHorizontally: session.bot?.entity?.isCollidedHorizontally === true,
      isInWater: session.bot?.entity?.isInWater === true,
      flow: Number.isFinite(session.fluidMotion?.currentX) && Number.isFinite(session.fluidMotion?.currentZ)
        ? { x: roundDiagnostic(session.fluidMotion.currentX), z: roundDiagnostic(session.fluidMotion.currentZ) }
        : null,
      headSubmerged: session.fluidMotion?.headSubmerged === true,
      correctionCount: Math.max(0, Number(session.fluidMotion?.serverCorrections) || 0)
    }
    entry.recentMovementPackets = (session.bot?.__afkDeskMovementTrace?.recent || []).slice(-20)
    const movementBlockCaptureKey = clientPosition
      ? `${Math.floor(clientPosition.x)},${Math.floor(clientPosition.y)},${Math.floor(clientPosition.z)}`
      : ''
    if (movementBlockCaptureKey && movementBlockCaptureKey !== session.movementBlockCaptureKey && entry.flow) {
      entry.nearbyBlocks = snapshotNearbyBlocks(session.bot, clientPosition)
      entry.nearbyEntities = snapshotNearbyEntities(session.bot, clientPosition)
      session.movementBlockCaptureKey = movementBlockCaptureKey
    }
    try {
      this.diagnose(entry)
    } catch {}
  }

  scheduleAntiAfk(id) {
    const session = this.sessions.get(id)
    if (!session) return
    const settings = session.antiAfkSettings
    const seconds = settings.minDelay + this.random() * (settings.maxDelay - settings.minDelay)
    session.antiAfkTimer = this.scheduleAntiAfkTimer(() => {
      session.antiAfkTimer = null
      if (!this.sessions.has(id)) return
      this.runAntiAfkCycle(id)
      this.scheduleAntiAfk(id)
    }, Math.round(seconds * 1000))
  }

  runAntiAfkCycle(id) {
    const session = this.sessions.get(id)
    if (!session?.bot?.entity) return
    const { bot } = session
    const settings = session.antiAfkSettings
    const duration = Math.round(settings.duration * 1000)
    const actions = [
      settings.jump && 'jump',
      settings.look && 'look',
      settings.sneak && 'sneak',
      settings.swing && 'swing',
      settings.walk && 'walk'
    ].filter(Boolean)
    if (!actions.length) return
    const action = actions[Math.min(actions.length - 1, Math.floor(this.random() * actions.length))]
    if (['jump', 'sneak', 'walk'].includes(action)) this.temporarilyEnablePhysics(session, duration + 200)
    if (action === 'jump' || action === 'sneak') this.holdAntiAfkControl(session, action, duration)
    if (action === 'swing') {
      try { bot.swingArm('right') } catch {}
    }
    if (action === 'look') {
      const direction = this.random() < 0.5 ? -1 : 1
      const radians = settings.lookDegrees * Math.PI / 180
      bot.look(bot.entity.yaw + direction * radians, bot.entity.pitch, true).catch(() => {})
    }
    if (action === 'walk') {
      const control = session.antiAfkWalkForward === false ? 'back' : 'forward'
      session.antiAfkWalkForward = !session.antiAfkWalkForward
      this.walkAntiAfkDistance(session, control, settings.walkDistance, duration)
    }
  }

  holdAntiAfkControl(session, control, duration) {
    session.bot.setControlState(control, true)
    const timer = this.scheduleAntiAfkTimer(() => {
      session.antiAfkActionTimers.delete(timer)
      if (this.sessions.get(session.account.id) === session) session.bot.setControlState(control, false)
    }, duration)
    session.antiAfkActionTimers.add(timer)
  }

  walkAntiAfkDistance(session, control, distance, duration) {
    const start = { x: Number(session.bot.entity.position.x), z: Number(session.bot.entity.position.z) }
    session.bot.setControlState(control, true)
    const startedAt = Date.now()
    const check = () => {
      if (this.sessions.get(session.account.id) !== session) return
      const position = session.bot.entity?.position
      const moved = position ? Math.hypot(Number(position.x) - Number(start.x), Number(position.z) - Number(start.z)) : 0
      if (moved >= distance || Date.now() - startedAt >= duration) {
        session.bot.setControlState(control, false)
        return
      }
      const timer = this.scheduleAntiAfkTimer(() => {
        session.antiAfkActionTimers.delete(timer)
        check()
      }, 50)
      session.antiAfkActionTimers.add(timer)
    }
    check()
  }

  temporarilyEnablePhysics(session, duration) {
    if (!session || session.account.environmentalMovement !== false) return
    if (session.physicsRestoreTimer) this.clearAntiAfkTimer(session.physicsRestoreTimer)
    session.bot.physicsEnabled = true
    session.physicsRestoreTimer = this.scheduleAntiAfkTimer(() => {
      session.physicsRestoreTimer = null
      if (this.sessions.get(session.account.id) === session && session.account.environmentalMovement === false) session.bot.physicsEnabled = false
    }, duration)
  }

  setEnvironmentalMovement(id, enabled) {
    const session = this.sessions.get(id)
    if (!session) return
    session.account.environmentalMovement = enabled !== false
    if (session.physicsRestoreTimer) this.clearAntiAfkTimer(session.physicsRestoreTimer)
    session.physicsRestoreTimer = null
    session.bot.physicsEnabled = enabled !== false
    resetFluidMotion(session.fluidMotion, enabled === false ? 'disabled' : 'checking')
    this.emitTelemetry(id)
  }

  setAntiAfk(id, account) {
    const session = this.sessions.get(id)
    if (!session) return
    Object.assign(session.account, account)
    if (session.antiAfkTimer) this.clearAntiAfkTimer(session.antiAfkTimer)
    for (const timer of session.antiAfkActionTimers) this.clearAntiAfkTimer(timer)
    session.antiAfkActionTimers.clear()
    session.bot.setControlState('jump', false)
    session.bot.setControlState('sneak', false)
    session.bot.setControlState('forward', false)
    session.bot.setControlState('back', false)
    session.antiAfkTimer = null
    if (account.antiAfk !== false && session.bot.entity) this.enableAntiAfk(id, account)
  }

  clearSession(id, expectedSession) {
    const session = this.sessions.get(id)
    if (expectedSession && session !== expectedSession) return
    this.sessions.delete(id)
    if (session) this.clearTimers(session)
  }

  clearTimers(session) {
    if (session.worldDigging) session.worldDigging.cancelled = true
    try { session.bot.stopDigging?.() } catch {}
    try { if (session.bot.usingHeldItem) session.bot.deactivateItem?.() } catch {}
    session.worldDigging = null
    session.depositRevision += 1
    try { session.activeDepositContainer?.close() } catch {}
    session.activeDepositContainer = null
    for (const timer of session.manualControlTimers || []) this.clearAntiAfkTimer(timer[1])
    session.manualControlTimers?.clear()
    session.manualControls?.clear()
    if (session.antiAfkTimer) this.clearAntiAfkTimer(session.antiAfkTimer)
    if (session.telemetryTimer) clearInterval(session.telemetryTimer)
    if (session.chestScanTimer) clearInterval(session.chestScanTimer)
    if (session.connectionTimer) this.clearNetworkTimer(session.connectionTimer)
    if (session.reconnectResetTimer) this.clearNetworkTimer(session.reconnectResetTimer)
    if (session.networkRecoveryTimer) this.clearNetworkTimer(session.networkRecoveryTimer)
    if (session.physicsRestoreTimer) this.clearAntiAfkTimer(session.physicsRestoreTimer)
    for (const timer of session.antiAfkActionTimers || []) this.clearAntiAfkTimer(timer)
    session.antiAfkActionTimers?.clear()
    for (const timer of session.messageTimers || []) clearTimeout(timer)
    session.messageTimers?.clear()
    session.antiAfkTimer = null
    session.telemetryTimer = null
    session.chestScanTimer = null
    session.connectionTimer = null
    session.reconnectResetTimer = null
    session.networkRecoveryTimer = null
    session.physicsRestoreTimer = null
  }

  requireOnline(id) {
    const session = this.sessions.get(id)
    if (!session?.bot?.entity) throw new Error('Account is not online yet.')
    return session.bot
  }

  status(id, status, detail) {
    this.emit('status', id, { status, detail, at: Date.now() })
  }
}

function worldEye(bot) {
  const height = Number(bot.entity.eyeHeight) || 1.62
  return bot.entity.position.offset(0, Math.max(0.1, Math.min(height, 2)), 0)
}

function crosshairBlock(bot, required = true) {
  if (!bot.world?.raycast) throw new Error('World raycasting is not available yet.')
  const yaw = Number(bot.entity.yaw) || 0
  const pitch = Number(bot.entity.pitch) || 0
  const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const block = bot.world.raycast(worldEye(bot), direction, 5)
  if (block && (!block.intersect || worldEye(bot).distanceTo(block.intersect) > 5.001)) throw new Error('Target is outside interaction range.')
  if (!block && required) throw new Error('No visible block is in reach.')
  return block
}

function validateVisibleBlock(bot, block) {
  if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) throw new Error('Target block is empty or unloaded.')
  const eye = worldEye(bot)
  const center = block.position.offset(0.5, 0.5, 0.5)
  if (eye.distanceTo(center) > 5) throw new Error('Target is outside interaction range.')
  const hit = bot.world?.raycast?.(eye, center.minus(eye).normalize(), 5)
  if (!hit || !hit.position.equals(block.position)) throw new Error('Target block is not visible.')
}

function blockFaceVector(face) {
  const values = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
  if (!Number.isInteger(face) || !values[face]) throw new Error('The target block face is not available.')
  return new Vec3(...values[face])
}

function isInteractiveBlock(name) {
  return /(?:chest|barrel|furnace|hopper|dispenser|dropper|crafting_table|anvil|enchanting_table|lectern|stonecutter|grindstone|loom|smithing_table|beacon|brewing_stand|lever|note_block|bell|(?:^|_)(?:door|trapdoor|button|bed|fence_gate))$/.test(String(name))
}

function boundedBlockShapes(block) {
  const shapes = Array.isArray(block.shapes) ? block.shapes : (block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
  return shapes.slice(0, 8).filter(shape => Array.isArray(shape) && shape.length === 6 && shape.every(Number.isFinite))
    .map(shape => shape.map(value => Math.max(0, Math.min(value, 1))))
    .filter(shape => shape[3] > shape[0] && shape[4] > shape[1] && shape[5] > shape[2])
}

function normalizeLoginCode(code) {
  if (typeof code === 'string') return { code }
  return {
    code: code?.user_code || code?.userCode || code?.code || '',
    verificationUri: code?.verification_uri || code?.verificationUri || code?.verification_uri_complete || 'https://microsoft.com/link',
    expiresIn: code?.expires_in || code?.expiresIn
  }
}

function describeNetworkError(error) {
  const raw = String(error?.message || error || '')
  const detected = raw.match(/\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/i)?.[1]
  let code = String(error?.code || detected || '').toUpperCase()
  if (!code && /timed out|timeout/i.test(raw)) code = 'ETIMEDOUT'
  const messages = {
    EAI_AGAIN: 'DNS lookup temporarily failed. Check the network connection or DNS service.',
    ENOTFOUND: 'Could not resolve the server address. Check DNS and the server name.',
    ECONNREFUSED: 'The server refused the connection. It may be offline or the port may be incorrect.',
    ECONNRESET: 'Connection was reset by the server or network.',
    ETIMEDOUT: 'The server stopped responding before the connection completed.',
    EHOSTUNREACH: 'The server host is unreachable from this network.',
    ENETUNREACH: 'The network is unreachable. Check the active internet connection.',
    EPIPE: 'The connection closed while AFK Desk was sending data.'
  }

  if (!messages[code] && /socket hang up/i.test(raw)) code = 'ECONNRESET'
  return {
    code: code || 'UNKNOWN',
    message: messages[code] || raw.slice(0, 180) || 'Unknown connection error.',
    retryable: Boolean(messages[code])
  }
}

function reconnectDelaySeconds(account, reason, attempts) {
  const base = boundedNumber(account?.autoReconnectDelay, 1, 3600, 5)
  const multiplier = boundedNumber(account?.autoReconnectBackoffMultiplier, 1, 10, 2)
  const maximum = Math.max(base, boundedNumber(account?.autoReconnectMaxDelay, 1, 86400, 300))
  const exponential = Math.min(base * (multiplier ** Math.min(Math.max(0, Number(attempts) - 1), 12)), maximum)
  const text = String(reason || '')
  const rateLimitMinimum = boundedNumber(account?.autoReconnectRateLimitDelay, 1, 86400, 30)
  const result = /logging in too fast|too many connection attempts|rate.?limit/i.test(text) ? Math.max(exponential, rateLimitMinimum) : exponential
  return Math.max(1, Math.round(result * 10) / 10)
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.min(number, maximum)) : fallback
}

function formatReason(reason) {
  const extracted = extractText(reason)
  if (extracted) return extracted
  try { return JSON.stringify(reason) } catch { return String(reason) }
}

function extractText(value) {
  if (typeof value === 'string') {
    try { return extractText(JSON.parse(value)) || value } catch { return value }
  }
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'string' && typeof value.value === 'string') return value.value
  const source = value.type === 'compound' && value.value ? value.value : value
  const text = extractText(source.text)
  const extrasValue = source.extra?.value?.value || source.extra?.value || source.extra
  const extras = Array.isArray(extrasValue) ? extrasValue.map(extractText).join('') : ''
  return `${text}${extras}`.trim()
}

const CHAT_COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff'
}

function parseMinecraftFormatting(input) {
  const source = String(input || '').slice(0, 8192)
  const segments = []
  let style = {}
  let text = ''
  const flush = () => {
    if (!text) return
    segments.push({ text, ...style })
    text = ''
  }
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '§' || index + 1 >= source.length) {
      text += source[index]
      continue
    }
    const code = source[index + 1].toLowerCase()
    if (code === '#' && /^[0-9a-f]{6}$/i.test(source.slice(index + 2, index + 8))) {
      flush()
      style = { color: `#${source.slice(index + 2, index + 8).toLowerCase()}` }
      index += 7
      continue
    }
    if (CHAT_COLORS[code]) {
      flush()
      style = { color: CHAT_COLORS[code] }
      index += 1
      continue
    }
    if (code === 'r') {
      flush()
      style = {}
      index += 1
      continue
    }
    const formats = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough' }
    if (formats[code]) {
      flush()
      style = { ...style, [formats[code]]: true }
      index += 1
      continue
    }
    if (code === 'k') {
      index += 1
      continue
    }
    text += source[index]
  }
  flush()
  return segments.slice(0, 256)
}

const CHAT_NAMED_COLORS = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa', dark_red: '#aa0000',
  dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff', green: '#55ff55',
  aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff'
}
const CHAT_CLICK_ACTIONS = new Set(['open_url', 'run_command', 'suggest_command', 'copy_to_clipboard'])
const CHAT_URL = /https?:\/\/[^\s<>"']+/gi

function parseInteractiveChat(originalMessage, fallbackMessage = '', formattedMessage = '') {
  const source = originalMessage?.json || originalMessage
  const segments = []
  if (source && typeof source === 'object') appendInteractiveComponent(segments, source, {})
  const visible = segments.map((segment) => segment.text).join('')
  if (!segments.length || (fallbackMessage && visible !== String(fallbackMessage))) {
    const formatted = parseMinecraftFormatting(formattedMessage)
    return linkifyChatSegments(formatted.length ? formatted : [{ text: String(fallbackMessage || '').slice(0, 8192) }])
  }
  return linkifyChatSegments(segments).slice(0, 256)
}

function appendInteractiveComponent(segments, component, inherited) {
  if (typeof component === 'string') {
    if (component) segments.push({ text: component, ...inherited })
    return
  }
  if (!component || typeof component !== 'object' || segments.length >= 256) return
  const source = component.json && typeof component.json === 'object' ? component.json : component
  const colorName = String(component.color ?? source.color ?? '')
  const color = /^#[0-9a-f]{6}$/i.test(colorName) ? colorName.toLowerCase() : CHAT_NAMED_COLORS[colorName]
  const style = {
    ...inherited,
    ...(color ? { color } : {}),
    ...booleanChatStyle('bold', component, source),
    ...booleanChatStyle('italic', component, source),
    ...booleanChatStyle('underlined', component, source),
    ...booleanChatStyle('strikethrough', component, source)
  }
  const click = normalizeChatClick(component.clickEvent || component.click_event || source.clickEvent || source.click_event)
  const hover = normalizeChatHover(component.hoverEvent || component.hover_event || source.hoverEvent || source.hover_event)
  const actionStyle = { ...style, ...(click ? { click } : {}), ...(hover ? { hover } : {}) }
  const text = component.text ?? source.text
  if (typeof text === 'string' && text) segments.push({ text: text.slice(0, 8192), ...actionStyle })
  const children = component.extra || source.extra || component.with || source.with
  if (Array.isArray(children)) for (const child of children) appendInteractiveComponent(segments, child, actionStyle)
}

function booleanChatStyle(name, component, source) {
  const value = component[name] ?? source[name]
  return value === true ? { [name]: true } : value === false ? { [name]: false } : {}
}

function normalizeChatClick(event) {
  if (!event || typeof event !== 'object') return null
  const action = String(event.action || '').toLowerCase()
  const value = String(event.value ?? event.command ?? event.url ?? '').slice(0, 2048)
  if (!CHAT_CLICK_ACTIONS.has(action) || !value) return null
  if (action === 'open_url') {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) return null
      return { action, value }
    } catch { return null }
  }
  return { action, value }
}

function normalizeChatHover(event) {
  if (!event || typeof event !== 'object' || String(event.action || '') !== 'show_text') return ''
  return String(extractText(event.value ?? event.contents) || '').slice(0, 500)
}

function linkifyChatSegments(segments) {
  return segments.flatMap((segment) => {
    if (segment.click || typeof segment.text !== 'string') return [segment]
    const parts = []
    let cursor = 0
    for (const match of segment.text.matchAll(CHAT_URL)) {
      if (match.index > cursor) parts.push({ ...segment, text: segment.text.slice(cursor, match.index) })
      parts.push({ ...segment, text: match[0], underlined: true, click: { action: 'open_url', value: match[0] }, hover: 'Click to copy link' })
      cursor = match.index + match[0].length
    }
    if (cursor < segment.text.length) parts.push({ ...segment, text: segment.text.slice(cursor) })
    return parts.length ? parts : [segment]
  }).slice(0, 256)
}

function normalizeChatSuggestions(matches, input) {
  const seen = new Set()
  return (Array.isArray(matches) ? matches : []).flatMap((match) => {
    const matchValue = String(typeof match === 'string' ? match : match?.match || '').slice(0, 256)
    if (!matchValue) return []
    const boundary = Math.max(input.lastIndexOf(' '), input.lastIndexOf('\t')) + 1
    const prefix = input.slice(0, boundary)
    const current = input.slice(boundary)
    const value = matchValue.startsWith(input) ? matchValue : matchValue.startsWith(current) ? `${prefix}${matchValue}` : input.startsWith('/') && !matchValue.startsWith('/') && boundary === 0 ? `/${matchValue}` : `${prefix}${matchValue}`
    if (seen.has(value)) return []
    seen.add(value)
    return [{
      value,
      label: value,
      tooltip: String(typeof match === 'object' ? extractText(match.tooltip) : '').slice(0, 180),
      source: 'server'
    }]
  }).filter((match) => match.value.toLowerCase().startsWith(input.toLowerCase()) || input.startsWith('/')).slice(0, 40)
}

function playerNameSuggestions(bot, input) {
  const text = String(input || '').slice(0, 256)
  const boundary = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t')) + 1
  const prefix = text.slice(0, boundary)
  const query = text.slice(boundary).toLowerCase()
  const self = String(bot?.username || '').toLowerCase()
  return Object.values(bot?.players || {})
    .map((player) => String(player?.username || ''))
    .filter((name) => name && name.toLowerCase() !== self && name.toLowerCase().startsWith(query))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 40)
    .map((name) => ({ value: `${prefix}${name}`, label: name, tooltip: '', source: 'player' }))
}

function normalizeSkinUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-z0-9]+$/i.test(url.pathname)) return ''
    url.protocol = 'https:'
    return url.toString()
  } catch { return '' }
}

function findNearestChest(bot, maxDistance = DEFAULT_AUTO_DEPOSIT_RANGE) {
  if (!bot?.entity?.position || typeof bot.findBlock !== 'function') return null
  return bot.findBlock({
    matching: (block) => CHEST_NAMES.has(block?.name),
    maxDistance: normalizeAutoDepositRange(maxDistance),
    useExtraInfo: (block) => {
      try { return typeof bot.canSeeBlock === 'function' && bot.canSeeBlock(block) === true }
      catch { return false }
    }
  })
}

function normalizeAutoDepositRange(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_AUTO_DEPOSIT_RANGE
  return Math.max(1, Math.min(Math.round(number), MAX_AUTO_DEPOSIT_RANGE))
}

function isDepositActive(session, revision) {
  return session?.account?.autoDepositToChest === true && session.depositRevision === revision
}

function chestLocation(bot, block) {
  const position = block?.position
  const player = bot?.entity?.position
  if (!position || !player) return null
  const deltaX = Number(position.x) - Number(player.x)
  const deltaY = Number(position.y) - Number(player.y)
  const deltaZ = Number(position.z) - Number(player.z)
  return {
    type: String(block?.name || 'chest'),
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z)),
    distance: Math.round(Math.sqrt(deltaX ** 2 + deltaY ** 2 + deltaZ ** 2) * 10) / 10
  }
}

function normalizeAntiAfkSettings(input) {
  const legacyInterval = typeof input === 'number' ? input : input?.antiAfkInterval
  const minDelay = clampNumber(input?.antiAfkMinDelay ?? legacyInterval, 2, 3600, 45)
  const maxDelay = Math.max(minDelay, clampNumber(input?.antiAfkMaxDelay ?? legacyInterval, 2, 3600, minDelay))
  return {
    minDelay,
    maxDelay,
    duration: clampNumber(input?.antiAfkActionDuration, 0.1, 10, 0.25),
    walkDistance: clampNumber(input?.antiAfkWalkDistance, 0.1, 8, 0.5),
    lookDegrees: clampNumber(input?.antiAfkLookDegrees, 5, 180, 12),
    jump: input?.antiAfkJump !== false,
    look: input?.antiAfkLook !== false,
    sneak: input?.antiAfkSneak === true,
    swing: input?.antiAfkSwing === true,
    walk: input?.antiAfkWalk === true
  }
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.min(number, maximum)) : fallback
}

function automaticServerSwitchKey(message) {
  const normalized = String(message || '').trim().replace(/\s+/g, ' ').toLowerCase()
  return /^\/server(?:\s|$)/.test(normalized) ? normalized : ''
}

function inspectFluidCurrent(bot, motionState = null) {
  const player = bot?.entity
  if (!player?.position?.floored || typeof bot.blockAt !== 'function') {
    resetFluidMotion(motionState, 'unavailable')
    return false
  }
  try {
    const current = fluidCurrentAtPlayer(bot, player.position)
    if (!current) {
      const recentlyInFlow = motionState &&
        Number.isFinite(motionState.lastFluidAt) && Date.now() - motionState.lastFluidAt <= FLUID_CONTACT_GRACE_MS &&
        Number.isFinite(motionState.currentX) &&
        Number.isFinite(motionState.currentZ)
      if (recentlyInFlow) {
        motionState.status = 'flowing'
        motionState.headSubmerged = false
        motionState.mineflayerInWater = player.isInWater === true
        return true
      }
      resetFluidMotion(motionState, 'dry')
      return false
    }
    if (!current.hasCurrent) {
      resetFluidMotion(motionState, 'still')
      if (motionState) {
        motionState.waterBlocks = current.waterBlocks
        motionState.waterLayers = current.waterLayers
        motionState.headSubmerged = current.headSubmerged
      }
      return false
    }
    const { x: directionX, z: directionZ } = current

    if (motionState) {
      motionState.status = 'flowing'
      motionState.waterBlocks = current.waterBlocks
      motionState.waterLayers = current.waterLayers
      motionState.headSubmerged = current.headSubmerged
      motionState.currentX = directionX
      motionState.currentZ = directionZ
      motionState.lastFluidAt = Date.now()
      motionState.mineflayerInWater = player.isInWater === true
      const moved = Number.isFinite(motionState.x)
        ? Math.hypot(player.position.x - motionState.x, player.position.z - motionState.z)
        : Infinity
      if (moved < 0.002) motionState.stagnantTicks = (motionState.stagnantTicks || 0) + 1
      else {
        motionState.stagnantTicks = 0
        motionState.forcing = false
      }
      // This hook runs after Mineflayer's native physics simulation. It is
      // diagnostics-only so it cannot double-apply current or entity pushes.
      motionState.forcing = false
      motionState.x = player.position.x
      motionState.z = player.position.z
    }
    return true
  } catch {
    resetFluidMotion(motionState, 'error')
    return false
  }
}

// Follow prismarine-physics 1.11.1's player bounding-box and per-block flow model.
// Source: https://github.com/PrismarineJS/prismarine-physics/blob/1.11.1/index.js#L628-L700
function fluidCurrentAtPlayer(bot, position) {
  let flowX = 0
  let flowZ = 0
  let waterBlocks = 0
  const waterLayers = new Set()
  const cursor = position.floored()
  const minX = Math.floor(position.x - 0.299)
  const maxX = Math.floor(position.x + 0.299)
  const minY = Math.floor(position.y)
  const maxY = Math.floor(position.y + 1.399)
  const minZ = Math.floor(position.z - 0.299)
  const maxZ = Math.floor(position.z + 0.299)

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        cursor.x = x
        cursor.y = y
        cursor.z = z
        const water = bot.blockAt(cursor, false)
        if (waterDepth(water) < 0) continue
        waterBlocks++
        waterLayers.add(y)
        const blockFlow = fluidCurrentAtBlock(bot, water)
        flowX += blockFlow.x
        flowZ += blockFlow.z
      }
    }
  }

  if (waterBlocks === 0) return null
  const length = Math.hypot(flowX, flowZ)
  const details = {
    waterBlocks,
    waterLayers: waterLayers.size,
    headSubmerged: [...waterLayers].some((y) => y > Math.floor(position.y))
  }
  return length > 0.001
    ? { x: flowX / length, z: flowZ / length, ...details, hasCurrent: true }
    : { x: 0, z: 0, ...details, hasCurrent: false }
}

function fluidCurrentAtBlock(bot, water) {
  const currentDepth = waterDepth(water)
  let flowX = 0
  let flowZ = 0
  for (const [dx, dz] of FLOW_DIRECTIONS) {
    const adjacentPosition = water.position.offset(dx, 0, dz)
    const adjacent = bot.blockAt(adjacentPosition, false)
    const adjacentDepth = waterDepth(adjacent)
    if (adjacentDepth >= 0) {
      const difference = adjacentDepth - currentDepth
      flowX += dx * difference
      flowZ += dz * difference
    } else if (canFluidSampleBelow(adjacent)) {
      const belowDepth = waterDepth(bot.blockAt(adjacentPosition.offset(0, -1, 0), false))
      if (belowDepth >= 0) {
        const difference = belowDepth - (currentDepth - 8)
        flowX += dx * difference
        flowZ += dz * difference
      }
    }
  }
  const length = Math.hypot(flowX, flowZ)
  return length > 0.001 ? { x: flowX / length, z: flowZ / length } : { x: 0, z: 0 }
}

function canFluidSampleBelow(block) {
  if (!block || block.boundingBox !== 'empty') return false
  return block.material === 'default' || block.name === 'cobweb' || block.name === 'bamboo_sapling'
}

function resetFluidMotion(state, status = 'dry') {
  if (!state) return
  delete state.x
  delete state.z
  delete state.currentX
  delete state.currentZ
  delete state.waterBlocks
  delete state.waterLayers
  delete state.headSubmerged
  delete state.mineflayerInWater
  delete state.lastFluidAt
  delete state.lastServerPosition
  state.stagnantTicks = 0
  state.forcing = false
  state.serverCorrections = 0
  state.stalledCorrections = 0
  state.status = status
}

function recordFluidCorrection(state, serverPosition) {
  if (!state) return
  state.serverCorrections = (state.serverCorrections || 0) + 1
  const position = vectorSnapshot(serverPosition)
  if (!position) {
    state.stalledCorrections = (state.stalledCorrections || 0) + 1
    return
  }
  const previous = state.lastServerPosition
  const progressed = previous && Math.hypot(position.x - previous.x, position.y - previous.y, position.z - previous.z) >= 0.2
  state.lastServerPosition = position
  if (progressed) {
    state.stalledCorrections = 1
  } else {
    state.stalledCorrections = (state.stalledCorrections || 0) + 1
  }
}

function waterDepth(block) {
  if (!block) return -1
  const properties = typeof block.getProperties === 'function' ? block.getProperties() : null
  if (block.isWaterlogged || properties?.waterlogged === true || WATERLIKE_NAMES.has(block.name)) return 0
  if (!WATER_NAMES.has(block.name)) return -1
  const rawLevel = properties?.level ?? block.metadata ?? 0
  const level = Number(rawLevel)
  const safeLevel = Number.isFinite(level) ? level : 0
  return safeLevel >= 8 ? 0 : safeLevel
}

function buildTelemetry(bot, nearestChest = null, environmentalMovement, fluidMotion = null, resourcePack = null) {
  const position = bot?.entity?.position
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const bySlot = new Map((bot?.inventory?.items?.() || []).map((item) => [Number(item.slot), item]))
  for (const slot of ARMOR_SLOT_TYPES.keys()) {
    const item = bot?.inventory?.slots?.[slot]
    if (item) bySlot.set(slot, item)
  }
  const inventory = [...bySlot.values()].sort((a, b) => Number(a.slot) - Number(b.slot)).slice(0, 46).map((item) => ({
    slot: Math.max(0, Math.min(Number(item.slot) || 0, 255)),
    slotType: ARMOR_SLOT_TYPES.get(Number(item.slot)) || 'inventory',
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127)),
    ...itemDurability(item),
    ...itemTooltipDetails(item, bot?.registry, bot?.__afkDeskEnchantmentsById),
    ...safeItemAppearance(resourcePack, item)
  }))
  const environment = environmentalMovement === undefined ? undefined : {
    enabled: environmentalMovement !== false,
    physicsEnabled: bot?.physicsEnabled !== false,
    waterStatus: String(fluidMotion?.status || 'checking'),
    waterBlocks: Math.max(0, Number(fluidMotion?.waterBlocks) || 0),
    current: Number.isFinite(fluidMotion?.currentX) && Number.isFinite(fluidMotion?.currentZ)
      ? { x: Math.round(fluidMotion.currentX * 100) / 100, z: Math.round(fluidMotion.currentZ * 100) / 100 }
      : null,
    fallbackActive: false,
    mineflayerInWater: fluidMotion?.mineflayerInWater === true,
    serverCorrections: Math.max(0, Number(fluidMotion?.serverCorrections) || 0),
    stalledCorrections: Math.max(0, Number(fluidMotion?.stalledCorrections) || 0)
  }
  return {
    health: Math.max(0, Math.min(finite(bot?.health), 20)),
    food: Math.max(0, Math.min(finite(bot?.food), 20)),
    position: position ? {
      x: Math.round(finite(position.x) * 10) / 10,
      y: Math.round(finite(position.y) * 10) / 10,
      z: Math.round(finite(position.z) * 10) / 10
    } : null,
    dimension: String(bot?.game?.dimension || 'unknown').slice(0, 80),
    nearestChest,
    inventory,
    selectedHotbarSlot: Math.max(0, Math.min(Number(bot?.quickBarSlot) || 0, 8)),
    ...(environment ? { environment } : {}),
    at: Date.now()
  }
}

const NAMED_CHAT_COLORS = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa', dark_red: '#aa0000',
  dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff',
  green: '#55ff55', aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff'
}

function itemDurability(item) {
  const maximum = Number(item?.maxDurability)
  if (!Number.isFinite(maximum) || maximum <= 0) return {}
  const used = Math.max(0, Math.min(Number(item?.durabilityUsed) || 0, maximum))
  const remaining = Math.round(maximum - used)
  return { durability: { remaining, maximum: Math.round(maximum), percent: Math.round((remaining / maximum) * 100) } }
}

function itemTooltipDetails(item, registry, enchantmentsById) {
  let customName = ''
  let lore = []
  let loreSegments = []
  let enchants = []
  try {
    const rawName = safeItemProperty(item, 'customName') ?? item?.componentMap?.get?.('custom_name')?.data ?? item?.components?.find?.((component) => component?.type === 'custom_name')?.data
    customName = String(extractText(rawName) || '').slice(0, 160)
  } catch {}
  try {
    const rawLore = safeItemProperty(item, 'customLore') ?? item?.componentMap?.get?.('lore')?.data ?? item?.components?.find?.((component) => component?.type === 'lore')?.data
    const loreValue = rawLore?.lines ?? rawLore
    const source = Array.isArray(loreValue) ? loreValue : loreValue ? [loreValue] : []
    const details = source.map(loreLineDetails).filter((line) => line.text).slice(0, 20)
    lore = details.map((line) => line.text)
    loreSegments = details.map((line) => line.segments)
  } catch {}
  try {
    const candidates = [
      safeItemProperty(item, 'enchants'),
      item?.componentMap?.get?.('enchantments')?.data,
      item?.componentMap?.get?.('stored_enchantments')?.data,
      item?.components?.find?.((component) => component?.type === 'enchantments')?.data,
      item?.components?.find?.((component) => component?.type === 'stored_enchantments')?.data
    ]
    for (const candidate of candidates) {
      enchants = normalizeEnchantments(candidate, registry, enchantmentsById)
      if (enchants.length) break
    }
  } catch {}
  return { ...(customName ? { customName } : {}), ...(lore.length ? { lore, loreSegments } : {}), ...(enchants.length ? { enchants } : {}) }
}

function normalizeEnchantments(raw, registry, enchantmentsById) {
  if (raw == null) return []
  const container = Array.isArray(raw) || raw instanceof Map
    ? raw
    : raw?.enchantments ?? raw?.levels ?? (Array.isArray(raw?.entries) ? raw.entries : raw)
  let list
  if (container instanceof Map) list = [...container.entries()].map(([name, level]) => ({ name, level }))
  else if (Array.isArray(container)) {
    list = container.map((entry) => Array.isArray(entry) && entry.length >= 2 ? { name: entry[0], level: entry[1] } : entry)
  } else if (container && typeof container === 'object') {
    list = Object.entries(container).map(([name, level]) => ({ name, level }))
  } else return []

  return list.map((enchant) => {
    const rawId = unwrapComponentValue(enchant?.name ?? enchant?.id ?? enchant?.key ?? enchant?.enchantment)
    const numericId = typeof rawId === 'number' || /^\d+$/.test(String(rawId || '')) ? Number(rawId) : null
    const dynamicName = numericId == null ? null : enchantmentsById?.get?.(numericId)
    const staticEntry = numericId == null || enchantmentsById?.size ? null : registry?.enchantmentsArray?.find?.((entry) => Number(entry?.id) === numericId)
    const name = String(dynamicName ?? staticEntry?.name ?? (numericId == null ? rawId : `enchantment_${numericId}`) ?? '').replace(/^minecraft:/, '').slice(0, 80)
    const rawLevel = unwrapComponentValue(enchant?.lvl ?? enchant?.level ?? enchant?.value)
    const numericLevel = Number(rawLevel)
    return { name, level: Math.max(1, Math.min(Number.isFinite(numericLevel) ? numericLevel : 1, 255)) }
  }).filter((enchant) => enchant.name).slice(0, 20)
}

function unwrapComponentValue(value, depth = 0) {
  if (depth > 6 || value == null) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'object') return value
  for (const key of ['value', 'data', 'level', 'lvl', 'id', 'name']) {
    if (value[key] !== undefined && value[key] !== value) return unwrapComponentValue(value[key], depth + 1)
  }
  return value
}

function safeItemProperty(item, key) {
  try { return item?.[key] } catch { return undefined }
}

function loreLineDetails(value) {
  const parsed = parseComponentValue(value)
  const text = String(extractText(parsed) || extractText(value) || '').replaceAll('\r', '').slice(0, 400)
  const segments = componentTextSegments(parsed).filter((segment) => segment.text).slice(0, 64)
  return { text, segments: segments.length ? segments : [{ text }] }
}

function parseComponentValue(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function componentTextSegments(value, inherited = {}) {
  if (typeof value === 'string') return parseMinecraftFormatting(value).map((segment) => ({ ...inherited, ...segment }))
  if (Array.isArray(value)) return value.flatMap((part) => componentTextSegments(part, inherited))
  if (!value || typeof value !== 'object') return []
  if (value.type === 'string') return componentTextSegments(value.value, inherited)
  const source = value.type === 'compound' && value.value ? value.value : value
  const style = { ...inherited }
  const color = componentScalar(source.color)
  if (/^#[0-9a-f]{6}$/i.test(color)) style.color = color.toLowerCase()
  else if (NAMED_CHAT_COLORS[color]) style.color = NAMED_CHAT_COLORS[color]
  for (const key of ['bold', 'italic', 'underlined', 'strikethrough']) {
    const setting = componentScalar(source[key])
    if (typeof setting === 'boolean') style[key] = setting
  }
  const segments = []
  const text = componentScalar(source.text)
  if (typeof text === 'string' && text) segments.push(...componentTextSegments(text, style))
  const extra = source.extra?.value?.value || source.extra?.value || source.extra
  if (Array.isArray(extra)) segments.push(...extra.flatMap((part) => componentTextSegments(part, style)))
  return segments
}

function componentScalar(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value
  return value
}

function playerInventorySlot(value) {
  const slot = Number(value)
  if (!Number.isInteger(slot) || slot < 5 || slot > 45) throw new Error('Invalid player inventory slot.')
  return slot
}

async function transferPlayerSlot(bot, container, slot, requestedCount) {
  if (typeof bot.transfer !== 'function') throw new Error('Exact-slot inventory transfer is unavailable.')
  const inventoryStart = Number(bot.inventory?.inventoryStart)
  const containerStart = Number(container?.inventoryStart)
  const containerEnd = Number(container?.inventoryEnd)
  const source = containerStart + slot - inventoryStart
  const item = bot.inventory?.slots?.[slot]
  const windowItem = container?.slots?.[source]
  if (!Number.isInteger(inventoryStart) || !Number.isInteger(containerStart) || !Number.isInteger(containerEnd) ||
      !Number.isInteger(source) || source < containerStart || source >= containerEnd ||
      !item || !windowItem || item.type !== windowItem.type || item.metadata !== windowItem.metadata ||
      !isDeepStrictEqual(item.nbt, windowItem.nbt) ||
      !isDeepStrictEqual(item.components, windowItem.components)) throw new Error('The selected inventory stack is no longer available in the container.')
  const count = Math.min(Number(requestedCount), Number(item.count), Number(windowItem.count))
  if (!Number.isInteger(count) || count < 1) throw new Error('The selected inventory stack is empty.')
  await bot.transfer({ window: container, itemType: item.type, metadata: item.metadata ?? null,
    nbt: item.nbt, count, sourceStart: source, sourceEnd: source + 1,
    destStart: 0, destEnd: containerStart })
  return count
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

function resolveEquipmentDestination(item, requested) {
  const allowed = new Set(['auto', 'hand', ...EQUIPMENT_DESTINATION_SLOTS.keys()])
  const destination = String(requested || 'auto')
  if (!allowed.has(destination)) throw new Error('Invalid equipment destination.')
  if (destination !== 'auto') return destination
  const name = String(item?.name || '')
  if (name.endsWith('_helmet') || name.endsWith('_skull') || ['player_head', 'carved_pumpkin'].includes(name)) return 'head'
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso'
  if (name.endsWith('_leggings')) return 'legs'
  if (name.endsWith('_boots')) return 'feet'
  throw new Error('Choose an equipment destination for this item.')
}

function normalizeLockedSlots(slots) {
  return [...new Set((Array.isArray(slots) ? slots : []).map(Number).filter((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 255))].sort((a, b) => a - b).slice(0, 46)
}

function lockedSlotSet(account) {
  return new Set(normalizeLockedSlots(account?.lockedInventorySlots))
}

function containerLabel(block) {
  if (block?.name === 'barrel') return 'barrel'
  if (block?.name === 'trapped_chest') return 'trapped chest'
  return 'chest'
}

function buildWindowSnapshot(window, registry, enchantmentsById, resourcePack = null) {
  const limit = Math.max(0, Math.min(Number(window?.inventoryStart) || window?.slots?.length || 0, 256))
  const slots = (window?.slots || []).slice(0, limit).map((item, slot) => item ? {
    slot,
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127)),
    ...itemDurability(item),
    ...itemTooltipDetails(item, registry, enchantmentsById),
    ...safeItemAppearance(resourcePack, item)
  } : null).filter(Boolean)
  const titleSource = window?.title?.json ?? window?.title
  const resourceTitle = safeTitleAppearance(resourcePack, titleSource)
  const title = resourceTitle ? 'Custom server menu' : String(extractText(window?.title) || 'Server menu').slice(0, 100)
  return { open: true, title, ...(resourceTitle ? { resourceTitle } : {}), size: limit, slots }
}

function safeItemAppearance(resourcePack, item) {
  try { return resourcePack?.itemAppearance?.(item) || {} } catch { return {} }
}

function safeTitleAppearance(resourcePack, title) {
  try { return resourcePack?.titleAppearance?.(title) || null } catch { return null }
}

function safeUrlHost(value) {
  try { return new URL(String(value)).host.slice(0, 120) || 'server' } catch { return 'server' }
}

function rejectResourcePack(bot, first, second, hash) {
  try {
    if (bot?.supportFeature?.('resourcePackUsesUUID')) {
      const uuid = [first, second].find((value) => value && typeof value === 'object')
      if (uuid) return bot._client?.write?.('resource_pack_receive', { uuid, result: 1 })
    }
    if (bot?.supportFeature?.('resourcePackUsesHash')) return bot._client?.write?.('resource_pack_receive', { hash: hash || '', result: 1 })
    return bot?._client?.write?.('resource_pack_receive', { result: 1 })
  } catch {}
}

module.exports = { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, parseInteractiveChat, normalizeSkinUrl, findNearestChest, buildTelemetry, buildWindowSnapshot, normalizeLockedSlots, describeNetworkError, reconnectDelaySeconds, normalizeAntiAfkSettings, inspectFluidCurrent, recordFluidCorrection, installMovementPacketCompatibility, installModernPlayerInputCompatibility }
