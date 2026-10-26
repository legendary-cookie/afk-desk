#!/usr/bin/env node
'use strict'
const path = require('node:path')
const readline = require('node:readline')
const { Writable } = require('node:stream')
const { AppCore } = require('../core/app-core.cjs')
const { createFileSecretBox } = require('../core/secrets.cjs')
const { AuthManager, validatePassword } = require('./auth.cjs')
const { createRemoteServer, detectTailscaleAddresses } = require('./http-server.cjs')

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = [...argv]
  let command = 'start'
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift()
  }

  let dataDir = env.AFKDESK_DATA || './data'
  let bind = env.AFKDESK_BIND || '127.0.0.1'
  let explicitBind = Boolean(env.AFKDESK_BIND)
  let port = env.AFKDESK_PORT !== undefined ? Number(env.AFKDESK_PORT) : 8787
  let allowedHosts = env.AFKDESK_ALLOWED_HOSTS
    ? env.AFKDESK_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  let trustProxy = /^(?:1|true|yes)$/i.test(String(env.AFKDESK_TRUST_PROXY || ''))
  let iUnderstandPlainHttp = false
  let passwordStdin = false
  let setupToken = /^(?:1|true|yes)$/i.test(String(env.AFKDESK_SETUP_TOKEN || ''))
  let username = 'admin'

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--data' && args[i + 1] !== undefined) {
      dataDir = args[++i]
    } else if (flag.startsWith('--data=')) {
      dataDir = flag.slice('--data='.length)
    } else if (flag === '--bind' && args[i + 1] !== undefined) {
      bind = args[++i]
      explicitBind = true
    } else if (flag.startsWith('--bind=')) {
      bind = flag.slice('--bind='.length)
      explicitBind = true
    } else if (flag === '--port' && args[i + 1] !== undefined) {
      port = Number(args[++i])
    } else if (flag.startsWith('--port=')) {
      port = Number(flag.slice('--port='.length))
    } else if (flag === '--allowed-hosts' && args[i + 1] !== undefined) {
      allowedHosts = args[++i].split(',').map((s) => s.trim()).filter(Boolean)
    } else if (flag.startsWith('--allowed-hosts=')) {
      allowedHosts = flag.slice('--allowed-hosts='.length).split(',').map((s) => s.trim()).filter(Boolean)
    } else if (flag === '--trust-proxy') {
      trustProxy = true
    } else if (flag === '--i-understand-plain-http') {
      iUnderstandPlainHttp = true
    } else if (flag === '--password-stdin') {
      passwordStdin = true
    } else if (flag === '--setup-token') {
      setupToken = true
    } else if (flag === '--username' && args[i + 1] !== undefined) {
      username = args[++i]
    } else if (flag === '--help' || flag === '-h') {
      command = 'help'
    }
  }

  return {
    command,
    dataDir: path.resolve(dataDir),
    bind,
    explicitBind,
    port,
    allowedHosts,
    trustProxy,
    iUnderstandPlainHttp,
    passwordStdin,
    setupToken,
    username
  }
}

function readPasswordFromStdin(stdin = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stdin.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
      resolve(text)
    })
    stdin.on('error', reject)
    stdin.resume?.()
  })
}

function readPasswordFromTty(stdin = process.stdin, stdout = process.stdout) {
  return new Promise((resolve, reject) => {
    let muted = false
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) stdout.write(chunk, encoding)
        callback()
      }
    })
    const rl = readline.createInterface({
      input: stdin,
      output: mutableStdout,
      terminal: true
    })
    stdout.write('Enter new admin password (min 12 chars): ')
    muted = true
    rl.question('', (answer) => {
      muted = false
      stdout.write('\n')
      rl.close()
      resolve(String(answer || ''))
    })
    rl.on('error', (err) => {
      muted = false
      reject(err)
    })
  })
}

async function runInit(options, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const password = options.passwordStdin
    ? await readPasswordFromStdin(stdin)
    : await readPasswordFromTty(stdin, stdout)

  const validationError = validatePassword(password)
  if (validationError) {
    stderr.write(`Error: ${validationError}\n`)
    return { exitCode: 1 }
  }

  // Initialize SecretBox keyfile and AuthManager admin record
  createFileSecretBox({ dataDir: options.dataDir, keyFromEnv: env.AFKDESK_SECRET_KEY })
  const auth = new AuthManager({ dataDir: options.dataDir })
  await auth.setAdminPassword(password, options.username || 'admin')
  stdout.write(`Admin user "${options.username || 'admin'}" initialized in ${options.dataDir}\n`)
  return { exitCode: 0 }
}

