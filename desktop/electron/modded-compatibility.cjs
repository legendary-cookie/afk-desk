const forgeAdapter = require('minecraft-protocol-forge')
const { describeCompatibility } = require('../assets/compatibility-capabilities.js')

const LOADERS = new Set(['auto', 'vanilla', 'plugin', 'fabric', 'quilt', 'forge', 'neoforge', 'sponge', 'custom'])
const HANDSHAKES = new Set(['auto', 'off', 'fml1', 'fml2', 'fml3'])
const FORGE_LOADERS = new Set(['auto', 'forge', 'neoforge'])
const DEFAULT_BRANDS = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge' }

function normalizeModdedProfile(input = {}) {
  const loader = LOADERS.has(input?.modLoader) ? input.modLoader : 'auto'
  const handshake = HANDSHAKES.has(input?.modHandshake) ? input.modHandshake : 'auto'
  const brand = String(input?.clientBrand || DEFAULT_BRANDS[loader] || 'vanilla').trim().slice(0, 64) || 'vanilla'
  return {
    loader,
    handshake,
    brand,
    mods: normalizeMods(input?.mods ?? input?.modList),
    channels: normalizeChannels(input?.channels ?? input?.modChannels)
  }
}

function normalizeMods(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\r\n,]+/)
  const seen = new Set(), mods = []
  for (const value of values) {
    const raw = typeof value === 'object' ? `${value?.modid || ''}@${value?.version || ''}` : String(value || '')
    const split = raw.lastIndexOf('@')
    const modid = (split > 0 ? raw.slice(0, split) : raw).trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100)
    const version = (split > 0 ? raw.slice(split + 1) : '').trim().slice(0, 100)
    if (!modid || seen.has(modid)) continue
    seen.add(modid); mods.push({ modid, version: version || '*' })
    if (mods.length >= 512) break
  }
  return mods
}

function normalizeChannels(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\r\n,]+/)
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter((value) => /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value)))].slice(0, 256)
}

function inferredHandshake(version) {
  const parts = String(version || '').split('.').map(Number)
  if (!parts[0]) return 'fml3'
  if (parts[0] === 1 && parts[1] <= 12) return 'fml1'
  if (parts[0] === 1 && parts[1] <= 18) return 'fml2'
  return 'fml3'
}

function installModdedCompatibility(client, account, report = () => {}, dependencies = {}) {
  const profile = normalizeModdedProfile(account)
  const capability = describeCompatibility(account)
  if (capability.error) throw new Error(capability.error)
  if (capability.mode === 'vanilla-only') { report(capability.summary); return false }
  if (!client || !FORGE_LOADERS.has(profile.loader) || profile.handshake === 'off') return false
  const autoVersionForge = dependencies.autoVersionForge || forgeAdapter.autoVersionForge
  const handshakes = dependencies.handshakes || {
    fml1: forgeAdapter.forgeHandshake,
    fml2: require('minecraft-protocol-forge/src/client/forgeHandshake2'),
    fml3: require('minecraft-protocol-forge/src/client/forgeHandshake3')
  }
  if (!profile.mods.length && profile.handshake !== 'auto') {
    if (profile.handshake !== 'fml1') {
      // FML2/3 reflect the server mod/channel lists when options are absent.
      handshakes[profile.handshake](client, {})
    } else {
      const hook = response => {
        const mods = response?.modinfo?.modList
        if (!Array.isArray(mods)) {
          report('FML1 requires a server-advertised mod list. Configure a manual mod list if the server omits it.')
          return
        }
        handshakes.fml1(client, { forgeMods: normalizeMods(mods) })
      }
      if (account?.version) detectFixedVersionMods(client, account, [hook], dependencies)
      else { (client.autoVersionHooks ||= []).push(hook) }
    }
    report(`Mod compatibility: using the explicitly selected ${profile.handshake.toUpperCase()} handshake.`)
    return true
  }
  if (profile.mods.length) {
    const install = (version) => {
      const generation = profile.handshake === 'auto' ? inferredHandshake(version) : profile.handshake
      const forgeMods = generation === 'fml1' ? profile.mods : profile.mods.map((mod) => mod.modid)
      // FML1 serializes id/version objects; FML2/FML3 serialize a string mod-name list.
      handshakes[generation](client, { forgeMods, modNames: forgeMods })
      report(`Mod compatibility: advertising ${profile.mods.length} configured mod${profile.mods.length === 1 ? '' : 's'} using ${generation.toUpperCase()}.`)
    }
    if (profile.handshake === 'auto' && !account?.version) {
      // Auto-version hooks run after protocol selection and before handshaking.
      if (!client.autoVersionHooks) client.autoVersionHooks = []
      client.autoVersionHooks.push((_response, negotiatedClient, options) => {
        const version = options.version || negotiatedClient.version
        const resolved = describeCompatibility({ ...account, version })
        if (resolved.mode === 'vanilla-only') { report(resolved.summary); return }
        install(version)
      })
    } else install(account?.version)
  } else {
    const firstHook = client.autoVersionHooks?.length || 0
    autoVersionForge(client, {})
    if (profile.loader === 'neoforge' && !account?.version) {
      client.autoVersionHooks = client.autoVersionHooks.map((hook, index) => index < firstHook ? hook : (response, negotiatedClient, options) => {
        const resolved = describeCompatibility({ ...account, version: options.version || negotiatedClient.version })
        if (resolved.mode === 'vanilla-only') { report(resolved.summary); return }
        hook(response, negotiatedClient, options)
      })
    }
    if (account?.version) {
      // Fixed-version connections skip upstream autoVersionHooks. Fetch the
      // Forge metadata separately without changing the selected game version.
      detectFixedVersionMods(client, account, client.autoVersionHooks.slice(firstHook), dependencies)
    }
    if (profile.loader !== 'auto') report('Mod compatibility: Forge FML1/FML2/FML3 auto-detection is active and will mirror the server-advertised mod list.')
  }
  return true
}

