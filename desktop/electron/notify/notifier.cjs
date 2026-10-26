'use strict'

const crypto = require('node:crypto')
const { EVENT_KINDS, CHANNEL_TYPES, LIMITS, ALLOWED_HOSTS } = require('./contract.cjs')

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const MC_COLOR_RE = /§[0-9A-FK-ORX]|§/gi
const CONTROL_NL_RE = /[\r\n\t]+/g
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g

const DISCORD_WEBHOOK_PATH_RE = /^\/api\/webhooks\/(\d+)\/([A-Za-z0-9_-]+)$/
const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/
const TELEGRAM_CHAT_ID_RE = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/

// Patterns for redactSecrets
const DISCORD_URL_GLOBAL_RE = /https?:\/\/(?:[A-Za-z0-9-]+\.)*discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s"'<>)]+/gi
const ANY_WEBHOOK_URL_GLOBAL_RE = /https?:\/\/[^\s"'<>)]*\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+[^\s"'<>)]*/gi
const WEBHOOK_PATH_GLOBAL_RE = /\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+/gi
const TELEGRAM_URL_GLOBAL_RE = /https?:\/\/api\.telegram\.org\/bot[^\s"'<>)]+/gi
const TELEGRAM_TOKEN_GLOBAL_RE = /(?:bot)?\d{5,15}:[A-Za-z0-9_-]{20,128}/g

const knownSecrets = new Set()

function rememberSecret(secret) {
  if (typeof secret !== 'string') return
  const trimmed = secret.trim()
  if (trimmed.length >= 4) {
    knownSecrets.add(trimmed)
  }
}

function rememberChannelSecrets(channel) {
  if (!channel || typeof channel !== 'object') return
  if (typeof channel.webhookUrl === 'string' && channel.webhookUrl.trim()) {
    const raw = channel.webhookUrl.trim()
    rememberSecret(raw)
    try {
      const parsed = new URL(raw)
      rememberSecret(`${parsed.origin}${parsed.pathname}`)
      const parts = parsed.pathname.split('/').filter(Boolean)
      const webhooksIdx = parts.indexOf('webhooks')
      if (webhooksIdx !== -1 && parts[webhooksIdx + 2]) {
        rememberSecret(parts[webhooksIdx + 2])
      }
    } catch {
      const match = /\/api\/webhooks\/[^/\s]+\/([^\s/?#]+)/i.exec(raw)
      if (match && match[1]) rememberSecret(match[1])
    }
  }
  if (typeof channel.botToken === 'string' && channel.botToken.trim()) {
    const token = channel.botToken.trim()
    rememberSecret(token)
    const colonIdx = token.indexOf(':')
    if (colonIdx !== -1 && token.slice(colonIdx + 1).length >= 6) {
      rememberSecret(token.slice(colonIdx + 1))
    }
  }
}

function redactSecrets(text) {
  if (text === null || text === undefined) return ''
  let out = String(text)
  if (!out) return ''

  out = out
    .replace(DISCORD_URL_GLOBAL_RE, '[redacted]')
    .replace(ANY_WEBHOOK_URL_GLOBAL_RE, '[redacted]')
    .replace(WEBHOOK_PATH_GLOBAL_RE, '[redacted]')
    .replace(TELEGRAM_URL_GLOBAL_RE, '[redacted]')
    .replace(TELEGRAM_TOKEN_GLOBAL_RE, '[redacted]')

  if (knownSecrets.size > 0) {
    const secrets = Array.from(knownSecrets).sort((a, b) => b.length - a.length)
    for (let i = 0; i < secrets.length; i += 1) {
      const secret = secrets[i]
      if (secret && out.includes(secret)) {
        out = out.split(secret).join('[redacted]')
      }
    }
  }

  return out
}

function sanitizeServerText(value, maxLen = 500) {
  if (value === null || value === undefined) return ''
  const cleaned = String(value)
    .replace(MC_COLOR_RE, '')
    .replace(CONTROL_NL_RE, ' ')
    .replace(CONTROL_CHARS_RE, '')
    .replace(EMAIL_RE, '[redacted-email]')
    .trim()
  const redacted = redactSecrets(cleaned)
  return redacted.slice(0, maxLen)
}

function formatEventLine(event, includeTimestamp, nowFn) {
  const rawAccount = event && typeof event.accountName === 'string' ? sanitizeServerText(event.accountName, 100) : ''
  const accountName = rawAccount || 'Account'
  const rawServer = event && typeof event.server === 'string' ? sanitizeServerText(event.server, 120) : ''
  const server = rawServer || 'unknown'
  const rawMessage = event && event.message !== undefined ? sanitizeServerText(event.message, 500) : ''
  const message = rawMessage || (event && typeof event.kind === 'string' ? sanitizeServerText(event.kind, 100) : 'notification')

  let line = `[AFK Desk] ${accountName} @ ${server}: ${message}`
  if (includeTimestamp) {
    const ts = event && typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : nowFn()
    let iso
    try {
      iso = new Date(ts).toISOString()
    } catch {
      iso = new Date(nowFn()).toISOString()
    }
    line += ` (${iso})`
  }
  return line
}

function formatBatchMessage(events, includeTimestamp, maxChars, nowFn) {
  const limit = LIMITS.maxEventsPerMessage
  const visible = events.slice(0, limit)
  const lines = visible.map((ev) => formatEventLine(ev, includeTimestamp, nowFn))
  if (events.length > limit) {
    lines.push(`+${events.length - limit} more`)
  }
  const joined = lines.join('\n')
  if (joined.length <= maxChars) return joined
  return joined.slice(0, maxChars)
}

function validateChannel(input) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { channel: null, errors: ['Channel must be an object.'] }
  }

  rememberChannelSecrets(input)

  const type = typeof input.type === 'string' ? input.type.trim() : ''
  if (!CHANNEL_TYPES.includes(type)) {
    errors.push('Channel type must be "discord" or "telegram".')
  }

  let id = ''
  if (input.id === undefined) {
    id = crypto.randomUUID()
  } else if (typeof input.id === 'string' && input.id.trim().length > 0 && input.id.trim().length <= 128) {
    id = input.id.trim()
  } else {
    errors.push('Channel id must be a non-empty string.')
  }

  let name = ''
  if (input.name === undefined) {
    name = type === 'telegram' ? 'Telegram' : 'Discord'
  } else if (typeof input.name === 'string' && input.name.trim().length > 0 && input.name.trim().length <= 40) {
    name = input.name.trim()
  } else if (typeof input.name === 'string' && input.name.trim().length > 40) {
    errors.push('Channel name must be at most 40 characters.')
  } else {
    errors.push('Channel name must be a non-empty string.')
  }

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true
  const includeTimestamp = Boolean(input.includeTimestamp)

  const events = []
  if (input.events !== undefined) {
    if (!Array.isArray(input.events)) {
      errors.push('Channel events must be an array.')
    } else {
      const seen = new Set()
      for (let i = 0; i < input.events.length; i += 1) {
        const ev = input.events[i]
        if (typeof ev !== 'string' || !EVENT_KINDS.includes(ev)) {
          errors.push(`Unknown event kind: ${redactSecrets(String(ev))}`)
        } else if (!seen.has(ev)) {
          seen.add(ev)
          events.push(ev)
        }
      }
    }
  }

  let accountIds = null
  if (input.accountIds !== null && input.accountIds !== undefined) {
    if (!Array.isArray(input.accountIds)) {
      errors.push('Channel accountIds must be an array of strings or null.')
    } else {
      accountIds = []
      const seen = new Set()
      for (let i = 0; i < input.accountIds.length; i += 1) {
        const acc = input.accountIds[i]
        if (typeof acc !== 'string' || !acc.trim()) {
          errors.push('Account id in accountIds must be a non-empty string.')
        } else {
          const trimmed = acc.trim()
          if (!seen.has(trimmed)) {
            seen.add(trimmed)
            accountIds.push(trimmed)
          }
        }
      }
    }
  }

  let normalizedWebhookUrl
  let normalizedBotToken
  let normalizedChatId

  if (type === 'discord') {
    const rawUrl = typeof input.webhookUrl === 'string' ? input.webhookUrl.trim() : ''
    if (!rawUrl) {
      errors.push('Discord webhookUrl is required.')
    } else {
      let parsed
      try {
        parsed = new URL(rawUrl)
      } catch {
        errors.push('Discord webhookUrl is not a valid URL.')
      }
      if (parsed) {
        if (parsed.protocol !== 'https:') {
          errors.push('Discord webhookUrl must use https.')
        }
        if (parsed.username || parsed.password) {
          errors.push('Discord webhookUrl must not contain credentials.')
        }
        if (parsed.port) {
          errors.push('Discord webhookUrl must not specify a custom port.')
        }
        const host = parsed.hostname.toLowerCase()
        if (!ALLOWED_HOSTS.discord.includes(host)) {
          errors.push(`Discord webhookUrl host "${redactSecrets(host)}" is not allowlisted.`)
        }
        const pathMatch = DISCORD_WEBHOOK_PATH_RE.exec(parsed.pathname)
        if (!pathMatch) {
          errors.push('Discord webhookUrl path must match /api/webhooks/<digits>/<token>.')
        } else {
          rememberSecret(pathMatch[2])
        }
        if (errors.length === 0) {
          normalizedWebhookUrl = `https://${host}${parsed.pathname}`
          rememberSecret(normalizedWebhookUrl)
        }
      }
    }
  } else if (type === 'telegram') {
    const rawToken = typeof input.botToken === 'string' ? input.botToken.trim() : ''
    if (!rawToken || !TELEGRAM_TOKEN_RE.test(rawToken)) {
      errors.push('Telegram botToken is invalid.')
    } else {
      normalizedBotToken = rawToken
      rememberSecret(normalizedBotToken)
    }

    const rawChatId =
      typeof input.chatId === 'string'
        ? input.chatId.trim()
        : typeof input.chatId === 'number' && Number.isInteger(input.chatId)
          ? String(input.chatId)
          : ''
    if (!rawChatId || !TELEGRAM_CHAT_ID_RE.test(rawChatId)) {
      errors.push('Telegram chatId must be a numeric id or @channelusername.')
    } else {
      normalizedChatId = rawChatId
    }
  }

  const redactedErrors = errors.map((err) => redactSecrets(err))
  if (redactedErrors.length > 0) {
    return { channel: null, errors: redactedErrors }
  }

  const channel = {
    id,
    type,
    name,
    enabled,
    events,
    accountIds,
    includeTimestamp
  }
  if (type === 'discord') {
    channel.webhookUrl = normalizedWebhookUrl
  } else {
    channel.botToken = normalizedBotToken
    channel.chatId = normalizedChatId
  }

  return { channel, errors: [] }
}

async function readResponseBounded(response, maxBytes) {
  if (!response) return ''
  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const step = await reader.read()
        if (!step || step.done) break
        const value = step.value
        if (!value) continue
        const bytes = value instanceof Uint8Array ? value : Buffer.from(value)
        const remaining = maxBytes - total
        if (bytes.byteLength > remaining) {
          if (remaining > 0) {
            chunks.push(bytes.subarray(0, remaining))
            total += remaining
          }
          try { await reader.cancel() } catch {}
          break
        }
        chunks.push(bytes)
        total += bytes.byteLength
        if (total >= maxBytes) {
          try { await reader.cancel() } catch {}
          break
        }
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      const remaining = maxBytes - total
      if (bytes.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(bytes.subarray(0, remaining))
          total += remaining
        }
        try { body.destroy?.() } catch {}
        break
      }
      chunks.push(bytes)
      total += bytes.byteLength
      if (total >= maxBytes) {
        try { body.destroy?.() } catch {}
        break
      }
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  if (typeof response.text === 'function') {
    const text = await response.text()
    return Buffer.from(String(text || ''), 'utf8').subarray(0, maxBytes).toString('utf8')
  }

  if (typeof response.json === 'function') {
    const data = await response.json()
    const text = JSON.stringify(data)
    return Buffer.from(String(text || ''), 'utf8').subarray(0, maxBytes).toString('utf8')
  }

  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8')
  }

  return ''
}

function getHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const val = headers.get(name) ?? headers.get(name.toLowerCase())
    if (val !== undefined && val !== null) return String(val)
  }
  if (typeof headers === 'object') {
    const lower = name.toLowerCase()
    const keys = Object.keys(headers)
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].toLowerCase() === lower && headers[keys[i]] !== undefined && headers[keys[i]] !== null) {
        return String(headers[keys[i]])
      }
    }
  }
  return null
}

function parseRetryAfterMs(channelType, response, bodyText) {
  let retrySeconds = NaN

  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText)
      if (channelType === 'telegram') {
        const paramRetry = Number(parsed?.parameters?.retry_after ?? parsed?.retry_after)
        if (Number.isFinite(paramRetry) && paramRetry >= 0) {
          retrySeconds = paramRetry
        }
      } else {
        const discordRetry = Number(parsed?.retry_after)
        if (Number.isFinite(discordRetry) && discordRetry >= 0) {
          retrySeconds = discordRetry
        }
      }
    } catch {}
  }

  if (!Number.isFinite(retrySeconds)) {
    const headerVal = getHeader(response?.headers, 'retry-after')
    if (headerVal !== null) {
      const parsedHeader = Number(headerVal.trim())
      if (Number.isFinite(parsedHeader) && parsedHeader >= 0) {
        retrySeconds = parsedHeader
      }
    }
  }

  if (!Number.isFinite(retrySeconds) || retrySeconds <= 0) {
    return LIMITS.minSendIntervalMs
  }
  return Math.min(60000, Math.ceil(retrySeconds * 1000))
}

