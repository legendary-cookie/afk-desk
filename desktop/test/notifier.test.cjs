'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LIMITS } = require('../electron/notify/contract.cjs')
const { createNotifier, validateChannel, redactSecrets } = require('../electron/notify/notifier.cjs')

function createFakeClock(initialMs = 1_700_000_000_000) {
  let currentMs = initialMs
  let nextId = 1
  const tasks = new Map()

  const timers = {
    setTimeout(fn, delayMs = 0) {
      const id = nextId++
      const wait = Math.max(0, Number(delayMs) || 0)
      tasks.set(id, { id, runAt: currentMs + wait, fn })
      return id
    },
    clearTimeout(id) {
      tasks.delete(id)
    }
  }

  function now() {
    return currentMs
  }

  function pendingCount() {
    return tasks.size
  }

  async function advance(ms) {
    const target = currentMs + Math.max(0, Number(ms) || 0)
    while (true) {
      let earliest = null
      tasks.forEach((task) => {
        if (task.runAt <= target) {
          if (!earliest || task.runAt < earliest.runAt || (task.runAt === earliest.runAt && task.id < earliest.id)) {
            earliest = task
          }
        }
      })
      if (!earliest) break
      tasks.delete(earliest.id)
      currentMs = earliest.runAt
      earliest.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
    currentMs = target
    await Promise.resolve()
    await Promise.resolve()
  }

  return { now, timers, advance, pendingCount }
}

function makeDiscordChannel(overrides = {}) {
  return {
    id: 'discord-1',
    type: 'discord',
    name: 'Alerts Discord',
    enabled: true,
    events: ['disconnected', 'kicked', 'banned', 'death', 'macro'],
    accountIds: null,
    includeTimestamp: false,
    webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/SecretDiscordToken_AbCdEf1234567890',
    ...overrides
  }
}

function makeTelegramChannel(overrides = {}) {
  return {
    id: 'tg-1',
    type: 'telegram',
    name: 'Alerts Telegram',
    enabled: true,
    events: ['disconnected', 'kicked', 'banned', 'death', 'macro'],
    accountIds: null,
    includeTimestamp: false,
    botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_99',
    chatId: '-100987654321',
    ...overrides
  }
}

test('validateChannel accepts valid Discord and Telegram channels and rejects invalid inputs', () => {
  // Valid Discord hosts
  for (const host of ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']) {
    const res = validateChannel(
      makeDiscordChannel({
        webhookUrl: `https://${host}/api/webhooks/999888777/ValidToken_123-abc`
      })
    )
    assert.equal(res.errors.length, 0)
    assert.ok(res.channel)
    assert.equal(res.channel.webhookUrl, `https://${host}/api/webhooks/999888777/ValidToken_123-abc`)
  }

  // Valid Telegram numeric, negative numeric, and @username chat IDs
  for (const chatId of ['123456789', '-1001234567890', '@my_alert_channel']) {
    const res = validateChannel(makeTelegramChannel({ chatId }))
    assert.equal(res.errors.length, 0)
    assert.ok(res.channel)
    assert.equal(res.channel.chatId, chatId)
  }

  // Bad Discord URLs: wrong host, http scheme, bad path, credentials, custom port
  const badDiscordUrls = [
    'http://discord.com/api/webhooks/123456/token123',
    'https://evil.example.com/api/webhooks/123456/token123',
    'https://discord.com.evil.com/api/webhooks/123456/token123',
    'https://discord.com/api/webhooks/not-digits/token123',
    'https://discord.com/api/webhooks/123456/',
    'https://discord.com/api/webhooks/123456/token/extra',
    'https://user:pass@discord.com/api/webhooks/123456/token123',
    'https://discord.com:8443/api/webhooks/123456/token123',
    'not-a-url',
    ''
  ]
  for (const badUrl of badDiscordUrls) {
    const res = validateChannel(makeDiscordChannel({ webhookUrl: badUrl }))
    assert.equal(res.channel, null, `Expected failure for URL: ${badUrl}`)
    assert.ok(res.errors.length > 0)
  }

  // Bad Telegram tokens
  const badTokens = [
    '1234:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_99', // <5 digits
    '123456789:short_token', // <30 chars token
    'not-a-token',
    '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw!@#$',
    ''
  ]
  for (const botToken of badTokens) {
    const res = validateChannel(makeTelegramChannel({ botToken }))
    assert.equal(res.channel, null, `Expected failure for token: ${botToken}`)
    assert.ok(res.errors.length > 0)
  }

  // Bad Telegram chat IDs
  const badChatIds = [
    '@abc', // <5 chars after @
    '@@channel_name',
    'not_a_number',
    '-',
    '123456789012345678901', // >20 digits
    ''
  ]
  for (const chatId of badChatIds) {
    const res = validateChannel(makeTelegramChannel({ chatId }))
    assert.equal(res.channel, null, `Expected failure for chatId: ${chatId}`)
    assert.ok(res.errors.length > 0)
  }
})

test('Discord body shape includes content, allowed_mentions: { parse: [] }, and ?wait=false', async () => {
  const clock = createFakeClock()
  const calls = []
  const channel = makeDiscordChannel({ includeTimestamp: true })

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      calls.push({ url, opts })
      return { status: 204 }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({
    kind: 'disconnected',
    accountId: 'acc-1',
    accountName: 'SteveBot',
    server: 'play.example.net',
    message: 'Connection reset @everyone',
    at: clock.now()
  })

  assert.equal(calls.length, 0)
  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(calls.length, 1)

  const call = calls[0]
  assert.equal(
    call.url,
    'https://discord.com/api/webhooks/123456789012345678/SecretDiscordToken_AbCdEf1234567890?wait=false'
  )
  const body = JSON.parse(call.opts.init.body)
  assert.deepEqual(body.allowed_mentions, { parse: [] })
  assert.ok(body.content.startsWith('[AFK Desk] SteveBot @ play.example.net: Connection reset @everyone'))
  assert.ok(body.content.includes(new Date(1_700_000_000_000).toISOString()))
})

test('Telegram body shape has chat_id, text, disable_web_page_preview: true, and NO parse_mode', async () => {
  const clock = createFakeClock()
  const calls = []
  const channel = makeTelegramChannel()

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      calls.push({ url, opts })
      return { status: 200, text: async () => JSON.stringify({ ok: true }) }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({
    kind: 'kicked',
    accountId: 'acc-1',
    accountName: 'AlexBot',
    server: 'lobby.example.org',
    message: '*bold* _italic_ [link](https://evil.example)',
    at: clock.now()
  })

  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(calls.length, 1)

  const call = calls[0]
  assert.equal(call.url, `https://api.telegram.org/bot${channel.botToken}/sendMessage`)
  const body = JSON.parse(call.opts.init.body)
  assert.equal(body.chat_id, '-100987654321')
  assert.equal(body.disable_web_page_preview, true)
  assert.equal('parse_mode' in body, false)
  assert.equal(body.text, '[AFK Desk] AlexBot @ lobby.example.org: *bold* _italic_ [link](https://evil.example)')
})

test('batching merges 3 events within batchWindowMs into one request and summarises >10 events with +N more', async () => {
  const clock = createFakeClock()
  const calls = []
  const channel = makeDiscordChannel()

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      calls.push(JSON.parse(opts.init.body))
      return { status: 204 }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({ kind: 'disconnected', accountName: 'Bot1', server: 'srv1', message: 'first', at: clock.now() })
  await clock.advance(500)
  notifier.notify({ kind: 'kicked', accountName: 'Bot2', server: 'srv1', message: 'second', at: clock.now() })
  await clock.advance(500)
  notifier.notify({ kind: 'death', accountName: 'Bot3', server: 'srv1', message: 'third', at: clock.now() })

  assert.equal(calls.length, 0)
  await clock.advance(LIMITS.batchWindowMs - 1000)
  assert.equal(calls.length, 1)

  const lines = calls[0].content.split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], '[AFK Desk] Bot1 @ srv1: first')
  assert.equal(lines[1], '[AFK Desk] Bot2 @ srv1: second')
  assert.equal(lines[2], '[AFK Desk] Bot3 @ srv1: third')

  // Overflow: 13 events -> 10 event lines + "+3 more"
  await clock.advance(LIMITS.minSendIntervalMs)
  for (let i = 1; i <= 13; i += 1) {
    notifier.notify({ kind: 'death', accountName: `Bot${i}`, server: 'srv', message: `event ${i}`, at: clock.now() })
  }
  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(calls.length, 2)
  const overflowLines = calls[1].content.split('\n')
  assert.equal(overflowLines.length, LIMITS.maxEventsPerMessage + 1)
  assert.equal(overflowLines[LIMITS.maxEventsPerMessage], '+3 more')
})

