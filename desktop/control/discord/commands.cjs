'use strict'

const { COMMANDS } = require('../../core/command-contract.cjs')
const { escapeDiscordText, redactSecrets } = require('./format.cjs')

const MAX_AUTOCOMPLETE_CHOICES = 25

// Discord ApplicationCommandOptionType values (avoids top-level discord.js import)
const OptionType = Object.freeze({
  Subcommand: 1,
  SubcommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5
})

// 1:1 mapping from /afk subcommand key to COMMANDS contract name
const SUBCOMMAND_MAP = Object.freeze({
  'status': 'status',
  'connect': 'account.connect',
  'disconnect': 'account.disconnect',
  'reconnect': 'account.reconnect',
  'chat': 'chat.send',
  'recent-chat': 'chat.recent',
  'inventory': 'inventory.view',
  'macro.run': 'macro.run',
  'macro.stop': 'macro.stop',
  'antiafk': 'antiAfk.set',
  'connect-all': 'connectAll',
  'disconnect-all': 'disconnectAll'
})

function accountOption(description = 'Target Minecraft account') {
  return {
    type: OptionType.String,
    name: 'account',
    description,
    required: true,
    autocomplete: true
  }
}

function buildAfkSlashCommand() {
  const messageMax = COMMANDS['chat.send'].args.message.max
  const limitSpec = COMMANDS['chat.recent'].args.limit

  return {
    name: 'afk',
    description: 'Control AFK Desk accounts',
    type: 1,
    dm_permission: false,
    dmPermission: false,
    options: [
      {
        type: OptionType.Subcommand,
        name: 'status',
        description: 'Show status of all accounts',
        options: []
      },
      {
        type: OptionType.Subcommand,
        name: 'connect',
        description: 'Connect an account',
        options: [accountOption('Account to connect')]
      },
      {
        type: OptionType.Subcommand,
        name: 'disconnect',
        description: 'Disconnect an account',
        options: [accountOption('Account to disconnect')]
      },
      {
        type: OptionType.Subcommand,
        name: 'reconnect',
        description: 'Reconnect an account',
        options: [accountOption('Account to reconnect')]
      },
      {
        type: OptionType.Subcommand,
        name: 'chat',
        description: 'Send a chat message from an account',
        options: [
          accountOption('Account to send chat from'),
          {
            type: OptionType.String,
            name: 'message',
            description: 'Chat message to send',
            required: true,
            max_length: messageMax,
            maxLength: messageMax
          }
        ]
      },
      {
        type: OptionType.Subcommand,
        name: 'recent-chat',
        description: 'View recent chat lines for an account',
        options: [
          accountOption('Account to view recent chat for'),
          {
            type: OptionType.Integer,
            name: 'limit',
            description: 'Number of recent lines (1-50)',
            required: false,
            min_value: limitSpec.min,
            max_value: limitSpec.max,
            minValue: limitSpec.min,
            maxValue: limitSpec.max
          }
        ]
      },
      {
        type: OptionType.Subcommand,
        name: 'inventory',
        description: 'View inventory of an account',
        options: [accountOption('Account to inspect')]
      },
      {
        type: OptionType.SubcommandGroup,
        name: 'macro',
        description: 'Run or stop a macro on an account',
        options: [
          {
            type: OptionType.Subcommand,
            name: 'run',
            description: 'Run a macro on an account',
            options: [
              accountOption('Account to run the macro on'),
              {
                type: OptionType.String,
                name: 'macro',
                description: 'Macro to run',
                required: true,
                autocomplete: true
              }
            ]
          },
          {
            type: OptionType.Subcommand,
            name: 'stop',
            description: 'Stop the running macro on an account',
            options: [accountOption('Account to stop the macro on')]
          }
        ]
      },
      {
        type: OptionType.Subcommand,
        name: 'antiafk',
        description: 'Enable or disable Anti-AFK on an account',
        options: [
          accountOption('Account to configure'),
          {
            type: OptionType.Boolean,
            name: 'enabled',
            description: 'Whether Anti-AFK is enabled',
            required: true
          }
        ]
      },
      {
        type: OptionType.Subcommand,
        name: 'connect-all',
        description: 'Connect all accounts',
        options: []
      },
      {
        type: OptionType.Subcommand,
        name: 'disconnect-all',
        description: 'Disconnect all accounts',
        options: []
      }
    ]
  }
}

