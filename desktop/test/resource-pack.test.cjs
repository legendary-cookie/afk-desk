const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const AdmZip = require('adm-zip')
const { ResourcePackLoader, parseResourcePack, normalizePackEvent, resolveItemDefinition } = require('../electron/resource-pack.cjs')

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfSUWQAAAABJRU5ErkJggg==', 'base64')

function fixturePack() {
  const zip = new AdmZip()
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'AFK Desk test' } })))
  zip.addFile('assets/minecraft/models/item/gold_nugget.json', Buffer.from(JSON.stringify({
    parent: 'minecraft:item/generated',
    textures: { layer0: 'minecraft:item/gold_nugget' },
    overrides: [{ predicate: { custom_model_data: 123 }, model: 'veridian:item/mission' }]
  })))
  zip.addFile('assets/veridian/models/item/mission.json', Buffer.from(JSON.stringify({ parent: 'minecraft:item/generated', textures: { layer0: 'veridian:item/mission' } })))
  zip.addFile('assets/veridian/items/mission.json', Buffer.from(JSON.stringify({ model: { type: 'minecraft:model', model: 'veridian:item/mission' } })))
  zip.addFile('assets/veridian/textures/item/mission.png', PIXEL)
  zip.addFile('assets/veridian/font/default.json', Buffer.from(JSON.stringify({ providers: [
    { type: 'bitmap', file: 'veridian:font/menu.png', ascent: 60, height: 64, chars: ['\ue001'] },
    { type: 'space', advances: { '\ue002': -20 } }
  ] })))
  zip.addFile('assets/veridian/textures/font/menu.png', PIXEL)
  return zip.toBuffer()
}

function corruptDeclaredSizes(buffer) {
  const result = Buffer.from(buffer)
  for (let offset = 0; offset + 46 <= result.length; offset++) {
    if (result.readUInt32LE(offset) !== 0x02014b50) continue
    result.writeUInt32LE(0x7fffffff, offset + 24)
    const nameLength = result.readUInt16LE(offset + 28)
    const extraLength = result.readUInt16LE(offset + 30)
    const commentLength = result.readUInt16LE(offset + 32)
    offset += 45 + nameLength + extraLength + commentLength
  }
  return result
}

test('parses legacy custom item models and bitmap GUI glyphs from a resource pack', () => {
  const pack = parseResourcePack(fixturePack(), { source: 'https://packs.example/menu.zip', sha1: 'fixture' })
  const item = { name: 'gold_nugget', componentMap: new Map([['custom_model_data', { data: 123 }]]) }
  const appearance = pack.itemAppearance(item)
  assert.equal(appearance.resourceModel, 'veridian:item/mission')
  assert.match(appearance.resourceIcon, /^data:image\/png;base64,/)

  const modernAppearance = pack.itemAppearance({ name: 'paper', componentMap: new Map([['item_model', { data: 'veridian:mission' }]]) })
  assert.equal(modernAppearance.resourceModel, 'veridian:item/mission')
  assert.match(modernAppearance.resourceIcon, /^data:image\/png;base64,/)

  const title = pack.titleAppearance('\ue001\ue002')
  assert.equal(title.text, '\ue001\ue002')
  assert.equal(title.glyphs[0].renderHeight, 64)
  assert.match(title.glyphs[0].image, /^data:image\/png;base64,/)
  assert.equal(title.glyphs[1].advance, -20)
})

test('bounded extraction handles resource packs with corrupt declared expanded sizes', () => {
  const pack = parseResourcePack(corruptDeclaredSizes(fixturePack()), { source: 'https://packs.example/corrupt.zip', sha1: 'fixture' })
  const appearance = pack.itemAppearance({ name: 'gold_nugget', componentMap: new Map([['custom_model_data', { data: 123 }]]) })
  assert.equal(appearance.resourceModel, 'veridian:item/mission')
  assert.match(appearance.resourceIcon, /^data:image\/png;base64,/)
  assert.match(pack.titleAppearance('\ue001').glyphs[0].image, /^data:image\/png;base64,/)
})

test('loads a bounded HTTP pack, validates its hash, and caches the parsed result', async () => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  let downloads = 0
  const loader = new ResourcePackLoader({ fetchImpl: async () => {
    downloads++
    return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes }
  } })
  const first = await loader.load('https://packs.example/menu.zip?token=secret', hash)
  const second = await loader.load('https://packs.example/menu.zip?token=secret', hash)
  assert.equal(first, second)
  assert.equal(downloads, 1)
  assert.equal(first.source, 'https://packs.example/menu.zip')
  await assert.rejects(loader.load('file:///tmp/menu.zip'), /HTTP or HTTPS/)
})

test('normalizes Mineflayer resource-pack argument order and modern item definitions', () => {
  assert.deepEqual(normalizePackEvent('0123456789012345678901234567890123456789', 'https://packs.example/menu.zip'), {
    url: 'https://packs.example/menu.zip',
    hash: '0123456789012345678901234567890123456789'
  })
  const model = resolveItemDefinition({
    type: 'minecraft:range_dispatch',
    property: 'minecraft:custom_model_data',
    fallback: { type: 'minecraft:model', model: 'minecraft:item/gold_nugget' },
    entries: [{ threshold: 5, model: { type: 'minecraft:model', model: 'veridian:item/mission' } }]
  }, { floats: [6] })
  assert.equal(model, 'veridian:item/mission')
})
