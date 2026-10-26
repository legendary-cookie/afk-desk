'use strict'
// Shared remote command layer contract (docs/design/remote-control.md §6).
// Every remote surface — HTTP API, Discord bot, later Telegram — acts ONLY through
// these commands. Node 18 compatible, CommonJS, no Electron imports.

const SCOPES = Object.freeze(['read', 'control', 'admin']) // ordered: admin ⊃ control ⊃ read

function scopeAllows(granted, required) {
  return SCOPES.indexOf(granted) >= 0 && SCOPES.indexOf(granted) >= SCOPES.indexOf(required)
}

// arg types: 'accountId' (existing account id), 'macroId', 'text' ({max}), 'int' ({min,max}), 'bool', 'slot' (0..44)
const COMMANDS = Object.freeze({
  'status': { scope: 'read', danger: 'none', args: {} },
  'account.info': { scope: 'read', danger: 'none', args: { accountId: { type: 'accountId', required: true } } },
  'account.connect': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true } } },
  'account.disconnect': { scope: 'control', danger: 'confirm', args: { accountId: { type: 'accountId', required: true } } },
  'account.reconnect': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true } } },
  'chat.send': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true }, message: { type: 'text', max: 256, required: true } } },
  'chat.recent': { scope: 'read', danger: 'none', args: { accountId: { type: 'accountId', required: true }, limit: { type: 'int', min: 1, max: 50 } } },
  'inventory.view': { scope: 'read', danger: 'none', args: { accountId: { type: 'accountId', required: true } } },
  'inventory.drop': { scope: 'control', danger: 'confirm', args: { accountId: { type: 'accountId', required: true }, slot: { type: 'slot', required: true }, count: { type: 'int', min: 1, max: 64 } } },
  'macro.list': { scope: 'read', danger: 'none', args: { accountId: { type: 'accountId' } } },
  'macro.run': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true }, macroId: { type: 'macroId', required: true } } },
  'macro.stop': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true } } },
  'antiAfk.set': { scope: 'control', danger: 'none', args: { accountId: { type: 'accountId', required: true }, enabled: { type: 'bool', required: true } } },
  'connectAll': { scope: 'control', danger: 'confirm', args: {} },
  'disconnectAll': { scope: 'control', danger: 'confirm', args: {} },
  'notify.test': { scope: 'admin', danger: 'none', args: { channelId: { type: 'text', max: 80, required: true } } },
  'audit.recent': { scope: 'admin', danger: 'none', args: { limit: { type: 'int', min: 1, max: 200 } } }
})

const LIMITS = Object.freeze({
  maxPayloadBytes: 256 * 1024,
  perActorPerMinute: 60,
  confirmTtlMs: 60_000
})

/**
 * Actor = { kind: 'session'|'token'|'discord'|'telegram'|'local', id: string, scope: 'read'|'control'|'admin', ip?: string }
 *
 * Implementation (desktop/core/commands.cjs):
 *   createCommandLayer({ core, audit, now, timers }) => {
 *     list(actor): { name, scope, danger, args }[]          commands this actor may use
 *     execute(actor, name, args, { confirmed = false }): Promise<{ ok: true, result } |
 *         { ok: false, error: { code: 'FORBIDDEN'|'INVALID'|'NOT_FOUND'|'CONFIRM_REQUIRED'|'RATE_LIMITED'|'OFFLINE'|'FAILED', message } }>
 *       - never throws; validates args against COMMANDS; enforces scopeAllows; per-actor rate limit;
 *         danger 'confirm' without confirmed → CONFIRM_REQUIRED; audits every call (allowed or not).
 *     accountsFor(actor): { id, name }[]                     for autocomplete
 *     macrosFor(actor, accountId?): { id, name }[]
 *   }
 * Results never contain credentials, tokens, emails or secrets (display names only).
 */

module.exports = { SCOPES, scopeAllows, COMMANDS, LIMITS }
