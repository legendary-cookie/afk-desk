// Destination policy for client-initiated HTTP(S) requests whose URL is chosen
// by a remote Minecraft server (resource packs). Prevents SSRF against
// loopback / private / link-local networks, including via redirects.
//
// Known limit: the address check resolves the host separately from the later
// connection made by fetch(), so a DNS-rebinding server that answers differently
// to the second lookup is not covered. Closing that needs a pinned-IP dispatcher.
const dns = require('node:dns')
const net = require('node:net')

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

class HostPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostPolicyError'
  }
}

function parseIPv4(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return bytes.every((value) => value >= 0 && value <= 255) ? bytes : null
}

function parseIPv6(text) {
  let value = String(text).split('%')[0]
  if (!net.isIPv6(value)) return null
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (groups.length !== 8) return null
  const bytes = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const number = parseInt(group, 16)
    bytes.push(number >> 8, number & 0xff)
  }
  return bytes
}

function isBlockedIPv4(b) {
  const [a, c] = b
  return a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT 100.64/10
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    a >= 224 // multicast 224/4 and reserved/broadcast 240/4
}

function isBlockedIPv6(b) {
  const allZeroPrefix = b.slice(0, 10).every((value) => value === 0)
  if (allZeroPrefix && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4(b.slice(12)) // IPv4-mapped
  if (b.slice(0, 12).every((value) => value === 0)) return true // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) { // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48
    if (b.slice(4, 12).every((value) => value === 0)) return isBlockedIPv4(b.slice(12))
    return true
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6)) // 6to4 embeds an IPv4 address
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 deprecated site local
  if (b[0] === 0xff) return true // multicast
  return false
}

// Fails closed: anything that is not a parseable IP address is blocked.
function isBlockedAddress(address) {
  const text = String(address || '').trim().replace(/^\[|\]$/g, '')
  if (net.isIPv4(text)) return isBlockedIPv4(parseIPv4(text))
  const v6 = parseIPv6(text)
  return v6 ? isBlockedIPv6(v6) : true
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

async function assertPublicHost(hostname, { lookup = dns.promises.lookup, allowPrivateHosts = false } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host) throw new HostPolicyError('Resource pack URL has no host.')
  if (allowPrivateHosts) return
  if (host === 'localhost' || host.endsWith('.localhost')) throw new HostPolicyError('Resource pack host is not allowed (loopback).')
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new HostPolicyError('Resource pack host is not allowed (private or loopback address).')
    return
  }
  let records
  try { records = await lookup(host, { all: true }) } catch { throw new HostPolicyError('Resource pack host could not be resolved.') }
  const addresses = (Array.isArray(records) ? records : [records]).map((record) => (typeof record === 'string' ? record : record?.address))
  if (!addresses.length || addresses.some((address) => !address || isBlockedAddress(address))) {
    throw new HostPolicyError('Resource pack host is not allowed (private or loopback address).')
  }
}

function parseHttpUrl(value) {
  const url = value instanceof URL ? new URL(value.href) : new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new HostPolicyError('Resource pack URL must use HTTP or HTTPS.')
  return url
}

// fetch() wrapper: every hop (initial URL and each redirect target) is validated
// and redirects are followed manually, at most `maxRedirects` times.
async function fetchWithPolicy(urlValue, { fetchImpl = globalThis.fetch, lookup, allowPrivateHosts = false, maxRedirects = MAX_REDIRECTS, signal, init = {} } = {}) {
  let url = parseHttpUrl(urlValue)
  for (let hop = 0; ; hop++) {
    if (signal?.aborted) throw signal.reason || new Error('Request aborted.')
    await assertPublicHost(hostnameOf(url), { lookup, allowPrivateHosts })
    const response = await fetchImpl(url, { ...init, signal, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response?.status)) return response
    try { await response.body?.cancel?.() } catch {}
    const location = response.headers?.get?.('location')
    if (!location) throw new HostPolicyError('Resource pack redirect had no Location header.')
    if (hop >= maxRedirects) throw new HostPolicyError(`Resource pack redirected more than ${maxRedirects} times.`)
    let next
    try { next = new URL(location, url) } catch { throw new HostPolicyError('Resource pack redirect target is invalid.') }
    url = parseHttpUrl(next)
  }
}

module.exports = { MAX_REDIRECTS, HostPolicyError, isBlockedAddress, assertPublicHost, fetchWithPolicy }
