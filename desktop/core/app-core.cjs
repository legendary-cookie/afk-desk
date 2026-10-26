'use strict'
// Electron-free owner of durable/application services. Platform effects enter through hooks.
const path = require('node:path')
const crypto = require('node:crypto')
const { AccountStore, SettingsStore, startupConnectionDelay } = require('../electron/store.cjs')
const { BotManager: DefaultBotManager, normalizeSkinUrl: defaultNormalizeSkinUrl } = require('../electron/bot-manager.cjs')
const { BedrockBotManager: DefaultBedrockBotManager } = require('../electron/bedrock-bot-manager.cjs')
const { MultiEditionBotManager: DefaultMultiEditionBotManager } = require('../electron/multi-edition-manager.cjs')
const { DiagnosticLog } = require('../electron/diagnostic-log.cjs')
const { MacroLibraryStore, writeBackV1 } = require('../electron/macro/library-store.cjs')
const macroModel = require('../electron/macro/model.cjs')
const macroTriggers = require('../electron/macro/triggers.cjs')
const { MacroEngine } = require('../electron/macro/engine.cjs')
const { createFacade } = require('../electron/macro/facade.cjs')
const { TriggerMatcher } = require('../electron/macro/triggers.cjs')
const { createBotEventAdapter } = require('../electron/macro/bot-events.cjs')
const { IPC, LIMITS } = require('../electron/macro/contract.cjs')
const { NotifySettings, classifyKickReason, crossedLowHealth } = require('../electron/notify/settings.cjs')
const { fetchWithPolicy } = require('../electron/net-policy.cjs')
const { rememberedVersionState } = require('../electron/version-compatibility.cjs')
const { supportedVersions, normalizeVersionSelection } = require('../electron/version-support.cjs')
const { normalizeModdedProfile } = require('../electron/modded-compatibility.cjs')
const { AlertManager, PersistentEventStore, SmartProxyManager, identityIdFor, normalizeAutomations, normalizeEdition } = require('../electron/beta-core.cjs')
const { validateProfileId } = require('../electron/profile-path.cjs')
const { isMicrosoftLoginUrl } = require('../electron/ipc-security.cjs')
const { createCommandLayer } = require('./commands.cjs')

const movementDiagnosticsEnabled = process.env.AFK_DESK_MOVEMENT_DIAGNOSTICS === '1'

