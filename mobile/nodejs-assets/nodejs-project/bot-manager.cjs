const path = require('node:path')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')

const PROXY_COMMANDS = new Set(['server', 'hub', 'lobby', 'switch'])
const CONTAINER_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const DEFAULT_AUTO_DEPOSIT_RANGE = 5
const MAX_AUTO_DEPOSIT_RANGE = 16
const CONTAINER_SCAN_INTERVAL = 5000

class BotManager {
  constructor({ profilesPath, emit, createBot = mineflayer.createBot, scheduleReconnectTimer = setTimeout, clearReconnectTimer = clearTimeout }) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createBot = createBot
    this.scheduleReconnectTimer = scheduleReconnectTimer
    this.clearReconnectTimer = clearReconnectTimer
    this.sessions = new Map()
    this.reconnects = new Map()
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
      version: account.version || false,
      profilesFolder: path.join(this.profilesPath, account.id),
      connect: createProxyConnect(account.proxy, { host: account.host, port: Number(account.port) || 25565 }),
      hideErrors: true,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })

    const session = {
      bot, account: { ...account }, antiAfkTimer: null, jumpTimer: null, telemetryTimer: null,
      containerScanTimer: null, messageTimers: new Set(), ready: false, switching: false,
      joinMessageSent: false, identityKey: '', telemetryKey: '', nearestChest: null,
      depositing: false, depositRevision: 0, activeDepositContainer: null
    }
    this.sessions.set(account.id, session)
    this.status(account.id, 'connecting', reconnecting ? `Reconnect attempt ${reconnectState.attempts}…` : `Connecting to ${account.host}…`)

    bot._client?.on?.('start_configuration', () => {
      session.switching = true
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
      if (!this.sessions.has(account.id)) return
      const completedSwitch = session.switching
      if (session.ready && !completedSwitch) return
      const firstReady = !session.ready
      session.ready = true
      session.switching = false
      reconnectState.attempts = 0
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
      this.emitTelemetry(account.id)
    }

    bot.on('login', () => {
      if (!session.ready) this.status(account.id, 'connected', 'Authenticated. Joining world…')
      emitIdentity()
    })
    bot.on('playerJoined', (player) => { if (player?.username === bot.username) emitIdentity() })
    bot.on('playerUpdated', (player) => { if (player?.username === bot.username) emitIdentity() })
    bot.on('health', emitTelemetry)
    bot.inventory?.on?.('updateSlot', emitTelemetry)
    bot.on('spawn', markReady)
    bot.on('forcedMove', markReady)
    bot.on('respawn', () => {
      markReady()
      if (account.serverChangeMessage) this.scheduleMessage(account.id, account.serverChangeMessage, account.messageDelay)
    })
    bot.on('messagestr', (message, _position, originalMessage) => {
      markReady()
      const formatted = originalMessage?.toMotd?.() || message
      this.emit('log', account.id, { kind: 'chat', message, segments: parseMinecraftFormatting(formatted), at: Date.now() })
    })
    bot.on('kicked', (reason) => {
      session.lastKickReason = formatReason(reason)
      this.emit('log', account.id, { kind: 'error', message: `Kicked: ${session.lastKickReason}`, at: Date.now() })
    })
    bot.on('error', (error) => this.emit('log', account.id, { kind: 'error', message: error.message, at: Date.now() }))
    bot.on('end', (reason) => {
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
    const base = Math.max(1, Math.min(Number(account.autoReconnectDelay) || 5, 300))
    const delay = Math.min(base * (2 ** Math.min(state.attempts - 1, 6)), 300)
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
    if (shouldUseProxyCommandPacket(bot, trimmed)) {
      bot._client.write('chat_command', { command: trimmed.slice(1) })
    } else {
      bot.chat(trimmed)
    }
    this.emit('log', id, { kind: 'sent', message: trimmed, at: Date.now() })
  }

  control(id, control, duration = 350) {
    const bot = this.requireOnline(id)
    const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
    if (!allowed.has(control)) throw new Error('Unknown movement control.')
    bot.setControlState(control, true)
    setTimeout(() => {
      if (this.sessions.has(id)) bot.setControlState(control, false)
    }, Math.max(100, Math.min(Number(duration) || 350, 3000)))
  }

  look(id, direction) {
    const bot = this.requireOnline(id)
    const delta = direction === 'left' ? -0.45 : 0.45
    bot.look(bot.entity.yaw + delta, bot.entity.pitch, true)
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
    if (!session?.bot?.entity || session.depositing || session.bot.currentWindow) return
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
    const snapshot = buildTelemetry(session.bot, session.nearestChest)
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
      if (!this.sessions.has(id)) return
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

function shouldUseProxyCommandPacket(bot, message) {
  if (!message.startsWith('/') || !bot?._client?.write) return false
  const command = message.slice(1).trim().split(/\s+/, 1)[0].toLowerCase()
  if (!PROXY_COMMANDS.has(command)) return false
  try { return bot.supportFeature?.('seperateSignedChatCommandPacket') === true }
  catch { return false }
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

function buildTelemetry(bot, nearestChest = null) {
  const position = bot?.entity?.position
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const inventory = (bot?.inventory?.items?.() || []).slice(0, 46).map((item) => ({
    slot: Math.max(0, Math.min(Number(item.slot) || 0, 255)),
    name: String(item.name || '').slice(0, 80),
    displayName: String(item.displayName || item.name || 'Unknown item').slice(0, 100),
    count: Math.max(1, Math.min(Number(item.count) || 1, 127))
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

module.exports = { BotManager, normalizeLoginCode, extractText, shouldUseProxyCommandPacket, parseMinecraftFormatting, normalizeSkinUrl, findNearestChest, buildTelemetry }
