function computeSignedChatChecksum(lastSeenMessages) {
  if (!lastSeenMessages || lastSeenMessages.length === 0) return 1

  let checksum = 1
  for (const message of lastSeenMessages) {
    if (!message.signature) continue
    let signatureHash = 1
    for (let index = 0; index < message.signature.length; index += 1) {
      signatureHash = (31 * signatureHash + message.signature[index]) & 0xffffffff
    }
    checksum = (31 * checksum + signatureHash) & 0xffffffff
  }

  const unsigned = checksum & 0xff
  const signed = unsigned > 127 ? unsigned - 256 : unsigned
  return signed === 0 ? 1 : signed
}

function applyProtocolFixes() {
  try {
    const checksums = require('minecraft-protocol/src/datatypes/checksums')
    checksums.computeChatChecksum = computeSignedChatChecksum
  } catch (error) {
    console.warn('Could not apply Minecraft 1.21.11 chat checksum compatibility fix:', error.message)
  }
}

module.exports = { applyProtocolFixes, computeSignedChatChecksum }