class AppCore {
  constructor({
    userDataPath,
    secretBox,
    notifier: notifierFactory,
    bots: injectedBots,
    botManager: injectedBotManager,
    managers: injectedManagers,
    BotManager = DefaultBotManager,
    BedrockBotManager = DefaultBedrockBotManager,
    MultiEditionBotManager = DefaultMultiEditionBotManager,
    normalizeSkinUrl = defaultNormalizeSkinUrl,
    emitToUi = () => {},
    platform = {},
    timers = globalThis,
    now = Date.now
  } = {}) {
    if (!userDataPath) throw new TypeError('userDataPath is required')
    this.userDataPath = userDataPath
    this.secretBox = secretBox
    this.platform = platform
    this.timers = timers
    this.now = now
    this.emitToUi = emitToUi
    this._normalizeSkinUrl = normalizeSkinUrl
    this.runtime = new Map()
    this.assignedProxies = new Map()
    this.startupTimers = new Map()
    this.activeSessions = new Set()
    this.healthEdges = new Map()
    this.previousInventoryFull = new Map()
    this.eventStorageWarnings = new Map()
    this.recentChats = new Map()
    this.store = this.accountsStore = new AccountStore(userDataPath)
    this.settingsStore = new SettingsStore(userDataPath)
    this.diagnosticLog = new DiagnosticLog(userDataPath)
    this.eventStore = new PersistentEventStore(userDataPath)
    this.smartProxies = new SmartProxyManager()
    this.alerts = new AlertManager(({ title, body }) => {
      try {
        if (this.settingsStore.get().notificationsEnabled === true) {
          this.platform.notify?.({ title, body })
        }
      } catch {}
    })
    const profilesPath = path.join(userDataPath, 'profiles')
    const managerOptions = {
      profilesPath,
      emit: this.emitBotEvent.bind(this),
      diagnose: (entry) => {
        this.diagnosticLog.write(entry)
        if (movementDiagnosticsEnabled) console.log(`[movement-diagnostic] ${JSON.stringify(entry)}`)
      }
    }
    const rawBots = injectedBotManager || injectedBots
    if (rawBots && typeof rawBots.connect === 'function') {
      this.botManager = rawBots
      if (!this.botManager.java) this.botManager.java = { sessions: new Map(), reconnects: new Map() }
      if (!this.botManager.bedrock) this.botManager.bedrock = { sessions: new Map(), reconnects: new Map() }
    } else if (injectedManagers) {
      this.botManager = new MultiEditionBotManager(injectedManagers)
    } else {
      this.botManager = new MultiEditionBotManager({
        java: new BotManager(managerOptions),
        bedrock: new BedrockBotManager({ profilesPath, emit: managerOptions.emit })
      })
    }
    this.macroLibrary = new MacroLibraryStore(userDataPath)
    this.notifySettings = new NotifySettings(this.settingsStore, secretBox)
    this.notifier = null
    this.botEventAdapter = null
    this.facade = null
    this.macroEngine = null
    this.started = false
    this._notifierFactory = notifierFactory
    this.commands = null

    this.accounts = {
      list: () => this.store.list().map(publicAccount),
      save: (input) => this._saveAccount(input),
      delete: (id) => {
        this.cancelStartupConnection(id)
        this.botManager.disconnect(id)
        this.activeSessions.delete(id)
        void this.macroEngine?.stop(id, 'account-deleted')
        this.store.delete(id)
        this.macroEngine?.setLibrary(this.macroLibrary.list())
      },
      duplicate: (id) => this._duplicateAccount(id),
      duplicateProfile: (id) => this._duplicateAccount(id),
      reorder: (orderedIds) => this.store.reorder(orderedIds).map(publicAccount),
      connect: (id) => this.connect(id),
      disconnect: (id) => this.disconnect(id),
      setAntiAfk: (id, enabled) => {
        const a = this._require(id)
        const saved = this.store.save({ ...a, antiAfk: enabled === true })
        this.botManager.setAntiAfk?.(id, saved)
        return publicAccount(saved)
      }
    }

    const botsDomain = {
      connect: (id) => this.connect(id),
      disconnect: (id) => this.disconnect(id),
      reconnect: (id) => { this.disconnect(id); return this.connect(id) },
      connectAll: () => this.store.list().map((a) => this.connect(a.id)),
      disconnectAll: () => this.store.list().map((a) => this.disconnect(a.id)),
      chat: (idOrInput, message) => { const p = unpack(idOrInput, { message }); return this.botManager.sendChat(p.id, p.message) },
      sendChat: (idOrInput, message) => { const p = unpack(idOrInput, { message }); return this.botManager.sendChat(p.id, p.message) },
      completeChat: (idOrInput, text) => { const p = unpack(idOrInput, { text }); return this.botManager.completeChat(p.id, p.text) },
      control: (idOrInput, control, duration) => { const p = unpack(idOrInput, { control, duration }); return this.botManager.control(p.id, p.control, p.duration) },
      controlState: (idOrInput, control, active) => { const p = unpack(idOrInput, { control, active }); return this.botManager.setControlState(p.id, p.control, p.active) },
      setControlState: (idOrInput, control, active) => { const p = unpack(idOrInput, { control, active }); return this.botManager.setControlState(p.id, p.control, p.active) },
      look: (idOrInput, direction) => { const p = unpack(idOrInput, { direction }); return this.botManager.look(p.id, p.direction) },
      lookDelta: (idOrInput, yawDelta, pitchDelta) => { const p = unpack(idOrInput, { yawDelta, pitchDelta }); return this.botManager.lookDelta(p.id, p.yawDelta, p.pitchDelta) },
      dropStack: (idOrInput, slot) => { const p = unpack(idOrInput, { slot }); return this.botManager.dropStack(p.id, p.slot) },
      dropItems: (idOrInput, slot, count) => { const p = unpack(idOrInput, { slot, count }); return this.botManager.dropItems(p.id, p.slot, p.count) },
      depositSlot: (idOrInput, slot, count) => { const p = unpack(idOrInput, { slot, count }); return this.botManager.depositSlot(p.id, p.slot, p.count) },
      itemLock: (idOrInput, slot, locked) => this._setItemLock(unpack(idOrInput, { slot, locked })),
      setItemLock: (idOrInput, slot, locked) => this._setItemLock(unpack(idOrInput, { slot, locked })),
      moveInventory: (idOrInput, sourceSlot, destinationSlot) => this._moveInventory(unpack(idOrInput, { sourceSlot, destinationSlot })),
      moveInventorySlot: (idOrInput, sourceSlot, destinationSlot) => this._moveInventory(unpack(idOrInput, { sourceSlot, destinationSlot })),
      equipItem: (idOrInput, slot, destination) => this._equipItem(unpack(idOrInput, { slot, destination })),
      equipInventoryItem: (idOrInput, slot, destination) => this._equipItem(unpack(idOrInput, { slot, destination })),
      windowClick: (idOrInput, slot) => { const p = unpack(idOrInput, { slot }); return this.botManager.clickWindowSlot(p.id, p.slot) },
      clickWindowSlot: (idOrInput, slot) => { const p = unpack(idOrInput, { slot }); return this.botManager.clickWindowSlot(p.id, p.slot) },
      windowClose: (idOrInput) => { const id = typeof idOrInput === 'object' && idOrInput !== null ? idOrInput.id : idOrInput; return this.botManager.closeWindow(id) },
      closeWindow: (idOrInput) => { const id = typeof idOrInput === 'object' && idOrInput !== null ? idOrInput.id : idOrInput; return this.botManager.closeWindow(id) },
      formRespond: (idOrInput, formId, response) => this._respondForm(unpack(idOrInput, { formId, response })),
      respondForm: (idOrInput, formId, response) => this._respondForm(unpack(idOrInput, { formId, response })),
      worldSnapshot: (idOrInput, radius, blockRefreshMs) => { const p = unpack(idOrInput, { radius, blockRefreshMs }); return this.botManager.worldSnapshot(p.id, p.radius, p.blockRefreshMs) },
      worldAction: (idOrInput, action, target) => { const p = unpack(idOrInput, { action, target }); return this.botManager.worldAction(p.id, p.action, p.target) },
      autoDeposit: (idOrInput, enabled) => this._setAutoDeposit(unpack(idOrInput, { enabled })),
      setAutoDeposit: (idOrInput, enabled) => this._setAutoDeposit(unpack(idOrInput, { enabled })),
      inventory: (id) => typeof this.botManager.inventory === 'function' ? this.botManager.inventory(id) : (this.runtime.get(id)?.telemetry?.inventory || this.facade?.state?.(id)?.inventory || [])
    }
    Object.defineProperties(botsDomain, {
      java: { get: () => this.botManager.java, enumerable: false },
      bedrock: { get: () => this.botManager.bedrock, enumerable: false },
      sessions: { get: () => this.botManager.sessions || this.botManager.java?.sessions, enumerable: false },
      manager: { value: (id) => typeof this.botManager.manager === 'function' ? this.botManager.manager(id) : this.botManager, enumerable: false }
    })
    this.bots = this.botsApi = botsDomain

    this.macros = {
      list: () => {
        const validation = {}
        for (const m of this.macroLibrary.list()) validation[m.id] = macroModel.validateMacro(m, this._macroOptions())
        return { macros: this.macroLibrary.list(), validation }
      },
      save: (input) => {
        assertMacroPayload(input)
        const prev = this.macroLibrary.get(input?.id)
        const macro = macroModel.normalizeMacro({ ...input, origin: input?.origin || prev?.origin })
        const errors = macroModel.validateMacro(macro, this._macroOptions())
        if (errors.length) {
          const e = new Error(errors.map((x) => `${x.path}: ${x.message}`).join(' '))
          e.validation = errors
          throw e
        }
        writeBackV1(this.store, macro)
        this.macroLibrary.save(macro)
        this.macroEngine?.setLibrary(this.macroLibrary.list())
        return macro
      },
      remove: (id) => this._removeMacro(id),
      delete: (id) => this._removeMacro(id),
      setEnabled: (input) => {
        assertMacroPayload(input)
        const macro = this.macroLibrary.get(input?.macroId)
        if (!macro) throw new Error('Macro not found.')
        const updated = macroModel.normalizeMacro({ ...macro, enabled: input.enabled === true })
        const errors = macroModel.validateMacro(updated, this._macroOptions())
        if (updated.enabled && errors.length) {
          const e = new Error(errors.map((x) => x.message).join(' '))
          e.validation = errors
          throw e
        }
        writeBackV1(this.store, updated)
        this.macroLibrary.save(updated)
        this.macroEngine?.setLibrary(this.macroLibrary.list())
        return updated
      },
      run: (input) => { assertMacroPayload(input); return this.macroEngine.run(input.accountId, input.macroId) },
      stop: (input) => { assertMacroPayload(input); return this.macroEngine.stop(input.accountId) },
      runs: (id) => { assertMacroPayload(id); return this.macroEngine.runLog(id) },
      importJson: (json) => this._importMacros(json),
      import: (json) => this._importMacros(json),
      exportJson: (ids) => this._exportMacros(ids),
      export: (ids) => this._exportMacros(ids)
    }

    this.notify = {
      list: () => this.notifySettings.list(),
      save: (v) => this.notifySettings.save(v),
      delete: (id) => this.notifySettings.delete(id),
      test: async (id) => this.notifier ? this.notifier.test(id) : { ok: false, error: 'Notifier unavailable' }
    }

    this.logs = {
      list: (idOrInput, options) => {
        if (idOrInput && typeof idOrInput === 'object') {
          return this.eventStore.list(idOrInput.id, { limit: idOrInput.limit, kinds: idOrInput.kinds })
        }
        return this.eventStore.list(idOrInput, options)
      },
      clear: (id) => this.eventStore.clear(id),
      recent: (limit = 50) => this.eventStore.list('audit', { limit, kinds: ['audit'] })
    }

    this.proxies = {
      health: () => this.smartProxies.snapshot()
    }

    this.settings = {
      get: () => {
        const settings = this.settingsStore.get()
        const startWithWindows = this.platform.getAutoLaunch ? Boolean(this.platform.getAutoLaunch()) : false
        return { startWithWindows, ...settings }
      },
      save: (input) => {
        const startWithWindows = input?.startWithWindows === true
        const settings = this.settingsStore.save(input)
        this.platform.setAutoLaunch?.(startWithWindows)
        const { notifyChannels: _hidden, ...safe } = settings
        return {
          startWithWindows: this.platform.getAutoLaunch ? Boolean(this.platform.getAutoLaunch()) : startWithWindows,
          ...safe
        }
      }
    }

    this.app = {
      version: () => this.platform.getVersion ? this.platform.getVersion() : '',
      supportedVersions: () => supportedVersions()
    }

    this.auth = {
      openIsolated: ({ id, url: rawUrl, code } = {}) => {
        if (!this.store.list().some((account) => account.id === id)) throw new Error('Account not found.')
        const supplied = new URL(rawUrl || 'https://microsoft.com/link')
        if (!isMicrosoftLoginUrl(supplied.href)) throw new Error('Microsoft sign-in must use a trusted Microsoft HTTPS address.')
        const loginUrl = new URL('https://microsoft.com/link')
        if (code) loginUrl.searchParams.set('otc', String(code).slice(0, 32))
        return this.platform.openIsolatedLogin?.({ id, url: loginUrl.toString(), code })
      }
    }

    this.system = {
      openExternal: (url) => {
        const parsed = new URL(url)
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported link.')
        return this.platform.openExternal?.(parsed.toString())
      }
    }

    this.audit = {
      recent: (limit = 50) => this.eventStore.list('audit', { limit, kinds: ['audit'] })
    }
  }

