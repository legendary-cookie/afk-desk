'use strict'

const { redactSecrets: notifierRedactSecrets, validateChannel } = require('../../electron/notify/notifier.cjs')

const MAX_MESSAGE_CHARS = 1900
const ALLOWED_MENTIONS = Object.freeze({ parse: [] })

const MC_COLOR_RE = /§[0-9A-FK-ORX]|§/gi
const SINGLE_LINE_WS_RE = /[\r\n\t]+/g
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g
const MULTILINE_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g
const DISCORD_MARKDOWN_RE = /([*_~`|>[\]()#-])/g
const DISCORD_BOT_TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g

const knownBotTokens = new Set()

function rememberBotToken(token) {
  if (typeof token !== 'string') return
  const trimmed = token.trim()
  if (!trimmed) return
  if (trimmed.length >= 4) {
    knownBotTokens.add(trimmed)
  }
  try {
    // Register into notifier.cjs knownSecrets as well so direct notifier.redactSecrets calls redact it.
    validateChannel({ type: 'telegram', botToken: trimmed, chatId: '0' })
  } catch {}
}

function redactSecrets(text) {
  if (text === null || text === undefined) return ''
  let out = notifierRedactSecrets(String(text))
  if (!out) return ''

  out = out.replace(DISCORD_BOT_TOKEN_RE, '[redacted]')

  if (knownBotTokens.size > 0) {
    const tokens = Array.from(knownBotTokens).sort((a, b) => b.length - a.length)
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]
      if (tok && out.includes(tok)) {
        out = out.split(tok).join('[redacted]')
      }
    }
  }

  return out
}

function stripCodesAndControls(raw, { preserveNewlines = false } = {}) {
  if (raw === null || raw === undefined) return ''
  let out = redactSecrets(String(raw)).replace(MC_COLOR_RE, '')
  if (preserveNewlines) {
    out = out.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(MULTILINE_CONTROL_CHARS_RE, '')
  } else {
    out = out.replace(SINGLE_LINE_WS_RE, ' ').replace(CONTROL_CHARS_RE, '')
  }
  return out
}

function escapeDiscordText(raw, options = {}) {
  const cleaned = stripCodesAndControls(raw, options)
  if (!cleaned) return ''
  return cleaned
    .replace(/@/g, '@\u200b')
    .replace(DISCORD_MARKDOWN_RE, '\\$1')
}

function truncateMessage(text, maxChars = MAX_MESSAGE_CHARS) {
  const clean = redactSecrets(String(text ?? ''))
  const limit = Number.isFinite(maxChars) && maxChars > 1 ? Math.floor(maxChars) : MAX_MESSAGE_CHARS
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1)}…`
}

function formatUptime(uptime) {
  if (typeof uptime === 'string' && uptime.trim()) {
    return escapeDiscordText(uptime.trim())
  }
  if (typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0) {
    const totalSec = Math.floor(uptime >= 1000 ? uptime / 1000 : uptime)
    const hours = Math.floor(totalSec / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }
  return ''
}

function formatStatus(result) {
  const list = Array.isArray(result)
    ? result
    : Array.isArray(result?.accounts)
      ? result.accounts
      : []

  if (list.length === 0) {
    return 'No accounts configured.'
  }

  const lines = list.map((acc) => {
    const name = escapeDiscordText(acc?.name || acc?.username || acc?.id || 'Account')
    const state = escapeDiscordText(acc?.state || acc?.status || (acc?.connected ? 'connected' : 'disconnected'))
    const server = acc?.server ? ` @ ${escapeDiscordText(acc.server)}` : ''
    const parts = [`${name}${server}: ${state}`]

    const health = typeof acc?.health === 'number' && Number.isFinite(acc.health) ? Math.round(acc.health) : null
    const food = typeof acc?.food === 'number' && Number.isFinite(acc.food) ? Math.round(acc.food) : null
    if (health !== null || food !== null) {
      const hf = [
        health !== null ? `HP ${health}` : null,
        food !== null ? `Food ${food}` : null
      ].filter(Boolean).join('/')
      parts.push(hf)
    }

    const uptimeStr = formatUptime(acc?.uptime ?? acc?.uptimeMs)
    if (uptimeStr) {
      parts.push(`up ${uptimeStr}`)
    }

    if (acc?.kickReason || acc?.lastError) {
      parts.push(`reason: ${escapeDiscordText(acc.kickReason || acc.lastError)}`)
    }

    return `• ${parts.join(' · ')}`
  })

  return truncateMessage(lines.join('\n'))
}

function formatInventory(result) {
  const items = Array.isArray(result)
    ? result
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result?.slots)
        ? result.slots
        : []

  const nonEmpty = items.filter((item) => item && (item.name || item.displayName || item.id || item.type))
  if (nonEmpty.length === 0) {
    return 'Inventory is empty.'
  }

  // Render inventory as a compact code-block-free list.
  const lines = nonEmpty.map((item, idx) => {
    const label = escapeDiscordText(item.displayName || item.name || item.id || item.type || 'item')
    const count = typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 1
    const slotPrefix = typeof item.slot === 'number' && Number.isFinite(item.slot) ? `[${item.slot}] ` : `${idx + 1}. `
    return `${escapeDiscordText(slotPrefix)}${label} x${count}`
  })

  return truncateMessage(lines.join('\n'))
}

function formatRecentChat(result) {
  const rawLines = Array.isArray(result)
    ? result
    : Array.isArray(result?.lines)
      ? result.lines
      : Array.isArray(result?.messages)
        ? result.messages
        : []

  if (rawLines.length === 0) {
    return 'No recent chat messages.'
  }

  const lines = rawLines.map((entry) => {
    if (typeof entry === 'string') {
      return `• ${escapeDiscordText(entry)}`
    }
    if (entry && typeof entry === 'object') {
      const sender = entry.sender || entry.author || entry.username
      const text = entry.message ?? entry.text ?? entry.content ?? ''
      if (sender) {
        return `• ${escapeDiscordText(sender)}: ${escapeDiscordText(text)}`
      }
      return `• ${escapeDiscordText(text)}`
    }
    return `• ${escapeDiscordText(String(entry ?? ''))}`
  })

  return truncateMessage(lines.join('\n'))
}

function formatCommandResult(commandName, result, args = {}) {
  switch (commandName) {
    case 'status':
      return formatStatus(result)
    case 'inventory.view':
      return formatInventory(result)
    case 'chat.recent':
      return formatRecentChat(result)
    case 'account.connect': {
      const target = escapeDiscordText(result?.name || result?.accountName || result?.accountId || args?.accountId || 'account')
      const detail = result?.message ? ` (${escapeDiscordText(result.message)})` : ''
      return truncateMessage(`Connecting ${target}.${detail}`)
    }
    case 'account.disconnect': {
      const target = escapeDiscordText(result?.name || result?.accountName || result?.accountId || args?.accountId || 'account')
      const detail = result?.message ? ` (${escapeDiscordText(result.message)})` : ''
      return truncateMessage(`Disconnected ${target}.${detail}`)
    }
    case 'account.reconnect': {
      const target = escapeDiscordText(result?.name || result?.accountName || result?.accountId || args?.accountId || 'account')
      const detail = result?.message ? ` (${escapeDiscordText(result.message)})` : ''
      return truncateMessage(`Reconnecting ${target}.${detail}`)
    }
    case 'chat.send': {
      const target = escapeDiscordText(result?.name || result?.accountName || result?.accountId || args?.accountId || 'account')
      return truncateMessage(`Sent chat message via ${target}.`)
    }
    case 'macro.run': {
      const target = escapeDiscordText(result?.accountName || result?.accountId || args?.accountId || 'account')
      const macro = escapeDiscordText(result?.macroName || result?.name || result?.macroId || args?.macroId || 'macro')
      return truncateMessage(`Started macro ${macro} on ${target}.`)
    }
    case 'macro.stop': {
      const target = escapeDiscordText(result?.accountName || result?.accountId || args?.accountId || 'account')
      return truncateMessage(`Stopped macro on ${target}.`)
    }
    case 'antiAfk.set': {
      const target = escapeDiscordText(result?.accountName || result?.accountId || args?.accountId || 'account')
      const enabled = Boolean(result?.enabled ?? args?.enabled)
      return truncateMessage(`Anti\\-AFK ${enabled ? 'enabled' : 'disabled'} for ${target}.`)
    }
    case 'connectAll': {
      const count = typeof result?.count === 'number' ? ` (${result.count})` : ''
      return truncateMessage(`Connecting all accounts${escapeDiscordText(count)}.`)
    }
    case 'disconnectAll': {
      const count = typeof result?.count === 'number' ? ` (${result.count})` : ''
      return truncateMessage(`Disconnected all accounts${escapeDiscordText(count)}.`)
    }
    default: {
      if (typeof result === 'string') {
        return truncateMessage(escapeDiscordText(result))
      }
      if (result && typeof result.message === 'string') {
        return truncateMessage(escapeDiscordText(result.message))
      }
      return 'Done.'
    }
  }
}

function formatCommandError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'FAILED'
  const rawMessage = typeof error?.message === 'string' && error.message.trim()
    ? escapeDiscordText(error.message.trim())
    : ''

  let prefix
  switch (code) {
    case 'FORBIDDEN':
      prefix = 'Permission denied'
      break
    case 'INVALID':
      prefix = 'Invalid arguments'
      break
    case 'NOT_FOUND':
      prefix = 'Not found'
      break
    case 'RATE_LIMITED':
      prefix = 'Rate limited'
      break
    case 'OFFLINE':
      prefix = 'Account is offline'
      break
    default:
      prefix = 'Command failed'
      break
  }

  const combined = rawMessage ? `${prefix}: ${rawMessage}` : `${prefix}.`
  return truncateMessage(combined)
}

function formatConfirmPrompt(commandName, args = {}, customMessage) {
  if (typeof customMessage === 'string' && customMessage.trim()) {
    return truncateMessage(escapeDiscordText(customMessage.trim()))
  }
  const target = args?.accountId ? ` for ${escapeDiscordText(args.accountId)}` : ''
  return truncateMessage(`Please confirm ${escapeDiscordText(commandName)}${target} within 60 seconds.`)
}

function formatNotification(text) {
  return truncateMessage(escapeDiscordText(text, { preserveNewlines: true }))
}

module.exports = {
  MAX_MESSAGE_CHARS,
  ALLOWED_MENTIONS,
  rememberBotToken,
  redactSecrets,
  escapeDiscordText,
  truncateMessage,
  formatStatus,
  formatInventory,
  formatRecentChat,
  formatCommandResult,
  formatCommandError,
  formatConfirmPrompt,
  formatNotification
}
