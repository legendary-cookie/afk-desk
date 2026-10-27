const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const AdmZip = require('adm-zip')
const { ResourcePackLoader, parseResourcePack, normalizePackEvent, resolveItemDefinition, discoverLauncherPackDirs } = require('../electron/resource-pack.cjs')

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }]
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XfSUWQAAAABJRU5ErkJggg==', 'base64')

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-pack-cache-'))
  try { return await callback(directory) } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

test('verified AFK Desk cache hit avoids fetching', async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const cacheDir = path.join(directory, 'cache')
  fs.mkdirSync(cacheDir)
  fs.writeFileSync(path.join(cacheDir, `${hash}.zip`), bytes)
  let calls = 0
  const diagnostics = []
  const loader = new ResourcePackLoader({ cacheDir, diagnose: (entry) => diagnostics.push(entry), fetchImpl: async () => { calls++; throw new Error('unexpected fetch') } })
  const pack = await loader.load('https://packs.example/a.zip', hash)
  assert.equal(pack.sha1, hash)
  assert.equal(calls, 0)
  assert.deepEqual(diagnostics.map((entry) => [entry.event, entry.source]), [['resource_pack_cache_hit', 'afkdesk']])
}))

test('mismatched AFK Desk cache file is deleted and download proceeds', async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const cacheDir = path.join(directory, 'cache')
  fs.mkdirSync(cacheDir)
  const cached = path.join(cacheDir, `${hash}.zip`)
  fs.writeFileSync(cached, Buffer.from('wrong'))
  let calls = 0
  const loader = new ResourcePackLoader({ cacheDir, lookup: PUBLIC_LOOKUP, fetchImpl: async () => { calls++; return new Response(bytes) } })
  assert.equal((await loader.load('https://packs.example/a.zip', hash)).sha1, hash)
  assert.equal(calls, 1)
  assert.equal(fs.readFileSync(cached).equals(bytes), true)
}))

test('AFK Desk cache ignores symlink entries', async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const cacheDir = path.join(directory, 'cache')
  fs.mkdirSync(cacheDir)
  const link = path.join(cacheDir, `${hash}.zip`)
  fs.writeFileSync(link, bytes)
  let calls = 0
  const loader = new ResourcePackLoader({ cacheDir, lookup: PUBLIC_LOOKUP, fetchImpl: async () => { calls++; return new Response(bytes) } })
  const originalLstat = fs.lstatSync
  fs.lstatSync = function (file, ...args) {
    if (file === link) return { isFile: () => false, isSymbolicLink: () => true }
    return originalLstat.call(this, file, ...args)
  }
  try { await loader.load('https://packs.example/a.zip', hash) } finally { fs.lstatSync = originalLstat }
  assert.equal(calls, 1)
  assert.equal(fs.readFileSync(link).equals(bytes), true)
}))

for (const suffix of ['', '.zip']) test(`launcher cache hit for ${suffix || 'bare hash'} is copied without changing source`, async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const external = path.join(directory, 'launcher')
  const cacheDir = path.join(directory, 'afk-cache')
  fs.mkdirSync(external)
  const source = path.join(external, `${hash}${suffix}`)
  fs.writeFileSync(source, bytes)
  let calls = 0
  const diagnostics = []
  const loader = new ResourcePackLoader({ cacheDir, externalCacheDirs: [external], diagnose: (entry) => diagnostics.push(entry), fetchImpl: async () => { calls++; throw new Error('unexpected fetch') } })
  assert.equal((await loader.load('https://packs.example/a.zip', hash)).sha1, hash)
  assert.equal(calls, 0)
  assert.equal(fs.readFileSync(source).equals(bytes), true)
  assert.equal(fs.readFileSync(path.join(cacheDir, `${hash}.zip`)).equals(bytes), true)
  assert.deepEqual(diagnostics.map((entry) => entry.source), ['launcher'])
}))

test('hashless load skips all cache lookups', async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const cacheDir = path.join(directory, 'cache')
  const external = path.join(directory, 'launcher')
  fs.mkdirSync(cacheDir); fs.mkdirSync(external)
  fs.writeFileSync(path.join(cacheDir, `${hash}.zip`), bytes)
  fs.writeFileSync(path.join(external, hash), bytes)
  let calls = 0
  const loader = new ResourcePackLoader({ cacheDir, externalCacheDirs: [external], lookup: PUBLIC_LOOKUP, fetchImpl: async () => { calls++; return new Response(bytes) } })
  await loader.load('https://packs.example/a.zip')
  assert.equal(calls, 1)
}))

