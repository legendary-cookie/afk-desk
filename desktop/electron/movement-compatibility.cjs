const CONFIGURATION_PACKET_NAMES = new Set([
  'start_configuration', 'configuration_acknowledged', 'select_known_packs',
  'finish_configuration', 'settings', 'login', 'respawn', 'chat_command',
  'chat_command_signed'
])

function installMovementPacketCompatibility(bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function' || client.__afkDeskMovementCompatibility) return
  const write = client.write.bind(client)
  client.write = (name, payload) => {
    if (name === 'player_input' && bot.supportFeature?.('newPlayerInputPacket')) {
      payload = { inputs: currentPlayerInput(bot, payload?.inputs) }
      const key = JSON.stringify(payload.inputs)
      if (key === bot.__afkDeskLastPlayerInput) return
      bot.__afkDeskLastPlayerInput = key
      bot.__afkDeskPacketDiagnostic?.({ event: 'player_input', direction: 'out', inputs: payload.inputs, at: Date.now() })
    }
    if (CONFIGURATION_PACKET_NAMES.has(name)) {
      bot.__afkDeskPacketDiagnostic?.({ event: 'protocol_packet', direction: 'out', name, at: Date.now() })
    }
    if (['position', 'look', 'position_look'].includes(name) && payload?.flags) {
      payload = {
        ...payload,
        flags: {
          ...payload.flags,
          hasHorizontalCollision: bot.entity?.isCollidedHorizontally === true
        }
      }
    }
    if (['position', 'look', 'position_look'].includes(name)) {
      const previous = bot.__afkDeskMovementTrace?.lastSent
      bot.__afkDeskMovementTrace = {
        lastSent: {
          packet: name,
          at: Date.now(),
          position: vectorSnapshot(payload) || previous?.position || null,
          yaw: Number.isFinite(Number(payload?.yaw)) ? roundDiagnostic(payload.yaw) : previous?.yaw ?? null,
          pitch: Number.isFinite(Number(payload?.pitch)) ? roundDiagnostic(payload.pitch) : previous?.pitch ?? null,
          onGround: payload?.flags && typeof payload.flags === 'object'
            ? payload.flags.onGround === true
            : payload?.onGround === true,
          horizontalCollision: payload?.flags && typeof payload.flags === 'object'
            ? payload.flags.hasHorizontalCollision === true
            : null
        }
      }
    }
    return write(name, payload)
  }
  client.__afkDeskMovementCompatibility = true
}

function installModernPlayerInputCompatibility(bot) {
  if (!bot || bot.__afkDeskPlayerInputCompatibility) return
  const sendCurrentInput = () => {
    if (!bot.supportFeature?.('newPlayerInputPacket')) return
    bot._client?.write?.('player_input', { inputs: currentPlayerInput(bot) })
  }
  const setControlState = typeof bot.setControlState === 'function' ? bot.setControlState.bind(bot) : null
  if (setControlState) {
    bot.setControlState = (control, state) => {
      const result = setControlState(control, state)
      sendCurrentInput()
      return result
    }
  }
  bot.on?.('spawn', sendCurrentInput)
  bot.__afkDeskPlayerInputCompatibility = true
}

function currentPlayerInput(bot, overrides = {}) {
  const active = (control) => {
    const packetKey = control === 'sneak' ? 'shift' : control
    if (Object.prototype.hasOwnProperty.call(overrides || {}, packetKey)) return overrides[packetKey] === true
    return bot.getControlState?.(control) === true
  }
  return {
    forward: active('forward'),
    backward: active('back'),
    left: active('left'),
    right: active('right'),
    jump: active('jump'),
    shift: active('sneak'),
    sprint: active('sprint')
  }
}

function roundDiagnostic(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000
}

function vectorSnapshot(value) {
  if (!value || !['x', 'y', 'z'].every((axis) => Number.isFinite(Number(value[axis])))) return null
  return { x: roundDiagnostic(value.x), y: roundDiagnostic(value.y), z: roundDiagnostic(value.z) }
}

function vectorDelta(to, from) {
  return {
    x: roundDiagnostic(to.x - from.x),
    y: roundDiagnostic(to.y - from.y),
    z: roundDiagnostic(to.z - from.z)
  }
}

function safeMovementFlags(flags) {
  if (Number.isFinite(Number(flags))) return Number(flags)
  if (!flags || typeof flags !== 'object') return null
  return {
    x: flags.x === true,
    y: flags.y === true,
    z: flags.z === true,
    yaw: flags.yaw === true,
    pitch: flags.pitch === true
  }
}

function snapshotNearbyBlocks(bot, position) {
  const blocks = []
  const baseX = Math.floor(position.x)
  const baseY = Math.floor(position.y)
  const baseZ = Math.floor(position.z)
  for (let y = baseY - 1; y <= baseY + 2; y++) {
    for (let x = baseX - 1; x <= baseX + 1; x++) {
      for (let z = baseZ - 1; z <= baseZ + 1; z++) {
        let block
        const entityPosition = bot.entity?.position
        const queryPosition = entityPosition?.offset?.(x - entityPosition.x, y - entityPosition.y, z - entityPosition.z)
        try { block = queryPosition ? bot.blockAt?.(queryPosition, false) : null } catch {}
        if (!block || block.name === 'air') continue
        blocks.push({
          x,
          y,
          z,
          name: String(block.name || 'unknown').slice(0, 80),
          type: Number.isFinite(Number(block.type)) ? Number(block.type) : null,
          metadata: Number.isFinite(Number(block.metadata)) ? Number(block.metadata) : null,
          boundingBox: String(block.boundingBox || '').slice(0, 24),
          shapes: Array.isArray(block.shapes) ? block.shapes.slice(0, 4).map((shape) => shape.slice(0, 6).map(roundDiagnostic)) : []
        })
      }
    }
  }
  return blocks.slice(0, 36)
}

module.exports = {
  CONFIGURATION_PACKET_NAMES,
  installMovementPacketCompatibility,
  installModernPlayerInputCompatibility,
  roundDiagnostic,
  vectorSnapshot,
  vectorDelta,
  safeMovementFlags,
  snapshotNearbyBlocks
}