  async start() {
    if (this.started) return this
    const accounts = this.store.list()
    this.macroLibrary.load(accounts)
    for (const warning of this.macroLibrary.warnings) this.diagnosticLog.write({ event: 'warning', at: this.now(), message: warning })
    const migration = macroModel.migrateV1(accounts, this.macroLibrary.library)
    if (migration.migratedAccountIds.length) this.macroLibrary.write(migration.library)
    this.macroLibrary.library = migration.library
    for (const warning of migration.warnings) this.diagnosticLog.write({ event: 'warning', at: this.now(), message: warning })
    this.botEventAdapter = createBotEventAdapter({
      sessionId: (id) => this.facade?.sessionId(id),
      isManualDisconnect: (id) => (typeof this.botManager.manager === 'function' ? this.botManager.manager(id) : this.botManager)?.reconnects?.get(id)?.manual === true
    })
    try {
      if (typeof this._notifierFactory === 'function') {
        this.notifier = await this._notifierFactory({ fetchWithPolicy, getChannels: () => this.notifySettings.getDecrypted(), onLog: (entry) => this.diagnosticLog.write(entry) })
      } else if (this._notifierFactory && typeof this._notifierFactory === 'object') {
        this.notifier = this._notifierFactory
      } else {
        this.notifier = require('../electron/notify/notifier.cjs').createNotifier({ fetchWithPolicy, getChannels: () => this.notifySettings.getDecrypted(), onLog: (entry) => this.diagnosticLog.write(entry) })
      }
    } catch {
      this.notifier = null
    }
    this.facade = createFacade({
      bots: this.botManager,
      getEdition: (id) => this.store.list().find((a) => a.id === id)?.edition || 'java',
      notify: (event) => this.notifyMacro(event)
    })
    const resolveTargets = (macro) => {
      const all = this.store.list()
      if (macro.targets.mode === 'all') return all.map((a) => a.id)
      if (macro.targets.mode === 'accounts') {
        const ids = new Set(all.map((a) => a.id))
        return macro.targets.accountIds.filter((id) => ids.has(id))
      }
      const tags = new Set(macro.targets.tags)
      return all.filter((a) => Array.isArray(a.tags) && a.tags.some((tag) => tags.has(tag))).map((a) => a.id)
    }
    this.macroEngine = new MacroEngine({
      facade: this.facade,
      matcher: new TriggerMatcher({}),
      now: this.now,
      emit: (e) => this.emitMacroRunEvent(e),
      getAccountState: this.facade.state,
      resolveTargets,
      nextScheduleTime: macroTriggers.nextScheduleTime
    })
    this.macroEngine.setLibrary(this.macroLibrary.list())
    this.commands = createCommandLayer({ core: this, audit: (entry) => this._appendAudit(entry), now: this.now, timers: this.timers })
    this.started = true
    return this
  }