test('disabled launcher setting skips launcher lookup', async () => withTempDir(async (directory) => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  const external = path.join(directory, 'launcher')
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, hash), bytes)
  let calls = 0
  const loader = new ResourcePackLoader({ externalCacheDirs: [external], useLauncherPackCache: false, lookup: PUBLIC_LOOKUP, fetchImpl: async () => { calls++; return new Response(bytes) } })
  await loader.load('https://packs.example/a.zip', hash)
  assert.equal(calls, 1)
}))

test('launcher cache discovery enumerates Minecraft, Modrinth, and CurseForge directories one level deep', () => withTempDir((directory) => {
  const appData = path.join(directory, 'appdata')
  const userProfile = path.join(directory, 'user')
  for (const relative of ['.minecraft/downloads', '.minecraft/server-resource-packs', 'ModrinthApp/profiles/one/downloads', 'ModrinthApp/profiles/one/server-resource-packs', 'ModrinthApp/profiles/two/downloads', 'curseforge/minecraft/Instances/world/downloads', 'curseforge/minecraft/Instances/world/server-resource-packs']) fs.mkdirSync(path.join(relative.startsWith('curseforge') ? userProfile : appData, relative), { recursive: true })
  fs.mkdirSync(path.join(appData, 'ModrinthApp/profiles/not-a-profile/nested/downloads'), { recursive: true })
  const found = discoverLauncherPackDirs({ appData, userProfile })
  assert.equal(found.length, 7)
  assert.ok(found.includes(path.join(appData, 'ModrinthApp/profiles/one/downloads')))
  assert.ok(found.includes(path.join(userProfile, 'curseforge/minecraft/Instances/world/server-resource-packs')))
  assert.equal(found.some((entry) => entry.includes('not-a-profile/nested')), false)
}))

test('a long chain of distinct model parents falls back without overflowing the stack', () => {
  const zip = new AdmZip()
  for (let index = 0; index < 12000; index++) {
    zip.addFile(`assets/minecraft/models/item/chain_${index}.json`, Buffer.from(JSON.stringify({ parent: `minecraft:item/chain_${index + 1}` })))
  }
  const pack = parseResourcePack(zip.toBuffer())
  assert.deepEqual(pack.itemAppearance({ name: 'chain_0' }), {})
})

test('declared oversized body is cancelled before any pull is consumed', async () => {
  let cancelled = false
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, maxPackBytes: 16, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true }
  }), { headers: { 'content-length': '17' } }) })
  await assert.rejects(loader.load('https://packs.example/declared.zip'), /download limit/)
  assert.equal(cancelled, true)
})

test('download deadline also bounds a stalled response-header request', async () => {
  let signal
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, downloadTimeoutMs: 10, fetchImpl: (_url, options) => {
    signal = options.signal
    return new Promise(() => {})
  } })
  await assert.rejects(loader.load('https://packs.example/no-headers.zip'), /timed out/)
  assert.equal(signal.aborted, true)
  assert.equal(loader.activeDownloads, 0)
})

test('stream read failure aborts download and removes failed cache entry', async () => {
  let signal
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl: async (_url, options) => {
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
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, maxPackBytes: 16, fetchImpl: async (_url, options) => {
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
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, downloadTimeoutMs: 10, fetchImpl: async (_url, options) => {
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
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true }
  }), { status: 500 }) })
  await assert.rejects(loader.load('https://packs.example/error.zip'), /HTTP 500/)
  assert.equal(cancelled, true)
})

