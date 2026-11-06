(function exposePovMath(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.afkPovMath = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPovMath() {
  function viewBasis(yawValue = 0, pitchValue = 0) {
    const yaw = Number(yawValue) || 0
    const pitch = Math.max(-1.45, Math.min(1.45, Number(pitchValue) || 0))
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw)
    const sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch)
    return {
      yaw,
      pitch,
      forward: { x: -sinYaw * cosPitch, y: sinPitch, z: -cosYaw * cosPitch },
      right: { x: cosYaw, y: 0, z: -sinYaw },
      up: { x: sinYaw * sinPitch, y: cosPitch, z: cosYaw * sinPitch }
    }
  }

  function eyeHeight(snapshot = {}) {
    const height = Number(snapshot.eyeHeight) || 1.62
    // Mineflayer may already report a crouching eye. Never subtract twice.
    return Math.max(.1, Math.min(height, snapshot.sneaking ? 1.32 : 2))
  }

  function cameraRay(snapshot, x = .5, y = .5, aspect = 16 / 9) {
    const basis = viewBasis(snapshot.yaw, snapshot.pitch)
    const scale = Math.tan(Math.PI / 5)
    const u = (x * 2 - 1) * scale * aspect, v = (1 - y * 2) * scale
    const direction = {}
    for (const axis of ['x', 'y', 'z']) direction[axis] = basis.forward[axis] + basis.right[axis] * u + basis.up[axis] * v
    const length = Math.hypot(direction.x, direction.y, direction.z)
    for (const axis of ['x', 'y', 'z']) direction[axis] /= length
    const p = snapshot.position
    return { origin: { x: p.x, y: p.y + eyeHeight(snapshot), z: p.z }, direction }
  }

  function projectHorizontal(dxValue, dzValue, yawValue = 0) {
    const dx = Number(dxValue) || 0, dz = Number(dzValue) || 0, yaw = Number(yawValue) || 0
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw)
    return { side: dx * cosYaw - dz * sinYaw, depth: -dx * sinYaw - dz * cosYaw }
  }

  function mouseLookDelta(movementX = 0, movementY = 0, sensitivity = 0.0025) {
    const scale = Math.max(0.0002, Math.min(0.02, Number(sensitivity) || 0.0025))
    return { yaw: -Number(movementX || 0) * scale, pitch: -Number(movementY || 0) * scale }
  }

  function entityLabel(entity) {
    const type = String(entity.entityType || entity.name || entity.type || '').toLowerCase().replace(/^minecraft:/, '').replace(/ /g, '_')
    if (type === 'item_display' || type === 'block_display') return ''
    if (type === 'text_display' || type === 'armor_stand') return String(entity.label || '')
    return String(entity.label ?? entity.username ?? entity.name ?? entity.type ?? 'entity')
  }

  function snapshotRadius(settings, viewMode, mapRadius) {
    if (viewMode === 'map') return Math.max(2, Math.min(12, Math.round(Number(mapRadius) || 6)))
    const chunks = Number(settings?.povRenderDistance)
    return Math.max(1, Math.min(8, Number.isFinite(chunks) ? Math.round(chunks) : 1)) * 16
  }

  return { eyeHeight, cameraRay, viewBasis, projectHorizontal, mouseLookDelta, entityLabel, snapshotRadius }
})