async function startHeadlessServer({
  dataDir,
  bind = '127.0.0.1',
  explicitBind = false,
  port = 8787,
  allowedHosts = [],
  trustProxy = false,
  iUnderstandPlainHttp = false,
  setupToken = false,
  core: injectedCore,
  auth: injectedAuth,
  secretKeyFromEnv,
  logger = console,
  processObj = process,
  autoConnect = true
} = {}) {
  const resolvedDataDir = path.resolve(dataDir || './data')
  let pkgVersion = '0.10.0-beta.9'
  try {
    pkgVersion = require('../package.json').version || pkgVersion
  } catch {}

  const auth = injectedAuth || new AuthManager({ dataDir: resolvedDataDir })
  if (!auth.hasAdmin() && !setupToken) {
    throw new Error('No admin user configured. Run "afk-desk-server init" first, or pass --setup-token on loopback.')
  }

  const secretBox = injectedCore?.secretBox || createFileSecretBox({
    dataDir: resolvedDataDir,
    keyFromEnv: secretKeyFromEnv !== undefined ? secretKeyFromEnv : process.env.AFKDESK_SECRET_KEY
  })

  const core = injectedCore || new AppCore({
    userDataPath: resolvedDataDir,
    secretBox,
    platform: {
      getVersion: () => pkgVersion
    }
  })

  if (!core.started && typeof core.start === 'function') {
    await core.start()
  }

  const remoteServer = createRemoteServer({
    core,
    auth,
    dataDir: resolvedDataDir,
    bind: explicitBind || bind === '127.0.0.1' || bind === '::1' || bind === 'localhost' ? bind : undefined,
    port,
    allowedHosts,
    trustProxy,
    iUnderstandPlainHttp,
    enableSetupToken: setupToken,
    logger
  })

  let addr
  try {
    addr = await remoteServer.start()
  } catch (err) {
    try { await core.shutdown?.() } catch {}
    throw err
  }

  if (autoConnect && typeof core.autoConnectConfiguredAccounts === 'function') {
    core.autoConnectConfiguredAccounts()
  }

  logger.log?.(`[AFK Desk Server] Listening on http://${addr.address}:${addr.port}`)

  let shuttingDown = false
  async function shutdown(signal = 'SIGTERM') {
    if (shuttingDown) return
    shuttingDown = true
    logger.log?.(`[AFK Desk Server] Received ${signal}, shutting down gracefully...`)
    try { await remoteServer.stop() } catch {}
    try { await core.shutdown?.() } catch {}
  }

  const onSigterm = () => {
    return shutdown('SIGTERM').then(() => {
      processObj?.exit?.(0)
    })
  }
  const onSigint = () => {
    return shutdown('SIGINT').then(() => {
      processObj?.exit?.(0)
    })
  }

  processObj?.on?.('SIGTERM', onSigterm)
  processObj?.on?.('SIGINT', onSigint)

  return {
    core,
    auth,
    remoteServer,
    address: addr,
    shutdown: async (sig = 'SIGTERM') => {
      processObj?.removeListener?.('SIGTERM', onSigterm)
      processObj?.removeListener?.('SIGINT', onSigint)
      await shutdown(sig)
    }
  }
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr
  const stdin = io.stdin || process.stdin
  const env = io.env || process.env
  const options = parseArgs(argv, env)

  if (options.command === 'help') {
    stdout.write(
      'Usage:\n' +
      '  afk-desk-server init [--data <dir>] [--password-stdin]\n' +
      '  afk-desk-server [start] [--data <dir>] [--bind <ip>] [--port <port>] [--allowed-hosts <hosts>] [--trust-proxy] [--i-understand-plain-http] [--setup-token]\n'
    )
    return { exitCode: 0 }
  }

  if (options.command === 'init') {
    return runInit(options, { stdin, stdout, stderr, env })
  }

  if (options.command === 'start') {
    try {
      const logger = {
        log: (msg) => stdout.write(`${msg}\n`),
        warn: (msg) => stderr.write(`${msg}\n`),
        error: (msg) => stderr.write(`${msg}\n`)
      }
      const instance = await startHeadlessServer({
        ...options,
        secretKeyFromEnv: env.AFKDESK_SECRET_KEY,
        logger,
        processObj: io.processObj || process
      })
      return { exitCode: 0, instance }
    } catch (error) {
      stderr.write(`Error: ${error.message}\n`)
      return { exitCode: 1 }
    }
  }

  stderr.write(`Unknown command: ${options.command}\n`)
  return { exitCode: 1 }
}

if (require.main === module) {
  runCli().then(({ exitCode, instance }) => {
    if (!instance && exitCode !== 0) {
      process.exit(exitCode)
    }
  }).catch((error) => {
    process.stderr.write(`Fatal: ${error?.message || error}\n`)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  runInit,
  startHeadlessServer,
  runCli,
  detectTailscaleAddresses
}
