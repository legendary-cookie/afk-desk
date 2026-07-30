const net = require('node:net')
const { SocksClient } = require('socks')

function createProxyConnect(proxy, destination) {
  if (!proxy?.enabled) return undefined
  if (proxy.type === 'socks5') return (client) => connectSocks(client, proxy, destination)
  if (proxy.type === 'http') return (client) => connectHttp(client, proxy, destination)
  throw new Error('Unsupported proxy type.')
}

function connectSocks(client, proxy, destination) {
  SocksClient.createConnection({
    command: 'connect',
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      userId: proxy.username || undefined,
      password: proxy.password || undefined
    },
    destination,
    timeout: 15_000
  }).then(({ socket }) => {
    client.setSocket(socket)
    client.emit('connect')
  }).catch((error) => client.emit('error', proxyError(error)))
}

function connectHttp(client, proxy, destination) {
  const socket = net.connect(proxy.port, proxy.host)
  let response = Buffer.alloc(0)
  let settled = false
  const fail = (error) => {
    if (settled) return
    settled = true
    cleanup()
    socket.destroy()
    client.emit('error', proxyError(error))
  }
  const cleanup = () => {
    socket.setTimeout(0)
    socket.removeListener('connect', onConnect)
    socket.removeListener('data', onData)
    socket.removeListener('error', fail)
    socket.removeListener('timeout', onTimeout)
  }
  const onTimeout = () => fail(new Error('Proxy connection timed out.'))
  const onConnect = () => {
    const authority = formatAuthority(destination.host, destination.port)
    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: Keep-Alive']
    if (proxy.username || proxy.password) headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64')}`)
    socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  }
  const onData = (chunk) => {
    response = Buffer.concat([response, chunk])
    if (response.length > 16_384) return fail(new Error('Proxy returned an oversized response.'))
    const headerEnd = response.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const statusLine = response.subarray(0, headerEnd).toString('latin1').split('\r\n', 1)[0]
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1])
    if (status !== 200) return fail(new Error(`HTTP proxy rejected the connection (${status || 'invalid response'}).`))
    settled = true
    const remaining = response.subarray(headerEnd + 4)
    cleanup()
    if (remaining.length) socket.unshift(remaining)
    client.setSocket(socket)
    client.emit('connect')
  }
  socket.setTimeout(15_000)
  socket.on('connect', onConnect)
  socket.on('data', onData)
  socket.on('error', fail)
  socket.on('timeout', onTimeout)
}

function formatAuthority(host, port) {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

function proxyError(error) {
  const safe = String(error?.message || 'Connection failed.').replace(/[\r\n]/g, ' ').slice(0, 160)
  return new Error(`Proxy connection failed: ${safe}`)
}

module.exports = { createProxyConnect, formatAuthority }