  async shutdown() {
    for (const timer of this.startupTimers.values()) this.timers.clearTimeout(timer)
    this.startupTimers.clear()
    const ids = new Set([
      ...this.runtime.keys(),
      ...this.activeSessions,
      ...(this.botManager?.sessions?.keys?.() || []),
      ...(this.botManager?.java?.sessions?.keys?.() || []),
      ...(this.botManager?.bedrock?.sessions?.keys?.() || [])
    ])
    for (const id of ids) {
      try { await this.macroEngine?.stop(id, 'shutdown') } catch {}
      try { await this.botManager?.disconnect?.(id) } catch {}
    }
    this.activeSessions.clear()
    try { await this.macroEngine?.shutdown() } catch {}
    try { await this.notifier?.flush?.() } catch {}
    try { this.eventStore.close?.() } catch {}
    this.started = false
  }

  emitBotEvent(type, id, payload = {}) {
    let account
    try {
      account = this.store.list().find((a) => a.id === id)
      this.platform.clearStorageError?.()
    } catch (e) {
      this._storageError(e)
    }
    if (account) this.alerts?.handle(account, type, payload)
    for (const event of this.botEventAdapter?.(type, id, payload) || []) {
      this.macroEngine?.onBotEvent(event)
      this._notifyBot(event, account)
    }
    if (type === 'log' && payload.kind === 'chat') {
      const rows = this.recentChats.get(id) || []
      rows.push({ at: Number(payload.at) || this.now(), message: String(payload.message || '') })
      if (rows.length > 100) rows.splice(0, rows.length - 100)
      this.recentChats.set(id, rows)
    }
    if (type === 'log' && payload.kind === 'error' && /kicked:/i.test(payload.message || '')) {
      const reason = String(payload.message).replace(/^.*?kicked:\s*/i, '')
      const kind = classifyKickReason(reason)
      const name = displayName(account)
      this._send({ kind, accountId: id, accountName: name, message: `${name} was ${kind}.`, payload: { reason }, at: Number(payload.at) || this.now() })
    }
    if (type === 'status' && payload.status === 'reconnecting' && account) {
      const delaySeconds = Number(String(payload.detail || '').match(/in\s+([\d.]+)s/i)?.[1]) || undefined
      const name = displayName(account)
      this._send({ kind: 'reconnecting', accountId: id, accountName: name, message: `${name} is reconnecting.`, payload: { delaySeconds }, at: Number(payload.at) || this.now() })
    }
    if (type === 'status' && payload.status === 'online') this.smartProxies.report(this.assignedProxies.get(id), true)
    if (type === 'status' && payload.status === 'offline') {
      this.smartProxies.release(this.assignedProxies.get(id))
      this.assignedProxies.delete(id)
      this.activeSessions.delete(id)
    }
    if (type === 'log' && payload.kind === 'error') this.smartProxies.report(this.assignedProxies.get(id), false)
    if (type === 'status') this.diagnosticLog.write({ event: 'status', at: payload.at, accountId: id, status: payload.status, detail: payload.detail })
    if (type === 'telemetry') this.diagnosticLog.write({ event: 'telemetry', at: payload.at, accountId: id, position: payload.position, environment: payload.environment, health: payload.health })
    if (type === 'log' && payload.kind === 'error') this.diagnosticLog.write({ event: 'error', at: payload.at, accountId: id, message: payload.message })
    if (movementDiagnosticsEnabled && type === 'status') console.log(`[movement-status] ${JSON.stringify({ accountId: id, status: payload.status })}`)
    if (movementDiagnosticsEnabled && type === 'telemetry') console.log(`[movement-telemetry] ${JSON.stringify({ accountId: id, position: payload.position, environment: payload.environment })}`)
    if (movementDiagnosticsEnabled && type === 'log' && payload.kind === 'error') console.log(`[movement-error] ${JSON.stringify({ accountId: id, message: String(payload.message || '').slice(0, 240) })}`)

    const current = this.status(id)
    const persistEvent = this.eventStore && (type !== 'telemetry' || telemetryChanged(current.telemetry, payload))
    if (type === 'status') this.runtime.set(id, { ...current, status: payload.status, detail: payload.detail })
    if (type === 'log') this.runtime.set(id, { ...current, logs: [...current.logs.slice(-499), payload] })
    if (type === 'telemetry') this.runtime.set(id, { ...current, telemetry: payload })
    if (type === 'version') {
      this.runtime.set(id, { ...current, resolvedVersion: payload.version })
      if (account && payload.version && payload.stable === true) {
        this._saveEventAccount({ ...account, lastSuccessfulVersion: String(payload.version).slice(0, 32), lastSuccessfulVersionStable: true })
      }
    }
    if (type === 'identity') {
      if (account) {
        const minecraftName = normalizeMinecraftName(payload.username) || account.minecraftName || ''
        this._saveEventAccount({
          ...account,
          label: minecraftName || account.label,
          minecraftName,
          minecraftUuid: normalizeUuid(payload.uuid) || account.minecraftUuid || '',
          skinUrl: this._normalizeSkinUrl(payload.skinUrl) || account.skinUrl || ''
        })
      }
    }
    this._sendUi('bot:event', { type, id, payload })
    if (persistEvent) this._persistEventSafely(id, type, payload)
  }

