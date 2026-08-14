const path = require('node:path')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
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

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const ARMOR_SLOT_TYPES = new Map([[5, 'helmet'], [6, 'chestplate'], [7, 'leggings'], [8, 'boots']])
const WATER_NAMES = new Set(['water', 'flowing_water'])
const WATERLIKE_NAMES = new Set(['bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const FLOW_DIRECTIONS = [[0, 1], [-1, 0], [0, -1], [1, 0]]
const FLUID_CONTACT_GRACE_MS = 750
const CHEST_SCAN_INTERVAL = 5000
const CHEST_MAX_DISTANCE = 5
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
    diagnose = () => {}
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
    this.sessions = new Map()
    this.reconnects = new Map()
    this.nextAutomaticServerSwitchAt = 0
  }

  connect(account, { reconnecting = false } = {}) {
    if (this.sessions.has(account.id)) throw new Error('This account is already connecting or online.')
    const reconnectState = this.reconnects.get(account.id) || { attempts: 0, timer: null, manual: false }
    if (reconnectState.timer) this.clearReconnectTimer(reconnectState.timer)
    reconnectState.timer = null
    reconnectState.manual = false
    reconnectState.account = account
    this.reconnects.set(account.id, reconnectState)

    const bot = this.createBot({
      host: account.host,
      port: Number(account.port) || 25565,
      username: account.username,
      auth: 'microsoft',
      version: account.version || account.lastSuccessfulVersion || false,
      profilesFolder: path.join(this.profilesPath, account.id),
      connect: createProxyConnect(account.proxy, { host: account.host, port: Number(account.port) || 25565 }),
      hideErrors: true,
      checkTimeoutInterval: 45_000,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })
    installMovementPacketCompatibility(bot)
    installModernPlayerInputCompatibility(bot)

    const session = {
      bot,
      account: { ...account },
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
      versionReported: false,
      versionConfirmed: false
    }
    bot.__afkDeskPacketDiagnostic = (entry) => this.diagnose({ ...entry, accountId: account.id, version: bot.version || account.version || 'auto' })
    bot._client?.on?.('packet', (_data, meta) => {
      if (CONFIGURATION_PACKET_NAMES.has(meta?.name)) {
        bot.__afkDeskPacketDiagnostic({ event: 'protocol_packet', direction: 'in', name: meta.name, at: Date.now() })
      }
    })
    bot.physicsEnabled = account.environmentalMovement !== false
    this.sessions.set(account.id, session)
    this.status(account.id, 'connecting', reconnecting ? `Reconnect attempt ${reconnectState.attempts}…` : `Connecting to ${account.host}…`)
    session.connectionTimer = this.scheduleNetworkTimer(() => {
      session.connectionTimer = null
      if (!this.sessions.has(account.id) || session.ready) return
      session.lastNetworkReason = 'ETIMEDOUT: The connection did not finish within 60 seconds.'
      this.emit('log', account.id, { kind: 'error', message: 'Network error (ETIMEDOUT): The connection did not finish within 60 seconds. Auto-reconnect will retry.', at: Date.now() })
      bot.end('connectTimeout')
    }, 60_000)

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
      }, 60_000)
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
      const snapshot = buildTelemetry(bot, session.nearestChest, session.account.environmentalMovement, session.fluidMotion)
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
      const emitWindow = () => this.emit('window', account.id, buildWindowSnapshot(window))
      emitWindow()
      window?.on?.('updateSlot', emitWindow)
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
      this.emit('log', account.id, { kind: 'chat', message, segments: parseMinecraftFormatting(formatted), at: Date.now() })
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
      const retryWithoutRememberedVersion = !session.ready && !account.version && Boolean(account.lastSuccessfulVersion)
      this.clearSession(account.id)
      if (account.autoReconnect !== false && !reconnectState.manual) {
        if (retryWithoutRememberedVersion) {
          this.emit('log', account.id, { kind: 'error', message: `Minecraft ${account.lastSuccessfulVersion} did not reach the world. Retrying with fresh version detection.`, at: Date.now() })
        }
        this.scheduleReconnect(
          retryWithoutRememberedVersion ? { ...account, lastSuccessfulVersion: '' } : account,
          session.lastKickReason || session.lastNetworkReason || reason
        )
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
    this.clearTimers(session)
    session.bot.quit('Disconnected from AFK Desk')
    this.sessions.delete(id)
    this.status(id, 'offline', 'Disconnected')
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

  async dropStack(id, slot) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    const safeSlot = Math.max(0, Math.min(Number(slot) || 0, 255))
    if (lockedSlotSet(session.account).has(safeSlot)) throw new Error('That inventory stack is locked. Unlock it before dropping it.')
    const item = bot.inventory?.slots?.[safeSlot] || bot.inventory?.items?.().find((entry) => entry.slot === safeSlot)
    if (!item) throw new Error('That inventory stack is no longer available.')
    await bot.tossStack(item)
    this.emit('log', id, { kind: 'sent', message: `Dropped ${item.count} × ${item.displayName || item.name}`, at: Date.now() })
    this.emitTelemetry(id)
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

  async setAutoDeposit(id, enabled) {
    const session = this.sessions.get(id)
    if (!session) return
    session.account.autoDepositToChest = enabled === true
    if (enabled) await this.refreshChest(id)
    else this.emitTelemetry(id)
  }

  async refreshChest(id) {
    const session = this.sessions.get(id)
    if (!session?.bot?.entity || session.depositing) return
    const block = findNearestChest(session.bot)
    session.nearestChest = block ? chestLocation(session.bot, block) : null
    this.emitTelemetry(id)
    if (!session.account.autoDepositToChest || !block) return
    const lockedSlots = lockedSlotSet(session.account)
    const items = (session.bot.inventory?.items?.() || []).filter((item) => !lockedSlots.has(Number(item.slot)))
    if (!items.length) return
    session.depositing = true
    let chest
    try {
      chest = await (session.bot.openContainer || session.bot.openChest).call(session.bot, block)
      let deposited = 0
      for (const item of items) {
        await chest.deposit(item.type, item.metadata ?? null, item.count, item.nbt)
        deposited += item.count
      }
      const { x, y, z } = session.nearestChest
      this.emit('log', id, { kind: 'sent', message: `Deposited ${deposited} items into ${containerLabel(block)} at ${x}, ${y}, ${z}.`, at: Date.now() })
    } catch (error) {
      this.emit('log', id, { kind: 'error', message: `Auto-deposit failed: ${String(error?.message || error).slice(0, 160)}`, at: Date.now() })
    } finally {
      try { chest?.close() } catch {}
      session.depositing = false
      this.emitTelemetry(id)
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

  clearSession(id) {
    const session = this.sessions.get(id)
    if (session) this.clearTimers(session)
    this.sessions.delete(id)
  }

  clearTimers(session) {
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
  const base = Math.max(1, Math.min(Number(account?.autoReconnectDelay) || 5, 300))
  const exponential = Math.min(base * (2 ** Math.min(Math.max(0, Number(attempts) - 1), 6)), 300)
  const text = String(reason || '')
  if (/logging in too fast|too many connection attempts|rate.?limit/i.test(text)) return Math.max(exponential, 30)
  return exponential
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

function normalizeSkinUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-z0-9]+$/i.test(url.pathname)) return ''
    url.protocol = 'https:'
    return url.toString()
  } catch { return '' }
}

