const protocol = require('minecraft-protocol')

const SUPPORTED = Object.freeze([...protocol.supportedVersions])
const SUPPORTED_SET = new Set(SUPPORTED)

function supportedVersions() {
  return [...SUPPORTED].reverse()
}

function normalizeVersionSelection(value) {
  const version = String(value || '').trim()
  if (!version || ['auto', 'automatic'].includes(version.toLowerCase())) return ''
  if (!SUPPORTED_SET.has(version)) throw new Error(`Minecraft ${version} is not supported. Choose Automatic or a listed version.`)
  return version
}

module.exports = { supportedVersions, normalizeVersionSelection }