  connect(id) {
    this.cancelStartupConnection(id)
    if (this.botManager?.sessions?.has?.(id) || this.botManager?.java?.sessions?.has?.(id) || this.botManager?.bedrock?.sessions?.has?.(id)) {
      throw new Error('This profile is already connecting or online.')
    }
    const a = this._require(id, true)
    this.smartProxies.release(this.assignedProxies.get(id))
    this.assignedProxies.set(id, a.proxy)
    this.activeSessions.add(id)
    try {
      return this.botManager.connect(a)
    } catch (e) {
      this.activeSessions.delete(id)
      this.smartProxies.release(this.assignedProxies.get(id))
      this.assignedProxies.delete(id)
      throw e
    }
  }

  disconnect(id) {
    this.cancelStartupConnection(id)
    this.botManager.disconnect(id)
    this.activeSessions.delete(id)
    this.smartProxies.release(this.assignedProxies.get(id))
    this.assignedProxies.delete(id)
  }

  recentChat(id) { return (this.recentChats.get(id) || []).slice() }
  status(id) { return this.runtime.get(id) || { status: 'offline', detail: 'Ready to connect', logs: [] } }

  _saveAccount(input) {
    const existing = this.store.list().find((a) => a.id === input?.id)
    const saved = this.store.save(validateAccount(input, existing, this.secretBox, this._normalizeSkinUrl))
    this.macroEngine?.setLibrary(this.macroLibrary.list())
    if (existing && (existing.autoDepositToChest !== saved.autoDepositToChest || existing.autoDepositRange !== saved.autoDepositRange)) {
      this.botManager.setAutoDeposit?.(saved.id, saved.autoDepositToChest, saved.autoDepositRange)
    }
    if (existing && existing.environmentalMovement !== saved.environmentalMovement) {
      this.botManager.setEnvironmentalMovement?.(saved.id, saved.environmentalMovement)
    }
    if (existing && antiAfkChanged(existing, saved)) {
      this.botManager.setAntiAfk?.(saved.id, saved)
    }
    if (existing) {
      try {
        this.botManager.updateAccountConfig?.(this._retryConfig(saved))
      } catch (e) {
        this.diagnosticLog.write({ event: 'error', at: this.now(), accountId: saved.id, message: `Could not refresh live config: ${String(e?.message || e).slice(0, 200)}` })
      }
    }
    return publicAccount(saved)
  }

  _duplicateAccount(id) {
    const source = this.store.list().find((a) => a.id === id)
    if (!source) throw new Error('Account profile not found.')
    const copy = this.store.save({
      ...source,
      id: crypto.randomUUID(),
      profileName: `${source.profileName || source.label || source.host} copy`.slice(0, 60),
      connectOnStartup: false,
      autoDepositToChest: false
    })
    this.macroEngine?.setLibrary(this.macroLibrary.list())
    return publicAccount(copy)
  }

  _setItemLock({ id, slot, locked }) {
    const a = this._require(id)
    const slots = new Set(a.lockedInventorySlots || [])
    if (locked === true) slots.add(Number(slot))
    else slots.delete(Number(slot))
    const updated = this.store.save({ ...a, lockedInventorySlots: normalizeSlots([...slots]) })
    this.botManager.setItemLocks?.(id, updated.lockedInventorySlots)
    return publicAccount(updated)
  }

  async _moveInventory({ id, sourceSlot, destinationSlot }) {
    this._require(id)
    const result = await this.botManager.moveInventorySlot(id, sourceSlot, destinationSlot)
    return { account: this._applyLockRelocation(id, result), ...result }
  }

  async _equipItem({ id, slot, destination }) {
    this._require(id)
    const result = await this.botManager.equipInventoryItem(id, slot, destination)
    return { account: this._applyLockRelocation(id, result), ...result }
  }

  async _setAutoDeposit({ id, enabled }) {
    const a = this._require(id)
    const updated = this.store.save({ ...a, autoDepositToChest: enabled === true })
    this.botManager.setAutoDeposit?.(id, updated.autoDepositToChest, updated.autoDepositRange)
    return publicAccount(updated)
  }

  _respondForm({ id, formId, response } = {}) {
    validateProfileId(id)
    const normalizedFormId = typeof formId === 'number' && Number.isInteger(formId) ? String(formId) : typeof formId === 'string' ? formId.trim() : ''
    if (!normalizedFormId || normalizedFormId.length > 64 || !/^\d+$/.test(normalizedFormId)) {
      throw new Error('Invalid formId: must be a numeric string up to 64 characters.')
    }
    if (response !== null && !(Number.isInteger(response) && response >= 0) && !isValidCustomFormResponse(response)) {
      throw new Error('Invalid form response.')
    }
    const bedrock = this.botManager?.bedrock || this.botManager
    if (typeof bedrock?.respondForm !== 'function') throw new Error('Bedrock forms are not supported by this bot manager.')
    return bedrock.respondForm(id, normalizedFormId, response)
  }
  _removeMacro(id) {
    assertMacroPayload(id)
    const m = this.macroLibrary.get(id)
    if (!m) return false
    writeBackV1(this.store, m, true)
    this.macroLibrary.remove(id)
    this.macroEngine?.setLibrary(this.macroLibrary.list())
    return true
  }

