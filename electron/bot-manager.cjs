const path = require('node:path')
const mineflayer = require('mineflayer')

class BotManager {
  constructor({ profilesPath, emit, createBot = mineflayer.createBot }) {
    this.profilesPath = profilesPath
    this.emit = emit
    this.createBot = createBot
    this.sessions = new Map()
  }

  connect(account) {
    if (this.sessions.has(account.id)) throw new Error('This account is already connecting or online.')

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

    const session = { bot, antiAfkTimer: null, jumpTimer: null, messageTimers: new Set(), ready: false, joinMessageSent: false }
    this.sessions.set(account.id, session)
    this.status(account.id, 'connecting', `Connecting to ${account.host}…`)

    const markReady = () => {
      if (session.ready || !this.sessions.has(account.id)) return
      session.ready = true
      this.status(account.id, 'online', `Online as ${bot.username}`)
      if (account.antiAfk !== false) this.enableAntiAfk(account.id, account.antiAfkInterval)
      if (account.joinMessage && !session.joinMessageSent) {
        session.joinMessageSent = true
        this.scheduleMessage(account.id, account.joinMessage, account.messageDelay)
      }
    }

    bot.on('login', () => {
      if (!session.ready) this.status(account.id, 'connected', 'Authenticated. Joining world…')
    })
    bot.on('spawn', markReady)
    bot.on('forcedMove', markReady)
    bot.on('respawn', () => {
      markReady()
      if (account.serverChangeMessage) this.scheduleMessage(account.id, account.serverChangeMessage, account.messageDelay)
    })
    bot.on('messagestr', (message) => {
      markReady()
      this.emit('log', account.id, { kind: 'chat', message, at: Date.now() })
    })
    bot.on('kicked', (reason) => this.emit('log', account.id, { kind: 'error', message: `Kicked: ${formatReason(reason)}`, at: Date.now() }))
    bot.on('error', (error) => this.emit('log', account.id, { kind: 'error', message: error.message, at: Date.now() }))
    bot.on('end', (reason) => {
      this.clearSession(account.id)
      this.status(account.id, 'offline', reason ? `Disconnected: ${reason}` : 'Disconnected')
    })
  }

  disconnect(id) {
    const session = this.sessions.get(id)
    if (!session) return
    this.clearTimers(session)
    session.bot.quit('Disconnected from AFK Desk')
    this.sessions.delete(id)
    this.status(id, 'offline', 'Disconnected')
  }

  sendChat(id, message) {
    const bot = this.requireOnline(id)
    const trimmed = String(message || '').trim()
    if (!trimmed) return
    bot.chat(trimmed)
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
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason) } catch { return String(reason) }
}

module.exports = { BotManager, normalizeLoginCode }
