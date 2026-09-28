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

  function projectHorizontal(dxValue, dzValue, yawValue = 0) {
    const dx = Number(dxValue) || 0, dz = Number(dzValue) || 0, yaw = Number(yawValue) || 0
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw)
    return { side: dx * cosYaw - dz * sinYaw, depth: -dx * sinYaw - dz * cosYaw }
  }

  function mouseLookDelta(movementX = 0, movementY = 0, sensitivity = 0.0025) {
    const scale = Math.max(0.0002, Math.min(0.02, Number(sensitivity) || 0.0025))
    return { yaw: -Number(movementX || 0) * scale, pitch: -Number(movementY || 0) * scale }
  }

  return { viewBasis, projectHorizontal, mouseLookDelta }
})
