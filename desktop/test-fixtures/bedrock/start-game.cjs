'use strict'

const minecraftData = require('minecraft-data')

function defaultValue (type, protocol, packet = {}) {
  if (typeof type === 'string') {
    if (type === 'bool') return false
    if (/64$/.test(type)) return 0n
    if (/^(?:string|UUID|uuid)$/.test(type)) return ''
    if (/^(?:vec[234]f|BlockCoordinates)$/.test(type)) return type === 'BlockCoordinates' ? { x: 0, y: 64, z: 0 } : { x: 0, y: 0, z: 0, w: 0 }
    if (Object.hasOwn(protocol.types, type)) return defaultValue(protocol.types[type], protocol, packet)
    return 0
  }
  if (!Array.isArray(type)) return 0
  if (type[0] === 'array') return []
  if (type[0] === 'option') return null
  if (type[0] === 'mapper') return Object.values(type[1].mappings)[0]
  if (type[0] === 'container') {
    const result = {}
    for (const field of type[1]) if (field.name) result[field.name] = defaultValue(field.type, protocol, result)
    return result
  }
  if (type[0] === 'switch') {
    const fieldNames = Object.keys(type[1].fields)
    const compareValue = packet[type[1].compareTo] ?? fieldNames[0]
    return defaultValue(type[1].fields[String(compareValue)] ?? type[1].fields[fieldNames[0]], protocol, packet)
  }
  return 0
}

function startGamePacket (version = '1.16.201') {
  const protocol = minecraftData('bedrock_' + version).protocol
  const packet = defaultValue(protocol.types.packet_start_game, protocol)
  Object.assign(packet, { entity_id: 1n, runtime_entity_id: 1n, player_gamemode: 'survival', player_position: { x: 0, y: 64, z: 0 }, rotation: { x: 0, y: 0 }, spawn_position: { x: 0, y: 64, z: 0 } })
  return packet
}

module.exports = { startGamePacket }