test('char-limit truncation caps Discord at 2000 chars and Telegram at 4096 chars', async () => {
  const clock = createFakeClock()
  const bodies = {}
  const discordCh = makeDiscordChannel({ id: 'd-trunc' })
  const telegramCh = makeTelegramChannel({ id: 't-trunc' })

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      const parsed = JSON.parse(opts.init.body)
      if (url.includes('discord.com')) {
        bodies.discord = parsed.content
        return { status: 204 }
      }
      bodies.telegram = parsed.text
      return { status: 200, text: async () => '{"ok":true}' }
    },
    getChannels: () => [discordCh, telegramCh],
    now: clock.now,
    timers: clock.timers
  })

  for (let i = 0; i < 10; i += 1) {
    notifier.notify({
      kind: 'disconnected',
      accountName: `LongAccountName_${i}`,
      server: 'very.long.server.hostname.example.com',
      message: 'X'.repeat(500),
      at: clock.now()
    })
  }

  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(bodies.discord.length, LIMITS.discordMaxChars)
  assert.equal(bodies.telegram.length, LIMITS.telegramMaxChars)
})

test('filters events by channel.enabled, channel.events, and channel.accountIds', async () => {
  const clock = createFakeClock()
  const sentTo = []
  const channels = [
    makeDiscordChannel({ id: 'disabled-ch', enabled: false, events: ['disconnected'] }),
    makeDiscordChannel({ id: 'events-only-death', enabled: true, events: ['death'] }),
    makeDiscordChannel({ id: 'acc-filtered', enabled: true, events: ['disconnected'], accountIds: ['acc-allowed'] }),
    makeDiscordChannel({ id: 'all-accounts', enabled: true, events: ['disconnected'], accountIds: null })
  ]

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      sentTo.push(JSON.parse(opts.init.body).content)
      return { status: 204 }
    },
    getChannels: () => channels,
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({
    kind: 'disconnected',
    accountId: 'acc-other',
    accountName: 'OtherBot',
    server: 'mc.test',
    message: 'dropped',
    at: clock.now()
  })

  await clock.advance(LIMITS.batchWindowMs)
  // Only 'all-accounts' should receive it
  assert.equal(sentTo.length, 1)

  notifier.notify({
    kind: 'disconnected',
    accountId: 'acc-allowed',
    accountName: 'AllowedBot',
    server: 'mc.test',
    message: 'dropped allowed',
    at: clock.now()
  })

  await clock.advance(LIMITS.batchWindowMs)
  // Now both 'acc-filtered' and 'all-accounts' receive it
  assert.equal(sentTo.length, 3)
})

