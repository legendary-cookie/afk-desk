'use strict'
const { gzipSync, gunzipSync } = require('node:zlib')

const MAX_SIZE = 256 * 1024
// Only connection and non-text behavior settings are portable. In particular,
// automatic chat, proxy credentials, identities and embedded automations stay local.
const PROFILE_FIELDS = ['host', 'port', 'edition', 'profileName', 'version', 'modLoader', 'modHandshake', 'clientBrand', 'mods', 'modChannels', 'antiAfk', 'antiAfkInterval', 'antiAfkMinDelay', 'antiAfkMaxDelay', 'antiAfkActionDuration', 'antiAfkWalkDistance', 'antiAfkLookDegrees', 'antiAfkJump', 'antiAfkLook', 'antiAfkSneak', 'antiAfkSwing', 'antiAfkWalk', 'environmentalMovement', 'autoReconnect', 'autoReconnectDelay', 'autoReconnectBackoffMultiplier', 'autoReconnectMaxDelay', 'autoReconnectRateLimitDelay', 'autoReconnectMaxAttempts', 'connectTimeoutSeconds', 'reconnectResetDelay', 'autoDepositToChest', 'autoDepositRange', 'autoDepositMode', 'autoDepositInterval', 'autoDepositFullThreshold', 'lockedInventorySlots', 'alerts']
function profileData(input) {
  const result = Object.fromEntries(PROFILE_FIELDS.filter(key => Object.hasOwn(input, key) && (input[key] === null || ['string', 'number', 'boolean'].includes(typeof input[key]))).map(key => [key, input[key]]))
  if (Array.isArray(input.mods)) result.mods = input.mods.map(mod => ({ modid: String(mod?.modid || ''), version: String(mod?.version || '') }))
  if (Array.isArray(input.modChannels)) result.modChannels = input.modChannels.filter(x => typeof x === 'string')
  if (Array.isArray(input.lockedInventorySlots)) result.lockedInventorySlots = input.lockedInventorySlots.filter(Number.isInteger)
  if (input.alerts && typeof input.alerts === 'object') result.alerts = { disconnect: input.alerts.disconnect, errors: input.alerts.errors, healthBelow: input.alerts.healthBelow }
  return result
}
function macroData(input, model) {
  const macro = model.normalizeMacro(input)
  macro.id = undefined
  macro.origin = {}
  macro.notify = {}
  macro.enabled = false
  macro.targets = { mode: 'accounts', accountIds: [] }
  // Arbitrary macro text can contain passwords, account names or webhook URLs.
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|webhook|account|username|uuid/i.test(key)).map(([key, val]) => [key, typeof val === 'string' && !['type', 'mode', 'concurrency', 'onError', 'comparator', 'match', 'source'].includes(key) ? '' : clean(val)]))
  }
  const result = clean(macro)
  result.name = 'Shared macro'
  return result
}
function encode(kind, data) {
  if (!['profile', 'macro'].includes(kind)) throw new Error('Unknown share kind.')
  const json = JSON.stringify({ version: 1, data })
  if (Buffer.byteLength(json) > MAX_SIZE) throw new Error('Share data is too large.')
  return `afkdesk://share/${kind}/${gzipSync(json).toString('base64url')}`
}
function decode(link) {
  if (typeof link !== 'string' || link.length > MAX_SIZE) throw new Error('Invalid share link.')
  const match = /^afkdesk:\/\/share\/(profile|macro)\/([A-Za-z0-9_-]+)$/.exec(link.trim())
  if (!match) throw new Error('Invalid share link.')
  let parsed
  try { parsed = JSON.parse(gunzipSync(Buffer.from(match[2], 'base64url'), { maxOutputLength: MAX_SIZE }).toString('utf8')) } catch { throw new Error('Invalid share data.') }
  if (!parsed || parsed.version !== 1 || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new Error('Unsupported or invalid share data.')
  return { kind: match[1], data: parsed.data }
}
module.exports = { encode, decode, profileData, macroData }