function createNotifier({
  fetchWithPolicy,
  getChannels,
  now = Date.now,
  timers = globalThis,
  onLog = () => {}
} = {}) {
  if (typeof fetchWithPolicy !== 'function') {
    throw new TypeError('fetchWithPolicy is required.')
  }
  if (typeof getChannels !== 'function') {
    throw new TypeError('getChannels is required.')
  }

  const channelStates = new Map()
  const activeTimers = new Set()
  const inFlightPromises = new Set()
  let disposed = false

  function safeNow() {
    try {
      const value = now()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function safeLog(entry) {
    try {
      if (typeof onLog !== 'function') return
      if (typeof entry === 'string') {
        onLog(redactSecrets(entry))
        return
      }
      if (entry && typeof entry === 'object') {
        const sanitized = {}
        const keys = Object.keys(entry)
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i]
          const val = entry[key]
          sanitized[key] = typeof val === 'string' ? redactSecrets(val) : val
        }
        onLog(sanitized)
      }
    } catch {}
  }

  function scheduleTimer(fn, delayMs) {
    const wait = Math.max(0, Math.floor(Number.isFinite(delayMs) ? delayMs : 0))
    let handle
    handle = timers.setTimeout(() => {
      activeTimers.delete(handle)
      if (disposed) return
      fn()
    }, wait)
    activeTimers.add(handle)
    return handle
  }

  function cancelTimer(handle) {
    if (handle === undefined || handle === null) return
    activeTimers.delete(handle)
    try {
      timers.clearTimeout(handle)
    } catch {}
  }

  function getState(channelId) {
    let state = channelStates.get(channelId)
    if (!state) {
      state = {
        pendingEvents: [],
        batchTimer: null,
        sending: false,
        consecutiveFailures: 0,
        lastOkAt: undefined,
        lastError: undefined,
        pausedUntil: undefined,
        nextAllowedSendAt: 0
      }
      channelStates.set(channelId, state)
    }
    return state
  }

  function readCurrentChannels() {
    try {
      const list = getChannels()
      if (!Array.isArray(list)) return []
      const slice = list.slice(0, LIMITS.maxChannels)
      for (let i = 0; i < slice.length; i += 1) {
        rememberChannelSecrets(slice[i])
      }
      return slice
    } catch (err) {
      safeLog({ level: 'error', event: 'get_channels_failed', message: err?.message || String(err) })
      return []
    }
  }

  function findChannelById(channelId) {
    const list = readCurrentChannels()
    for (let i = 0; i < list.length; i += 1) {
      const ch = list[i]
      if (ch && ch.id === channelId) return ch
    }
    return null
  }

  function buildRequestForChannel(validChannel, text) {
    if (validChannel.type === 'discord') {
      const urlObj = new URL(validChannel.webhookUrl)
      urlObj.searchParams.set('wait', 'false')
      const body = JSON.stringify({
        content: text,
        allowed_mentions: { parse: [] }
      })
      return { url: urlObj.toString(), body }
    }
    const url = `https://api.telegram.org/bot${validChannel.botToken}/sendMessage`
    const body = JSON.stringify({
      chat_id: validChannel.chatId,
      text,
      disable_web_page_preview: true
    })
    return { url, body }
  }

  async function executeHttpSend(validChannel, text) {
    const { url, body } = buildRequestForChannel(validChannel, text)
    const controller = new AbortController()
    let timeoutHandle = null
    timeoutHandle = scheduleTimer(() => {
      try {
        controller.abort(new Error(`Request timed out after ${LIMITS.requestTimeoutMs}ms`))
      } catch {
        controller.abort()
      }
    }, LIMITS.requestTimeoutMs)

    try {
      const headers = { 'content-type': 'application/json' }
      const init = {
        method: 'POST',
        headers,
        body,
        redirect: 'manual'
      }
      const response = await fetchWithPolicy(url, {
        maxRedirects: 0,
        signal: controller.signal,
        init,
        method: 'POST',
        headers,
        body,
        redirect: 'manual'
      })

      if (!response || typeof response.status !== 'number') {
        return { ok: false, status: 0, error: 'Invalid response from fetchWithPolicy.' }
      }

      const status = response.status
      const bodyText = await readResponseBounded(response, LIMITS.maxResponseBytes)

      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(validChannel.type, response, bodyText)
        return { ok: false, rateLimited: true, status: 429, retryAfterMs, error: 'HTTP 429 Too Many Requests' }
      }

      if (status >= 300 && status < 400) {
        try { await response.body?.cancel?.() } catch {}
        return { ok: false, status, error: `Unexpected redirect HTTP ${status}` }
      }

      if (status < 200 || status >= 300) {
        const detail = bodyText ? `: ${bodyText.slice(0, 200)}` : ''
        return { ok: false, status, error: redactSecrets(`HTTP ${status}${detail}`) }
      }

      if (validChannel.type === 'telegram' && bodyText) {
        try {
          const parsed = JSON.parse(bodyText)
          if (parsed && parsed.ok === false) {
            return {
              ok: false,
              status,
              error: redactSecrets(`Telegram API error: ${parsed.description || 'unknown'}`)
            }
          }
        } catch {}
      }

      return { ok: true, status }
    } catch (err) {
      const rawMessage = controller.signal.aborted
        ? `Request timed out after ${LIMITS.requestTimeoutMs}ms`
        : err?.message || String(err)
      return { ok: false, status: 0, error: redactSecrets(rawMessage) }
    } finally {
      cancelTimer(timeoutHandle)
    }
  }

  function scheduleChannelSend(channelId, delayMs) {
    if (disposed) return
    const state = getState(channelId)
    if (state.batchTimer !== null || state.sending) return
    if (state.pendingEvents.length === 0) return

    state.batchTimer = scheduleTimer(() => {
      state.batchTimer = null
      triggerChannelSend(channelId, false)
    }, delayMs)
  }

  function triggerChannelSend(channelId, ignoreRateInterval) {
    if (disposed) return Promise.resolve()
    const state = getState(channelId)
    if (state.sending) return Promise.resolve()
    if (state.pendingEvents.length === 0) return Promise.resolve()

    const nowTs = safeNow()
    if (state.pausedUntil !== undefined && nowTs < state.pausedUntil) {
      state.pendingEvents.length = 0
      return Promise.resolve()
    }

    if (!ignoreRateInterval && state.nextAllowedSendAt > nowTs) {
      const waitMs = state.nextAllowedSendAt - nowTs
      scheduleChannelSend(channelId, waitMs)
      return Promise.resolve()
    }

    const rawChannel = findChannelById(channelId)
    if (!rawChannel || !rawChannel.enabled) {
      state.pendingEvents.length = 0
      return Promise.resolve()
    }

    const validation = validateChannel(rawChannel)
    if (!validation.channel) {
      const errMsg = validation.errors.join('; ') || 'Invalid channel configuration.'
      state.pendingEvents.length = 0
      recordChannelFailure(channelId, state, errMsg)
      return Promise.resolve()
    }

    const validChannel = validation.channel
    const batch = state.pendingEvents.splice(0, state.pendingEvents.length)
    const maxChars = validChannel.type === 'discord' ? LIMITS.discordMaxChars : LIMITS.telegramMaxChars
    const text = formatBatchMessage(batch, validChannel.includeTimestamp, maxChars, safeNow)

    state.sending = true
    let sendPromise
    sendPromise = (async () => {
      try {
        const result = await executeHttpSend(validChannel, text)
        if (disposed) return

        const finishedAt = safeNow()
        if (result.ok) {
          state.consecutiveFailures = 0
          state.lastOkAt = finishedAt
          state.lastError = undefined
          state.pausedUntil = undefined
          state.nextAllowedSendAt = finishedAt + LIMITS.minSendIntervalMs
          safeLog({ level: 'info', event: 'sent', channelId, count: batch.length })
        } else if (result.rateLimited) {
          const delayMs = result.retryAfterMs
          state.nextAllowedSendAt = finishedAt + delayMs
          // Prepend the batch back so the rate-limited events are sent after the retry delay
          state.pendingEvents = batch.concat(state.pendingEvents)
          safeLog({
            level: 'warn',
            event: 'rate_limited',
            channelId,
            retryAfterMs: delayMs,
            message: redactSecrets(`Channel ${channelId} rate limited for ${delayMs}ms`)
          })
        } else {
          recordChannelFailure(channelId, state, result.error || 'Notification request failed.')
          state.nextAllowedSendAt = finishedAt + LIMITS.minSendIntervalMs
        }
      } catch (err) {
        if (!disposed) {
          recordChannelFailure(channelId, state, err?.message || String(err))
        }
      } finally {
        state.sending = false
        inFlightPromises.delete(sendPromise)
        if (!disposed && state.pendingEvents.length > 0 && state.batchTimer === null) {
          const nextNow = safeNow()
          if (state.pausedUntil !== undefined && nextNow < state.pausedUntil) {
            state.pendingEvents.length = 0
          } else {
            const waitMs = Math.max(0, state.nextAllowedSendAt - nextNow)
            scheduleChannelSend(channelId, waitMs)
          }
        }
      }
    })()

    inFlightPromises.add(sendPromise)
    return sendPromise
  }

  function recordChannelFailure(channelId, state, rawError) {
    const cleanError = redactSecrets(rawError || 'Notification error')
    state.consecutiveFailures += 1
    state.lastError = cleanError
    const currentNow = safeNow()

    if (state.consecutiveFailures >= LIMITS.failurePauseThreshold) {
      state.pausedUntil = currentNow + LIMITS.failurePauseMs
      state.pendingEvents.length = 0
      cancelTimer(state.batchTimer)
      state.batchTimer = null
      safeLog({
        level: 'warn',
        event: 'channel_paused',
        channelId,
        error: cleanError,
        pausedUntil: state.pausedUntil,
        message: redactSecrets(`Channel ${channelId} paused until ${state.pausedUntil}: ${cleanError}`)
      })
    } else {
      safeLog({
        level: 'error',
        event: 'send_failed',
        channelId,
        error: cleanError,
        consecutiveFailures: state.consecutiveFailures,
        message: redactSecrets(`Channel ${channelId} send failed (${state.consecutiveFailures}): ${cleanError}`)
      })
    }
  }

  function matchesChannelFilter(channel, event) {
    if (!channel || channel.enabled !== true) return false
    if (!Array.isArray(channel.events) || !channel.events.includes(event.kind)) return false
    if (channel.accountIds !== null && channel.accountIds !== undefined) {
      if (!Array.isArray(channel.accountIds)) return false
      if (!event.accountId || !channel.accountIds.includes(event.accountId)) return false
    }
    return true
  }

  function notify(event) {
    try {
      if (disposed) return
      if (!event || typeof event !== 'object') return
      if (typeof event.kind !== 'string' || !EVENT_KINDS.includes(event.kind)) return

      const channels = readCurrentChannels()
      const currentNow = safeNow()
      const normalizedEvent = {
        kind: event.kind,
        accountId: typeof event.accountId === 'string' ? event.accountId : undefined,
        accountName: typeof event.accountName === 'string' ? event.accountName : undefined,
        server: typeof event.server === 'string' ? event.server : undefined,
        message: typeof event.message === 'string' ? event.message : String(event.message ?? ''),
        payload: event.payload,
        at: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : currentNow
      }

      for (let i = 0; i < channels.length; i += 1) {
        const ch = channels[i]
        if (!ch || typeof ch.id !== 'string' || !ch.id.trim()) continue
        if (!matchesChannelFilter(ch, normalizedEvent)) continue

        const channelId = ch.id.trim()
        const state = getState(channelId)

        if (state.pausedUntil !== undefined) {
          if (currentNow < state.pausedUntil) {
            continue
          }
          state.pausedUntil = undefined
        }

        state.pendingEvents.push(normalizedEvent)
        if (state.batchTimer === null && !state.sending) {
          const earliestAt = Math.max(currentNow + LIMITS.batchWindowMs, state.nextAllowedSendAt)
          scheduleChannelSend(channelId, earliestAt - currentNow)
        }
      }
    } catch (err) {
      safeLog({ level: 'error', event: 'notify_error', message: err?.message || String(err) })
    }
  }

  async function test(channelId) {
    try {
      if (disposed) return { ok: false, error: 'Notifier is disposed.' }
      const rawChannel = findChannelById(channelId)
      if (!rawChannel) {
        return { ok: false, error: redactSecrets(`Channel "${String(channelId)}" not found.`) }
      }

      const validation = validateChannel(rawChannel)
      if (!validation.channel) {
        return {
          ok: false,
          error: redactSecrets(validation.errors.join('; ') || 'Invalid channel configuration.')
        }
      }

      const validChannel = validation.channel
      const state = getState(validChannel.id)
      const maxChars = validChannel.type === 'discord' ? LIMITS.discordMaxChars : LIMITS.telegramMaxChars
      const line = formatBatchMessage(
        [
          {
            kind: 'test',
            accountName: 'AFK Desk',
            server: 'test',
            message: 'Test notification',
            at: safeNow()
          }
        ],
        validChannel.includeTimestamp,
        maxChars,
        safeNow
      )

      const result = await executeHttpSend(validChannel, line)
      const finishedAt = safeNow()
      if (result.ok) {
        state.consecutiveFailures = 0
        state.lastOkAt = finishedAt
        state.lastError = undefined
        state.pausedUntil = undefined
        safeLog({ level: 'info', event: 'test_ok', channelId: validChannel.id })
        return { ok: true }
      }

      const errText = redactSecrets(result.error || 'Test notification failed.')
      safeLog({ level: 'warn', event: 'test_failed', channelId: validChannel.id, error: errText })
      return { ok: false, error: errText }
    } catch (err) {
      return { ok: false, error: redactSecrets(err?.message || String(err)) }
    }
  }

  function status() {
    const out = {}
    const channels = readCurrentChannels()
    for (let i = 0; i < channels.length; i += 1) {
      const ch = channels[i]
      if (ch && typeof ch.id === 'string' && ch.id.trim()) {
        getState(ch.id.trim())
      }
    }

    const currentNow = safeNow()
    channelStates.forEach((state, channelId) => {
      const entry = {}
      if (state.lastOkAt !== undefined) {
        entry.lastOkAt = state.lastOkAt
      }
      if (state.lastError !== undefined) {
        entry.lastError = redactSecrets(state.lastError)
      }
      if (state.pausedUntil !== undefined && currentNow < state.pausedUntil) {
        entry.pausedUntil = state.pausedUntil
      }
      out[redactSecrets(channelId)] = entry
    })
    return out
  }

  async function flush() {
    if (disposed) return
    const pendingPromises = Array.from(inFlightPromises)
    channelStates.forEach((state, channelId) => {
      if (state.batchTimer !== null) {
        cancelTimer(state.batchTimer)
        state.batchTimer = null
      }
      if (state.pendingEvents.length > 0 && !state.sending) {
        pendingPromises.push(triggerChannelSend(channelId, true))
      }
    })
    if (pendingPromises.length > 0) {
      await Promise.allSettled(pendingPromises)
    }
  }

  function dispose() {
    disposed = true
    activeTimers.forEach((handle) => {
      try {
        timers.clearTimeout(handle)
      } catch {}
    })
    activeTimers.clear()
    channelStates.forEach((state) => {
      state.batchTimer = null
      state.pendingEvents.length = 0
    })
  }

  return {
    notify,
    test,
    status,
    flush,
    dispose
  }
}

module.exports = {
  createNotifier,
  validateChannel,
  redactSecrets
}