function detectFixedVersionMods(client, account, hooks, dependencies) {
  const ping = dependencies.ping || require('minecraft-protocol').ping
  const createProxyConnect = dependencies.createProxyConnect || require('./proxy-connect.cjs').createProxyConnect
  const destination = { host: account.host, port: Number(account.port) || 25565 }
  const options = {
    ...destination, version: account.version, closeTimeout: 10000, noPongTimeout: 1000,
    connect: createProxyConnect(account.proxy, destination)
  }
  let ended = false
  const onEnd = () => { ended = true }
  client.once('end', onEnd)
  client.wait_connect = true
  Promise.resolve().then(() => ping(options)).then(response => {
    if (ended) return
    for (const hook of hooks) hook(response, client, options)
    client.wait_connect = false
    client.emit('connect_allowed')
  }).catch(error => {
    if (ended) return
    // A metadata failure must not silently continue with a missing handshake.
    try { client.emit('error', new Error(`Forge mod detection failed: ${error.message}`)) }
    finally { client.end('modDetectionFailed') }
  }).finally(() => client.removeListener('end', onEnd))
}

function installCustomChannels(client, account, report = () => {}) {
  const profile = normalizeModdedProfile(account)
  if (!client?.on) return 0
  const reserved = new Set(['minecraft:brand', 'minecraft:register', 'minecraft:unregister', 'fml:loginwrapper', 'fml:handshake'])
  const channels = profile.channels.filter(channel => {
    if (!reserved.has(channel)) return true
    report(`Mod channel ${channel} is reserved for a built-in codec and cannot be registered as raw data.`)
    return false
  })
  const registered = new Set()
  const reported = new Set()
  const onState = state => {
    if (state !== 'play') return
    const repeat = []
    for (const channel of channels) {
      if (registered.has(channel)) { repeat.push(channel); continue }
      try {
        if (typeof client.registerChannel !== 'function') throw new Error('Protocol channel registration is unavailable')
        client.registerChannel(channel, ['restBuffer', []], true)
        registered.add(channel)
      } catch (error) { report(`Mod channel ${channel} was not registered: ${error.message}`) }
    }
    if (repeat.length && client.writeChannel) {
      const minor = Number(String(client.version || '').split('.')[1])
      try { client.writeChannel(minor <= 12 ? 'REGISTER' : 'minecraft:register', repeat) }
      catch (error) { report(`Optional mod channels could not be reannounced: ${error.message}`) }
    }
    if (registered.size) report(`Mod compatibility: registered ${registered.size} optional raw plugin channel${registered.size === 1 ? '' : 's'}; no custom mod codec is implied.`)
  }
  const onRequest = packet => {
    const channel = String(packet?.channel || '').slice(0, 128)
    if (!channel || reported.has(channel) || reported.size >= 16 || channel === 'fml:loginwrapper') return
    reported.add(channel)
    report(`Server requested login channel ${channel}. AFK Desk has no custom login handler for it; use optional/server-side mods or a dedicated compatible adapter. The standard unsupported response is preserved.`)
  }
  client.on('state', onState)
  client.on('login_plugin_request', onRequest)
  client.once('end', () => {
    client.removeListener('state', onState)
    client.removeListener('login_plugin_request', onRequest)
  })
  onState(client.state)
  return channels.length
}

function moddedBotOptions(account) {
  const capability = describeCompatibility(account)
  if (capability.error) throw new Error(capability.error)
  const profile = normalizeModdedProfile(account)
  return { brand: profile.brand }
}

module.exports = { normalizeModdedProfile, normalizeMods, normalizeChannels, inferredHandshake, installModdedCompatibility, installCustomChannels, moddedBotOptions }
