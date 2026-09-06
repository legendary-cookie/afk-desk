const path = require('node:path')
const { profilePath } = require('./profile-path.cjs')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
const { ResourcePackLoader, normalizePackEvent } = require('./resource-pack.cjs')
const { normalizeVersionSelection } = require('./version-support.cjs')
const { installMovementPacketCompatibility, installModernPlayerInputCompatibility } = require('./movement-compatibility.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')

const CONTAINER_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const DEFAULT_AUTO_DEPOSIT_RANGE = 5
const MAX_AUTO_DEPOSIT_RANGE = 16
const CONTAINER_SCAN_INTERVAL = 5000
const STABLE_SESSION_MS = 60_000
const CONNECTION_TIMEOUT_MS = 120_000
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000
const CONFIGURATION_BLOCKED_GAMEPLAY_PACKETS = new Set([
  'position', 'look', 'position_look', 'flying', 'player_input', 'tick_end',
  'entity_action', 'arm_animation', 'held_item_slot', 'block_dig', 'block_place',
  'use_item', 'use_entity', 'window_click', 'close_window',
  'creative_inventory_action', 'spectate', 'teleport_confirm', 'vehicle_move',
  'steer_vehicle', 'chat', 'chat_message', 'chat_command',
  'chat_command_signed', 'tab_complete', 'client_command'
])