test('429 handling delays Discord and Telegram channels without counting as failure and caps at 60s', async () => {
  const clock = createFakeClock()
  let discordAttempts = 0
  let telegramAttempts = 0

  const discordCh = makeDiscordChannel({ id: 'd-429' })
  const telegramCh = makeTelegramChannel({ id: 't-429' })

  const notifier = createNotifier({
    fetchWithPolicy: async (url) => {
      if (url.includes('discord.com')) {
        discordAttempts += 1
        if (discordAttempts === 1) {
          return {
            status: 429,
            headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '5' : null) },
            text: async () => JSON.stringify({ retry_after: 4.2 })
          }
        }
        return { status: 204 }
      }
      telegramAttempts += 1
      if (telegramAttempts === 1) {
        return {
          status: 429,
          text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 180 } })
        }
      }
      return { status: 200, text: async () => JSON.stringify({ ok: true }) }
    },
    getChannels: () => [discordCh, telegramCh],
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({
    kind: 'disconnected',
    accountName: 'Bot',
    server: 'srv',
    message: 'rate limit test',
    at: clock.now()
  })

  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(discordAttempts, 1)
  assert.equal(telegramAttempts, 1)

  // Neither channel should have recorded an error or pause
  const st1 = notifier.status()
  assert.equal(st1['d-429'].lastError, undefined)
  assert.equal(st1['d-429'].pausedUntil, undefined)
  assert.equal(st1['t-429'].lastError, undefined)
  assert.equal(st1['t-429'].pausedUntil, undefined)

  // Discord retry_after is 4.2s -> ceil to 4200ms
  await clock.advance(4199)
  assert.equal(discordAttempts, 1)
  await clock.advance(1)
  assert.equal(discordAttempts, 2)

  // Telegram retry_after was 180s -> capped at 60,000ms total from first attempt
  await clock.advance(60000 - 4200 - 1)
  assert.equal(telegramAttempts, 1)
  await clock.advance(1)
  assert.equal(telegramAttempts, 2)
})

