const path = require('node:path')

function validateProfileId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(id) ||
      id.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
    throw new Error('Invalid profile identifier. Existing profile data has not been moved or deleted.')
  }
  return id
}

function profilePath(root, id) {
  return path.join(root, validateProfileId(id))
}

module.exports = { profilePath, validateProfileId }
