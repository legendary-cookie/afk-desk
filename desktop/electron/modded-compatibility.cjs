const forgeAdapter = require('minecraft-protocol-forge')

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
  if (!client || !FORGE_LOADERS.has(profile.loader) || profile.handshake === 'off') return false
  const autoVersionForge = dependencies.autoVersionForge || forgeAdapter.autoVersionForge
  const handshakes = dependencies.handshakes || {
    fml1: forgeAdapter.forgeHandshake,
    fml2: require('minecraft-protocol-forge/src/client/forgeHandshake2'),
    fml3: require('minecraft-protocol-forge/src/client/forgeHandshake3')
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
      client.autoVersionHooks.push((_response, negotiatedClient, options) => install(options.version || negotiatedClient.version))
    } else install(account?.version)
  } else {
    autoVersionForge(client, {})
    if (profile.loader !== 'auto') report(account?.version
      ? 'Mod compatibility: automatic Forge matching needs Minecraft version set to Automatic; no manual mod list is configured.'
      : 'Mod compatibility: Forge FML1/FML2/FML3 auto-detection is active and will mirror the server-advertised mod list.')
  }
  return true
}

function installCustomChannels(client, account, report = () => {}) {
  const profile = normalizeModdedProfile(account)
  let registered = 0
  for (const channel of profile.channels) {
    try { client?.registerChannel?.(channel, ['restBuffer', []], true); registered += 1 } catch (error) { report(`Mod channel ${channel} was not registered: ${error.message}`) }
  }
  if (registered) report(`Mod compatibility: registered ${registered} custom plugin channel${registered === 1 ? '' : 's'}.`)
  return registered
}

function moddedBotOptions(account) {
  const profile = normalizeModdedProfile(account)
  return { brand: profile.brand }
}

module.exports = { normalizeModdedProfile, normalizeMods, normalizeChannels, inferredHandshake, installModdedCompatibility, installCustomChannels, moddedBotOptions }
