const path = require('node:path')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')

const PROXY_COMMANDS = new Set(['server', 'hub', 'lobby', 'switch'])
const CHEST_NAMES = new Set(['chest', 'trapped_chest'])
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
    clearNetworkTimer = clearTimeout
  }) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createBot = createBot
    this.scheduleReconnectTimer = scheduleReconnectTimer
    this.clearReconnectTimer = clearReconnectTimer
    this.scheduleNetworkTimer = scheduleNetworkTimer
    this.clearNetworkTimer = clearNetworkTimer
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
      checkTimeoutInterval: 45_000,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })

    const session = {
      bot,
      account: { ...account },
      antiAfkTimer: null,
      jumpTimer: null,
      telemetryTimer: null,
      chestScanTimer: null,
      connectionTimer: null,
      networkRecoveryTimer: null,
      messageTimers: new Set(),
      ready: false,
      switching: false,
      depositing: false,
      joinMessageSent: false,
      nearestChest: null,
      identityKey: '',
      telemetryKey: ''
    }
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
      if (session.connectionTimer) this.clearNetworkTimer(session.connectionTimer)
      session.connectionTimer = null
      reconnectState.attempts = 0
      this.status(account.id, 'online', `Online as ${bot.username}`)
      emitIdentity()
      emitTelemetry()
      if (!session.telemetryTimer) session.telemetryTimer = setInterval(emitTelemetry, 2000)
      if (!session.chestScanTimer) {
        void this.refreshChest(account.id)
        session.chestScanTimer = setInterval(() => { void this.refreshChest(account.id) }, CHEST_SCAN_INTERVAL)
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
      const snapshot = buildTelemetry(bot, session.nearestChest)
      const { at: _at, ...stableSnapshot } = snapshot
      const key = JSON.stringify(stableSnapshot)
      if (key === session.telemetryKey) return
      session.telemetryKey = key
      this.emit('telemetry', account.id, snapshot)
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
      this.clearSession(account.id)
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

  async dropStack(id, slot) {
    const bot = this.requireOnline(id)
    const safeSlot = Math.max(0, Math.min(Number(slot) || 0, 255))
    const item = bot.inventory?.slots?.[safeSlot] || bot.inventory?.items?.().find((entry) => entry.slot === safeSlot)
    if (!item) throw new Error('That inventory stack is no longer available.')
    await bot.tossStack(item)
    this.emit('log', id, { kind: 'sent', message: `Dropped ${item.count} × ${item.displayName || item.name}`, at: Date.now() })
    this.emitTelemetry(id)
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
    const items = session.bot.inventory?.items?.() || []
    if (!items.length) return
    session.depositing = true
    let chest
    try {
      chest = await session.bot.openChest(block)
      let deposited = 0
      for (const item of items) {
        await chest.deposit(item.type, item.metadata ?? null, item.count, item.nbt)
        deposited += item.count
      }
      const { x, y, z } = session.nearestChest
      this.emit('log', id, { kind: 'sent', message: `Deposited ${deposited} items into chest at ${x}, ${y}, ${z}.`, at: Date.now() })
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
    if (session.antiAfkTimer) clearInterval(session.antiAfkTimer)
    if (session.jumpTimer) clearTimeout(session.jumpTimer)
    if (session.telemetryTimer) clearInterval(session.telemetryTimer)
    if (session.chestScanTimer) clearInterval(session.chestScanTimer)
    if (session.connectionTimer) this.clearNetworkTimer(session.connectionTimer)
    if (session.networkRecoveryTimer) this.clearNetworkTimer(session.networkRecoveryTimer)
    for (const timer of session.messageTimers || []) clearTimeout(timer)
    session.messageTimers?.clear()
    session.antiAfkTimer = null
    session.jumpTimer = null
    session.telemetryTimer = null
    session.chestScanTimer = null
    session.connectionTimer = null
    session.networkRecoveryTimer = null
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
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
    z: Math.round(Number(position.z)),
    distance: Math.round(Math.sqrt(deltaX ** 2 + deltaY ** 2 + deltaZ ** 2) * 10) / 10
  }
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

module.exports = { BotManager, normalizeLoginCode, extractText, shouldUseProxyCommandPacket, parseMinecraftFormatting, normalizeSkinUrl, findNearestChest, buildTelemetry, describeNetworkError }
