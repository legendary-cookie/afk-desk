const path = require('node:path')

function profilePath(root, id) {
  // Preserve existing timestamp/random IDs and UUIDs, but never interpret IDs
  // as paths (including Windows ADS and device names when tested on Windows).
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
    throw new Error('Invalid account ID')
  }
  const base = path.resolve(root)
  const result = path.resolve(base, id)
  if (path.dirname(result) !== base) throw new Error('Account profile is outside the profile directory')
  return result
}

module.exports = { profilePath }
