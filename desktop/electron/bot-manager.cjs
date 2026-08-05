const path = require('node:path')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
const { createProxyConnect } = require('./proxy-connect.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')

const CHEST_NAMES = new Set(['chest', 'trapped_chest'])
const WATER_NAMES = new Set(['water', 'flowing_water'])
const WATERLIKE_NAMES = new Set(['bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const FLOW_DIRECTIONS = [[0, 1], [-1, 0], [0, -1], [1, 0]]
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
    random = Math.random
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
      telemetryTimer: null,
      chestScanTimer: null,
      connectionTimer: null,
      networkRecoveryTimer: null,
      physicsRestoreTimer: null,
      antiAfkActionTimers: new Set(),
      messageTimers: new Set(),
      ready: false,
      switching: false,
      depositing: false,
      joinMessageSent: false,
      nearestChest: null,
      identityKey: '',
      telemetryKey: ''
    }
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
      if (firstReady && account.antiAfk !== false) this.enableAntiAfk(account.id, account)
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
    bot.on('physicsTick', () => {
      if (session.account.environmentalMovement !== false) {
        applyEntityCollisionPush(bot)
        applyFluidCurrentPush(bot)
      }
    })
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
    bot.chat(trimmed)
    this.emit('log', id, { kind: 'sent', message: trimmed, at: Date.now() })
  }

  control(id, control, duration = 350) {
    const session = this.sessions.get(id)
    const bot = this.requireOnline(id)
    const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
    if (!allowed.has(control)) throw new Error('Unknown movement control.')
    this.temporarilyEnablePhysics(session, Math.max(100, Math.min(Number(duration) || 350, 3000)) + 200)
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

  enableAntiAfk(id, input = {}) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.antiAfkTimer) this.clearAntiAfkTimer(session.antiAfkTimer)
    for (const timer of session.antiAfkActionTimers) this.clearAntiAfkTimer(timer)
    session.antiAfkActionTimers.clear()
    session.antiAfkSettings = normalizeAntiAfkSettings(input)
    this.scheduleAntiAfk(id)
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
    if (session.antiAfkTimer) this.clearAntiAfkTimer(session.antiAfkTimer)
    if (session.telemetryTimer) clearInterval(session.telemetryTimer)
    if (session.chestScanTimer) clearInterval(session.chestScanTimer)
    if (session.connectionTimer) this.clearNetworkTimer(session.connectionTimer)
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

function applyEntityCollisionPush(bot) {
  const player = bot?.entity
  if (!player?.position || !player?.velocity) return 0
  let collisions = 0
  for (const key in bot.entities || {}) {
    const entity = bot.entities[key]
    if (!entity || entity === player || entity.id === player.id || entity.isValid === false || !['mob', 'player'].includes(entity.type) || !entity.position) continue
    const verticalOverlap = Number(entity.position.y) < Number(player.position.y) + Number(player.height || 1.8) && Number(entity.position.y) + Number(entity.height || 1.8) > Number(player.position.y)
    if (!verticalOverlap) continue
    const dx = Number(player.position.x) - Number(entity.position.x)
    const dz = Number(player.position.z) - Number(entity.position.z)
    const distance = Math.hypot(dx, dz)
    const collisionDistance = (Number(player.width) || 0.6) / 2 + (Number(entity.width) || 0.6) / 2
    if (distance <= 0.001 || distance >= collisionDistance) continue
    const strength = Math.min(0.05, (collisionDistance - distance) * 0.08)
    player.velocity.x += dx / distance * strength
    player.velocity.z += dz / distance * strength
    collisions += 1
  }
  return collisions
}

function applyFluidCurrentPush(bot) {
  const player = bot?.entity
  if (!player?.position?.floored || !player?.velocity || typeof bot.blockAt !== 'function') return false
  try {
    const position = player.position.floored()
    const feetBlock = bot.blockAt(position, false)
    const water = waterDepth(feetBlock) >= 0 ? feetBlock : bot.blockAt(position.offset(0, 1, 0), false)
    if (waterDepth(water) < 0) return false

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
      } else if (!adjacent || adjacent.boundingBox === 'empty') {
        const belowDepth = waterDepth(bot.blockAt(adjacentPosition.offset(0, -1, 0), false))
        if (belowDepth >= 0) {
          const difference = belowDepth - (currentDepth - 8)
          flowX += dx * difference
          flowZ += dz * difference
        }
      }
    }

    const length = Math.hypot(flowX, flowZ)
    if (length <= 0.001) return false
    const directionX = flowX / length
    const directionZ = flowZ / length
    const minimumCurrent = 0.014
    const currentSpeed = Number(player.velocity.x) * directionX + Number(player.velocity.z) * directionZ
    if (currentSpeed < minimumCurrent) {
      const missingSpeed = minimumCurrent - currentSpeed
      player.velocity.x += directionX * missingSpeed
      player.velocity.z += directionZ * missingSpeed
    }
    return true
  } catch {
    return false
  }
}

function waterDepth(block) {
  if (!block) return -1
  if (block.isWaterlogged || WATERLIKE_NAMES.has(block.name)) return 0
  if (!WATER_NAMES.has(block.name)) return -1
  const metadata = Number(block.metadata) || 0
  return metadata >= 8 ? 0 : metadata
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

module.exports = { BotManager, normalizeLoginCode, extractText, parseMinecraftFormatting, normalizeSkinUrl, findNearestChest, buildTelemetry, describeNetworkError, normalizeAntiAfkSettings, applyEntityCollisionPush, applyFluidCurrentPush }
