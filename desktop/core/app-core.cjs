'use strict'
// Electron-free owner of durable/application services. Platform effects enter through hooks.
const path = require('node:path')
const { AccountStore, SettingsStore, startupConnectionDelay } = require('../electron/store.cjs')
const { BotManager, normalizeSkinUrl } = require('../electron/bot-manager.cjs')
const { BedrockBotManager } = require('../electron/bedrock-bot-manager.cjs')
const { MultiEditionBotManager } = require('../electron/multi-edition-manager.cjs')
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

class AppCore {
  constructor({ userDataPath, secretBox, notifier: notifierFactory, emitToUi = () => {}, platform = {}, timers = globalThis, now = Date.now } = {}) {
    if (!userDataPath) throw new TypeError('userDataPath is required')
    this.userDataPath = userDataPath; this.secretBox = secretBox; this.platform = platform; this.timers = timers; this.now = now
    this.emitToUi = emitToUi; this.runtime = new Map(); this.assignedProxies = new Map(); this.startupTimers = new Map(); this.healthEdges = new Map(); this.previousInventoryFull = new Map(); this.eventStorageWarnings = new Map(); this.recentChats = new Map()
    this.store = this.accountsStore = new AccountStore(userDataPath); this.settingsStore = new SettingsStore(userDataPath); this.diagnosticLog = new DiagnosticLog(userDataPath); this.eventStore = new PersistentEventStore(userDataPath)
    this.smartProxies = new SmartProxyManager()
    this.alerts = new AlertManager(({ title, body }) => platform.notify?.({ title, body }))
    const profilesPath = path.join(userDataPath, 'profiles')
    const options = { profilesPath, emit: this.emitBotEvent.bind(this), diagnose: (entry) => this.diagnosticLog.write(entry) }
    this.bots = new MultiEditionBotManager({ java: new BotManager(options), bedrock: new BedrockBotManager({ profilesPath, emit: options.emit }) })
    this.macroLibrary = new MacroLibraryStore(userDataPath)
    this.notifySettings = new NotifySettings(this.settingsStore, secretBox)
    this.notifier = null
    this.botEventAdapter = null
    this.macroEngine = null
    this.started = false
    this._notifierFactory = notifierFactory
  }
  async start() {
    if (this.started) return this
    const accounts = this.store.list(); this.macroLibrary.load(accounts)
    for (const warning of this.macroLibrary.warnings) this.diagnosticLog.write({ event: 'warning', at: this.now(), message: warning })
    const migration = macroModel.migrateV1(accounts, this.macroLibrary.library)
    if (migration.migratedAccountIds.length) this.macroLibrary.write(migration.library)
    this.macroLibrary.library = migration.library
    for (const warning of migration.warnings) this.diagnosticLog.write({ event: 'warning', at: this.now(), message: warning })
    this.botEventAdapter = createBotEventAdapter({ sessionId: (id) => this.facade?.sessionId(id), isManualDisconnect: (id) => this.bots?.manager(id)?.reconnects?.get(id)?.manual === true })
    try { this.notifier = this._notifierFactory ? await this._notifierFactory({ fetchWithPolicy, getChannels: () => this.notifySettings.getDecrypted(), onLog: (entry) => this.diagnosticLog.write(entry) }) : require('../electron/notify/notifier.cjs').createNotifier({ fetchWithPolicy, getChannels: () => this.notifySettings.getDecrypted(), onLog: (entry) => this.diagnosticLog.write(entry) }) } catch { this.notifier = null }
    this.facade = createFacade({ bots: this.bots, getEdition: (id) => this.store.list().find((a) => a.id === id)?.edition || 'java', notify: (event) => this.notifyMacro(event) })
    const resolveTargets = (macro) => { const all = this.store.list(); if (macro.targets.mode === 'all') return all.map((a) => a.id); if (macro.targets.mode === 'accounts') { const ids = new Set(all.map((a) => a.id)); return macro.targets.accountIds.filter((id) => ids.has(id)) } const tags = new Set(macro.targets.tags); return all.filter((a) => Array.isArray(a.tags) && a.tags.some((tag) => tags.has(tag))).map((a) => a.id) }
    this.macroEngine = new MacroEngine({ facade: this.facade, matcher: new TriggerMatcher({}), now: this.now, emit: (e) => this.emitMacroRunEvent(e), getAccountState: this.facade.state, resolveTargets, nextScheduleTime: macroTriggers.nextScheduleTime })
    this.macroEngine.setLibrary(this.macroLibrary.list()); this.started = true
    return this
  }
  async shutdown() {
    for (const timer of this.startupTimers.values()) this.timers.clearTimeout(timer)
    this.startupTimers.clear()
    for (const id of new Set([...this.runtime.keys(), ...this.bots.java.sessions.keys(), ...this.bots.bedrock.sessions.keys()])) { try { await this.macroEngine?.stop(id, 'shutdown') } catch {}; try { await this.bots.disconnect(id) } catch {} }
    try { await this.macroEngine?.shutdown() } catch {}
    try { await this.notifier?.flush?.() } catch {}
    try { this.eventStore.close?.() } catch {}
  }
  emitBotEvent(type, id, payload = {}) {
    let account; try { account = this.store.list().find((a) => a.id === id) } catch (e) { this._storageError(e) }
    if (account) this.alerts?.handle(account, type, payload)
    for (const event of this.botEventAdapter?.(type, id, payload) || []) { this.macroEngine?.onBotEvent(event); this._notifyBot(event, account) }
    if (type === 'log' && payload.kind === 'chat') { const rows = this.recentChats.get(id) || []; rows.push({ at: Number(payload.at) || this.now(), message: String(payload.message || '') }); if (rows.length > 100) rows.splice(0, rows.length - 100); this.recentChats.set(id, rows) }
    if (type === 'log' && payload.kind === 'error' && /kicked:/i.test(payload.message || '')) { const reason = String(payload.message).replace(/^.*?kicked:\s*/i, ''); const kind = classifyKickReason(reason); const name = displayName(account); this._send({ kind, accountId: id, accountName: name, message: `${name} was ${kind}.`, payload: { reason }, at: Number(payload.at) || this.now() }) }
    if (type === 'status' && payload.status === 'reconnecting' && account) { const delaySeconds = Number(String(payload.detail || '').match(/in\s+([\d.]+)s/i)?.[1]) || undefined; const name = displayName(account); this._send({ kind: 'reconnecting', accountId: id, accountName: name, message: `${name} is reconnecting.`, payload: { delaySeconds }, at: Number(payload.at) || this.now() }) }
    if (type === 'status' && payload.status === 'online') this.smartProxies.report(this.assignedProxies.get(id), true)
    if (type === 'status' && payload.status === 'offline') { this.smartProxies.release(this.assignedProxies.get(id)); this.assignedProxies.delete(id) }
    if (type === 'log' && payload.kind === 'error') this.smartProxies.report(this.assignedProxies.get(id), false)
    if (type === 'status') this.diagnosticLog.write({ event: 'status', at: payload.at, accountId: id, status: payload.status, detail: payload.detail })
    if (type === 'telemetry') this.diagnosticLog.write({ event: 'telemetry', at: payload.at, accountId: id, position: payload.position, environment: payload.environment, health: payload.health })
    if (type === 'log' && payload.kind === 'error') this.diagnosticLog.write({ event: 'error', at: payload.at, accountId: id, message: payload.message })
    const current = this.runtime.get(id) || { status: 'offline', detail: 'Ready to connect', logs: [] }
    if (type === 'status') this.runtime.set(id, { ...current, status: payload.status, detail: payload.detail })
    if (type === 'log') this.runtime.set(id, { ...current, logs: [...current.logs.slice(-499), payload] })
    if (type === 'telemetry') this.runtime.set(id, { ...current, telemetry: payload })
    this._sendUi('bot:event', { type, id, payload })
    try { if (type !== 'telemetry' || telemetryChanged(current.telemetry, payload)) this.eventStore.append(id, { type, ...payload }) } catch (e) { this._storageError(e) }
  }
  accounts = {
    list: () => this.store.list().map(publicAccount),
    save: (input) => this._saveAccount(input),
    delete: (id) => { this.cancelStartupConnection(id); this.bots.disconnect(id); void this.macroEngine.stop(id, 'account-deleted'); this.store.delete(id); this.macroEngine.setLibrary(this.macroLibrary.list()) },
    reorder: (ids) => this.store.reorder(ids).map(publicAccount),
    connect: (id) => this.connect(id), disconnect: (id) => this.disconnect(id),
    setAntiAfk: (id, enabled) => { const a = this._require(id); const saved = this.store.save({ ...a, antiAfk: enabled === true }); this.bots.setAntiAfk(id, saved); return publicAccount(saved) }
  }
  connect(id) { this.cancelStartupConnection(id); if (this.bots.java.sessions.has(id) || this.bots.bedrock.sessions.has(id)) throw new Error('This profile is already connecting or online.'); const a = this._require(id, true); this.smartProxies.release(this.assignedProxies.get(id)); this.assignedProxies.set(id, a.proxy); try { return this.bots.connect(a) } catch (e) { this.smartProxies.release(this.assignedProxies.get(id)); this.assignedProxies.delete(id); throw e } }
  disconnect(id) { this.cancelStartupConnection(id); this.bots.disconnect(id); this.smartProxies.release(this.assignedProxies.get(id)); this.assignedProxies.delete(id) }
  recentChat(id) { return (this.recentChats.get(id) || []).slice() }
  status(id) { return this.runtime.get(id) || { status: 'offline', detail: 'Ready to connect', logs: [] } }
  _saveAccount(input) { const existing = this.store.list().find((a) => a.id === input?.id); const saved = this.store.save(validateAccount(input, existing, this.secretBox)); this.macroEngine.setLibrary(this.macroLibrary.list()); if (existing && (existing.autoDepositToChest !== saved.autoDepositToChest || existing.autoDepositRange !== saved.autoDepositRange)) this.bots.setAutoDeposit(saved.id, saved.autoDepositToChest, saved.autoDepositRange); if (existing && existing.environmentalMovement !== saved.environmentalMovement) this.bots.setEnvironmentalMovement(saved.id, saved.environmentalMovement); if (existing && antiAfkChanged(existing, saved)) this.bots.setAntiAfk(saved.id, saved); if (existing) { try { this.bots.updateAccountConfig(this._retryConfig(saved)) } catch (e) { this.diagnosticLog.write({ event: 'error', at: this.now(), accountId: saved.id, message: `Could not refresh live config: ${String(e?.message || e).slice(0, 200)}` }) } } return publicAccount(saved) }
  _require(id, password = false) { const a = this.store.list().find((x) => x.id === id); if (!a) throw new Error('Account not found.'); return password ? this._withProxyPassword(a) : a }
  _withProxyPassword(a) { const proxy = a.proxy || {}; let password = ''; if (proxy.passwordEncrypted) try { password = this.secretBox.decrypt(proxy.passwordEncrypted) } catch { throw new Error('Could not decrypt this account’s proxy password. Re-enter it in account settings.') } const enabled = a.proxyMode === 'manual' ? proxy.enabled === true : a.proxyMode === 'smart'; return { ...a, proxy: { ...proxy, enabled, password } } }
  _retryConfig(a) { const result = this._withProxyPassword(a); if (a.proxyMode === 'smart' && this.assignedProxies.get(a.id)) result.proxy = this.assignedProxies.get(a.id); return result }
  cancelStartupConnection(id) { const timer = this.startupTimers.get(id); if (timer) this.timers.clearTimeout(timer); this.startupTimers.delete(id) }
  autoConnectConfiguredAccounts() { const s = this.settingsStore.get(); this.store.list().filter((a) => a.connectOnStartup).forEach((a, i) => this.startupTimers.set(a.id, this.timers.setTimeout(() => { this.startupTimers.delete(a.id); try { if (this.store.list().find((x) => x.id === a.id)?.connectOnStartup) this.connect(a.id) } catch (e) { this.emitBotEvent('log', a.id, { kind: 'error', message: `Startup connection failed: ${e.message}`, at: this.now() }); this.emitBotEvent('status', a.id, { status: 'offline', detail: 'Startup connection failed' }) } }, startupConnectionDelay(s, i)))) }
  _send(event) { try { this.notifier?.notify(event) } catch {} }
  _sendUi(channel, payload) { try { this.emitToUi(channel, payload) } catch {} }
  _storageError(error) { try { this.platform.storageError?.(error) } catch {} }
  _notifyBot(event, account) { if (!account) return; const name = displayName(account); if (event.type === 'connected') this._send({ kind: 'connected', accountId: account.id, accountName: name, message: `${name} connected.`, at: event.at }); if (event.type === 'disconnected') this._send({ kind: 'disconnected', accountId: account.id, accountName: name, message: `${name} disconnected: ${event.payload.reason}`, payload: event.payload, at: event.at }); if (event.type === 'disconnected') { this.healthEdges.delete(account.id); this.previousInventoryFull.delete(account.id) } if (event.type === 'telemetry') { const p = event.payload, before = this.healthEdges.get(account.id), h = Number(p.health); if (crossedLowHealth(before, h)) this._send({ kind: 'lowHealth', accountId: account.id, accountName: name, message: `${name} health is ${h}/20.`, payload: { health: h }, at: event.at }); if (p.inventoryFull && !this.previousInventoryFull.get(account.id)) this._send({ kind: 'inventoryFull', accountId: account.id, accountName: name, message: `${name} inventory is full.`, at: event.at }); this.healthEdges.set(account.id, h); this.previousInventoryFull.set(account.id, p.inventoryFull === true) } if (event.type === 'death') this._send({ kind: 'death', accountId: account.id, accountName: name, message: `${name} died.`, at: event.at }) }
  notifyMacro(event) { const a = this.store.list().find((x) => x.id === event.accountId); const name = a?.profileName || a?.label || 'Minecraft account'; const message = String(event.message || event.error || 'Macro notification').slice(0, 500); this.platform.notifyMacro?.(name, message, event); this._send({ kind: 'macro', accountId: event.accountId, accountName: name, message, payload: { macroName: event.macroName || 'Macro', status: event.status || 'notify' }, at: this.now() }) }
  emitMacroRunEvent(event) { this._sendUi(IPC.event, event); if (event.accountId) { try { this.eventStore.append(event.accountId, { type: 'macro', ...event }) } catch (e) { this._storageError(e) } } if (event.status === 'failed') this.notifyMacro({ accountId: event.accountId, macroName: this.macroLibrary.get(event.macroId)?.name, status: 'failed', error: event.error?.message || event.reason || 'Macro failed' }) }
  macros = {
    list: () => { const validation = {}; for (const m of this.macroLibrary.list()) validation[m.id] = macroModel.validateMacro(m, this._macroOptions()); return { macros: this.macroLibrary.list(), validation } },
    run: (input) => { assertMacroPayload(input); return this.macroEngine.run(input.accountId, input.macroId) }, stop: (input) => { assertMacroPayload(input); return this.macroEngine.stop(input.accountId) },
    save: (input) => { assertMacroPayload(input); const prev = this.macroLibrary.get(input?.id); const macro = macroModel.normalizeMacro({ ...input, origin: input?.origin || prev?.origin }); const errors = macroModel.validateMacro(macro, this._macroOptions()); if (errors.length) { const e = new Error(errors.map((x) => `${x.path}: ${x.message}`).join(' ')); e.validation = errors; throw e } writeBackV1(this.store, macro); this.macroLibrary.save(macro); this.macroEngine.setLibrary(this.macroLibrary.list()); return macro },
    remove: (id) => { assertMacroPayload(id); const m = this.macroLibrary.get(id); if (!m) return false; writeBackV1(this.store, m, true); this.macroLibrary.remove(id); this.macroEngine.setLibrary(this.macroLibrary.list()); return true }
  }
  _macroOptions() { const a = this.store.list(); return { accountIds: a.map((x) => x.id), editionOf: (id) => a.find((x) => x.id === id)?.edition } }
  get notify() { return { list: () => this.notifySettings.list(), save: (v) => this.notifySettings.save(v), delete: (id) => this.notifySettings.delete(id), test: (id) => this.notifier ? this.notifier.test(id) : { ok: false, error: 'Notifier unavailable' } } }
  get logs() { return { list: (id, o) => this.eventStore.list(id, o), clear: (id) => this.eventStore.clear(id), recent: (limit) => this.eventStore.list(undefined, { limit }) } }
}

