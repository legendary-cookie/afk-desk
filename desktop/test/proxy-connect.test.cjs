const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { EventEmitter, once } = require('node:events')
const { createProxyConnect, formatAuthority } = require('../electron/proxy-connect.cjs')

test('HTTP proxy transport creates an authenticated CONNECT tunnel', async (t) => {
  let request = ''
  const proxyServer = net.createServer((socket) => socket.once('data', (chunk) => {
    request = chunk.toString('latin1')
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
  }))
  proxyServer.listen(0, '127.0.0.1')
  await once(proxyServer, 'listening')
  t.after(() => proxyServer.close())

  const client = new EventEmitter()
  client.setSocket = (socket) => { client.socket = socket }
  const connect = createProxyConnect({
    enabled: true, type: 'http', host: '127.0.0.1', port: proxyServer.address().port,
    username: 'proxy-user', password: 'proxy-pass'
  }, { host: 'play.example.com', port: 25565 })
  connect(client)
  await once(client, 'connect')
  t.after(() => client.socket.destroy())

  assert.match(request, /^CONNECT play\.example\.com:25565 HTTP\/1\.1/m)
  assert.match(request, new RegExp(`Proxy-Authorization: Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`))
  assert.equal(formatAuthority('2001:db8::1', 25565), '[2001:db8::1]:25565')
})
