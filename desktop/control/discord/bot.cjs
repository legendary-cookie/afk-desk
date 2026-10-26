'use strict'

const crypto = require('node:crypto')
const { SCOPES, LIMITS } = require('../../core/command-contract.cjs')
const {
  ALLOWED_MENTIONS,
  rememberBotToken,
  redactSecrets,
  truncateMessage,
  formatCommandResult,
  formatCommandError,
  formatConfirmPrompt,
  formatNotification
} = require('./format.cjs')
const {
  buildSlashCommands,
  parseCommandInteraction,
  resolveAutocompleteChoices
} = require('./commands.cjs')

const GUILDS_INTENT_BIT = 1 << 0 // GatewayIntentBits.Guilds === 1
const USER_FLOOD_LIMIT = 10
const USER_FLOOD_WINDOW_MS = 10_000
const UNAUTHORIZED_MESSAGE = 'You are not allowed to control AFK Desk.'
const GENERIC_ERROR_MESSAGE = 'An internal error occurred while processing the command.'
const FLOOD_LIMIT_MESSAGE = 'Too many requests. Please wait a moment before trying again.'

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const botToken = typeof cfg.botToken === 'string' ? cfg.botToken.trim() : ''
  if (botToken) {
    rememberBotToken(botToken)
  }

  const guildIds = Array.isArray(cfg.guildIds)
    ? cfg.guildIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : []
  const channelIds = Array.isArray(cfg.channelIds)
    ? cfg.channelIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : []

  const users = cfg.users && typeof cfg.users === 'object' && !Array.isArray(cfg.users) ? cfg.users : {}
  const roles = cfg.roles && typeof cfg.roles === 'object' && !Array.isArray(cfg.roles) ? cfg.roles : {}

  return {
    enabled: Boolean(cfg.enabled),
    botToken,
    applicationId: typeof cfg.applicationId === 'string' ? cfg.applicationId.trim() : '',
    guildIds,
    channelIds,
    users,
    roles,
    notifyChannelId: typeof cfg.notifyChannelId === 'string' && cfg.notifyChannelId.trim()
      ? cfg.notifyChannelId.trim()
      : null,
    publicReplies: Boolean(cfg.publicReplies)
  }
}

function extractMemberRoleIds(interaction) {
  const roles = interaction?.member?.roles
  if (!roles) return []

  if (Array.isArray(roles)) {
    return roles
      .map((r) => (typeof r === 'string' ? r : r?.id))
      .filter((id) => typeof id === 'string' && id.length > 0)
  }

  if (roles instanceof Set) {
    return Array.from(roles)
      .map((r) => (typeof r === 'string' ? r : r?.id))
      .filter((id) => typeof id === 'string' && id.length > 0)
  }

  const cache = roles.cache
  if (cache) {
    if (Array.isArray(cache)) {
      return cache
        .map((r) => (typeof r === 'string' ? r : r?.id))
        .filter((id) => typeof id === 'string' && id.length > 0)
    }
    if (typeof cache.keys === 'function') {
      return Array.from(cache.keys()).filter((id) => typeof id === 'string' && id.length > 0)
    }
    if (typeof cache === 'object') {
      return Object.keys(cache)
    }
  }

  return []
}

function maxScope(scopeA, scopeB) {
  const idxA = SCOPES.indexOf(scopeA)
  const idxB = SCOPES.indexOf(scopeB)
  if (idxA < 0 && idxB < 0) return null
  if (idxA >= idxB) return scopeA
  return scopeB
}

function resolveActorScope(cfg, interaction) {
  const userId = interaction?.user?.id || interaction?.member?.user?.id
  if (!userId || typeof userId !== 'string') return null

  let resolved = null
  const directScope = cfg.users?.[userId]
  if (typeof directScope === 'string' && SCOPES.includes(directScope)) {
    resolved = maxScope(resolved, directScope)
  }

  const roleIds = extractMemberRoleIds(interaction)
  for (let i = 0; i < roleIds.length; i += 1) {
    const roleScope = cfg.roles?.[roleIds[i]]
    if (typeof roleScope === 'string' && SCOPES.includes(roleScope)) {
      resolved = maxScope(resolved, roleScope)
    }
  }

  return resolved
}