function buildSlashCommands() {
  return [buildAfkSlashCommand()]
}

function readOptionValue(interaction, name, type) {
  const opts = interaction?.options
  if (!opts) return undefined

  if (type === 'string' && typeof opts.getString === 'function') {
    const val = opts.getString(name, false)
    if (val !== null && val !== undefined) return val
  }
  if (type === 'int' && typeof opts.getInteger === 'function') {
    const val = opts.getInteger(name, false)
    if (val !== null && val !== undefined) return val
  }
  if (type === 'bool' && typeof opts.getBoolean === 'function') {
    const val = opts.getBoolean(name, false)
    if (val !== null && val !== undefined) return val
  }
  if (typeof opts.get === 'function') {
    const entry = opts.get(name, false)
    if (entry && entry.value !== undefined) return entry.value
  }
  if (Array.isArray(opts.data)) {
    for (const item of opts.data) {
      if (item?.name === name && item.value !== undefined) return item.value
      if (Array.isArray(item?.options)) {
        for (const sub of item.options) {
          if (sub?.name === name && sub.value !== undefined) return sub.value
          if (Array.isArray(sub?.options)) {
            for (const leaf of sub.options) {
              if (leaf?.name === name && leaf.value !== undefined) return leaf.value
            }
          }
        }
      }
    }
  }
  if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
    if (Object.prototype.hasOwnProperty.call(opts, name)) {
      return opts[name]
    }
    if (opts.values && Object.prototype.hasOwnProperty.call(opts.values, name)) {
      return opts.values[name]
    }
  }
  return undefined
}

function resolveSubcommandKey(interaction) {
  const opts = interaction?.options
  let group = null
  let sub = null

  if (opts && typeof opts.getSubcommandGroup === 'function') {
    try {
      group = opts.getSubcommandGroup(false)
    } catch {
      group = null
    }
  }
  if (opts && typeof opts.getSubcommand === 'function') {
    try {
      sub = opts.getSubcommand(false)
    } catch {
      sub = null
    }
  }

  if (!group && typeof interaction?.subcommandGroup === 'string') {
    group = interaction.subcommandGroup
  }
  if (!sub && typeof interaction?.subcommand === 'string') {
    sub = interaction.subcommand
  }

  if (!sub && Array.isArray(opts?.data)) {
    const first = opts.data[0]
    if (first?.type === OptionType.SubcommandGroup) {
      group = first.name
      const nested = Array.isArray(first.options) ? first.options[0] : null
      if (nested?.type === OptionType.Subcommand) {
        sub = nested.name
      }
    } else if (first?.type === OptionType.Subcommand) {
      sub = first.name
    }
  }

  if (!sub) return null
  return group ? `${group}.${sub}` : sub
}

