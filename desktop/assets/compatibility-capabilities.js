(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.AfkCompatibility = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function describeCompatibility(account = {}) {
    const loaders = ['auto', 'vanilla', 'plugin', 'fabric', 'quilt', 'forge', 'neoforge', 'sponge', 'custom']
    const loader = loaders.includes(account.modLoader) ? account.modLoader : 'auto'
    const version = String(account.version || '')
    const parts = version.split('.').map(Number)
    const modernNeoForge = loader === 'neoforge' && (parts[0] > 1 || (parts[0] === 1 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 4))))
    const handshake = account.modHandshake || 'auto'
    const result = { loader, mode: 'vanilla-protocol', summary: 'Uses the standard Java protocol for vanilla-compatible servers.', limitations: ['Client mod code and custom gameplay are not executed.'], handshakes: ['off'], error: '' }
    if (['fabric', 'quilt', 'sponge', 'custom'].includes(loader)) {
      result.mode = 'brand-and-channels'
      result.summary = 'Vanilla-compatible connections, configured client brand, and optional raw plugin channels.'
      result.limitations.push('Required client mods, registry synchronization and arbitrary payload codecs need a dedicated adapter; channel registration alone does not implement them.')
    } else if (loader === 'auto' || loader === 'forge' || loader === 'neoforge') {
      result.mode = modernNeoForge ? 'vanilla-only' : 'legacy-fml'
      result.handshakes = modernNeoForge ? ['auto', 'off'] : ['auto', 'off', 'fml1', 'fml2', 'fml3']
      result.summary = modernNeoForge
        ? 'Modern NeoForge: vanilla-compatible servers only; configuration payload negotiation is not implemented.'
        : 'Supports advertised legacy Forge FML1/FML2/FML3 negotiation, subject to server mod requirements.'
      result.limitations.push('FML metadata matching does not implement mod blocks, entities or custom packet logic.')
      if (loader === 'neoforge') result.limitations.push('NeoForge 20.4 networking was rewritten. Its modern configuration protocol is not the legacy FML3 login wrapper. Automatic version checks the negotiated version before applying a legacy handler.')
      if (modernNeoForge && !['auto', 'off'].includes(handshake)) {
        result.error = 'Modern NeoForge configuration negotiation is not implemented. Choose Automatic/Disabled for a vanilla-compatible server, or use a supported legacy Forge server.'
      } else if (loader === 'neoforge' && !/^\d+\.\d+/.test(version) && !['auto', 'off'].includes(handshake)) {
        result.error = 'Select an explicit legacy Minecraft version before forcing a NeoForge FML handshake; modern configuration negotiation is not implemented.'
      }
    }
    return result
  }
  return { describeCompatibility }
})
