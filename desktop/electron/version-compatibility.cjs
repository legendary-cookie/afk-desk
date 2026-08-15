function preferredVersionForAccount(account, accounts = []) {
  const explicit = cleanVersion(account?.version)
  if (explicit) return explicit
  const successful = account?.lastSuccessfulVersionStable === true
    ? cleanVersion(account?.lastSuccessfulVersion)
    : ''
  if (successful) return successful

  const host = String(account?.host || '').trim().toLowerCase()
  const port = Number(account?.port) || 25565
  const counts = new Map()
  for (const peer of accounts) {
    if (peer?.id === account?.id) continue
    if (String(peer?.host || '').trim().toLowerCase() !== host) continue
    if ((Number(peer?.port) || 25565) !== port) continue
    const version = cleanVersion(peer?.version) || (peer?.lastSuccessfulVersionStable === true ? cleanVersion(peer?.lastSuccessfulVersion) : '')
    if (version) counts.set(version, (counts.get(version) || 0) + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0], undefined, { numeric: true }))[0]?.[0] || ''
}

function cleanVersion(value) {
  return String(value || '').trim().slice(0, 32)
}

function rememberedVersionState(inputVersion, input, existing) {
  const version = cleanVersion(inputVersion)
  const clearedExplicitVersion = Boolean(cleanVersion(existing?.version)) && !version
  if (clearedExplicitVersion) {
    return { lastSuccessfulVersion: '', lastSuccessfulVersionStable: false }
  }
  return {
    lastSuccessfulVersion: cleanVersion(input?.lastSuccessfulVersion || existing?.lastSuccessfulVersion || existing?.version),
    lastSuccessfulVersionStable: input?.lastSuccessfulVersionStable === true || existing?.lastSuccessfulVersionStable === true
  }
}

module.exports = { preferredVersionForAccount, rememberedVersionState }