class BotManager {
  constructor({ profilesPath, emit, createBot = mineflayer.createBot, scheduleReconnectTimer = setTimeout, clearReconnectTimer = clearTimeout, resourcePackLoader }) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createBot = createBot
    this.scheduleReconnectTimer = scheduleReconnectTimer
    this.clearReconnectTimer = clearReconnectTimer
    this.resourcePackLoader = resourcePackLoader || new ResourcePackLoader({ cacheDir: path.join(path.dirname(profilesPath), 'resource-packs') })
    this.sessions = new Map()
    this.reconnects = new Map()
  }

  connect(account, { reconnecting = false } = {}) {
    const profilesFolder = profilePath(this.profilesPath, account?.id)
    if (this.sessions.has(account.id)) throw new Error('This account is already connecting or online.')
    const reconnectState = this.reconnects.get(account.id) || { attempts: 0, timer: null, manual: false }
    if (reconnectState.timer) this.clearReconnectTimer(reconnectState.timer)
    reconnectState.timer = null
    reconnectState.manual = false
    reconnectState.account = account
    this.reconnects.set(account.id, reconnectState)

    const selectedVersion = normalizeVersionSelection(account.version)
    let session
    let loginCodeRequested = false
    const bot = this.createBot({
      host: account.host,
      port: Number(account.port) || 25565,
      username: account.username,
      auth: 'microsoft',
      version: selectedVersion || false,
      profilesFolder,
      connect: createProxyConnect(account.proxy, { host: account.host, port: Number(account.port) || 25565 }),
      hideErrors: true,
      onMsaCode: (code) => {
        if (session && this.sessions.get(account.id) !== session) return
        loginCodeRequested = true
        if (session) this.armConnectionWatchdog(account.id, session, DEVICE_LOGIN_TIMEOUT_MS)
        this.emit('login-code', account.id, normalizeLoginCode(code))
      }
    })
    installMovementPacketCompatibility(bot)
    installModernPlayerInputCompatibility(bot)

    session = {
      bot, account: { ...account }, antiAfkTimer: null, jumpTimer: null, telemetryTimer: null,
      containerScanTimer: null, messageTimers: new Set(), ready: false, switching: false,
      joinMessageSent: false, identityKey: '', telemetryKey: '', nearestChest: null,
      depositing: false, depositRevision: 0, activeDepositContainer: null,
      inventoryAction: false, resourcePack: null
    }
    this.sessions.set(account.id, session)
    this.status(account.id, 'connecting', reconnecting ? `Reconnect attempt ${reconnectState.attempts}…` : `Connecting to ${account.host}…`)
    this.armConnectionWatchdog(account.id, session, loginCodeRequested ? DEVICE_LOGIN_TIMEOUT_MS : CONNECTION_TIMEOUT_MS)

    bot._client?.on?.('start_configuration', () => {
      if (this.sessions.get(account.id) !== session) return
      session.switching = true
      this.armConnectionWatchdog(account.id, session, CONNECTION_TIMEOUT_MS)
      bot._client.write('settings', {
        locale: 'en_us',
        viewDistance: 3,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true,
        particleStatus: 'all'
      })
      this.status(account.id, 'connected', 'Switching servers…')
    })

    const markReady = () => {
      if (this.sessions.get(account.id) !== session) return
      const completedSwitch = session.switching
      if (session.ready && !completedSwitch) return
      const firstReady = !session.ready
      session.ready = true
      session.switching = false
      clearTimeout(session.connectionTimer)
      session.connectionTimer = null
      if (firstReady) session.stabilityTimer = setTimeout(() => {
        if (this.sessions.get(account.id) === session) reconnectState.attempts = 0
      }, STABLE_SESSION_MS)
      this.status(account.id, 'online', `Online as ${bot.username}`)
      emitIdentity()
      this.emitTelemetry(account.id)
      if (!session.telemetryTimer) session.telemetryTimer = setInterval(emitTelemetry, 2000)
      if (!session.containerScanTimer) {
        void this.refreshChest(account.id)
        session.containerScanTimer = setInterval(() => { void this.refreshChest(account.id) }, CONTAINER_SCAN_INTERVAL)
      }
      if (firstReady && account.antiAfk !== false) this.enableAntiAfk(account.id, account.antiAfkInterval)
      if (firstReady && account.joinMessage && !session.joinMessageSent) {
        session.joinMessageSent = true
        this.scheduleMessage(account.id, account.joinMessage, account.messageDelay)
      }
    }

    bot._client?.on?.('finish_configuration', () => {
      if (session.switching) markReady()
    })

    const emitIdentity = () => {
      if (this.sessions.get(account.id) !== session) return
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
      if (this.sessions.get(account.id) !== session) return
      this.emitTelemetry(account.id)
    }

    bot.on('login', () => {
      if (this.sessions.get(account.id) !== session) return
      if (!session.ready) this.armConnectionWatchdog(account.id, session, CONNECTION_TIMEOUT_MS)
      if (!session.ready) this.status(account.id, 'connected', 'Authenticated. Joining world…')
      emitIdentity()
    })
    bot.on('playerJoined', (player) => { if (player?.username === bot.username) emitIdentity() })
    bot.on('playerUpdated', (player) => { if (player?.username === bot.username) emitIdentity() })
    bot.on('health', emitTelemetry)
    bot.inventory?.on?.('updateSlot', emitTelemetry)
    bot.on('windowOpen', (window) => {
      if (this.sessions.get(account.id) !== session || session.depositing) return
      const emitWindow = () => {
        if (this.sessions.get(account.id) === session && bot.currentWindow === window) {
          this.emit('window', account.id, buildWindowSnapshot(window, session.resourcePack))
        }
      }
      emitWindow()
      window?.on?.('updateSlot', emitWindow)
    })
    bot.on('windowClose', () => {
      if (this.sessions.get(account.id) !== session) return
      if (!session.depositing) this.emit('window', account.id, { open: false })
    })
    bot.on('resourcePack', async (first, second) => {
      if (this.sessions.get(account.id) !== session) return
      const pack = normalizePackEvent(first, second)
      if (!pack.url) {
        this.emit('log', account.id, { kind: 'error', message: 'The server offered a resource pack without a usable HTTP address.', at: Date.now() })
        rejectResourcePack(bot, first, second, pack.hash)
        return
      }
      const host = safeUrlHost(pack.url)
      this.emit('log', account.id, { kind: 'system', message: `Loading server resource pack from ${host}…`, at: Date.now() })
      try {
        const loaded = await this.resourcePackLoader.load(pack.url, pack.hash)
        if (this.sessions.get(account.id) !== session) return
        session.resourcePack = loaded
        bot.acceptResourcePack?.()
        session.telemetryKey = ''
        emitTelemetry()
        if (bot.currentWindow && !session.depositing) this.emit('window', account.id, buildWindowSnapshot(bot.currentWindow, session.resourcePack))
        this.emit('log', account.id, { kind: 'system', message: 'Server resource pack loaded. Custom menu art is enabled.', at: Date.now() })
      } catch (error) {
        if (this.sessions.get(account.id) !== session) return
        rejectResourcePack(bot, first, second, pack.hash)
        this.emit('log', account.id, { kind: 'error', message: `Server resource pack failed: ${String(error?.message || error).slice(0, 180)}`, at: Date.now() })
      }
    })
    bot.on('spawn', markReady)
    bot.on('forcedMove', markReady)
    bot.on('respawn', () => {
      if (this.sessions.get(account.id) !== session) return
      markReady()
      if (account.serverChangeMessage) this.scheduleMessage(account.id, account.serverChangeMessage, account.messageDelay)
    })
    bot.on('messagestr', (message, _position, originalMessage) => {
      if (this.sessions.get(account.id) !== session) return
      markReady()
      const formatted = originalMessage?.toMotd?.() || message
      this.emit('log', account.id, { kind: 'chat', message, segments: parseInteractiveChat(originalMessage, message, formatted), at: Date.now() })
    })
    bot.on('kicked', (reason) => {
      if (this.sessions.get(account.id) !== session) return
      session.lastKickReason = formatReason(reason)
      this.emit('log', account.id, { kind: 'error', message: `Kicked: ${session.lastKickReason}`, at: Date.now() })
    })
    bot.on('error', (error) => {
      if (this.sessions.get(account.id) === session) this.emit('log', account.id, { kind: 'error', message: error.message, at: Date.now() })
    })
    bot.on('end', (reason) => {
      if (this.sessions.get(account.id) !== session) return
      this.clearSession(account.id)
      if (account.autoReconnect !== false && !reconnectState.manual) {
        this.scheduleReconnect(account, session.lastKickReason || reason)
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
    this.clearSession(id)
    session.bot.quit('Disconnected from AFK Desk')
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
    const base = Math.max(1, Math.min(Number(account.autoReconnectDelay) || 5, 300))
    const delay = Math.min(base * (2 ** Math.min(state.attempts - 1, 6)), 300)
    state.manual = false
    state.account = account
    this.status(account.id, 'reconnecting', `Disconnected${reason ? `: ${String(reason).slice(0, 90)}` : ''}. Retrying in ${delay}s…`)
    state.timer = this.scheduleReconnectTimer(() => {
      state.timer = null
      if (this.reconnects.get(account.id) !== state || state.manual || this.sessions.has(account.id)) return
      try { this.connect(state.account, { reconnecting: true }) }
      catch (error) {
        this.emit('log', account.id, { kind: 'error', message: `Reconnect failed: ${error.message}`, at: Date.now() })
        this.scheduleReconnect(state.account, error.message)
      }
    }, delay * 1000)
    this.reconnects.set(account.id, state)
  }

  armConnectionWatchdog(id, session, delay) {
    clearTimeout(session.connectionTimer)
    session.connectionTimer = setTimeout(() => {
      if (this.sessions.get(id) !== session) return
      const reason = 'Connection timed out before joining the world'
      this.clearSession(id)
      try { session.bot.quit(reason) } catch {}
      if (session.account.autoReconnect !== false && !this.reconnects.get(id)?.manual) {
        this.scheduleReconnect(session.account, reason)
      } else {
        this.reconnects.delete(id)
        this.status(id, 'offline', reason)
      }
    }, delay)
    session.connectionTimer?.unref?.()
  }

  sendChat(id, message) {
    const bot = this.requireOnline(id)
    const trimmed = String(message || '').trim()
    if (!trimmed) return
    // The protocol chat path supplies version-specific session and checksum
    // fields that modern proxy commands also require.
    bot.chat(trimmed)
    this.emit('log', id, { kind: 'sent', message: trimmed, at: Date.now() })
  }

  async completeChat(id, input) {
    const bot = this.requireOnline(id)
    const text = String(input || '').slice(0, 256)
    if (!text) return []
    if (!text.startsWith('/')) return playerNameSuggestions(bot, text)
    try {
      return normalizeChatSuggestions(await bot.tabComplete(text, true, false, 2500), text)
    } catch {
      return playerNameSuggestions(bot, text)
    }
  }

  control(id, control, duration = 350) {
    const bot = this.requireOnline(id)
    const session = this.sessions.get(id)
    const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
    if (!allowed.has(control)) throw new Error('Unknown movement control.')
    bot.setControlState(control, true)
    const timer = setTimeout(() => {
      session.messageTimers.delete(timer)
      if (this.sessions.get(id) === session) bot.setControlState(control, false)
    }, Math.max(100, Math.min(Number(duration) || 350, 3000)))
    session.messageTimers.add(timer)
  }

  look(id, direction) {
    const bot = this.requireOnline(id)
    const delta = direction === 'left' ? -0.45 : 0.45
    bot.look(bot.entity.yaw + delta, bot.entity.pitch, true)
  }

  async dropStack(id, slot) {
    return this.withInventoryAction(id, async (bot) => {
      const safeSlot = playerInventorySlot(slot)
      const item = bot.inventory?.slots?.[safeSlot] || bot.inventory?.items?.().find((entry) => Number(entry.slot) === safeSlot)
      if (!item) throw new Error('That inventory stack is no longer available.')
      await bot.tossStack(item)
      this.emit('log', id, { kind: 'sent', message: `Dropped ${item.count} × ${item.displayName || item.name}`, at: Date.now() })
    })
  }

  async withInventoryAction(id, action) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    if (bot.currentWindow) throw new Error('Close the server menu before managing player inventory.')
    if (session.depositing || session.inventoryAction) throw new Error('Another inventory action is still running.')
    session.inventoryAction = true
    try { return await action(bot, session) }
    finally {
      session.inventoryAction = false
      this.emitTelemetry(id)
    }
  }

  async clickWindowSlot(id, slot) {
    const bot = this.requireOnline(id)
    const window = bot.currentWindow
    if (!window) throw new Error('The server menu is no longer open.')
    const safeSlot = Number(slot)
    if (!Number.isInteger(safeSlot) || safeSlot < 0 || safeSlot > 255) throw new Error('Invalid server-menu slot.')
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
    const reconnectState = this.reconnects.get(id)
    if (reconnectState?.account) {
      reconnectState.account.autoDepositToChest = nextEnabled
      reconnectState.account.autoDepositRange = nextRange
    }
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
    session.nearestChest = block ? containerLocation(session.bot, block) : null
    this.emitTelemetry(id)
    if (!session.account.autoDepositToChest || !block) return
    const items = session.bot.inventory?.items?.() || []
    if (!items.length) return
    session.depositing = true
    const depositRevision = session.depositRevision
    let container
    let deposited = 0
    try {
      container = await (session.bot.openContainer || session.bot.openChest).call(session.bot, block)
      session.activeDepositContainer = container
      for (const item of items) {
        if (!isDepositActive(session, depositRevision)) break
        await container.deposit(item.type, item.metadata ?? null, item.count, item.nbt)
        deposited += item.count
      }
      if (deposited > 0) {
        const { x, y, z } = containerLocation(session.bot, block)
        this.emit('log', id, { kind: 'sent', message: `Deposited ${deposited} items into ${containerLabel(block)} at ${x}, ${y}, ${z}.`, at: Date.now() })
      }
    } catch (error) {
      if (isDepositActive(session, depositRevision)) {
        this.emit('log', id, { kind: 'error', message: `Auto-deposit failed: ${String(error?.message || error).slice(0, 160)}`, at: Date.now() })
      }
    } finally {
      if (session.activeDepositContainer === container) session.activeDepositContainer = null
      try { container?.close() } catch {}
      session.depositing = false
      this.emitTelemetry(id)
      if (session.depositRevision !== depositRevision) void this.refreshChest(id)
    }
  }

  emitTelemetry(id) {
    const session = this.sessions.get(id)
    if (!session) return
    const snapshot = buildTelemetry(session.bot, session.nearestChest, session.resourcePack)
    const { at: _at, ...stableSnapshot } = snapshot
    const key = JSON.stringify(stableSnapshot)
    if (key === session.telemetryKey) return
    session.telemetryKey = key
    this.emit('telemetry', id, snapshot)
  }

  scheduleMessage(id, message, delaySeconds = 2) {
    const session = this.sessions.get(id)
    if (!session) return
    const delay = Math.max(0, Math.min(Number(delaySeconds) || 0, 30)) * 1000
    const timer = setTimeout(() => {
      session.messageTimers.delete(timer)
      if (this.sessions.get(id) !== session) return
      try { this.sendChat(id, String(message).slice(0, 256)) }
      catch (error) { this.emit('log', id, { kind: 'error', message: `Automatic message failed: ${error.message}`, at: Date.now() }) }
    }, delay)
    session.messageTimers.add(timer)
  }

  enableAntiAfk(id, seconds = 45) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.antiAfkTimer) clearInterval(session.antiAfkTimer)
    if (session.jumpTimer) clearTimeout(session.jumpTimer)
    const interval = Math.max(15, Math.min(Number(seconds) || 45, 3600)) * 1000
    session.antiAfkTimer = setInterval(() => {
      const bot = session.bot
      if (!bot.entity) return
      bot.setControlState('jump', true)
      session.jumpTimer = setTimeout(() => bot.setControlState('jump', false), 250)
      bot.look(bot.entity.yaw + 0.2, bot.entity.pitch, true).catch(() => {})
    }, interval)
  }

  clearSession(id) {
    const session = this.sessions.get(id)
    if (session) this.clearTimers(session)
    this.sessions.delete(id)
  }

  clearTimers(session) {
    if (session.connectionTimer) clearTimeout(session.connectionTimer)
    session.connectionTimer = null
    if (session.stabilityTimer) clearTimeout(session.stabilityTimer)
    session.stabilityTimer = null
    session.depositRevision += 1
    try { session.activeDepositContainer?.close() } catch {}
    session.activeDepositContainer = null
    if (session.antiAfkTimer) clearInterval(session.antiAfkTimer)
    if (session.jumpTimer) clearTimeout(session.jumpTimer)
    if (session.telemetryTimer) clearInterval(session.telemetryTimer)
    if (session.containerScanTimer) clearInterval(session.containerScanTimer)
    for (const timer of session.messageTimers || []) clearTimeout(timer)
    session.messageTimers?.clear()
    session.antiAfkTimer = null
    session.jumpTimer = null
    session.telemetryTimer = null
    session.containerScanTimer = null
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

function findNearestChest(bot, maxDistance = DEFAULT_AUTO_DEPOSIT_RANGE) {
  if (!bot?.entity?.position || typeof bot.findBlock !== 'function') return null
  return bot.findBlock({
    matching: (block) => CONTAINER_NAMES.has(block?.name),
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

function containerLocation(bot, block) {
  const position = block?.position
  const player = bot?.entity?.position
  if (!position || !player) return null
  const dx = Number(position.x) - Number(player.x)
  const dy = Number(position.y) - Number(player.y)
  const dz = Number(position.z) - Number(player.z)
  return {
    type: String(block.name || 'chest'),
    x: Math.round(Number(position.x)), y: Math.round(Number(position.y)), z: Math.round(Number(position.z)),
    distance: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10
  }
}

function containerLabel(block) {
  return String(block?.name || 'chest').replace(/_/g, ' ')
}

function buildTelemetry(bot, nearestChest = null, resourcePack = null) {
  const position = bot?.entity?.position
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const inventory = (bot?.inventory?.items?.() || []).slice(0, 46).map((item) => ({
    slot: Math.max(0, Math.min(Number(item.slot) || 0, 255)),
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127)),
    ...resourcePack?.itemAppearance?.(item)
  }))
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
    at: Date.now()
  }
}

function installConfigurationPacketGuard(bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function' || client.__afkDeskConfigurationPacketGuard) return
  const write = client.write.bind(client)
  client.write = (name, payload) => {
    if (client.state === 'configuration' && CONFIGURATION_BLOCKED_GAMEPLAY_PACKETS.has(name)) return
    return write(name, payload)
  }
  client.__afkDeskConfigurationPacketGuard = true
}

const CHAT_NAMED_COLORS = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa', dark_red: '#aa0000', dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff', green: '#55ff55', aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff'
}
const CHAT_CLICK_ACTIONS = new Set(['open_url', 'run_command', 'suggest_command', 'copy_to_clipboard'])
const CHAT_URL = /https?:\/\/[^\s<>"']+/gi

function parseInteractiveChat(originalMessage, fallbackMessage = '', formattedMessage = '') {
  const source = originalMessage?.json || originalMessage
  const segments = []
  if (source && typeof source === 'object') appendInteractiveComponent(segments, source, {})
  if (!segments.length || (fallbackMessage && segments.map((segment) => segment.text).join('') !== String(fallbackMessage))) {
    const formatted = parseMinecraftFormatting(formattedMessage)
    return linkifyChatSegments(formatted.length ? formatted : [{ text: String(fallbackMessage || '').slice(0, 8192) }])
  }
  return linkifyChatSegments(segments).slice(0, 256)
}

function appendInteractiveComponent(segments, component, inherited) {
  if (typeof component === 'string') { if (component) segments.push({ text: component, ...inherited }); return }
  if (!component || typeof component !== 'object' || segments.length >= 256) return
  const source = component.json && typeof component.json === 'object' ? component.json : component
  const colorName = String(component.color ?? source.color ?? '')
  const color = /^#[0-9a-f]{6}$/i.test(colorName) ? colorName.toLowerCase() : CHAT_NAMED_COLORS[colorName]
  const style = { ...inherited, ...(color ? { color } : {}) }
  for (const name of ['bold', 'italic', 'underlined', 'strikethrough']) {
    const value = component[name] ?? source[name]
    if (typeof value === 'boolean') style[name] = value
  }
  const click = normalizeChatClick(component.clickEvent || component.click_event || source.clickEvent || source.click_event)
  const hoverEvent = component.hoverEvent || component.hover_event || source.hoverEvent || source.hover_event
  const hover = String(hoverEvent?.action === 'show_text' ? extractText(hoverEvent.value ?? hoverEvent.contents) : '').slice(0, 500)
  const actionStyle = { ...style, ...(click ? { click } : {}), ...(hover ? { hover } : {}) }
  const text = component.text ?? source.text
  if (typeof text === 'string' && text) segments.push({ text: text.slice(0, 8192), ...actionStyle })
  const children = component.extra || source.extra || component.with || source.with
  if (Array.isArray(children)) for (const child of children) appendInteractiveComponent(segments, child, actionStyle)
}

function normalizeChatClick(event) {
  if (!event || typeof event !== 'object') return null
  const action = String(event.action || '').toLowerCase()
  const value = String(event.value ?? event.command ?? event.url ?? '').slice(0, 2048)
  if (!CHAT_CLICK_ACTIONS.has(action) || !value) return null
  if (action === 'open_url') {
    try { if (!['http:', 'https:'].includes(new URL(value).protocol)) return null } catch { return null }
  }
  return { action, value }
}

function linkifyChatSegments(segments) {
  return segments.flatMap((segment) => {
    if (segment.click || typeof segment.text !== 'string') return [segment]
    const parts = []
    let cursor = 0
    for (const match of segment.text.matchAll(CHAT_URL)) {
      if (match.index > cursor) parts.push({ ...segment, text: segment.text.slice(cursor, match.index) })
      parts.push({ ...segment, text: match[0], underlined: true, click: { action: 'open_url', value: match[0] }, hover: 'Tap to open link' })
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
    return [{ value, label: value, tooltip: String(typeof match === 'object' ? extractText(match.tooltip) : '').slice(0, 180), source: 'server' }]
  }).filter((match) => match.value.toLowerCase().startsWith(input.toLowerCase()) || input.startsWith('/')).slice(0, 40)
}

function playerNameSuggestions(bot, input) {
  const text = String(input || '').slice(0, 256)
  const boundary = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t')) + 1
  const prefix = text.slice(0, boundary)
  const query = text.slice(boundary).toLowerCase()
  const self = String(bot?.username || '').toLowerCase()
  return Object.values(bot?.players || {}).map((player) => String(player?.username || '')).filter((name) => name && name.toLowerCase() !== self && name.toLowerCase().startsWith(query)).sort((a, b) => a.localeCompare(b)).slice(0, 40).map((name) => ({ value: `${prefix}${name}`, label: name, tooltip: '', source: 'player' }))
}

function playerInventorySlot(value) {
  const slot = Number(value)
  if (!Number.isInteger(slot) || slot < 9 || slot > 45) throw new Error('Invalid player inventory slot.')
  return slot
}

function buildWindowSnapshot(window, resourcePack = null) {
  const limit = Math.max(0, Math.min(Number(window?.inventoryStart) || window?.slots?.length || 0, 256))
  const slots = (window?.slots || []).slice(0, limit).map((item, slot) => item ? {
    slot,
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127)),
    ...resourcePack?.itemAppearance?.(item)
  } : null).filter(Boolean)
  const titleSource = window?.title?.json ?? window?.title
  const resourceTitle = resourcePack?.titleAppearance?.(titleSource)
  const title = resourceTitle ? 'Custom server menu' : String(extractText(window?.title) || 'Server menu').slice(0, 100)
  return { open: true, title, ...(resourceTitle ? { resourceTitle } : {}), size: limit, slots }
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

module.exports = { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, parseInteractiveChat, normalizeSkinUrl, findNearestChest, buildTelemetry, buildWindowSnapshot, installConfigurationPacketGuard }