test('failure pause after 3 consecutive errors and recovery after pause window', async () => {
  const clock = createFakeClock()
  let shouldFail = true
  let attempts = 0
  const channel = makeDiscordChannel({ id: 'ch-pause' })

  const notifier = createNotifier({
    fetchWithPolicy: async () => {
      attempts += 1
      if (shouldFail) {
        return { status: 500, text: async () => 'Internal Server Error' }
      }
      return { status: 204 }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  // 3 consecutive failures
  for (let i = 1; i <= 3; i += 1) {
    notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: `fail ${i}`, at: clock.now() })
    await clock.advance(LIMITS.batchWindowMs)
  }

  assert.equal(attempts, 3)
  const pausedStatus = notifier.status()['ch-pause']
  assert.ok(pausedStatus.lastError)
  assert.equal(pausedStatus.pausedUntil, clock.now() + LIMITS.failurePauseMs)

  // Events while paused are ignored
  notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'ignored', at: clock.now() })
  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(attempts, 3)

  // Advance past pause duration and recover
  await clock.advance(LIMITS.failurePauseMs)
  shouldFail = false
  notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'recovered', at: clock.now() })
  await clock.advance(LIMITS.batchWindowMs)

  assert.equal(attempts, 4)
  const recoveredStatus = notifier.status()['ch-pause']
  assert.equal(recoveredStatus.lastOkAt, clock.now())
  assert.equal(recoveredStatus.lastError, undefined)
  assert.equal(recoveredStatus.pausedUntil, undefined)
})

test('secrets never appear in onLog, status, or errors', async () => {
  const clock = createFakeClock()
  const logs = []
  const discordSecret = 'SuperSecretWebhookToken_998877665544332211'
  const telegramSecret = '987654321:AAH_SuperSecretTelegramToken_ZzYyXxWwVvUuTtSs'

  const discordCh = makeDiscordChannel({
    id: 'sec-d',
    webhookUrl: `https://discord.com/api/webhooks/1122334455/${discordSecret}`
  })
  const telegramCh = makeTelegramChannel({
    id: 'sec-t',
    botToken: telegramSecret
  })

  // Direct redactSecrets checks
  assert.equal(
    redactSecrets(`Error posting to https://discord.com/api/webhooks/1122334455/${discordSecret}`),
    'Error posting to [redacted]'
  )
  assert.equal(
    redactSecrets(`Error posting to https://api.telegram.org/bot${telegramSecret}/sendMessage`),
    'Error posting to [redacted]'
  )
  assert.equal(redactSecrets(`Token is ${telegramSecret}`), 'Token is [redacted]')

  const notifier = createNotifier({
    fetchWithPolicy: async (url) => {
      throw new Error(`Connection refused for ${url} using ${discordSecret} and ${telegramSecret}`)
    },
    getChannels: () => [discordCh, telegramCh],
    now: clock.now,
    timers: clock.timers,
    onLog: (entry) => logs.push(entry)
  })

  notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'boom', at: clock.now() })
  await clock.advance(LIMITS.batchWindowMs)

  const testResD = await notifier.test('sec-d')
  const testResT = await notifier.test('sec-t')
  assert.equal(testResD.ok, false)
  assert.equal(testResT.ok, false)

  const serializedAll = JSON.stringify({
    logs,
    status: notifier.status(),
    testResD,
    testResT
  })

  assert.equal(serializedAll.includes(discordSecret), false, 'Discord token leaked')
  assert.equal(serializedAll.includes(telegramSecret), false, 'Telegram token leaked')
})

test('sanitizes email addresses, Minecraft § colour codes, and control characters', async () => {
  const clock = createFakeClock()
  let sentContent = ''
  const channel = makeDiscordChannel()

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      sentContent = JSON.parse(opts.init.body).content
      return { status: 204 }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  notifier.notify({
    kind: 'kicked',
    accountName: '§aPlayer_One§r (owner@example.com)',
    server: '§6mc.server.org\n\r\t\x07',
    message: '§cKicked: contact admin@server.io\nSecond line\x00\x1b[31m!',
    at: clock.now()
  })

  await clock.advance(LIMITS.batchWindowMs)
  assert.equal(
    sentContent,
    '[AFK Desk] Player_One ([redacted-email]) @ mc.server.org: Kicked: contact [redacted-email] Second line[31m!'
  )
  assert.equal(sentContent.includes('§'), false)
  assert.equal(sentContent.includes('owner@example.com'), false)
  assert.equal(sentContent.includes('admin@server.io'), false)
})

