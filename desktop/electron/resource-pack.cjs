const AdmZip = require('adm-zip')
const crypto = require('crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const MAX_PACK_BYTES = 100 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_TEXTURE_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_PARSED_JSON_BYTES = 100 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

class ResourcePackLoader {
  constructor({ fetchImpl = globalThis.fetch, cacheDir = '', maxPackBytes = MAX_PACK_BYTES,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS, maxCacheEntries = 8, maxCacheBytes = 300 * 1024 * 1024 } = {}) {
    this.fetchImpl = fetchImpl
    this.cacheDir = cacheDir
    this.maxPackBytes = boundedLimit(maxPackBytes, MAX_PACK_BYTES)
    this.downloadTimeoutMs = boundedLimit(downloadTimeoutMs, DOWNLOAD_TIMEOUT_MS)
    this.maxCacheEntries = boundedLimit(maxCacheEntries, 8)
    this.maxCacheBytes = boundedLimit(maxCacheBytes, 300 * 1024 * 1024)
    this.cache = new Map()
    this.activeDownloads = 0
  }

  async load(urlValue, expectedHash = '') {
    const url = normalizePackUrl(urlValue)
    const hash = normalizeHash(expectedHash)
    const key = `${url.href}|${hash}`
    if (this.cache.has(key)) return this.cache.get(key)
    if (this.activeDownloads >= 4) throw new Error('Too many resource pack downloads in progress. Try again shortly.')
    while (this.cache.size >= this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value)
    this.activeDownloads++
    const task = this.#downloadAndParse(url, hash).catch((error) => {
      if (this.cache.get(key) === task) this.cache.delete(key)
      throw error
    }).finally(() => { this.activeDownloads-- })
    this.cache.set(key, task)
    return task
  }

  async #downloadAndParse(url, expectedHash) {
    const controller = new AbortController()
    const timeoutError = new Error('Resource pack download timed out.')
    let rejectAbort
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(controller.signal.reason || timeoutError)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(timeoutError), this.downloadTimeoutMs)
    let response
    let reader
    try {
      response = await Promise.race([Promise.resolve().then(() => this.fetchImpl(url, { signal: controller.signal, redirect: 'follow' })), aborted])
      if (!response?.ok) throw new Error(`Resource pack download failed with HTTP ${response?.status || 'unknown'}.`)
      const length = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(length) && length > this.maxPackBytes) throw new Error('Resource pack exceeds the download limit (maximum 100 MB).')
      if (!response.body?.getReader) throw new Error('Resource pack response does not support safe streaming.')
      reader = response.body.getReader()
      const chunks = []
      let total = 0
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) break
        total += value.byteLength
        if (total > this.maxPackBytes) throw new Error('Resource pack exceeds the download limit (maximum 100 MB).')
        chunks.push(Buffer.from(value))
      }
      const buffer = Buffer.concat(chunks, total)
      const sha1 = crypto.createHash('sha1').update(buffer).digest('hex')
      if (expectedHash && expectedHash.length === 40 && sha1 !== expectedHash) throw new Error('Resource pack SHA-1 does not match the server hash.')
      const parsed = parseResourcePack(buffer, { source: safePackSource(url), sha1 })
      if (this.cacheDir && buffer.length <= this.maxCacheBytes) this.#cacheToDisk(sha1, buffer)
      return parsed
    } catch (error) {
      controller.abort(error)
      // Cancellation must not make the deadline depend on a broken stream's cancel promise.
      try { Promise.resolve(reader ? reader.cancel(error) : response?.body?.cancel(error)).catch(() => {}) } catch {}
      throw error
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      try { reader?.releaseLock() } catch {}
    }
  }

  #cacheToDisk(sha1, buffer) {
    fs.mkdirSync(this.cacheDir, { recursive: true })
    const target = path.join(this.cacheDir, `${sha1}.zip`)
    const entries = fs.readdirSync(this.cacheDir).filter(name => /^[a-f0-9]{40}\.zip$/.test(name)).flatMap(name => {
      const file = path.join(this.cacheDir, name)
      const stat = fs.lstatSync(file)
      return stat.isFile() ? [{ file, size: stat.size, mtime: stat.mtimeMs }] : []
    }).sort((a, b) => a.mtime - b.mtime)
    // Do not follow symlinks or overwrite unrelated directories at the destination.
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error('Unsafe resource pack cache destination.')
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    let count = entries.length
    const previous = entries.find(entry => entry.file === target)
    if (previous) { bytes -= previous.size; count-- }
    for (const entry of entries) {
      if (bytes + buffer.length <= this.maxCacheBytes && count + 1 <= this.maxCacheEntries) break
      if (entry.file === target) continue
      fs.unlinkSync(entry.file)
      bytes -= entry.size
      count--
    }
    // Remove only an already managed hash file, then create exclusively (no symlink following).
    if (previous) fs.unlinkSync(target)
    fs.writeFileSync(target, buffer, { flag: 'wx' })
  }
}

