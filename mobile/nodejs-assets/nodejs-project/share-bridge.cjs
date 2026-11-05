'use strict'
const share = require('./share-links.cjs')
const model = require('./macro/model.cjs')

function exportShare(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Share data is required.')
  if (kind === 'profile') return share.encode(kind, share.profileData(data))
  if (kind === 'macro') { if (data.version != null && ![2, 3].includes(data.version)) throw new Error('Unsupported macro version.'); return share.encode(kind, share.macroData(data, model)) }
  throw new Error('Unknown share kind.')
}
function previewShare(link) {
  const { kind, data } = share.decode(link)
  if (kind === 'profile') {
    const safe = share.profileData(data)
    if (typeof safe.host !== 'string' || !safe.host.trim()) throw new Error('Server address is required.')
    if (safe.port !== undefined && (!Number.isInteger(Number(safe.port)) || Number(safe.port) < 1 || Number(safe.port) > 65535)) throw new Error('Invalid server port.')
    return { kind, data: safe, errors: [] }
  }
  if (data.version != null && ![2, 3].includes(data.version)) throw new Error('Unsupported macro version.')
  const safe = share.macroData(data, model)
  const result = model.importMacros(JSON.stringify(safe), { accountIds: [] })
  if (!result.macros.length) throw new Error('Invalid macro.')
  return { kind, data: result.macros[0], errors: result.errors }
}
module.exports = { exportShare, previewShare }