function checkGuildAndChannelAllowed(cfg, interaction) {
  const guildId = interaction?.guildId
  if (!guildId || typeof guildId !== 'string') {
    return false // Reject DMs or guildless interactions
  }
  if (!cfg.guildIds.includes(guildId)) {
    return false
  }
  if (cfg.channelIds.length > 0) {
    const channelId = interaction?.channelId
    if (!channelId || !cfg.channelIds.includes(channelId)) {
      return false
    }
  }
  return true
}

function isAutocompleteInteraction(interaction) {
  if (typeof interaction?.isAutocomplete === 'function') {
    return Boolean(interaction.isAutocomplete())
  }
  return interaction?.type === 4
}

function isButtonInteraction(interaction) {
  if (typeof interaction?.isButton === 'function') {
    return Boolean(interaction.isButton())
  }
  return interaction?.type === 3 || (typeof interaction?.customId === 'string' && !interaction?.commandName)
}

function isCommandInteraction(interaction) {
  if (typeof interaction?.isChatInputCommand === 'function') {
    return Boolean(interaction.isChatInputCommand())
  }
  if (typeof interaction?.isCommand === 'function') {
    return Boolean(interaction.isCommand())
  }
  return !isAutocompleteInteraction(interaction) && !isButtonInteraction(interaction)
}

function buildConfirmComponents(nonce) {
  const confirmId = `afk_confirm:${nonce}`
  const cancelId = `afk_cancel:${nonce}`
  return [
    {
      type: 1, // ActionRow
      components: [
        {
          type: 2, // Button
          style: 4, // Danger
          label: 'Confirm',
          custom_id: confirmId,
          customId: confirmId
        },
        {
          type: 2, // Button
          style: 2, // Secondary
          label: 'Cancel',
          custom_id: cancelId,
          customId: cancelId
        }
      ]
    }
  ]
}

