const path = require('node:path')
const { applyProtocolFixes } = require('./protocol-fixes.cjs')
applyProtocolFixes()
const mineflayer = require('mineflayer')

const PROXY_COMMANDS = new Set(['server', 'hub', 'lobby', 'switch'])

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
      hideErrors: true,
      onMsaCode: (code) => this.emit('login-code', account.id, normalizeLoginCode(code))
    })

    const session = { bot, antiAfkTimer: null, jumpTimer: null, messageTimers: new Set(), ready: false, switching: false, joinMessageSent: false, identityKey: '' }
    this.sessions.set(account.id, session)
    this.status(account.id, 'connecting', reconnecting ? `Reconnect attempt ${reconnectState.attempts}…` : `Connecting to ${account.host}…`)

    bot._client?.on?.('start_configuration', () => {
      session.switching = true
      bot._client.write('settings', {
        locale: 'en_us',
        viewDistance: 10,
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

    bot.on('login', () => {
      if (!session.ready) this.status(account.id, 'connected', 'Authenticated. Joining world…')
      emitIdentity()
    })
    bot.on('playerJoined', (player) => { if (player?.username === bot.username) emitIdentity() })
    bot.on('playerUpdated', (player) => { if (player?.username === bot.username) emitIdentity() })
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
    for (const timer of session.messageTimers || []) clearTimeout(timer)
    session.messageTimers?.clear()
    session.antiAfkTimer = null
    session.jumpTimer = null
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

module.exports = { BotManager, normalizeLoginCode, extractText, shouldUseProxyCommandPacket, parseMinecraftFormatting, normalizeSkinUrl }