test('test() bypasses batching and pausing, and flush() sends pending batches immediately', async () => {
  const clock = createFakeClock()
  const calls = []
  const channel = makeDiscordChannel({ id: 'ch-test', enabled: false, events: [] })

  let failMode = true
  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      calls.push(JSON.parse(opts.init.body).content)
      if (failMode) return { status: 503, text: async () => 'Unavailable' }
      return { status: 204 }
    },
    getChannels: () => [{ ...channel, enabled: true, events: ['disconnected'] }],
    now: clock.now,
    timers: clock.timers
  })

  // Trigger 3 failures to pause the channel
  for (let i = 0; i < 3; i += 1) {
    notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'err', at: clock.now() })
    await clock.advance(LIMITS.batchWindowMs)
  }
  assert.ok(notifier.status()['ch-test'].pausedUntil)

  // test() bypasses pause and sends immediately without advancing timers
  failMode = false
  const beforeTestCalls = calls.length
  const res = await notifier.test('ch-test')
  assert.equal(res.ok, true)
  assert.equal(calls.length, beforeTestCalls + 1)

  // Queue an event and flush() immediately without advancing the batch timer
  notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'flushed now', at: clock.now() })
  assert.equal(calls.length, beforeTestCalls + 1)
  await notifier.flush()
  assert.equal(calls.length, beforeTestCalls + 2)
  assert.ok(calls[calls.length - 1].includes('flushed now'))
})

test('notify() never throws even when fetchWithPolicy or getChannels throws synchronously, and dispose() clears timers', async () => {
  const clock = createFakeClock()
  const channel = makeDiscordChannel()

  const notifier = createNotifier({
    fetchWithPolicy: () => {
      throw new Error('Synchronous fetch failure')
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  assert.doesNotThrow(() => {
    notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'sync throw', at: clock.now() })
  })

  await clock.advance(LIMITS.batchWindowMs)
  assert.ok(notifier.status()[channel.id].lastError.includes('Synchronous fetch failure'))

  // Queue another event, then dispose() before timer fires
  notifier.notify({ kind: 'disconnected', accountName: 'Bot', server: 'srv', message: 'before dispose', at: clock.now() })
  assert.ok(clock.pendingCount() > 0)
  notifier.dispose()
  assert.equal(clock.pendingCount(), 0)
})

test('enforces requestTimeoutMs via AbortSignal, treats 3xx as failure, and caps response reads at maxResponseBytes', async () => {
  const clock = createFakeClock()
  const channel = makeDiscordChannel({ id: 'ch-policy' })
  let mode = 'redirect'
  let bytesRead = 0

  const notifier = createNotifier({
    fetchWithPolicy: async (url, opts) => {
      assert.equal(opts.maxRedirects, 0)
      assert.ok(opts.signal)
      if (mode === 'redirect') {
        return { status: 302, headers: { get: () => 'https://discord.com/other' } }
      }
      if (mode === 'timeout') {
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new Error('Aborted by signal'))
          })
        })
      }
      // Large streaming response exceeding maxResponseBytes
      const chunk = Buffer.alloc(16 * 1024, 0x61)
      return {
        status: 500,
        body: {
          getReader() {
            return {
              async read() {
                bytesRead += chunk.byteLength
                return { done: false, value: chunk }
              },
              async cancel() {},
              releaseLock() {}
            }
          }
        }
      }
    },
    getChannels: () => [channel],
    now: clock.now,
    timers: clock.timers
  })

  // 1) 3xx redirect treated as failure
  const resRedirect = await notifier.test('ch-policy')
  assert.equal(resRedirect.ok, false)
  assert.ok(resRedirect.error.includes('302'))

  // 2) Timeout via AbortSignal
  mode = 'timeout'
  const testPromise = notifier.test('ch-policy')
  await clock.advance(LIMITS.requestTimeoutMs)
  const resTimeout = await testPromise
  assert.equal(resTimeout.ok, false)
  assert.ok(resTimeout.error.includes('timed out'))

  // 3) Bounded response read at LIMITS.maxResponseBytes
  mode = 'huge-body'
  const resHuge = await notifier.test('ch-policy')
  assert.equal(resHuge.ok, false)
  assert.equal(bytesRead, LIMITS.maxResponseBytes)
})

