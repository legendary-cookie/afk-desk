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

module.exports = { rememberedVersionState }