  _importMacros(json) {
    assertMacroPayload(json)
    const result = macroModel.importMacros(json, this._macroOptions())
    if (result.errors.length) return result
    const merged = [...this.macroLibrary.list(), ...result.macros].slice(0, LIMITS.maxMacros)
    this.macroLibrary.replaceAll(merged)
    this.macroEngine?.setLibrary(this.macroLibrary.list())
    return { ...result, macros: result.macros }
  }

  _exportMacros(ids) {
    assertMacroPayload(ids)
    const set = new Set(Array.isArray(ids) ? ids : [])
    return macroModel.exportMacros(this.macroLibrary.list().filter((m) => !set.size || set.has(m.id)))
  }

  _require(id, password = false) {
    const a = this.store.list().find((x) => x.id === id)
    if (!a) throw new Error('Account not found.')
    if (!password) return a
    const resolved = this._withProxyPassword(a)
    if (a.proxyMode !== 'smart') return resolved
    const pool = this.store.list().map((candidate) => this._withProxyPassword(candidate))
    return { ...resolved, proxy: this.smartProxies.select(resolved, pool) }
  }

  _withProxyPassword(a) {
    const proxy = a.proxy || {}
    let password = ''
    if (proxy.passwordEncrypted) {
      try {
        password = this.secretBox.decrypt(proxy.passwordEncrypted)
      } catch {
        throw new Error('Could not decrypt this account’s proxy password. Re-enter it in account settings.')
      }
    }
    const enabled = a.proxyMode === 'manual' ? proxy.enabled === true : a.proxyMode === 'smart'
    return { ...a, proxy: { ...proxy, enabled, password } }
  }

  _retryConfig(a) {
    const result = this._withProxyPassword(a)
    if (a.proxyMode === 'smart' && this.assignedProxies.get(a.id)) result.proxy = this.assignedProxies.get(a.id)
    return result
  }

  cancelStartupConnection(id) {
    const timer = this.startupTimers.get(id)
    if (timer) this.timers.clearTimeout(timer)
    this.startupTimers.delete(id)
  }

  autoConnectConfiguredAccounts() {
    const s = this.settingsStore.get()
    this.store.list().filter((a) => a.connectOnStartup).forEach((a, i) => {
      this.startupTimers.set(a.id, this.timers.setTimeout(() => {
        this.startupTimers.delete(a.id)
        try {
          if (this.store.list().find((x) => x.id === a.id)?.connectOnStartup) this.connect(a.id)
        } catch (e) {
          this.emitBotEvent('log', a.id, { kind: 'error', message: `Startup connection failed: ${e.message}`, at: this.now() })
          this.emitBotEvent('status', a.id, { status: 'offline', detail: 'Startup connection failed' })
        }
      }, startupConnectionDelay(s, i)))
    })
  }

  _persistEventSafely(id, type, payload) {
    try {
      this.eventStore.append(id, { type, ...payload })
    } catch (error) {
      try {
        const code = String(error?.code || 'UNKNOWN').slice(0, 32)
        const now = this.now()
        const last = this.eventStorageWarnings.get(code)
        if (last !== undefined && now - last < 60_000) return
        this.eventStorageWarnings.set(code, now)
        this._sendUi('bot:event', { type: 'storage-warning', id, payload: { code, message: 'Event history could not be saved.', at: now } })
      } catch {}
    }
  }

  _saveEventAccount(account) {
    try {
      this.store.save(account)
    } catch (error) {
      this._storageError(error)
    }
  }

  _send(event) { try { this.notifier?.notify(event) } catch {} }
  _sendUi(channel, payload) { try { this.emitToUi(channel, payload) } catch {} }
  _storageError(error) { try { this.platform.storageError?.(error) } catch {} }

  _notifyBot(event, account) {
    if (!account) return
    const name = displayName(account)
    if (event.type === 'connected') this._send({ kind: 'connected', accountId: account.id, accountName: name, message: `${name} connected.`, at: event.at })
    if (event.type === 'disconnected') this._send({ kind: 'disconnected', accountId: account.id, accountName: name, message: `${name} disconnected: ${event.payload.reason}`, payload: event.payload, at: event.at })
    if (event.type === 'disconnected') {
      this.healthEdges.delete(account.id)
      this.previousInventoryFull.delete(account.id)
    }
    if (event.type === 'telemetry') {
      const p = event.payload
      const before = this.healthEdges.get(account.id)
      const h = Number(p.health)
      if (crossedLowHealth(before, h)) this._send({ kind: 'lowHealth', accountId: account.id, accountName: name, message: `${name} health is ${h}/20.`, payload: { health: h }, at: event.at })
      if (p.inventoryFull && !this.previousInventoryFull.get(account.id)) this._send({ kind: 'inventoryFull', accountId: account.id, accountName: name, message: `${name} inventory is full.`, at: event.at })
      this.healthEdges.set(account.id, h)
      this.previousInventoryFull.set(account.id, p.inventoryFull === true)
    }
    if (event.type === 'death') this._send({ kind: 'death', accountId: account.id, accountName: name, message: `${name} died.`, at: event.at })
  }