function boundedLimit(value, maximum) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, Math.max(1, Math.floor(number))) : maximum
}

class ParsedResourcePack {
  constructor({ source, sha1, json, textureStore, fonts }) {
    this.source = source
    this.sha1 = sha1
    this.json = json
    this.textureStore = textureStore
    this.fonts = fonts
  }

  itemAppearance(item) {
    const itemName = String(item?.name || '').replace(/^minecraft:/, '')
    if (!itemName) return {}
    const components = itemComponents(item)
    let model = components.itemModel ? this.#componentItemModel(components.itemModel, components.customModelData) : null
    if (!model) model = this.#modernItemModel(itemName, components.customModelData)
    if (!model) model = this.#legacyItemModel(itemName, components.customModelData)
    if (!model) return {}
    const texture = this.#modelTexture(model)
    const image = texture && this.textureStore.get(textureKey(texture))
    return image ? { resourceIcon: image.dataUrl, resourceModel: normalizeAssetKey(model) } : {}
  }

  #componentItemModel(itemModel, customModelData) {
    const definition = this.json.get(itemDefinitionJsonKey(itemModel))
    return definition ? resolveItemDefinition(definition.model || definition, customModelData) : itemModel
  }

  titleAppearance(value) {
    const text = flattenComponentText(value)
    if (!text) return null
    const glyphs = []
    let customGlyphs = 0
    for (const character of [...text].slice(0, 160)) {
      const glyph = resolveFontGlyph(this.fonts.get(character), this.textureStore)
      if (glyph) {
        glyphs.push({ character, ...glyph })
        if (glyph.image) customGlyphs++
      } else glyphs.push({ character, advance: 8 })
    }
    return customGlyphs ? { text, glyphs } : null
  }

  #legacyItemModel(itemName, customModelData) {
    const base = this.json.get(`minecraft:models/item/${itemName}.json`)
    if (!base) return null
    let selected = `minecraft:item/${itemName}`
    const numeric = firstNumber(customModelData)
    if (numeric == null) return selected
    for (const override of Array.isArray(base.overrides) ? base.overrides : []) {
      const threshold = Number(override?.predicate?.custom_model_data)
      if (Number.isFinite(threshold) && numeric >= threshold && override?.model) selected = override.model
    }
    return selected
  }

  #modernItemModel(itemName, customModelData) {
    const definition = this.json.get(`minecraft:items/${itemName}.json`)
    return definition ? resolveItemDefinition(definition.model || definition, customModelData) : null
  }

  #modelTexture(modelKey) {
    const seen = new Set()
    let key = normalizeAssetKey(modelKey)
    let textures = {}
    for (let depth = 0; depth < 64 && key && !seen.has(key); depth++) {
      seen.add(key)
      const model = this.json.get(modelJsonKey(key))
      if (!model) return key.includes(':item/') ? key : null
      textures = { ...textures, ...(model.textures || {}) }
      const candidate = textures.layer0 || textures.layer1 || textures.particle || Object.values(textures).find((value) => typeof value === 'string')
      if (candidate) return resolveTextureVariable(candidate, textures)
      key = model.parent ? normalizeAssetKey(model.parent) : ''
    }
    return null
  }
}