function findNearestChest(bot) {
  if (!bot?.entity?.position || typeof bot.findBlock !== 'function') return null
  return bot.findBlock({ matching: (block) => CHEST_NAMES.has(block?.name), maxDistance: CHEST_MAX_DISTANCE })
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

function buildTelemetry(bot, nearestChest = null, environmentalMovement, fluidMotion = null) {
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
    ...itemDurability(item)
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
    ...(environment ? { environment } : {}),
    at: Date.now()
  }
}

function itemDurability(item) {
  const maximum = Number(item?.maxDurability)
  if (!Number.isFinite(maximum) || maximum <= 0) return {}
  const used = Math.max(0, Math.min(Number(item?.durabilityUsed) || 0, maximum))
  const remaining = Math.round(maximum - used)
  return { durability: { remaining, maximum: Math.round(maximum), percent: Math.round((remaining / maximum) * 100) } }
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

function buildWindowSnapshot(window) {
  const limit = Math.max(0, Math.min(Number(window?.inventoryStart) || window?.slots?.length || 0, 256))
  const slots = (window?.slots || []).slice(0, limit).map((item, slot) => item ? {
    slot,
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127)),
    ...itemDurability(item)
  } : null).filter(Boolean)
  return { open: true, title: String(extractText(window?.title) || 'Server menu').slice(0, 100), size: limit, slots }
}

module.exports = { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, normalizeSkinUrl, findNearestChest, buildTelemetry, buildWindowSnapshot, normalizeLockedSlots, describeNetworkError, reconnectDelaySeconds, normalizeAntiAfkSettings, inspectFluidCurrent, recordFluidCorrection, installMovementPacketCompatibility, installModernPlayerInputCompatibility }