  notifyMacro(event) {
    const a = this.store.list().find((x) => x.id === event.accountId)
    const name = a?.profileName || a?.label || 'Minecraft account'
    const message = String(event.message || event.error || 'Macro notification').slice(0, 500)
    try {
      if (event.desktop !== false && this.settingsStore.get().notificationsEnabled) {
        const title = displayName(a) === 'Minecraft account' ? 'AFK Desk macro' : displayName(a)
        this.platform.notifyMacro ? this.platform.notifyMacro(title, message, event) : this.platform.notify?.({ title, body: message })
      }
    } catch {}
    this._send({ kind: 'macro', accountId: event.accountId, accountName: name, message, payload: { macroName: event.macroName || 'Macro', status: event.status || 'notify' }, at: this.now() })
  }

  emitMacroRunEvent(event) {
    this._sendUi(IPC.event, event)
    if (event.accountId) this._persistEventSafely(event.accountId, 'macro', event)
    if (event.status === 'failed') {
      this.notifyMacro({ accountId: event.accountId, macroName: this.macroLibrary.get(event.macroId)?.name, status: 'failed', error: event.error?.message || event.reason || 'Macro failed' })
    }
  }

  _macroOptions() {
    const a = this.store.list()
    return { accountIds: a.map((x) => x.id), editionOf: (id) => a.find((x) => x.id === id)?.edition }
  }

  _appendAudit(entry) {
    const record = { type: 'audit', ...redactAudit(entry) }
    this.eventStore.append('audit', record)
    if (entry?.accountId && entry.accountId !== 'audit') {
      this.eventStore.append(entry.accountId, record)
    }
  }

  _applyLockRelocation(id, result) {
    const updated = this.store.updateAccount(id, (a) => relocateLocks(a, result.sourceSlot, result.targetSlot))
    if (!updated) throw new Error('Account not found.')
    this.botManager.setItemLocks?.(id, updated.lockedInventorySlots)
    return publicAccount(updated)
  }
}

function unpack(idOrInput, rest) {
  if (idOrInput && typeof idOrInput === 'object') return idOrInput
  return { id: idOrInput, ...rest }
}

function isValidCustomFormResponse(response) {
  if (!Array.isArray(response) || response.length > 64) return false
  return response.every((item) => item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 512))
}
function displayName(a) {
  for (const v of [a?.profileName, a?.minecraftName, a?.label]) {
    const s = String(v || '').trim()
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.slice(0, 60)
  }
  return 'Minecraft account'
}

function publicAccount(a) {
  const { passwordEncrypted, password, ...proxy } = a.proxy || {}
  return { ...a, proxy: { ...proxy, hasPassword: Boolean(passwordEncrypted) } }
}

function assertMacroPayload(v) {
  let s
  try { s = JSON.stringify(v) } catch { throw new Error('Macro payload must be JSON serializable.') }
  if (Buffer.byteLength(s === undefined ? 'null' : s, 'utf8') > LIMITS.maxIpcPayloadBytes) throw new Error('Macro payload exceeds 256 KB.')
}

function telemetryChanged(a, b) {
  return !a || a.health !== b.health || a.food !== b.food || a.dimension !== b.dimension ||
    JSON.stringify(a.position) !== JSON.stringify(b.position) || JSON.stringify(a.inventory) !== JSON.stringify(b.inventory)
}

function antiAfkChanged(a, b) {
  return ['antiAfk', 'antiAfkMinDelay', 'antiAfkMaxDelay', 'antiAfkActionDuration', 'antiAfkWalkDistance', 'antiAfkLookDegrees', 'antiAfkJump', 'antiAfkLook', 'antiAfkSneak', 'antiAfkSwing', 'antiAfkWalk'].some((k) => a?.[k] !== b?.[k])
}

function normalizeSlots(a) {
  return [...new Set((Array.isArray(a) ? a : []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 255))].sort((x, y) => x - y).slice(0, 46)
}

function relocateLocks(a, s, t) {
  const slots = new Set(normalizeSlots(a?.lockedInventorySlots))
  const sl = slots.has(s)
  const tl = slots.has(t)
  slots.delete(s)
  slots.delete(t)
  if (sl) slots.add(t)
  if (tl) slots.add(s)
  return { ...a, lockedInventorySlots: normalizeSlots([...slots]) }
}

function redactAudit(v) {
  if (Array.isArray(v)) return v.map(redactAudit)
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]') : v
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/email|token|secret|password|credential|username/i.test(k)).map(([k, x]) => [k, redactAudit(x)]))
}

function bounded(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : fallback
}

function normalizeUuid(v) {
  const s = String(v || '').replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(s) ? s : ''
}

function normalizeMinecraftName(v) {
  const s = String(v || '').trim()
  return /^[A-Za-z0-9_]{1,16}$/.test(s) ? s : ''
}

function validateProxy(input, existing, secretBox) {
  const enabled = input?.enabled === true
  const type = input?.type === 'http' ? 'http' : 'socks5'
  const host = String(input?.host || '').trim()
  const port = Number(input?.port) || (type === 'http' ? 8080 : 1080)
  const username = String(input?.username || '').trim()
  if (enabled && (!host || host.length > 255 || /[\s\r\n]/.test(host))) throw new Error('Enter a valid proxy host.')
  if (enabled && (port < 1 || port > 65535)) throw new Error('Proxy port must be between 1 and 65535.')
  if (username.length > 128 || /[\r\n]/.test(username)) throw new Error('Proxy username is invalid.')
  let passwordEncrypted = String(existing?.passwordEncrypted || '')
  if (input?.clearPassword === true) passwordEncrypted = ''
  const p = String(input?.password || '')
  if (p) {
    if (p.length > 512 || /[\r\n]/.test(p)) throw new Error('Proxy password is invalid.')
    if (!secretBox?.available?.()) throw new Error('Windows credential encryption is not available. Proxy password was not saved.')
    passwordEncrypted = secretBox.encrypt(p)
  }
  return { enabled, type, host, port, username, passwordEncrypted }
}