function parseResourcePack(buffer, metadata = {}) {
  const archive = new AdmZip(buffer)
  const entries = archive.getEntries()
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Resource pack contains too many files.')
  const json = new Map()
  const textureEntries = new Map()
  const fontDefinitions = []
  let parsedJsonBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = String(entry.entryName || '').replaceAll('\\', '/')
    if (!/^assets\/[a-z0-9_.-]+\/(?:models|items|textures|font)\//i.test(name)) continue
    const match = name.match(/^assets\/([^/]+)\/(.+)$/i)
    if (!match) continue
    const namespace = match[1].toLowerCase()
    const relative = match[2]
    if (relative.endsWith('.json')) {
      try {
        const data = safeEntryData(entry, MAX_JSON_BYTES)
        if (!data) continue
        if (data.length > MAX_JSON_BYTES || parsedJsonBytes + data.length > MAX_PARSED_JSON_BYTES) continue
        parsedJsonBytes += data.length
        const value = JSON.parse(data.toString('utf8'))
        const key = `${namespace}:${relative}`
        json.set(key, value)
        if (relative.startsWith('font/')) fontDefinitions.push({ namespace, value })
      } catch {}
    } else if (relative.startsWith('textures/') && relative.endsWith('.png')) {
      textureEntries.set(`${namespace}:${relative.slice('textures/'.length, -4)}`, entry)
    }
  }
  const textureStore = new LazyTextureStore(textureEntries)
  return new ParsedResourcePack({ ...metadata, json, textureStore, fonts: buildFontIndex(fontDefinitions) })
}

class LazyTextureStore {
  constructor(entries) {
    this.entries = entries
    this.decoded = new Map()
    this.dataUrls = { get: (key) => this.get(key)?.dataUrl }
  }

  get(key) {
    if (this.decoded.has(key)) return this.decoded.get(key)
    const entry = this.entries.get(key)
    if (!entry) return null
    const data = safeEntryData(entry, MAX_TEXTURE_BYTES)
    if (!data) return null
    const dimensions = pngDimensions(data)
    const texture = dimensions ? { dataUrl: `data:image/png;base64,${data.toString('base64')}`, ...dimensions } : null
    this.decoded.set(key, texture)
    return texture
  }
}

function safeEntryData(entry, maximumBytes) {
  try {
    if ((Number(entry?.header?.flags) & 1) !== 0) return null
    const compressed = entry?.getCompressedData?.()
    if (!Buffer.isBuffer(compressed) || compressed.length > MAX_PACK_BYTES) return null
    const method = Number(entry?.header?.method)
    if (method === 0) return compressed.length <= maximumBytes ? Buffer.from(compressed) : null
    if (method !== 8) return null
    return zlib.inflateRawSync(compressed, { maxOutputLength: maximumBytes })
  } catch {
    return null
  }
}

function buildFontIndex(definitions) {
  const fonts = new Map()
  for (const { namespace, value } of definitions) {
    for (const provider of Array.isArray(value?.providers) ? value.providers : []) {
      if (provider?.type === 'space') {
        for (const [character, advance] of Object.entries(provider.advances || {})) fonts.set(character, { advance: Number(advance) || 0 })
        continue
      }
      if (provider?.type !== 'bitmap' || !provider.file || !Array.isArray(provider.chars)) continue
      const rows = provider.chars.length
      const columns = Math.max(0, ...provider.chars.map((row) => [...String(row)].length))
      if (!rows || !columns) continue
      for (let row = 0; row < rows; row++) {
        const characters = [...String(provider.chars[row])]
        for (let column = 0; column < characters.length; column++) {
          const character = characters[column]
          if (!character || character === '\u0000') continue
          fonts.set(character, {
            textureKey: textureKey(provider.file, namespace),
            row,
            column,
            rows,
            columns,
            renderHeight: Math.max(1, Math.min(Number(provider.height) || 8, 512)),
            ascent: Number(provider.ascent) || Number(provider.height) || 8
          })
        }
      }
    }
  }
  return fonts
}

function resolveFontGlyph(glyph, textures) {
  if (!glyph?.textureKey) return glyph
  const texture = textures.get(glyph.textureKey)
  if (!texture) return null
  const sourceWidth = texture.width / glyph.columns
  const sourceHeight = texture.height / glyph.rows
  return {
    image: texture.dataUrl,
    sourceX: Math.round(glyph.column * sourceWidth),
    sourceY: Math.round(glyph.row * sourceHeight),
    sourceWidth: Math.round(sourceWidth),
    sourceHeight: Math.round(sourceHeight),
    renderHeight: glyph.renderHeight,
    ascent: glyph.ascent,
    advance: Math.max(0, Math.round(sourceWidth * (glyph.renderHeight / sourceHeight)))
  }
}

