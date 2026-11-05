const { redactDiagnostic } = require('./diagnostic-log.cjs')
const { redactSecrets } = require('./notify/notifier.cjs')
const { maskText, label } = require('../src/streamer-mask.js')
const INTERVAL = 12 * 60 * 60 * 1000
function parseVersion(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value))
  if (!m) return null
  const pre = m[4]?.split('.') || []
  if (pre.some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null
  return { numbers: m.slice(1, 4).map(BigInt), pre }
}
function compareVersions(a, b) {
  a = parseVersion(a); b = parseVersion(b)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
function shouldCheck(last, now = Date.now()) { return !Number.isFinite(last) || last <= 0 || now < last || now - last >= INTERVAL }
function makeBundle({ version, os, settings, accounts, logs }) {
  function clean(value, key = '') {
    if (/password|token|secret|authorization|credential|api.?key|webhook|chat.?id/i.test(key) || /^(?:code|user_?code|device_?code)$/i.test(key)) return '[redacted]'
    if (typeof value === 'string') return redactSecrets(redactDiagnostic(maskText(value, accounts, true).replace(/(^|[\s:>])\/?(login|l|register|reg|changepassword|cp|2fa|auth|authenticate|password|passwd|pass|otp|verify)(?=\s)\s+[^\r\n]*/gim, '$1$2 [redacted]'))) 
    if (Array.isArray(value)) return value.map(v => clean(v))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), clean(v, k)]))
    return value
  }
  return JSON.stringify({ version: clean(version), os: clean(os), settings: clean(settings), accounts: accounts.map(a => ({ name: clean(label(a)), console: clean(logs[a.id]?.console || []), events: clean(logs[a.id]?.events || []) })) }, null, 2)
}
module.exports = { compareVersions, shouldCheck, makeBundle, INTERVAL }