function displayName(a) { for (const v of [a?.profileName, a?.minecraftName, a?.label]) { const s = String(v || '').trim(); if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.slice(0, 60) } return 'Minecraft account' }
function publicAccount(a) { const { passwordEncrypted, password, ...proxy } = a.proxy || {}; return { ...a, proxy: { ...proxy, hasPassword: Boolean(passwordEncrypted) } } }
function assertMacroPayload(v) { let s; try { s = JSON.stringify(v) } catch { throw new Error('Macro payload must be JSON serializable.') } if (Buffer.byteLength(s === undefined ? 'null' : s) > LIMITS.maxIpcPayloadBytes) throw new Error('Macro payload exceeds 256 KB.') }
function telemetryChanged(a, b) { return !a || a.health !== b.health || a.food !== b.food || a.dimension !== b.dimension || JSON.stringify(a.position) !== JSON.stringify(b.position) || JSON.stringify(a.inventory) !== JSON.stringify(b.inventory) }
function antiAfkChanged(a, b) { return ['antiAfk','antiAfkMinDelay','antiAfkMaxDelay','antiAfkActionDuration','antiAfkWalkDistance','antiAfkLookDegrees','antiAfkJump','antiAfkLook','antiAfkSneak','antiAfkSwing','antiAfkWalk'].some((k) => a?.[k] !== b?.[k]) }
function bounded(v, min, max, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : fallback }
function normalizeUuid(v) { const s = String(v || '').replace(/-/g, '').toLowerCase(); return /^[0-9a-f]{32}$/.test(s) ? s : '' }
function normalizeMinecraftName(v) { const s = String(v || '').trim(); return /^[A-Za-z0-9_]{1,16}$/.test(s) ? s : '' }
function validateProxy(input, existing, secretBox) { const enabled = input?.enabled === true, type = input?.type === 'http' ? 'http' : 'socks5', host = String(input?.host || '').trim(), port = Number(input?.port) || (type === 'http' ? 8080 : 1080), username = String(input?.username || '').trim(); if (enabled && (!host || host.length > 255 || /[\s\r\n]/.test(host))) throw new Error('Enter a valid proxy host.'); if (enabled && (port < 1 || port > 65535)) throw new Error('Proxy port must be between 1 and 65535.'); if (username.length > 128 || /[\r\n]/.test(username)) throw new Error('Proxy username is invalid.'); let passwordEncrypted = String(existing?.passwordEncrypted || ''); if (input?.clearPassword === true) passwordEncrypted = ''; const p = String(input?.password || ''); if (p) { if (p.length > 512 || /[\r\n]/.test(p)) throw new Error('Proxy password is invalid.'); if (!secretBox?.available?.()) throw new Error('Windows credential encryption is not available. Proxy password was not saved.'); passwordEncrypted = secretBox.encrypt(p) } return { enabled, type, host, port, username, passwordEncrypted } }
function validateAccount(input, existing, secretBox) {
  const host=String(input?.host||'').trim(), username=String(input?.username||'').trim(); if(!host) throw new Error('Server address is required.'); if(!username) throw new Error('Microsoft account email is required.')
  const edition=normalizeEdition(input?.edition??existing?.edition), port=Number(input?.port)||(edition==='bedrock'?19132:25565); if(port<1||port>65535) throw new Error('Port must be between 1 and 65535.')
  const minecraftName=normalizeMinecraftName(input?.minecraftName), version=edition==='java'?normalizeVersionSelection(input?.version):'', remembered=rememberedVersionState(version,input,existing), modded=edition==='java'?normalizeModdedProfile(input):normalizeModdedProfile({modLoader:'vanilla',modHandshake:'off'})
  const antiAfk=input?.antiAfk!==false, antiAfkJump=input?.antiAfkJump!==false, antiAfkLook=input?.antiAfkLook!==false, antiAfkSneak=input?.antiAfkSneak===true, antiAfkSwing=input?.antiAfkSwing===true, antiAfkWalk=input?.antiAfkWalk===true; if(antiAfk&&![antiAfkJump,antiAfkLook,antiAfkSneak,antiAfkSwing,antiAfkWalk].some(Boolean)) throw new Error('Select at least one anti-AFK action or turn anti-AFK off.')
  return { id:validateProfileId(input?.id||require('node:crypto').randomUUID()), identityId:validateProfileId(existing?.identityId||identityIdFor(edition,username)), edition, profileName:String(input?.profileName||existing?.profileName||host).trim().slice(0,60), tags:[...new Set((Array.isArray(input?.tags)?input.tags:existing?.tags||[]).filter((x)=>typeof x==='string').map((x)=>x.trim().slice(0,24)).filter(Boolean))].slice(0,10), label:minecraftName||String(input?.label||username.split('@')[0]||'Minecraft account').trim().slice(0,50), username, host, port, version, modLoader:modded.loader, modHandshake:modded.handshake, clientBrand:modded.brand, mods:modded.mods, modChannels:modded.channels, ...remembered, minecraftName, minecraftUuid:normalizeUuid(input?.minecraftUuid), skinUrl:normalizeSkinUrl(input?.skinUrl), antiAfk, antiAfkInterval:bounded(input?.antiAfkMinDelay??input?.antiAfkInterval,2,3600,45), antiAfkMinDelay:bounded(input?.antiAfkMinDelay??input?.antiAfkInterval,2,3600,45), antiAfkMaxDelay:Math.max(bounded(input?.antiAfkMinDelay??input?.antiAfkInterval,2,3600,45),bounded(input?.antiAfkMaxDelay??input?.antiAfkInterval,2,3600,45)), antiAfkActionDuration:bounded(input?.antiAfkActionDuration,.1,10,.25), antiAfkWalkDistance:bounded(input?.antiAfkWalkDistance,.1,8,.5), antiAfkLookDegrees:bounded(input?.antiAfkLookDegrees,5,180,12), antiAfkJump, antiAfkLook, antiAfkSneak, antiAfkSwing, antiAfkWalk, environmentalMovement:input?.environmentalMovement!==false, autoReconnect:input?.autoReconnect!==false, autoReconnectDelay:bounded(input?.autoReconnectDelay,1,3600,5), autoReconnectBackoffMultiplier:bounded(input?.autoReconnectBackoffMultiplier,1,10,2), autoReconnectMaxDelay:bounded(input?.autoReconnectMaxDelay,1,86400,300), autoReconnectRateLimitDelay:bounded(input?.autoReconnectRateLimitDelay,1,86400,30), autoReconnectMaxAttempts:Math.max(0,Math.min(Number(input?.autoReconnectMaxAttempts)||0,1000)), connectTimeoutSeconds:bounded(input?.connectTimeoutSeconds,5,300,60), reconnectResetDelay:bounded(input?.reconnectResetDelay,5,3600,60), connectOnStartup:input?.connectOnStartup===true, autoDepositToChest:input?.autoDepositToChest===true, autoDepositRange:Math.round(bounded(input?.autoDepositRange??existing?.autoDepositRange,1,16,5)), lockedInventorySlots:[...new Set((Array.isArray(input?.lockedInventorySlots)?input.lockedInventorySlots:existing?.lockedInventorySlots||[]).map(Number).filter((x)=>Number.isInteger(x)&&x>=0&&x<=255))].sort((a,b)=>a-b).slice(0,46), proxy:validateProxy(input?.proxy,existing?.proxy,secretBox), proxyMode:['direct','manual','smart'].includes(input?.proxyMode)?input.proxyMode:(input?.proxy?.enabled?'manual':'direct'), shareProxyToPool:input?.shareProxyToPool===true, proxyLabel:String(input?.proxyLabel||'').trim().slice(0,60), proxyMaxSessions:Math.max(1,Math.min(Number(input?.proxyMaxSessions)||1,100)), alerts:{disconnect:input?.alerts?.disconnect!==false,errors:input?.alerts?.errors!==false,healthBelow:Math.max(0,Math.min(Number(input?.alerts?.healthBelow)||6,20))}, automations:normalizeAutomations(input?.automations??existing?.automations), joinMessage:String(input?.joinMessage||'').trim().slice(0,256), serverChangeMessage:String(input?.serverChangeMessage||'').trim().slice(0,256), messageDelay:Math.max(0,Math.min(input?.messageDelay===''||input?.messageDelay==null?6:Number(input.messageDelay)||0,600)) }
}
module.exports = { AppCore, publicAccount, displayName }
