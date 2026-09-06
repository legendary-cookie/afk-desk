const protocol = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const { latestSupportedVersion, oldestSupportedVersion } = require('mineflayer')

// node-minecraft-protocol can parse protocols that Mineflayer cannot run as a
// complete bot. NMP advertises 1.7, but Mineflayer rejects it before login.
const ENGINE_VERSIONS = Object.freeze(protocol.supportedVersions.filter((version) => {
  if (version === '1.7') return false
  const registry = minecraftData(version)
  return registry?.version?.['>=']?.(oldestSupportedVersion) && registry.version['<='](latestSupportedVersion)
}))
const ENGINE_VERSION_SET = new Set(ENGINE_VERSIONS)

function supportedVersions() {
  return [...ENGINE_VERSIONS].reverse()
}

function normalizeVersionSelection(value) {
  const version = String(value || '').trim()
  if (!version || ['auto', 'automatic'].includes(version.toLowerCase())) return ''
  if (!ENGINE_VERSION_SET.has(version)) {
    throw new Error(`Minecraft ${version} is not supported by this AFK Desk engine. Choose Auto or one of the listed versions.`)
  }
  return version
}

function supportedVersionOrEmpty(value) {
  try { return normalizeVersionSelection(value) } catch { return '' }
}

function resolvePingVersion(response) {
  const protocolVersion = Number(response?.version?.protocol)
  if (!Number.isInteger(protocolVersion)) return ''
  const branded = String(response?.version?.name || '').match(/\b\d+\.\d+(?:\.\d+)?\b/g) || []
  for (const version of branded.reverse()) {
    if (ENGINE_VERSION_SET.has(version)) return version
  }
  const candidates = minecraftData.postNettyVersionsByProtocolVersion.pc[protocolVersion] || []
  for (const candidate of candidates) {
    if (ENGINE_VERSION_SET.has(candidate.minecraftVersion)) return candidate.minecraftVersion
  }
  for (const candidate of candidates) {
    if (ENGINE_VERSION_SET.has(candidate.majorVersion)) return candidate.majorVersion
  }
  return ''
}

module.exports = { supportedVersions, normalizeVersionSelection, supportedVersionOrEmpty, resolvePingVersion }