function validateAccount(input, existing, secretBox, normalizeSkinUrl = defaultNormalizeSkinUrl) {
  const host = String(input?.host || '').trim()
  const username = String(input?.username || '').trim()
  if (!host) throw new Error('Server address is required.')
  if (!username) throw new Error('Microsoft account email is required.')
  const edition = normalizeEdition(input?.edition ?? existing?.edition)
  const port = Number(input?.port) || (edition === 'bedrock' ? 19132 : 25565)
  if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.')
  const minecraftName = normalizeMinecraftName(input?.minecraftName)
  const version = edition === 'java' ? normalizeVersionSelection(input?.version) : ''
  const remembered = rememberedVersionState(version, input, existing)
  const modded = edition === 'java' ? normalizeModdedProfile(input) : normalizeModdedProfile({ modLoader: 'vanilla', modHandshake: 'off' })
  const antiAfk = input?.antiAfk !== false
  const antiAfkJump = input?.antiAfkJump !== false
  const antiAfkLook = input?.antiAfkLook !== false
  const antiAfkSneak = input?.antiAfkSneak === true
  const antiAfkSwing = input?.antiAfkSwing === true
  const antiAfkWalk = input?.antiAfkWalk === true
  if (antiAfk && ![antiAfkJump, antiAfkLook, antiAfkSneak, antiAfkSwing, antiAfkWalk].some(Boolean)) {
    throw new Error('Select at least one anti-AFK action or turn anti-AFK off.')
  }
  return {
    id: validateProfileId(input?.id || crypto.randomUUID()),
    identityId: validateProfileId(existing?.identityId || identityIdFor(edition, username)),
    edition,
    profileName: String(input?.profileName || existing?.profileName || host).trim().slice(0, 60),
    tags: [...new Set((Array.isArray(input?.tags) ? input.tags : existing?.tags || []).filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 24)).filter(Boolean))].slice(0, 10),
    label: minecraftName || String(input?.label || username.split('@')[0] || 'Minecraft account').trim().slice(0, 50),
    username,
    host,
    port,
    version,
    modLoader: modded.loader,
    modHandshake: modded.handshake,
    clientBrand: modded.brand,
    mods: modded.mods,
    modChannels: modded.channels,
    ...remembered,
    minecraftName,
    minecraftUuid: normalizeUuid(input?.minecraftUuid),
    skinUrl: normalizeSkinUrl(input?.skinUrl),
    antiAfk,
    antiAfkInterval: bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
    antiAfkMinDelay: bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
    antiAfkMaxDelay: Math.max(
      bounded(input?.antiAfkMinDelay ?? input?.antiAfkInterval, 2, 3600, 45),
      bounded(input?.antiAfkMaxDelay ?? input?.antiAfkInterval, 2, 3600, 45)
    ),
    antiAfkActionDuration: bounded(input?.antiAfkActionDuration, 0.1, 10, 0.25),
    antiAfkWalkDistance: bounded(input?.antiAfkWalkDistance, 0.1, 8, 0.5),
    antiAfkLookDegrees: bounded(input?.antiAfkLookDegrees, 5, 180, 12),
    antiAfkJump,
    antiAfkLook,
    antiAfkSneak,
    antiAfkSwing,
    antiAfkWalk,
    environmentalMovement: input?.environmentalMovement !== false,
    autoReconnect: input?.autoReconnect !== false,
    autoReconnectDelay: bounded(input?.autoReconnectDelay, 1, 3600, 5),
    autoReconnectBackoffMultiplier: bounded(input?.autoReconnectBackoffMultiplier, 1, 10, 2),
    autoReconnectMaxDelay: bounded(input?.autoReconnectMaxDelay, 1, 86400, 300),
    autoReconnectRateLimitDelay: bounded(input?.autoReconnectRateLimitDelay, 1, 86400, 30),
    autoReconnectMaxAttempts: Math.max(0, Math.min(Number(input?.autoReconnectMaxAttempts) || 0, 1000)),
    connectTimeoutSeconds: bounded(input?.connectTimeoutSeconds, 5, 300, 60),
    reconnectResetDelay: bounded(input?.reconnectResetDelay, 5, 3600, 60),
    connectOnStartup: input?.connectOnStartup === true,
    autoDepositToChest: input?.autoDepositToChest === true,
    autoDepositRange: Math.round(bounded(input?.autoDepositRange ?? existing?.autoDepositRange, 1, 16, 5)),
    lockedInventorySlots: normalizeSlots(input?.lockedInventorySlots ?? existing?.lockedInventorySlots),
    proxy: validateProxy(input?.proxy, existing?.proxy, secretBox),
    proxyMode: ['direct', 'manual', 'smart'].includes(input?.proxyMode) ? input.proxyMode : (input?.proxy?.enabled ? 'manual' : 'direct'),
    shareProxyToPool: input?.shareProxyToPool === true,
    proxyLabel: String(input?.proxyLabel || '').trim().slice(0, 60),
    proxyMaxSessions: Math.max(1, Math.min(Number(input?.proxyMaxSessions) || 1, 100)),
    alerts: {
      disconnect: input?.alerts?.disconnect !== false,
      errors: input?.alerts?.errors !== false,
      healthBelow: Math.max(0, Math.min(Number(input?.alerts?.healthBelow) || 6, 20))
    },
    automations: normalizeAutomations(input?.automations ?? existing?.automations),
    joinMessage: String(input?.joinMessage || '').trim().slice(0, 256),
    serverChangeMessage: String(input?.serverChangeMessage || '').trim().slice(0, 256),
    messageDelay: Math.max(0, Math.min(input?.messageDelay === '' || input?.messageDelay == null ? 6 : Number(input.messageDelay) || 0, 600))
  }
}

module.exports = { AppCore, publicAccount, displayName, validateAccount }
