/* Original procedural materials. No Minecraft assets or client code are distributed. */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.afkVoxelRenderer = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FULL = [[0, 0, 0, 1, 1, 1]]
  const textures = new Map()
  const frac = n => n - Math.floor(n)
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

  const woods = {
    oak: [170, 128, 74], spruce: [112, 82, 48], birch: [216, 202, 143], jungle: [174, 123, 89],
    acacia: [173, 92, 59], dark_oak: [75, 49, 27], mangrove: [117, 54, 49], cherry: [226, 176, 170],
    pale_oak: [222, 216, 196], bamboo: [193, 176, 80], crimson: [112, 49, 75], warped: [44, 124, 119]
  }
  const dyes = {
    white: [224, 224, 218], orange: [224, 113, 30], magenta: [177, 62, 171], light_blue: [68, 163, 208],
    yellow: [235, 195, 42], lime: [111, 184, 25], pink: [218, 126, 151], gray: [65, 69, 72],
    light_gray: [150, 150, 143], cyan: [22, 134, 143], purple: [119, 49, 166], blue: [49, 60, 152],
    brown: [115, 74, 43], green: [83, 106, 28], red: [160, 40, 34], black: [28, 29, 33]
  }
  function blockName(value) { return String(value || '').toLowerCase().replace(/^minecraft:/, '').split('[')[0] }
  function baseName(value) {
    const name = blockName(value)
    if (name === 'glass_pane') return 'glass'
    if (name.endsWith('_stained_glass_pane')) return name.replace(/_pane$/, '')
    const shape = name.replace(/_(stairs|slab|wall|fence_gate|fence)$/, '')
    if (shape !== name) {
      if (woods[shape]) return `${shape}_planks`
      return ({ brick: 'bricks', stone_brick: 'stone_bricks', mossy_stone_brick: 'mossy_stone_bricks', nether_brick: 'nether_bricks', red_nether_brick: 'red_nether_bricks', deepslate_brick: 'deepslate_bricks', deepslate_tile: 'deepslate_tiles', quartz: 'quartz_block' })[shape] || shape
    }
    return name
  }
  function material(value) {
    const name = baseName(value)
    if (name === 'grass_block') return 'grass'
    if (/leaves|vine|^(short_grass|tall_grass|grass|moss_block|moss_carpet)$/.test(name)) return 'leaves'
    if (/glass/.test(name)) return 'glass'
    if (/water/.test(name)) return 'water'
    if (/wool$/.test(name)) return 'wool'
    if (/concrete(_powder)?$/.test(name)) return 'concrete'
    if (/terracotta$/.test(name)) return 'terracotta'
    if (/_(log|stem|wood|hyphae)$/.test(name)) return 'log'
    if (/plank|chest|barrel|crafting/.test(name)) return 'planks'
    if (/ore/.test(name)) return 'ore'
    if (/dirt|mud|clay/.test(name)) return 'dirt'
    if (/sand/.test(name)) return 'sand'
    if (/snow|quartz/.test(name)) return 'snow'
    if (/stone|cobble|deepslate|andesite|diorite|granite|blackstone/.test(name)) return 'stone'
    if (/brick/.test(name)) return 'bricks'
    if (/stone|slab|stairs|cobble/.test(name)) return 'stone'
    return 'unknown'
  }

  function surfaceColor(name, face, x, y) {
    name = baseName(name)
    const kind = material(name)
    x = x & 15; y = y & 15
    const noise = ((x * 73 + y * 151 + x * y * 19) ^ (x * 17 + y * 31)) & 31
    let base = [125, 111, 91], shade = (noise - 15) * .8
    const wood = Object.keys(woods).find(key => name.replace(/^stripped_/, '').startsWith(`${key}_`))
    const dyeName = name.replace(/_(wool|concrete_powder|concrete|terracotta|stained_glass)$/, '')
    const dye = dyes[dyeName]
    if (kind === 'grass') base = face === 'top' || (face === 'side' && y > 12 - noise % 3) ? [92, 145, 53] : [125, 85, 52]
    if (kind === 'leaves') { base = [58, 114, 46]; shade = noise < 8 ? -26 : shade }
    if (kind === 'dirt') base = noise < 5 ? [157, 121, 86] : [121, 81, 49]
    if (kind === 'stone' || kind === 'ore') {
      base = [131, 133, 136]
      shade += (x + y * 3) % 13 === 0 ? -24 : 0
      if (kind === 'ore' && noise < 7) base = /diamond/.test(name) ? [61, 209, 200] : /gold/.test(name) ? [219, 180, 47] : /redstone/.test(name) ? [190, 41, 35] : [169, 123, 86]
    }
    if (kind === 'planks') { base = woods[wood] || woods.oak; shade = y % 4 === 0 || (x + Math.floor(y / 4) * 7) % 16 === 0 ? -40 : ((x * 3 + y) % 7 - 3) * 3 }
    if (kind === 'log') {
      base = face !== 'side' || name.startsWith('stripped_') ? (woods[wood] || woods.oak) : wood === 'birch' ? [210, 209, 193] : (woods[wood] || woods.oak).map(c => c * .65)
      shade = face === 'top' ? (Math.max(Math.abs(x - 7), Math.abs(y - 7)) % 3 === 0 ? -36 : 6) : ((x + noise % 3) % 5 === 0 ? -30 : shade)
    }
    if (kind === 'bricks') { base = [147, 76, 60]; shade = y % 5 === 0 || (x + Math.floor(y / 5) * 8) % 16 === 0 ? 44 : shade }
    if (kind === 'sand') base = name.startsWith('red_') ? [185, 99, 40] : [221, 201, 142]
    if (kind === 'snow') base = [232, 237, 233]
    if (kind === 'water') { base = [42, 122, 181]; shade = (x + y * 2) % 9 < 2 ? 24 : noise * .3 }
    if (kind === 'glass') { base = [166, 216, 223]; shade = x === 0 || y === 0 || x === 15 || y === 15 ? 40 : Math.abs(x - y) < 2 ? 18 : -18 }
    if (kind === 'wool' || kind === 'concrete') { base = dye || dyes.white; shade *= kind === 'wool' ? .7 : .25 }
    if (kind === 'terracotta') { base = dye ? dye.map((c, i) => c * .55 + [155, 94, 68][i] * .45) : [155, 94, 68]; shade *= .4 }
    if (kind === 'glass' && dye) base = dye
    return base.map(c => clamp(Math.round(c + shade), 0, 255))
  }

  function texture(name, face) {
    const key = `${name}|${face}`
    if (textures.has(key)) return textures.get(key)
    if (textures.size >= 192) textures.delete(textures.keys().next().value)
    const pixels = new Uint8Array(16 * 16 * 3)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set(surfaceColor(name, face, x, y), (y * 16 + x) * 3)
    textures.set(key, pixels)
    return pixels
  }

  class VoxelRenderer {
    constructor() { this.indexBuilds = 0; this.frame = null; this.blocks = null; this.revision = undefined; this.cells = [] }

    update(snapshot) {
      if (snapshot.blockRevision !== undefined ? this.revision === snapshot.blockRevision : this.blocks === snapshot.blocks) return
      this.blocks = snapshot.blocks
      this.revision = snapshot.blockRevision
      this.indexBuilds++
      const blocks = (snapshot.blocks || []).slice(0, 16000).filter(b => [b.x, b.y, b.z].every(Number.isInteger))
      this.blockCount = blocks.length
      this.minX = 0; this.minY = 0; this.minZ = 0
      // Center bounds on the actual snapshot, not world zero (world coordinates can be millions).
      if (blocks.length) { this.minX = Math.floor(blocks[0].x); this.minY = Math.floor(blocks[0].y); this.minZ = Math.floor(blocks[0].z) }
      let maxX = this.minX, maxY = this.minY, maxZ = this.minZ
      for (const b of blocks) { this.minX = Math.min(this.minX, b.x); this.minY = Math.min(this.minY, b.y); this.minZ = Math.min(this.minZ, b.z); maxX = Math.max(maxX, b.x); maxY = Math.max(maxY, b.y); maxZ = Math.max(maxZ, b.z) }
      this.sizeX = Math.min(257, maxX - this.minX + 1); this.sizeY = Math.min(64, maxY - this.minY + 1); this.sizeZ = Math.min(257, maxZ - this.minZ + 1)
      // Full eight-chunk bounds; use sparse numeric keys for unusually tall inputs.
      const volume = this.sizeX * this.sizeY * this.sizeZ
      this.sparse = volume > 600000
      this.cells = this.sparse ? new Map() : new Array(volume)
      for (const block of blocks) {
        const x = block.x - this.minX, y = block.y - this.minY, z = block.z - this.minZ
        if (x >= this.sizeX || y >= this.sizeY || z >= this.sizeZ) continue
        const shapes = Array.isArray(block.shapes) ? block.shapes.slice(0, 8).filter(shape => Array.isArray(shape) && shape.length === 6 && shape.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) : FULL
        const name = String(block.name || 'unknown')
        const index = (y * this.sizeZ + z) * this.sizeX + x
        const cell = { ...block, shapes: block.water ? [[0, 0, 0, 1, .88, 1]] : shapes, top: texture(name, 'top'), side: texture(name, 'side'), bottom: texture(name, 'bottom'), material: material(name) }
        if (this.sparse) this.cells.set(index, cell)
        else this.cells[index] = cell
      }
    }

    at(x, y, z) {
      x -= this.minX; y -= this.minY; z -= this.minZ
      if (x < 0 || y < 0 || z < 0 || x >= this.sizeX || y >= this.sizeY || z >= this.sizeZ) return null
      const index = (y * this.sizeZ + z) * this.sizeX + x
      return (this.sparse ? this.cells.get(index) : this.cells[index]) || null
    }

    trace(origin, ray, maximum = 16, skip = null) {
      if (!this.blockCount) return null
      let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z), distance = 0
      const sx = ray.x < 0 ? -1 : 1, sy = ray.y < 0 ? -1 : 1, sz = ray.z < 0 ? -1 : 1
      const dx = Math.abs(1 / ray.x), dy = Math.abs(1 / ray.y), dz = Math.abs(1 / ray.z)
      let tx = ray.x === 0 ? Infinity : (ray.x < 0 ? origin.x - x : x + 1 - origin.x) * dx
      let ty = ray.y === 0 ? Infinity : (ray.y < 0 ? origin.y - y : y + 1 - origin.y) * dy
      let tz = ray.z === 0 ? Infinity : (ray.z < 0 ? origin.z - z : z + 1 - origin.z) * dz
      for (let step = 0; step < 448 && distance <= maximum; step++) {
        // Once outside and moving away, a ray cannot re-enter the snapshot bounds.
        if ((x < this.minX && ray.x <= 0) || (x >= this.minX + this.sizeX && ray.x >= 0) ||
            (y < this.minY && ray.y <= 0) || (y >= this.minY + this.sizeY && ray.y >= 0) ||
            (z < this.minZ && ray.z <= 0) || (z >= this.minZ + this.sizeZ && ray.z >= 0)) return null
        const block = this.at(x, y, z)
        if (block && block !== skip && (block.solid || block.water || block.material === 'glass')) {
          let closest = null
          for (const shape of block.shapes) {
            const hit = intersectBox(origin, ray, x, y, z, shape)
            if (hit && hit.distance <= maximum && (!closest || hit.distance < closest.distance)) closest = hit
          }
          if (closest) return { ...closest, block }
        }
        if (tx < ty && tx < tz) { x += sx; distance = tx; tx += dx }
        else if (ty < tz) { y += sy; distance = ty; ty += dy }
        else { z += sz; distance = tz; tz += dz }
      }
      return null
    }

    render(snapshot, requestedWidth, requestedHeight) {
      this.update(snapshot)
      const width = clamp(Math.round(Number(requestedWidth) || 160), 16, 320), height = clamp(Math.round(Number(requestedHeight) || 90), 9, 180)
      if (!this.frame || this.frame.width !== width || this.frame.height !== height) this.frame = { width, height, data: new Uint8ClampedArray(width * height * 4) }
      const pixels = this.frame.data, p = snapshot.position || { x: 0, y: 0, z: 0 }
      const origin = { x: p.x, y: p.y + 1.62, z: p.z }, yaw = Number(snapshot.yaw) || 0, pitch = Number(snapshot.pitch) || 0
      const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
      const scale = Math.tan(Math.PI / 5), aspect = width / height, maximum = clamp(Number(snapshot.renderDistance) || (snapshot.radius || 6) * 1.7, 6, 128)
      const ray = { x: 0, y: 0, z: 0 }
      for (let y = 0; y < height; y++) {
        const v = (1 - (y + .5) / height * 2) * scale
        for (let x = 0; x < width; x++) {
          const u = ((x + .5) / width * 2 - 1) * scale * aspect
          ray.x = -sy * cp + cy * u + sy * sp * v; ray.y = sp + cp * v; ray.z = -cy * cp - sy * u + cy * sp * v
          const length = Math.hypot(ray.x, ray.y, ray.z); ray.x /= length; ray.y /= length; ray.z /= length
          const hit = this.trace(origin, ray, maximum), offset = (y * width + x) * 4
          let r = 126 + ray.y * 35, g = 181 + ray.y * 22, b = 216 + ray.y * 17
          if (hit) {
            const face = hit.ny > 0 ? 'top' : hit.ny < 0 ? 'bottom' : 'side'
            const tex = hit.block[face], index = ((Math.floor(hit.v * 16) & 15) * 16 + (Math.floor(hit.u * 16) & 15)) * 3
            const lighting = hit.ny > 0 ? 1 : hit.ny < 0 ? .48 : hit.nx ? .82 : .68
            const fog = Math.min(.8, hit.distance / maximum * .72)
            r = tex[index] * lighting * (1 - fog) + 145 * fog; g = tex[index + 1] * lighting * (1 - fog) + 185 * fog; b = tex[index + 2] * lighting * (1 - fog) + 206 * fog
            // Two-layer transparency gives water/glass depth without an unbounded recursion.
            if (hit.block.material === 'glass' || hit.block.water) {
              const behind = this.trace(origin, ray, maximum, hit.block)
              if (behind) {
                const backTex = behind.block[behind.ny > 0 ? 'top' : 'side'], j = ((Math.floor(behind.v * 16) & 15) * 16 + (Math.floor(behind.u * 16) & 15)) * 3
                const opacity = hit.block.water ? .55 : .3
                r = r * opacity + backTex[j] * (1 - opacity) * .8; g = g * opacity + backTex[j + 1] * (1 - opacity) * .8; b = b * opacity + backTex[j + 2] * (1 - opacity) * .8
              }
            }
          }
          pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b; pixels[offset + 3] = 255
        }
      }
      return this.frame
    }
  }

  function intersectBox(origin, ray, x, y, z, box) {
    let near = -Infinity, far = Infinity, axis = 0, sign = 0
    const o = [origin.x - x, origin.y - y, origin.z - z], d = [ray.x, ray.y, ray.z]
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < box[i] || o[i] > box[i + 3]) return null; continue }
      let a = (box[i] - o[i]) / d[i], b = (box[i + 3] - o[i]) / d[i]
      if (a > b) [a, b] = [b, a]
      if (a > near) { near = a; axis = i; sign = d[i] > 0 ? -1 : 1 }
      far = Math.min(far, b)
      if (near > far) return null
    }
    if (far < .0001 || near < -.0001) return null
    const distance = Math.max(0, near), px = origin.x + ray.x * distance, py = origin.y + ray.y * distance, pz = origin.z + ray.z * distance
    return { distance, nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0, u: frac(axis === 0 ? pz : px), v: frac(axis === 1 ? pz : py) }
  }
  return { VoxelRenderer, surfaceColor, material }
})
