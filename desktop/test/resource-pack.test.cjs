const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const AdmZip = require('adm-zip')
const { ResourcePackLoader, parseResourcePack, normalizePackEvent, resolveItemDefinition } = require('../electron/resource-pack.cjs')

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfSUWQAAAABJRU5ErkJggg==', 'base64')

test('declared oversized body is cancelled before any pull is consumed', async () => {
  let cancelled = false
  const loader = new ResourcePackLoader({ maxPackBytes: 16, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true }
  }), { headers: { 'content-length': '17' } }) })
  await assert.rejects(loader.load('https://packs.example/declared.zip'), /download limit/)
  assert.equal(cancelled, true)
})

test('download deadline also bounds a stalled response-header request', async () => {
  let signal
  const loader = new ResourcePackLoader({ downloadTimeoutMs: 10, fetchImpl: (_url, options) => {
    signal = options.signal
    return new Promise(() => {})
  } })
  await assert.rejects(loader.load('https://packs.example/no-headers.zip'), /timed out/)
  assert.equal(signal.aborted, true)
  assert.equal(loader.activeDownloads, 0)
})

test('stream read failure aborts download and removes failed cache entry', async () => {
  let signal
  const loader = new ResourcePackLoader({ fetchImpl: async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('stream failed')) } }))
  } })
  await assert.rejects(loader.load('https://packs.example/read-error.zip'), /stream failed/)
  assert.equal(signal.aborted, true)
  assert.equal(loader.cache.size, 0)
  assert.equal(loader.activeDownloads, 0)
})


test('streamed pack rejects lying content length before buffering the oversized body', async () => {
  let cancelled = false
  let signal
  let chunks = 0
  const loader = new ResourcePackLoader({ maxPackBytes: 16, fetchImpl: async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({
      pull(controller) { chunks++; if (chunks > 4) controller.close(); else controller.enqueue(new Uint8Array(12)) },
      cancel() { cancelled = true }
    }), { headers: { 'content-length': '1' } })
  } })
  await assert.rejects(loader.load('https://packs.example/oversize.zip'), /download limit/)
  assert.equal(cancelled, true)
  assert.equal(signal.aborted, true)
  assert.ok(chunks <= 3)
  assert.equal(loader.cache.size, 0)
})

test('download deadline cancels a stalled stream and releases its cache entry', async () => {
  let cancelled = false
  let signal
  const loader = new ResourcePackLoader({ downloadTimeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  } })
  await assert.rejects(loader.load('https://packs.example/stalled.zip'), /timed out/)
  assert.equal(cancelled, true)
  assert.equal(signal.aborted, true)
  assert.equal(loader.cache.size, 0)
})

test('failed HTTP response bodies are cancelled without reading', async () => {
  let cancelled = false
  const loader = new ResourcePackLoader({ fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true }
  }), { status: 500 }) })
  await assert.rejects(loader.load('https://packs.example/error.zip'), /HTTP 500/)
  assert.equal(cancelled, true)
})

test('bounded parsed cache evicts oldest result and download failures allow retry', async () => {
  let downloads = 0
  const bytes = fixturePack()
  const loader = new ResourcePackLoader({ maxCacheEntries: 2, fetchImpl: async () => {
    downloads++
    if (downloads === 1) return new Response('invalid zip')
    return new Response(bytes)
  } })
  await assert.rejects(loader.load('https://packs.example/one.zip'))
  await loader.load('https://packs.example/one.zip')
  await loader.load('https://packs.example/two.zip')
  await loader.load('https://packs.example/three.zip')
  assert.equal(loader.cache.size, 2)
  await loader.load('https://packs.example/one.zip')
  assert.equal(downloads, 5)
})

test('disk cache prunes only owned hash zip files and never caches invalid archives', async (t) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afkdesk-pack-cache-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const oldName = 'a'.repeat(40) + '.zip'
  fs.writeFileSync(path.join(directory, oldName), 'old')
  fs.writeFileSync(path.join(directory, 'notes.zip'), 'preserve')
  fs.mkdirSync(path.join(directory, 'b'.repeat(40) + '.zip'))
  const bytes = fixturePack()
  let invalid = true
  const loader = new ResourcePackLoader({ cacheDir: directory, maxCacheEntries: 1, maxCacheBytes: bytes.length, fetchImpl: async () => new Response(invalid ? 'bad zip' : bytes) })
  await assert.rejects(loader.load('https://packs.example/bad.zip'))
  assert.deepEqual(fs.readdirSync(directory).sort(), [oldName, 'b'.repeat(40) + '.zip', 'notes.zip'].sort())
  invalid = false
  await loader.load('https://packs.example/good.zip')
  assert.equal(fs.existsSync(path.join(directory, oldName)), false)
  assert.equal(fs.readFileSync(path.join(directory, 'notes.zip'), 'utf8'), 'preserve')
  assert.equal(fs.statSync(path.join(directory, 'b'.repeat(40) + '.zip')).isDirectory(), true)
  const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{40}\.zip$/.test(name) && fs.lstatSync(path.join(directory, name)).isFile())
  assert.equal(files.length, 1)
  assert.ok(files.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0) <= bytes.length)
})


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
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
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