test('bounded parsed cache evicts oldest result and download failures allow retry', async () => {
  let downloads = 0
  const bytes = fixturePack()
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, maxCacheEntries: 2, fetchImpl: async () => {
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
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, cacheDir: directory, maxCacheEntries: 1, maxCacheBytes: bytes.length, fetchImpl: async () => new Response(invalid ? 'bad zip' : bytes) })
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

test('tolerant ZIP fallback ignores corrupt extra fields and trusts central sizes', () => {
  const bytes = syntheticZip([
    { name: 'assets/veridian/models/item/mission.json', data: Buffer.from('{"parent":"minecraft:item/generated"}'), method: 8, badExtra: true, lyingLocalSizes: true },
    { name: 'assets/minecraft/models/item/stone.json', data: Buffer.from('{}'), method: 0 }
  ])
  assert.throws(() => new AdmZip(bytes).getEntries(), /ADM-ZIP/)
  const pack = parseResourcePack(bytes)
  assert.ok(pack.json.has('veridian:models/item/mission.json'))
  assert.ok(pack.json.has('minecraft:models/item/stone.json'))
})

test('tolerant ZIP extraction enforces the compression ratio and rejects traversal names', () => {
  const bytes = syntheticZip([
    { name: 'assets/veridian/models/item/huge.json', data: Buffer.from(' '.repeat(1_800_000) + '{}'), method: 8, badExtra: true },
    { name: '../assets/veridian/models/item/traversal.json', data: Buffer.from('{}'), method: 0, badExtra: true }
  ])
  const pack = parseResourcePack(bytes)
  assert.equal(pack.json.has('veridian:models/item/huge.json'), false)
  assert.equal(pack.json.has('veridian:models/item/traversal.json'), false)
})

function syntheticZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = file.method === 8 ? zlib.deflateRawSync(file.data) : file.data
    const extra = file.badExtra ? Buffer.from([1, 0, 16, 0]) : Buffer.alloc(0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(file.method, 8)
    local.writeUInt32LE(file.lyingLocalSizes ? 0xffffffff : data.length, 18)
    local.writeUInt32LE(file.lyingLocalSizes ? 0xffffffff : file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(file.method, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(file.badExtra ? 0xffff : extra.length, 30); central.writeUInt32LE(offset, 42)
    centrals.push(central, name, extra)
    offset += local.length + name.length + data.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

test('loads a bounded HTTP pack, validates its hash, and caches the parsed result', async () => {
  const bytes = fixturePack()
  const hash = crypto.createHash('sha1').update(bytes).digest('hex')
  let downloads = 0
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl: async () => {
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


// --- SSRF destination policy ---

const PUBLIC_IP = '93.184.216.34'

function recordingFetch(handler) {
  const calls = []
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), redirect: options?.redirect }); return handler(String(url), calls.length) }
  return { calls, fetchImpl }
}

function packZip() {
  const zip = new AdmZip()
  zip.addFile('assets/minecraft/models/item/stone.json', Buffer.from('{}'))
  return zip.toBuffer()
}

test('resource pack URLs that target loopback, private, or link-local hosts are refused without a request', async () => {
  const blocked = [
    'http://127.0.0.1/p.zip', 'http://localhost/p.zip', 'http://sub.localhost/p.zip', 'http://0.0.0.0/p.zip', 'http://10.1.2.3/p.zip',
    'http://172.16.0.1/p.zip', 'http://172.31.255.255/p.zip', 'http://192.168.0.1/p.zip', 'http://100.64.0.1/p.zip',
    'http://169.254.169.254/latest/meta-data', 'http://224.0.0.1/p.zip', 'http://2130706433/p.zip', 'http://0x7f.1/p.zip',
    'http://[::1]/p.zip', 'http://[::]/p.zip', 'http://[::ffff:127.0.0.1]/p.zip', 'http://[::ffff:7f00:1]/p.zip',
    'http://[::ffff:10.0.0.1]/p.zip', 'http://[fe80::1]/p.zip', 'http://[fd12:3456::1]/p.zip', 'http://[fc00::1]/p.zip',
    'http://[ff02::1]/p.zip', 'http://[64:ff9b::7f00:1]/p.zip', 'http://[2002:7f00:1::]/p.zip'
  ]
  for (const url of blocked) {
    const { calls, fetchImpl } = recordingFetch(() => new Response(packZip()))
    const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl })
    await assert.rejects(loader.load(url), /not allowed/, url)
    assert.equal(calls.length, 0, url)
  }
})

test('public addresses and ports are still allowed', async () => {
  for (const url of ['https://packs.example/p.zip', `http://${PUBLIC_IP}:8080/p.zip`, 'http://[2606:4700:4700::1111]/p.zip', 'http://172.32.0.1/p.zip', 'http://100.128.0.1/p.zip']) {
    const { calls, fetchImpl } = recordingFetch(() => new Response(packZip()))
    const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl })
    await loader.load(url)
    assert.equal(calls.length, 1, url)
  }
})

test('a host is refused when any resolved address is private', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(packZip()))
  const lookup = async (host, options) => {
    assert.equal(options.all, true)
    return [{ address: PUBLIC_IP, family: 4 }, { address: '10.0.0.5', family: 4 }]
  }
  const loader = new ResourcePackLoader({ lookup, fetchImpl })
  await assert.rejects(loader.load('https://rebind.example/p.zip'), /not allowed/)
  assert.equal(calls.length, 0)
  const failing = new ResourcePackLoader({ lookup: async () => { throw new Error('ENOTFOUND') }, fetchImpl })
  await assert.rejects(failing.load('https://nxdomain.example/p.zip'), /could not be resolved/)
  const mappedV6 = new ResourcePackLoader({ lookup: async () => [{ address: '::ffff:192.168.1.1', family: 6 }], fetchImpl })
  await assert.rejects(mappedV6.load('https://mapped.example/p.zip'), /not allowed/)
})