function createDiscordControl({
  commandLayer,
  getConfig,
  onLog = () => {},
  onAudit = () => {},
  Client: InjectedClient,
  now = Date.now,
  timers = globalThis
} = {}) {
  if (!commandLayer || typeof commandLayer.execute !== 'function') {
    throw new TypeError('commandLayer with execute() is required.')
  }
  if (typeof getConfig !== 'function') {
    throw new TypeError('getConfig is required.')
  }

  let client = null
  let currentState = 'stopped'
  let lastError = undefined
  let readyPromise = null

  const pendingConfirms = new Map()
  const userInteractionTimestamps = new Map()

  function safeNow() {
    try {
      const value = now()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function readConfig() {
    try {
      return normalizeConfig(getConfig())
    } catch (err) {
      safeLog({ level: 'error', event: 'discord_config_error', message: err?.message || String(err) })
      return normalizeConfig({})
    }
  }

  function safeLog(entry) {
    try {
      if (typeof onLog !== 'function') return
      if (typeof entry === 'string') {
        onLog(redactSecrets(entry))
        return
      }
      if (entry && typeof entry === 'object') {
        const out = {}
        const keys = Object.keys(entry)
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i]
          const v = entry[k]
          out[k] = typeof v === 'string' ? redactSecrets(v) : v
        }
        onLog(out)
      }
    } catch {}
  }

  function safeAudit(entry) {
    try {
      if (typeof onAudit !== 'function' || !entry || typeof entry !== 'object') return
      const sanitized = { ...entry }
      if (typeof sanitized.command === 'string') {
        sanitized.command = redactSecrets(sanitized.command)
      }
      if (typeof sanitized.result === 'string') {
        sanitized.result = redactSecrets(sanitized.result)
      }
      onAudit(sanitized)
    } catch {}
  }

  function pruneConfirmNonces(nowTs) {
    pendingConfirms.forEach((entry, nonce) => {
      if (!entry || nowTs >= entry.expiresAt) {
        pendingConfirms.delete(nonce)
      }
    })
  }

  function checkUserFlood(userId, nowTs) {
    const key = String(userId || 'anonymous')
    const cutoff = nowTs - USER_FLOOD_WINDOW_MS
    const prev = userInteractionTimestamps.get(key) || []
    const recent = prev.filter((ts) => ts > cutoff)
    if (recent.length >= USER_FLOOD_LIMIT) {
      userInteractionTimestamps.set(key, recent)
      return false
    }
    recent.push(nowTs)
    userInteractionTimestamps.set(key, recent)
    return true
  }

  async function sendInteractionReply(interaction, { content, ephemeral = true, components } = {}) {
    const safeContent = truncateMessage(redactSecrets(content || ''))
    const payload = {
      content: safeContent,
      ephemeral: Boolean(ephemeral),
      allowed_mentions: ALLOWED_MENTIONS,
      allowedMentions: ALLOWED_MENTIONS
    }
    if (Array.isArray(components)) {
      payload.components = components
    }

    if (typeof interaction?.reply === 'function') {
      await interaction.reply(payload)
    } else if (typeof interaction?.followUp === 'function') {
      await interaction.followUp(payload)
    }
  }

  async function handleButton(interaction, cfg, nowTs) {
    const userId = String(interaction?.user?.id || interaction?.member?.user?.id || '')
    const rawCustomId = String(interaction?.customId ?? interaction?.custom_id ?? '')
    const match = /^(afk_confirm|afk_cancel):([a-f0-9]+)$/i.exec(rawCustomId)
    if (!match) {
      await sendInteractionReply(interaction, {
        content: 'Unknown button interaction.',
        ephemeral: true
      })
      return
    }

    const action = match[1].toLowerCase()
    const nonce = match[2]
    const entry = pendingConfirms.get(nonce)

    if (!checkGuildAndChannelAllowed(cfg, interaction)) {
      safeAudit({
        actor: { kind: 'discord', id: userId || 'unknown', scope: null },
        command: entry?.command || 'button',
        result: 'forbidden'
      })
      await sendInteractionReply(interaction, {
        content: UNAUTHORIZED_MESSAGE,
        ephemeral: true
      })
      return
    }

    if (!entry) {
      await sendInteractionReply(interaction, {
        content: 'Confirmation expired or already used.',
        ephemeral: true
      })
      return
    }

    if (nowTs >= entry.expiresAt) {
      pendingConfirms.delete(nonce)
      await sendInteractionReply(interaction, {
        content: 'Confirmation expired.',
        ephemeral: true
      })
      return
    }

    if (entry.userId !== userId) {
      await sendInteractionReply(interaction, {
        content: 'Only the user who initiated this command can confirm or cancel it.',
        ephemeral: true
      })
      return
    }

    const scope = resolveActorScope(cfg, interaction)
    if (!scope) {
      pendingConfirms.delete(nonce)
      safeAudit({
        actor: { kind: 'discord', id: userId || 'unknown', scope: null },
        command: entry.command,
        result: 'forbidden'
      })
      await sendInteractionReply(interaction, {
        content: UNAUTHORIZED_MESSAGE,
        ephemeral: true
      })
      return
    }

    // Single-use nonce: consume before executing
    pendingConfirms.delete(nonce)

    if (action === 'afk_cancel') {
      await sendInteractionReply(interaction, {
        content: 'Command cancelled.',
        ephemeral: true
      })
      return
    }

    const actor = { kind: 'discord', id: userId, scope }
    const response = await commandLayer.execute(actor, entry.command, entry.args, { confirmed: true })
    if (response && response.ok) {
      const text = formatCommandResult(entry.command, response.result, entry.args)
      await sendInteractionReply(interaction, {
        content: text,
        ephemeral: !cfg.publicReplies
      })
    } else {
      const errText = formatCommandError(response?.error)
      await sendInteractionReply(interaction, {
        content: errText,
        ephemeral: true
      })
    }
  }

  async function handleAutocomplete(interaction, cfg) {
    if (!checkGuildAndChannelAllowed(cfg, interaction)) {
      if (typeof interaction?.respond === 'function') {
        await interaction.respond([])
      }
      return
    }

    const scope = resolveActorScope(cfg, interaction)
    if (!scope) {
      if (typeof interaction?.respond === 'function') {
        await interaction.respond([])
      }
      return
    }

    const userId = String(interaction?.user?.id || interaction?.member?.user?.id || '')
    const actor = { kind: 'discord', id: userId, scope }
    const choices = await resolveAutocompleteChoices({
      interaction,
      actor,
      commandLayer
    })
    if (typeof interaction?.respond === 'function') {
      await interaction.respond(choices)
    }
  }

  async function handleSlashCommand(interaction, cfg, nowTs) {
    const userId = String(interaction?.user?.id || interaction?.member?.user?.id || '')
    const parsed = parseCommandInteraction(interaction)
    const commandNameForAudit = parsed?.command || interaction?.commandName || 'unknown'

    const locationAllowed = checkGuildAndChannelAllowed(cfg, interaction)
    const scope = locationAllowed ? resolveActorScope(cfg, interaction) : null

    if (!locationAllowed || !scope || !userId) {
      const actor = { kind: 'discord', id: userId || 'unknown', scope: scope || null }
      safeAudit({
        actor,
        command: commandNameForAudit,
        result: 'forbidden'
      })
      await sendInteractionReply(interaction, {
        content: UNAUTHORIZED_MESSAGE,
        ephemeral: true
      })
      return
    }

    if (!parsed) {
      await sendInteractionReply(interaction, {
        content: 'Unknown or unsupported /afk subcommand.',
        ephemeral: true
      })
      return
    }

    const actor = { kind: 'discord', id: userId, scope }
    const response = await commandLayer.execute(actor, parsed.command, parsed.args, { confirmed: false })

    if (response && response.ok) {
      const text = formatCommandResult(parsed.command, response.result, parsed.args)
      await sendInteractionReply(interaction, {
        content: text,
        ephemeral: !cfg.publicReplies
      })
      return
    }

    if (response?.error?.code === 'CONFIRM_REQUIRED') {
      pruneConfirmNonces(nowTs)
      const nonce = crypto.randomBytes(16).toString('hex')
      pendingConfirms.set(nonce, {
        userId: actor.id,
        command: parsed.command,
        args: parsed.args,
        expiresAt: nowTs + LIMITS.confirmTtlMs
      })
      const promptText = formatConfirmPrompt(parsed.command, parsed.args, response.error.message)
      const components = buildConfirmComponents(nonce)
      await sendInteractionReply(interaction, {
        content: promptText,
        ephemeral: true,
        components
      })
      return
    }

    const errText = formatCommandError(response?.error)
    await sendInteractionReply(interaction, {
      content: errText,
      ephemeral: true
    })
  }

  async function handleInteraction(interaction) {
    if (!interaction) return
    const cfg = readConfig()
    const nowTs = safeNow()
    const userId = String(interaction?.user?.id || interaction?.member?.user?.id || 'anonymous')

    try {
      if (!checkUserFlood(userId, nowTs)) {
        if (isAutocompleteInteraction(interaction)) {
          if (typeof interaction?.respond === 'function') {
            await interaction.respond([])
          }
        } else {
          await sendInteractionReply(interaction, {
            content: FLOOD_LIMIT_MESSAGE,
            ephemeral: true
          })
        }
        return
      }

      if (isAutocompleteInteraction(interaction)) {
        await handleAutocomplete(interaction, cfg)
        return
      }

      if (isButtonInteraction(interaction)) {
        await handleButton(interaction, cfg, nowTs)
        return
      }

      if (isCommandInteraction(interaction)) {
        await handleSlashCommand(interaction, cfg, nowTs)
      }
    } catch (err) {
      const cleanErr = redactSecrets(err?.message || String(err))
      lastError = cleanErr
      safeLog({ level: 'error', event: 'discord_interaction_error', message: cleanErr })
      try {
        if (!isAutocompleteInteraction(interaction)) {
          await sendInteractionReply(interaction, {
            content: GENERIC_ERROR_MESSAGE,
            ephemeral: true
          })
        }
      } catch {}
    }
  }

  async function registerCommands() {
    const cfg = readConfig()
    if (!client || cfg.guildIds.length === 0) return

    const commandsPayload = buildSlashCommands()

    for (let i = 0; i < cfg.guildIds.length; i += 1) {
      const guildId = cfg.guildIds[i]
      if (typeof client.application?.commands?.set === 'function') {
        await client.application.commands.set(commandsPayload, guildId)
        continue
      }

      const guild =
        client.guilds?.cache?.get?.(guildId) ||
        (typeof client.guilds?.fetch === 'function' ? await client.guilds.fetch(guildId) : null)
      if (guild && typeof guild.commands?.set === 'function') {
        await guild.commands.set(commandsPayload)
        continue
      }

      if (typeof client.registerGuildCommands === 'function') {
        await client.registerGuildCommands(guildId, commandsPayload)
      }
    }
  }

  async function start() {
    const cfg = readConfig()
    if (!cfg.enabled) {
      if (client) {
        await stop()
      }
      currentState = 'stopped'
      return
    }

    if (!cfg.botToken) {
      currentState = 'error'
      lastError = 'Discord botToken is required when enabled.'
      safeLog({ level: 'error', event: 'discord_start_failed', message: lastError })
      return
    }

    if (client) {
      await stop()
    }

    currentState = 'starting'
    lastError = undefined

    let ClientClass = InjectedClient
    let guildsIntent = GUILDS_INTENT_BIT
    if (!ClientClass) {
      // Lazy require discord.js ONLY inside start() when enabled
      const discordJs = require('discord.js')
      ClientClass = discordJs.Client
      if (discordJs.GatewayIntentBits?.Guilds !== undefined) {
        guildsIntent = discordJs.GatewayIntentBits.Guilds
      }
    }

    const activeClient = new ClientClass({
      intents: [guildsIntent]
    })
    client = activeClient

    const onReady = () => {
      if (client !== activeClient) return
      currentState = 'ready'
      lastError = undefined
      safeLog({
        level: 'info',
        event: 'discord_ready',
        user: redactSecrets(activeClient.user?.tag || activeClient.user?.username || activeClient.user?.id || 'bot')
      })
      readyPromise = Promise.resolve(registerCommands()).catch((err) => {
        const clean = redactSecrets(err?.message || String(err))
        lastError = clean
        safeLog({ level: 'error', event: 'discord_register_failed', message: clean })
      })
    }

    if (typeof activeClient.on === 'function') {
      activeClient.on('ready', onReady)
      activeClient.on('interactionCreate', (interaction) => {
        handleInteraction(interaction)
      })
      activeClient.on('error', (err) => {
        const clean = redactSecrets(err?.message || String(err))
        lastError = clean
        safeLog({ level: 'error', event: 'discord_client_error', message: clean })
      })
    }

    try {
      if (typeof activeClient.login === 'function') {
        await activeClient.login(cfg.botToken)
      }
      if (readyPromise) {
        await readyPromise
      }
    } catch (err) {
      const clean = redactSecrets(err?.message || String(err))
      currentState = 'error'
      lastError = clean
      safeLog({ level: 'error', event: 'discord_login_failed', message: clean })
      try {
        await activeClient.destroy?.()
      } catch {}
      if (client === activeClient) {
        client = null
      }
    }
  }

  async function stop() {
    const activeClient = client
    client = null
    readyPromise = null
    currentState = 'stopped'
    pendingConfirms.clear()
    userInteractionTimestamps.clear()

    if (activeClient) {
      try {
        if (typeof activeClient.removeAllListeners === 'function') {
          activeClient.removeAllListeners()
        }
      } catch {}
      try {
        if (typeof activeClient.destroy === 'function') {
          await activeClient.destroy()
        }
      } catch (err) {
        const clean = redactSecrets(err?.message || String(err))
        lastError = clean
        safeLog({ level: 'warn', event: 'discord_stop_error', message: clean })
      }
    }
  }

  function status() {
    const cfg = readConfig()
    const out = {
      state: currentState
    }

    if (client?.user) {
      const userLabel = client.user.tag || client.user.username || client.user.id
      if (userLabel) {
        out.user = redactSecrets(String(userLabel))
      }
    }

    if (cfg.guildIds.length > 0) {
      out.guilds = cfg.guildIds.map((id) => redactSecrets(id))
    } else if (client?.guilds?.cache && typeof client.guilds.cache.keys === 'function') {
      out.guilds = Array.from(client.guilds.cache.keys()).map((id) => redactSecrets(String(id)))
    }

    if (lastError !== undefined) {
      out.lastError = redactSecrets(lastError)
    }

    return out
  }

  async function postNotification(text) {
    const cfg = readConfig()
    if (!client || !cfg.notifyChannelId) return

    const content = formatNotification(text)
    if (!content) return

    const messagePayload = {
      content,
      allowed_mentions: ALLOWED_MENTIONS,
      allowedMentions: ALLOWED_MENTIONS
    }

    try {
      let channel = client.channels?.cache?.get?.(cfg.notifyChannelId)
      if (!channel && typeof client.channels?.fetch === 'function') {
        channel = await client.channels.fetch(cfg.notifyChannelId)
      }
      if (!channel && typeof client.getChannel === 'function') {
        channel = await client.getChannel(cfg.notifyChannelId)
      }

      if (channel && typeof channel.send === 'function') {
        await channel.send(messagePayload)
      } else if (typeof client.sendToChannel === 'function') {
        await client.sendToChannel(cfg.notifyChannelId, messagePayload)
      }
    } catch (err) {
      const clean = redactSecrets(err?.message || String(err))
      lastError = clean
      safeLog({ level: 'error', event: 'discord_notify_failed', message: clean })
    }
  }

  return {
    start,
    stop,
    status,
    registerCommands,
    postNotification
  }
}

module.exports = {
  createDiscordControl
}
