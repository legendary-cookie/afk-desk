const test = require('node:test')
const assert = require('node:assert/strict')
const { HostPolicyError, isBlockedAddress, fetchWithPolicy } = require('../electron/net-policy.cjs')

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('embedded-IPv4 IPv6 forms and private ranges are blocked; public addresses are not', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::', '::1', '::10.0.0.1', '::7f00:1', '::ffff:192.168.1.1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedAddress(address), false, address)
  }
})

test('numeric and hex IPv4 literals are normalised by URL parsing and blocked before fetch', async () => {
  for (const literal of ['http://2130706433/p.zip', 'http://0x7f.1/p.zip', 'http://[::10.0.0.1]/p.zip', 'http://127.0.0.1./p.zip']) {
    let fetched = false
    await assert.rejects(fetchWithPolicy(literal, { lookup: publicLookup, fetchImpl: async () => { fetched = true } }), HostPolicyError, literal)
    assert.equal(fetched, false, literal)
  }
})

test('credentialed URLs are rejected on the first hop and on redirects', async () => {
  let fetched = false
  await assert.rejects(fetchWithPolicy('https://user:secret@packs.example/p.zip', { lookup: publicLookup, fetchImpl: async () => { fetched = true } }), /credentials/)
  assert.equal(fetched, false)

  let calls = 0
  const redirecting = async () => {
    calls++
    return { status: 302, headers: new Headers({ location: 'https://user:secret@other.example/p.zip' }), body: null }
  }
  await assert.rejects(fetchWithPolicy('https://packs.example/p.zip', { lookup: publicLookup, fetchImpl: redirecting }), /credentials/)
  assert.equal(calls, 1)
})