test('redirects are followed manually and every hop is revalidated', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url === 'https://packs.example/start.zip') return new Response(null, { status: 302, headers: { location: '/next.zip' } })
    if (url === 'https://packs.example/next.zip') return new Response(packZip())
    throw new Error(`unexpected ${url}`)
  })
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl })
  await loader.load('https://packs.example/start.zip')
  assert.deepEqual(calls.map((call) => call.url), ['https://packs.example/start.zip', 'https://packs.example/next.zip'])
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual'])

  for (const target of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:8080/admin', 'http://[::1]/x', 'file:///etc/passwd', 'ftp://packs.example/p.zip']) {
    const redirecting = recordingFetch(() => new Response(null, { status: 307, headers: { location: target } }))
    const guarded = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl: redirecting.fetchImpl })
    await assert.rejects(guarded.load('https://packs.example/hop.zip'), /not allowed|HTTP or HTTPS/, target)
    assert.equal(redirecting.calls.length, 1, target)
  }

  const viaDns = recordingFetch(() => new Response(null, { status: 301, headers: { location: 'https://internal.example/p.zip' } }))
  const lookup = async (host) => [{ address: host === 'internal.example' ? '192.168.0.9' : PUBLIC_IP, family: 4 }]
  await assert.rejects(new ResourcePackLoader({ lookup, fetchImpl: viaDns.fetchImpl }).load('https://packs.example/a.zip'), /not allowed/)
  assert.equal(viaDns.calls.length, 1)
})

test('redirect chains are limited to five hops', async () => {
  const { calls, fetchImpl } = recordingFetch((_url, count) => new Response(null, { status: 302, headers: { location: `https://packs.example/hop${count}.zip` } }))
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl })
  await assert.rejects(loader.load('https://packs.example/hop0.zip'), /redirected more than 5 times/)
  assert.equal(calls.length, 6)

  const five = recordingFetch((_url, count) => count <= 5
    ? new Response(null, { status: 302, headers: { location: `https://packs.example/hop${count}.zip` } })
    : new Response(packZip()))
  await new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl: five.fetchImpl }).load('https://packs.example/hop0.zip')
  assert.equal(five.calls.length, 6)
})

test('allowPrivatePackHosts is opt-in and does not leak through the cache', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(packZip()))
  const loader = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl })
  await assert.rejects(loader.load('http://192.168.1.5/p.zip'), /not allowed/)
  await loader.load('http://192.168.1.5/p.zip', '', { allowPrivateHosts: true })
  assert.equal(calls.length, 1)
  await assert.rejects(loader.load('http://192.168.1.5/p.zip'), /not allowed/)
  const optIn = new ResourcePackLoader({ lookup: PUBLIC_LOOKUP, fetchImpl, allowPrivatePackHosts: true })
  await optIn.load('http://127.0.0.1:9000/p.zip')
  assert.equal(calls.length, 2)
  assert.equal(new ResourcePackLoader({}).allowPrivatePackHosts, false)
})

test('the default DNS lookup is used when none is injected', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(packZip()))
  const loader = new ResourcePackLoader({ fetchImpl })
  await assert.rejects(loader.load('http://localhost/p.zip'), /not allowed/)
  assert.equal(calls.length, 0)
})

test('component text flattening is bounded and iterative', () => {
  const { flattenComponentText } = require('../electron/resource-pack.cjs')
  let chain = { text: 'x' }
  for (let index = 0; index < 12_000; index++) chain = { text: '', extra: [chain] }
  assert.doesNotThrow(() => flattenComponentText(chain))
  assert.equal(flattenComponentText(chain), '')
  const wide = { text: 'a', extra: Array.from({ length: 100_000 }, () => ({ text: 'b' })) }
  const flat = flattenComponentText(wide)
  assert.equal(flat.startsWith('abb'), true)
  assert.equal(flat.length <= 4097, true)
  assert.equal(flattenComponentText({ text: 'Hi ', extra: [{ text: 'there' }, '!'] }), 'Hi there!')
  assert.equal(flattenComponentText('{"text":"json","extra":[{"text":"!"}]}'), 'json!')
})

test('launcher pack cache is searched from system %APPDATA%, not AFK Desk userData', () => {
  const { resolveSystemAppData } = require('../electron/resource-pack.cjs')
  assert.equal(resolveSystemAppData({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u\\AppData\\Roaming\\afkdesk'), 'C:\\Users\\u\\AppData\\Roaming')
  assert.equal(resolveSystemAppData({}, '/home/u/.config/afkdesk'), require('node:path').dirname('/home/u/.config/afkdesk'))
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'core', 'app-core.cjs'), 'utf8')
  assert.doesNotMatch(src, /appDataPath:\s*userDataPath/)
})