function parseCommandInteraction(interaction) {
  const commandName = interaction?.commandName || 'afk'
  if (commandName !== 'afk') {
    return null
  }

  const key = resolveSubcommandKey(interaction)
  if (!key || !Object.prototype.hasOwnProperty.call(SUBCOMMAND_MAP, key)) {
    return null
  }

  const contractCommand = SUBCOMMAND_MAP[key]
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, contractCommand)) {
    return null
  }

  const args = {}
  switch (contractCommand) {
    case 'status':
    case 'connectAll':
    case 'disconnectAll':
      break
    case 'account.connect':
    case 'account.disconnect':
    case 'account.reconnect':
    case 'inventory.view':
    case 'macro.stop': {
      const accountId = readOptionValue(interaction, 'account', 'string')
      if (accountId !== undefined) args.accountId = accountId
      break
    }
    case 'chat.send': {
      const accountId = readOptionValue(interaction, 'account', 'string')
      const message = readOptionValue(interaction, 'message', 'string')
      if (accountId !== undefined) args.accountId = accountId
      if (message !== undefined) args.message = message
      break
    }
    case 'chat.recent': {
      const accountId = readOptionValue(interaction, 'account', 'string')
      const limit = readOptionValue(interaction, 'limit', 'int')
      if (accountId !== undefined) args.accountId = accountId
      if (limit !== undefined && limit !== null) args.limit = limit
      break
    }
    case 'macro.run': {
      const accountId = readOptionValue(interaction, 'account', 'string')
      const macroId = readOptionValue(interaction, 'macro', 'string')
      if (accountId !== undefined) args.accountId = accountId
      if (macroId !== undefined) args.macroId = macroId
      break
    }
    case 'antiAfk.set': {
      const accountId = readOptionValue(interaction, 'account', 'string')
      const enabled = readOptionValue(interaction, 'enabled', 'bool')
      if (accountId !== undefined) args.accountId = accountId
      if (enabled !== undefined) args.enabled = enabled
      break
    }
    default:
      break
  }

  return { subcommandKey: key, command: contractCommand, args }
}

function getFocusedOption(interaction) {
  const opts = interaction?.options
  if (opts && typeof opts.getFocused === 'function') {
    try {
      const focusedObj = opts.getFocused(true)
      if (focusedObj && typeof focusedObj === 'object' && typeof focusedObj.name === 'string') {
        return { name: focusedObj.name, value: String(focusedObj.value ?? '') }
      }
      if (typeof focusedObj === 'string') {
        return { name: interaction?.focusedName || 'account', value: focusedObj }
      }
    } catch {
      try {
        const val = opts.getFocused()
        if (typeof val === 'string') {
          return { name: interaction?.focusedName || 'account', value: val }
        }
      } catch {}
    }
  }
  if (interaction?.focused && typeof interaction.focused === 'object') {
    return {
      name: String(interaction.focused.name || 'account'),
      value: String(interaction.focused.value ?? '')
    }
  }
  return null
}

function sanitizeChoiceLabel(name, fallback) {
  const clean = escapeDiscordText(name || fallback || '').replace(/\\/g, '').trim()
  const redacted = redactSecrets(clean) || String(fallback || 'item')
  return redacted.slice(0, 100)
}

async function resolveAutocompleteChoices({ interaction, actor, commandLayer }) {
  const focused = getFocusedOption(interaction)
  if (!focused) return []

  const prefix = String(focused.value ?? '').trim().toLowerCase()
  let rawItems = []

  if (focused.name === 'account') {
    if (typeof commandLayer?.accountsFor === 'function') {
      rawItems = (await commandLayer.accountsFor(actor)) || []
    }
  } else if (focused.name === 'macro') {
    const accountId = readOptionValue(interaction, 'account', 'string')
    if (typeof commandLayer?.macrosFor === 'function') {
      rawItems = (await commandLayer.macrosFor(actor, accountId)) || []
    }
  } else {
    return []
  }

  if (!Array.isArray(rawItems)) return []

  const filtered = []
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i]
    if (!item || typeof item !== 'object') continue
    const id = item.id !== undefined && item.id !== null ? String(item.id) : ''
    const name = item.name !== undefined && item.name !== null ? String(item.name) : id
    if (!id) continue

    if (prefix && !name.toLowerCase().startsWith(prefix)) {
      continue
    }

    filtered.push({
      name: sanitizeChoiceLabel(name, id),
      value: id.slice(0, 100)
    })

    if (filtered.length >= MAX_AUTOCOMPLETE_CHOICES) {
      break
    }
  }

  return filtered
}

module.exports = {
  OptionType,
  MAX_AUTOCOMPLETE_CHOICES,
  SUBCOMMAND_MAP,
  buildAfkSlashCommand,
  buildSlashCommands,
  resolveSubcommandKey,
  parseCommandInteraction,
  getFocusedOption,
  resolveAutocompleteChoices
}
