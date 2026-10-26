'use strict'
// Notification service contract (Discord webhooks + Telegram bots). Outbound only:
// AFK Desk SENDS alerts; it never accepts commands from Discord/Telegram (remote
// control needs an auth design first). Implemented in electron/notify/notifier.cjs,
// wired by main.cjs (Stage 2). Node 18 compatible (may later run in the Android engine).

const EVENT_KINDS = Object.freeze([
  'connected', // account joined a server
  'disconnected', // connection lost (payload.reason)
  'kicked', // kicked by server (payload.reason)
  'banned', // kick reason looks like a ban
  'reconnecting', // auto-reconnect scheduled (payload.delaySeconds)
  'death', // bot died (payload.deathMessage)
  'lowHealth', // health crossed below threshold
  'inventoryFull',
  'macro', // macro notify step or macro failure (payload.macroName, payload.status)
  'test' // "send test message" button
])

const CHANNEL_TYPES = Object.freeze(['discord', 'telegram'])

const LIMITS = Object.freeze({
  maxChannels: 10,
  batchWindowMs: 2000, // events within this window are merged into one message per channel
  maxEventsPerMessage: 10,
  discordMaxChars: 2000,
  telegramMaxChars: 4096,
  requestTimeoutMs: 10000,
  maxResponseBytes: 64 * 1024,
  failurePauseThreshold: 3, // consecutive failures …
  failurePauseMs: 5 * 60 * 1000, // … pause that channel this long
  minSendIntervalMs: 1000 // per channel
})

/**
 * @typedef {Object} Channel
 * @property {string} id
 * @property {'discord'|'telegram'} type
 * @property {string} name                 user label, ≤ 40 chars
 * @property {boolean} enabled
 * @property {string[]} events             subset of EVENT_KINDS (empty = none)
 * @property {string[]|null} accountIds    null = all accounts
 * @property {boolean} [includeTimestamp]
 * Secrets (only ever in memory after decryption; persisted encrypted by main.cjs):
 * @property {string} [webhookUrl]         discord: https://discord.com/api/webhooks/{id}/{token} (or discordapp.com)
 * @property {string} [botToken]           telegram: "<digits>:<token>"
 * @property {string} [chatId]             telegram: numeric id or @channelusername
 *
 * @typedef {Object} NotifyEvent
 * @property {(typeof EVENT_KINDS)[number]} kind
 * @property {string} [accountId]
 * @property {string} [accountName]        display name; never an email address
 * @property {string} [server]
 * @property {string} message              plain text, ≤ 500 chars (truncated)
 * @property {Object} [payload]
 * @property {number} at                   epoch ms
 */

/**
 * module.exports = { createNotifier, validateChannel, redactSecrets }
 *
 * createNotifier({
 *   fetchWithPolicy,               // desktop/electron/net-policy.cjs export (manual redirects, public hosts)
 *   getChannels: () => Channel[],  // decrypted, current
 *   now = Date.now, timers = globalThis, onLog = (entry) => {}
 * }) => {
 *   notify(event: NotifyEvent): void           // never throws, never blocks the caller (fire-and-forget)
 *   test(channelId): Promise<{ ok: boolean, error?: string }>  // sends kind 'test' immediately, bypasses batching
 *   status(): { [channelId]: { lastOkAt?, lastError?, pausedUntil? } }
 *   flush(): Promise<void>                     // send pending batches now (app quit)
 *   dispose(): void
 * }
 *
 * validateChannel(input): { channel: Channel|null, errors: string[] }
 *   Strict URL/token/chat-id validation; only the allowlisted hosts below.
 * redactSecrets(text): string
 *   Replaces any webhook token, bot token or full webhook URL with "[redacted]". Every log line,
 *   error message and status() value must pass through this.
 */

const ALLOWED_HOSTS = Object.freeze({
  discord: ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'],
  telegram: ['api.telegram.org']
})

module.exports = { EVENT_KINDS, CHANNEL_TYPES, LIMITS, ALLOWED_HOSTS }