function itemComponents(item) {
  const map = item?.componentMap
  const find = (name) => map?.get?.(name)?.data ?? item?.components?.find?.((component) => component?.type === name)?.data
  let customModelData
  try { customModelData = item?.customModel } catch {}
  customModelData ??= find('custom_model_data') ?? find('custom_model')
  return { itemModel: find('item_model') || (typeof customModelData === 'string' ? customModelData : ''), customModelData }
}

function resolveItemDefinition(model, customModelData, depth = 0) {
  if (!model || depth > 12) return null
  if (typeof model === 'string') return model
  const type = String(model.type || '').replace(/^minecraft:/, '')
  if (type === 'model') return model.model
  if (type === 'range_dispatch') {
    const number = firstNumber(customModelData) ?? 0
    let selected = model.fallback
    for (const entry of Array.isArray(model.entries) ? model.entries : []) if (number >= Number(entry.threshold)) selected = entry.model
    return resolveItemDefinition(selected, customModelData, depth + 1)
  }
  if (type === 'select') {
    const selectedValue = firstString(customModelData)
    const match = (Array.isArray(model.cases) ? model.cases : []).find((entry) => (Array.isArray(entry.when) ? entry.when : [entry.when]).map(String).includes(selectedValue))
    return resolveItemDefinition(match?.model || model.fallback, customModelData, depth + 1)
  }
  if (type === 'condition') return resolveItemDefinition(firstBoolean(customModelData) ? model.on_true : model.on_false, customModelData, depth + 1)
  if (type === 'composite') return resolveItemDefinition(model.models?.[0], customModelData, depth + 1)
  return model.model || null
}

function normalizePackEvent(first, second) {
  const values = [first, second]
  const url = values.find((value) => /^https?:\/\//i.test(String(value || '')))
  const hash = values.find((value) => /^[a-f0-9]{40}$/i.test(String(value || '')))
  return { url: url ? String(url) : '', hash: hash ? String(hash).toLowerCase() : '' }
}

function normalizePackUrl(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Resource pack URL must use HTTP or HTTPS.')
  return url
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{40}$/.test(hash) ? hash : ''
}

function safePackSource(url) {
  return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 300)
}

function normalizeAssetKey(value, fallbackNamespace = 'minecraft') {
  const raw = String(value || '').replace(/^\//, '')
  if (!raw) return ''
  return raw.includes(':') ? raw : `${fallbackNamespace}:${raw}`
}

function modelJsonKey(value) {
  const [namespace, path] = normalizeAssetKey(value).split(':', 2)
  return `${namespace}:models/${path}.json`
}

function itemDefinitionJsonKey(value) {
  const [namespace, path] = normalizeAssetKey(value).split(':', 2)
  return `${namespace}:items/${path}.json`
}

function textureKey(value, fallbackNamespace = 'minecraft') {
  const [namespace, path] = normalizeAssetKey(value, fallbackNamespace).split(':', 2)
  return `${namespace}:${path.replace(/^textures\//, '').replace(/\.png$/, '')}`
}

function resolveTextureVariable(value, textures, depth = 0) {
  if (depth > 8) return null
  const text = String(value || '')
  if (!text.startsWith('#')) return text
  const next = textures[text.slice(1)]
  return next ? resolveTextureVariable(next, textures, depth + 1) : null
}

function firstNumber(value) {
  if (Number.isFinite(Number(value)) && value !== '') return Number(value)
  const candidates = value?.floats ?? value?.values ?? value?.value
  if (Array.isArray(candidates) && Number.isFinite(Number(candidates[0]))) return Number(candidates[0])
  return null
}

function firstString(value) {
  if (typeof value === 'string') return value
  return String(value?.strings?.[0] ?? '')
}

function firstBoolean(value) {
  if (typeof value === 'boolean') return value
  return value?.flags?.[0] === true
}

function flattenComponentText(value) {
  if (typeof value === 'string') {
    try { return flattenComponentText(JSON.parse(value)) } catch { return value }
  }
  if (Array.isArray(value)) return value.map(flattenComponentText).join('')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'string') return flattenComponentText(value.value)
  const source = value.type === 'compound' && value.value ? value.value : value
  const text = flattenComponentText(source.text?.value ?? source.text ?? '')
  const extra = source.extra?.value?.value ?? source.extra?.value ?? source.extra ?? []
  return text + flattenComponentText(extra)
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192) return null
  return { width, height }
}

module.exports = { ResourcePackLoader, ParsedResourcePack, parseResourcePack, normalizePackEvent, itemComponents, resolveItemDefinition, flattenComponentText }
