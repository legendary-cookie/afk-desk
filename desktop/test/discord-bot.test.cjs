'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { COMMANDS, SCOPES, scopeAllows, LIMITS } = require('../core/command-contract.cjs')
const { createDiscordControl } = require('../control/discord/bot.cjs')
const { SUBCOMMAND_MAP, buildAfkSlashCommand } = require('../control/discord/commands.cjs')
const {
  escapeDiscordText,
  truncateMessage,
  formatInventory,
  redactSecrets
} = require('../control/discord/format.cjs')

const FAKE_BOT_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GeFaKe.SuperSecretBotTokenValue987654321'

function createFakeClientClass(tracker) {
  return class FakeClient extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.destroyed = false
      this.loggedInToken = null
      this.user = { id: 'bot-999', tag: 'AFKDeskBot#0001' }
      this.registrations = []
      this.sentMessages = []

      this.application = {
        commands: {
          set: async (commands, guildId) => {
            this.registrations.push({ guildId, commands })
            tracker.registrations.push({ guildId, commands })
            return commands
          }
        }
      }

      this.channels = {
        cache: new Map(),
        fetch: async (channelId) => ({
          id: channelId,
          send: async (payload) => {
            this.sentMessages.push({ channelId, payload })
            tracker.sentMessages.push({ channelId, payload })
            return payload
          }
        })
      }

      tracker.instances.push(this)
    }

    async login(token) {
      if (tracker.failLoginWithToken) {
        throw new Error(`Login failed for token ${token}`)
      }
      this.loggedInToken = token
      this.emit('ready')
      return token
    }

    async destroy() {
      this.destroyed = true
      tracker.destroyCount += 1
    }

    async emitInteraction(interaction) {
      const listeners = this.listeners('interactionCreate')
      for (const fn of listeners) {
        await fn(interaction)
      }
      // Allow microtasks inside handleInteraction to settle
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function createFakeCommandLayer({
  accounts = [
    { id: 'acc-1', name: 'AlphaBot' },
    { id: 'acc-2', name: 'BetaMiner' }
  ],
  macros = [
    { id: 'mac-1', name: 'FarmWheat' },
    { id: 'mac-2', name: 'DepositChest' }
  ],
  customHandler = null
} = {}) {
  const calls = []
  const accountCalls = []
  const macroCalls = []

  return {
    calls,
    accountCalls,
    macroCalls,
    async accountsFor(actor) {
      accountCalls.push({ actor })
      return typeof accounts === 'function' ? accounts(actor) : accounts
    },
    async macrosFor(actor, accountId) {
      macroCalls.push({ actor, accountId })
      return typeof macros === 'function' ? macros(actor, accountId) : macros
    },
    async execute(actor, name, args, { confirmed = false } = {}) {
      calls.push({ actor, name, args, confirmed })
      if (typeof customHandler === 'function') {
        const res = await customHandler(actor, name, args, { confirmed })
        if (res !== undefined) return res
      }

      const spec = COMMANDS[name]
      if (!spec) {
        return { ok: false, error: { code: 'INVALID', message: `Unknown command: ${name}` } }
      }
      if (!scopeAllows(actor.scope, spec.scope)) {
        return {
          ok: false,
          error: { code: 'FORBIDDEN', message: `Scope "${actor.scope}" cannot run "${name}".` }
        }
      }
      if (spec.danger === 'confirm' && !confirmed) {
        return {
          ok: false,
          error: { code: 'CONFIRM_REQUIRED', message: `Confirm ${name}?` }
        }
      }

      if (name === 'status') {
        return {
          ok: true,
          result: [
            {
              id: 'acc-1',
              name: 'AlphaBot',
              server: 'mc.example.com',
              state: 'connected',
              health: 20,
              food: 18,
              uptimeMs: 3661000
            }
          ]
        }
      }

      if (name === 'inventory.view') {
        return {
          ok: true,
          result: [
            { slot: 0, name: 'diamond_sword', displayName: '§bDiamond `Sword` *Sharp*', count: 1 },
            { slot: 1, name: 'golden_apple', displayName: 'Golden Apple @everyone', count: 16 }
          ]
        }
      }

      if (name === 'chat.recent') {
        return {
          ok: true,
          result: [
            { sender: '§cAdmin_User', message: 'Hello @everyone <@123456> **bold** `code`' }
          ]
        }
      }

      return { ok: true, result: { accountId: args.accountId, macroId: args.macroId, enabled: args.enabled } }
    }
  }
}

function makeSlashInteraction({
  userId = 'user-control',
  guildId = 'guild-1',
  channelId = 'chan-1',
  subcommand = 'status',
  subcommandGroup = null,
  options = {},
  memberRoles = [],
  replies = []
} = {}) {
  return {
    guildId,
    channelId,
    commandName: 'afk',
    user: { id: userId },
    member: { user: { id: userId }, roles: memberRoles },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    options: {
      getSubcommandGroup: () => subcommandGroup,
      getSubcommand: () => subcommand,
      getString: (name) => (typeof options[name] === 'string' ? options[name] : null),
      getInteger: (name) => (typeof options[name] === 'number' ? options[name] : null),
      getBoolean: (name) => (typeof options[name] === 'boolean' ? options[name] : null)
    },
    replies,
    async reply(payload) {
      replies.push(payload)
      return payload
    }
  }
}

function makeButtonInteraction({
  userId = 'user-control',
  guildId = 'guild-1',
  channelId = 'chan-1',
  customId,
  memberRoles = [],
  replies = []
} = {}) {
  return {
    guildId,
    channelId,
    customId,
    user: { id: userId },
    member: { user: { id: userId }, roles: memberRoles },
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => true,
    replies,
    async reply(payload) {
      replies.push(payload)
      return payload
    }
  }
}

function makeAutocompleteInteraction({
  userId = 'user-control',
  guildId = 'guild-1',
  channelId = 'chan-1',
  focusedName = 'account',
  focusedValue = '',
  options = {},
  memberRoles = [],
  responses = []
} = {}) {
  return {
    guildId,
    channelId,
    commandName: 'afk',
    user: { id: userId },
    member: { user: { id: userId }, roles: memberRoles },
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    isButton: () => false,
    options: {
      getFocused: (full) => (full ? { name: focusedName, value: focusedValue } : focusedValue),
      getString: (name) => (typeof options[name] === 'string' ? options[name] : null)
    },
    responses,
    async respond(choices) {
      responses.push(choices)
      return choices
    }
  }
}

function createHarness(configOverrides = {}, commandLayerOpts = {}) {
  let nowMs = 1_700_000_000_000
  const tracker = {
    instances: [],
    registrations: [],
    sentMessages: [],
    destroyCount: 0,
    failLoginWithToken: false
  }
  const logs = []
  const audits = []
  const commandLayer = createFakeCommandLayer(commandLayerOpts)

  const baseConfig = {
    enabled: true,
    botToken: FAKE_BOT_TOKEN,
    applicationId: 'app-123',
    guildIds: ['guild-1', 'guild-2'],
    channelIds: ['chan-1'],
    users: {
      'user-read': 'read',
      'user-control': 'control',
      'user-admin': 'admin'
    },
    roles: {
      'role-control': 'control',
      'role-admin': 'admin'
    },
    notifyChannelId: 'chan-notify',
    publicReplies: false,
    ...configOverrides
  }

  let currentConfig = baseConfig
  const FakeClient = createFakeClientClass(tracker)

  const bot = createDiscordControl({
    commandLayer,
    getConfig: () => currentConfig,
    onLog: (entry) => logs.push(entry),
    onAudit: (entry) => audits.push(entry),
    Client: FakeClient,
    now: () => nowMs
  })

  return {
    bot,
    tracker,
    commandLayer,
    logs,
    audits,
    getNow: () => nowMs,
    advanceTime: (ms) => {
      nowMs += ms
    },
    setConfig: (next) => {
      currentConfig = { ...currentConfig, ...next }
    }
  }
}

test('slash command definition maps 1:1 to COMMANDS with contract option limits', () => {
  const slash = buildAfkSlashCommand()
  assert.equal(slash.name, 'afk')
  assert.equal(slash.dm_permission, false)

  for (const [, contractName] of Object.entries(SUBCOMMAND_MAP)) {
    assert.ok(COMMANDS[contractName], `Missing contract command for ${contractName}`)
  }

  const chatSub = slash.options.find((o) => o.name === 'chat')
  const msgOpt = chatSub.options.find((o) => o.name === 'message')
  assert.equal(msgOpt.max_length, 256)

  const recentChatSub = slash.options.find((o) => o.name === 'recent-chat')
  const limitOpt = recentChatSub.options.find((o) => o.name === 'limit')
  assert.equal(limitOpt.min_value, 1)
  assert.equal(limitOpt.max_value, 50)
})

test('start() uses Guilds-only intent, registers guild-scoped commands, and stop() destroys client', async () => {
  const { bot, tracker } = createHarness()
  await bot.start()

  assert.equal(tracker.instances.length, 1)
  const client = tracker.instances[0]
  // GatewayIntentBits.Guilds === 1 (1 << 0) ONLY; no MessageContent (1 << 15)
  assert.deepEqual(client.options.intents, [1])

  // Registered once per allowed guild
  assert.equal(tracker.registrations.length, 2)
  assert.equal(tracker.registrations[0].guildId, 'guild-1')
  assert.equal(tracker.registrations[1].guildId, 'guild-2')
  assert.equal(tracker.registrations[0].commands[0].name, 'afk')

  const st = bot.status()
  assert.equal(st.state, 'ready')
  assert.equal(st.user, 'AFKDeskBot#0001')
  assert.deepEqual(st.guilds, ['guild-1', 'guild-2'])

  await bot.stop()
  assert.equal(client.destroyed, true)
  assert.equal(tracker.destroyCount, 1)
  assert.equal(bot.status().state, 'stopped')
})

test('disabled config does not instantiate Client or connect', async () => {
  const { bot, tracker } = createHarness({ enabled: false })
  await bot.start()
  assert.equal(tracker.instances.length, 0)
  assert.equal(bot.status().state, 'stopped')
})

test('rejects DM, disallowed guild, disallowed channel, and unknown user before calling commandLayer', async () => {
  const { bot, tracker, commandLayer, audits } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  // 1. DM rejected (no guildId)
  const dm = makeSlashInteraction({ guildId: null, userId: 'user-control', subcommand: 'status' })
  await client.emitInteraction(dm)
  assert.equal(dm.replies.length, 1)
  assert.equal(dm.replies[0].content, 'You are not allowed to control AFK Desk.')
  assert.equal(dm.replies[0].ephemeral, true)
  assert.deepEqual(dm.replies[0].allowed_mentions, { parse: [] })

  // 2. Disallowed guild rejected
  const badGuild = makeSlashInteraction({ guildId: 'guild-other', userId: 'user-control', subcommand: 'status' })
  await client.emitInteraction(badGuild)
  assert.equal(badGuild.replies.length, 1)
  assert.equal(badGuild.replies[0].content, 'You are not allowed to control AFK Desk.')
  assert.equal(badGuild.replies[0].ephemeral, true)

  // 3. Disallowed channel rejected when channelIds is non-empty
  const badChan = makeSlashInteraction({ guildId: 'guild-1', channelId: 'chan-other', userId: 'user-control', subcommand: 'status' })
  await client.emitInteraction(badChan)
  assert.equal(badChan.replies.length, 1)
  assert.equal(badChan.replies[0].content, 'You are not allowed to control AFK Desk.')

  // 4. Unknown user rejected + audited
  const unknownUser = makeSlashInteraction({ guildId: 'guild-1', channelId: 'chan-1', userId: 'stranger-99', subcommand: 'connect', options: { account: 'acc-1' } })
  await client.emitInteraction(unknownUser)
  assert.equal(unknownUser.replies.length, 1)
  assert.equal(unknownUser.replies[0].content, 'You are not allowed to control AFK Desk.')
  assert.equal(unknownUser.replies[0].ephemeral, true)
  assert.deepEqual(unknownUser.replies[0].allowed_mentions, { parse: [] })

  // Command layer must NOT have been called for any of the above
  assert.equal(commandLayer.calls.length, 0)
  assert.equal(audits.length, 4)
  assert.deepEqual(audits[3], {
    actor: { kind: 'discord', id: 'stranger-99', scope: null },
    command: 'account.connect',
    result: 'forbidden'
  })
})

test('empty channelIds allows any channel in an allowed guild', async () => {
  const { bot, tracker, commandLayer } = createHarness({ channelIds: [] })
  await bot.start()
  const client = tracker.instances[0]

  const ix = makeSlashInteraction({
    guildId: 'guild-2',
    channelId: 'any-random-channel',
    userId: 'user-read',
    subcommand: 'status'
  })
  await client.emitInteraction(ix)
  assert.equal(commandLayer.calls.length, 1)
  assert.equal(ix.replies.length, 1)
  assert.match(ix.replies[0].content, /AlphaBot/)
})

test('role-based scope resolution picks max(users[userId], matching roles[roleId])', async () => {
  const { bot, tracker, commandLayer } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  // User not in users map, but has role-control
  const roleOnly = makeSlashInteraction({
    userId: 'role-member-1',
    memberRoles: ['role-unrelated', 'role-control'],
    subcommand: 'connect',
    options: { account: 'acc-1' }
  })
  await client.emitInteraction(roleOnly)
  assert.equal(commandLayer.calls.length, 1)
  assert.deepEqual(commandLayer.calls[0].actor, {
    kind: 'discord',
    id: 'role-member-1',
    scope: 'control'
  })

  // User in users map as 'read', but has 'role-admin' in roles.cache Map -> gets 'admin'
  const elevated = makeSlashInteraction({
    userId: 'user-read',
    memberRoles: { cache: new Map([['role-admin', { id: 'role-admin' }]]) },
    subcommand: 'reconnect',
    options: { account: 'acc-1' }
  })
  await client.emitInteraction(elevated)
  assert.equal(commandLayer.calls.length, 2)
  assert.deepEqual(commandLayer.calls[1].actor, {
    kind: 'discord',
    id: 'user-read',
    scope: 'admin'
  })
})

test('read user cannot run control commands: scope is forwarded and FORBIDDEN is surfaced politely', async () => {
  const { bot, tracker, commandLayer } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  const ix = makeSlashInteraction({
    userId: 'user-read',
    subcommand: 'connect',
    options: { account: 'acc-1' }
  })
  await client.emitInteraction(ix)

  assert.equal(commandLayer.calls.length, 1)
  assert.deepEqual(commandLayer.calls[0].actor, {
    kind: 'discord',
    id: 'user-read',
    scope: 'read'
  })
  assert.equal(commandLayer.calls[0].name, 'account.connect')
  assert.equal(ix.replies.length, 1)
  assert.equal(ix.replies[0].ephemeral, true)
  assert.match(ix.replies[0].content, /Permission denied/)
  assert.deepEqual(ix.replies[0].allowed_mentions, { parse: [] })
})

test('all 12 /afk subcommands route to their 1:1 COMMANDS entries with expected args', async () => {
  const { bot, tracker, commandLayer } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  const cases = [
    { subcommand: 'status', options: {}, expectedCmd: 'status', expectedArgs: {} },
    { subcommand: 'connect', options: { account: 'acc-1' }, expectedCmd: 'account.connect', expectedArgs: { accountId: 'acc-1' } },
    { subcommand: 'disconnect', options: { account: 'acc-1' }, expectedCmd: 'account.disconnect', expectedArgs: { accountId: 'acc-1' } },
    { subcommand: 'reconnect', options: { account: 'acc-1' }, expectedCmd: 'account.reconnect', expectedArgs: { accountId: 'acc-1' } },
    { subcommand: 'chat', options: { account: 'acc-1', message: 'hello world' }, expectedCmd: 'chat.send', expectedArgs: { accountId: 'acc-1', message: 'hello world' } },
    { subcommand: 'recent-chat', options: { account: 'acc-1', limit: 15 }, expectedCmd: 'chat.recent', expectedArgs: { accountId: 'acc-1', limit: 15 } },
    { subcommand: 'inventory', options: { account: 'acc-1' }, expectedCmd: 'inventory.view', expectedArgs: { accountId: 'acc-1' } },
    { subcommandGroup: 'macro', subcommand: 'run', options: { account: 'acc-1', macro: 'mac-1' }, expectedCmd: 'macro.run', expectedArgs: { accountId: 'acc-1', macroId: 'mac-1' } },
    { subcommandGroup: 'macro', subcommand: 'stop', options: { account: 'acc-1' }, expectedCmd: 'macro.stop', expectedArgs: { accountId: 'acc-1' } },
    { subcommand: 'antiafk', options: { account: 'acc-1', enabled: true }, expectedCmd: 'antiAfk.set', expectedArgs: { accountId: 'acc-1', enabled: true } },
    { subcommand: 'connect-all', options: {}, expectedCmd: 'connectAll', expectedArgs: {} },
    { subcommand: 'disconnect-all', options: {}, expectedCmd: 'disconnectAll', expectedArgs: {} }
  ]

  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i]
    // Use distinct users or advance time to avoid hitting the 10/10s flood limit
    const userId = i < 6 ? 'user-control' : 'user-admin'
    const ix = makeSlashInteraction({
      userId,
      subcommandGroup: c.subcommandGroup || null,
      subcommand: c.subcommand,
      options: c.options
    })
    await client.emitInteraction(ix)
    assert.equal(commandLayer.calls[i].name, c.expectedCmd)
    assert.deepEqual(commandLayer.calls[i].args, c.expectedArgs)
  }
})

test('confirm flow: buttons, wrong user rejected, expired rejected, confirmed executes, reused nonce rejected', async () => {
  const { bot, tracker, commandLayer, advanceTime } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  // 1. Trigger danger: 'confirm' command (disconnect)
  const disconnectIx = makeSlashInteraction({
    userId: 'user-control',
    subcommand: 'disconnect',
    options: { account: 'acc-1' }
  })
  await client.emitInteraction(disconnectIx)

  assert.equal(commandLayer.calls.length, 1)
  assert.equal(commandLayer.calls[0].confirmed, false)
  assert.equal(disconnectIx.replies.length, 1)

  const promptReply = disconnectIx.replies[0]
  assert.equal(promptReply.ephemeral, true)
  assert.ok(Array.isArray(promptReply.components))
  const buttons = promptReply.components[0].components
  assert.equal(buttons.length, 2)
  const confirmCustomId = buttons[0].customId
  const cancelCustomId = buttons[1].customId
  assert.match(confirmCustomId, /^afk_confirm:[a-f0-9]+$/)
  assert.match(cancelCustomId, /^afk_cancel:[a-f0-9]+$/)

  // 2. Wrong user tries to press Confirm -> rejected, nonce preserved
  const wrongUserBtn = makeButtonInteraction({
    userId: 'user-admin',
    customId: confirmCustomId
  })
  await client.emitInteraction(wrongUserBtn)
  assert.equal(wrongUserBtn.replies.length, 1)
  assert.equal(wrongUserBtn.replies[0].ephemeral, true)
  assert.match(wrongUserBtn.replies[0].content, /Only the user who initiated/)
  assert.equal(commandLayer.calls.length, 1)

  // 3. Original user presses Confirm -> calls execute(..., { confirmed: true })
  const confirmBtn = makeButtonInteraction({
    userId: 'user-control',
    customId: confirmCustomId
  })
  await client.emitInteraction(confirmBtn)
  assert.equal(commandLayer.calls.length, 2)
  assert.equal(commandLayer.calls[1].name, 'account.disconnect')
  assert.deepEqual(commandLayer.calls[1].args, { accountId: 'acc-1' })
  assert.equal(commandLayer.calls[1].confirmed, true)
  assert.equal(confirmBtn.replies.length, 1)
  assert.match(confirmBtn.replies[0].content, /Disconnected/)

  // 4. Reused nonce -> rejected
  const reusedBtn = makeButtonInteraction({
    userId: 'user-control',
    customId: confirmCustomId
  })
  await client.emitInteraction(reusedBtn)
  assert.equal(reusedBtn.replies.length, 1)
  assert.match(reusedBtn.replies[0].content, /expired or already used/i)
  assert.equal(commandLayer.calls.length, 2)

  // 5. Expired nonce test (after LIMITS.confirmTtlMs)
  const connectAllIx = makeSlashInteraction({
    userId: 'user-control',
    subcommand: 'connect-all'
  })
  await client.emitInteraction(connectAllIx)
  const expiredConfirmId = connectAllIx.replies[0].components[0].components[0].customId

  advanceTime(LIMITS.confirmTtlMs + 1)

  const expiredBtn = makeButtonInteraction({
    userId: 'user-control',
    customId: expiredConfirmId
  })
  await client.emitInteraction(expiredBtn)
  assert.equal(expiredBtn.replies.length, 1)
  assert.match(expiredBtn.replies[0].content, /expired/i)
  assert.equal(commandLayer.calls.length, 3) // no confirmed execute call
})

test('autocomplete filters by name prefix, limits to 25 choices, and rejects unauthorized users', async () => {
  const manyAccounts = Array.from({ length: 35 }, (_, idx) => ({
    id: `acc-${idx + 1}`,
    name: idx < 30 ? `MinerBot_${String(idx + 1).padStart(2, '0')}` : `Trader_${idx + 1}`
  }))
  const macros = [
    { id: 'm1', name: 'AutoFish' },
    { id: 'm2', name: 'AutoFarm' },
    { id: 'm3', name: 'GuardBase' }
  ]

  const { bot, tracker, commandLayer } = createHarness({}, { accounts: manyAccounts, macros })
  await bot.start()
  const client = tracker.instances[0]

  // 1. Account autocomplete with prefix 'miner' -> capped at 25
  const ac1 = makeAutocompleteInteraction({
    userId: 'user-read',
    focusedName: 'account',
    focusedValue: 'miner'
  })
  await client.emitInteraction(ac1)
  assert.equal(ac1.responses.length, 1)
  assert.equal(ac1.responses[0].length, 25)
  assert.ok(ac1.responses[0].every((c) => c.name.startsWith('MinerBot_')))

  // 2. Macro autocomplete passes accountId and filters by prefix 'auto'
  const ac2 = makeAutocompleteInteraction({
    userId: 'user-control',
    focusedName: 'macro',
    focusedValue: 'auto',
    options: { account: 'acc-7' }
  })
  await client.emitInteraction(ac2)
  assert.equal(ac2.responses.length, 1)
  assert.deepEqual(ac2.responses[0], [
    { name: 'AutoFish', value: 'm1' },
    { name: 'AutoFarm', value: 'm2' }
  ])
  assert.equal(commandLayer.macroCalls[0].accountId, 'acc-7')

  // 3. Unauthorized user gets empty autocomplete without calling commandLayer
  const prevAccountCalls = commandLayer.accountCalls.length
  const acUnauth = makeAutocompleteInteraction({
    userId: 'stranger',
    focusedName: 'account',
    focusedValue: ''
  })
  await client.emitInteraction(acUnauth)
  assert.deepEqual(acUnauth.responses[0], [])
  assert.equal(commandLayer.accountCalls.length, prevAccountCalls)
})

test('format.cjs escapes markdown, neutralizes mentions, strips § colours, renders code-block-free inventory, and truncates to 1900 chars', async () => {
  const dirty = '§cHello @everyone and <@123456> **bold** _ital_ ~strike~ `code` ||spoiler|| > quote [link](url) #heading - list'
  const escaped = escapeDiscordText(dirty)

  assert.ok(!escaped.includes('§'))
  assert.ok(escaped.includes('@\u200beveryone'))
  assert.ok(!escaped.includes('<@123456>'))
  assert.ok(escaped.includes('<@\u200b123456\\>'))
  assert.ok(escaped.includes('\\*\\*bold\\*\\*'))
  assert.ok(escaped.includes('\\`code\\`'))
  assert.ok(escaped.includes('\\|\\|spoiler\\|\\|'))
  assert.ok(escaped.includes('\\> quote'))
  assert.ok(escaped.includes('\\[link\\]\\(url\\)'))
  assert.ok(escaped.includes('\\#heading'))
  assert.ok(escaped.includes('\\- list'))

  // Inventory list has no unescaped code blocks
  const invRendered = formatInventory([
    { slot: 0, displayName: '§aEmerald `Block`', count: 64 },
    { slot: 1, displayName: 'Diamond *Pickaxe*', count: 1 }
  ])
  assert.ok(!invRendered.includes('```'))
  assert.ok(!/(?<!\\)`/.test(invRendered))
  assert.match(invRendered, /Emerald \\`Block\\` x64/)

  // Truncation to 1900 chars with ellipsis
  const longText = 'A'.repeat(2500)
  const truncated = truncateMessage(longText)
  assert.equal(truncated.length, 1900)
  assert.ok(truncated.endsWith('…'))
})

test('allowed_mentions is always { parse: [] } on replies and postNotification', async () => {
  const { bot, tracker } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  const ix = makeSlashInteraction({
    userId: 'user-read',
    subcommand: 'recent-chat',
    options: { account: 'acc-1' }
  })
  await client.emitInteraction(ix)
  assert.equal(ix.replies.length, 1)
  assert.deepEqual(ix.replies[0].allowed_mentions, { parse: [] })
  assert.ok(ix.replies[0].content.includes('@\u200beveryone'))
  assert.ok(!ix.replies[0].content.includes('<@123456>'))
  assert.ok(ix.replies[0].content.includes('<@\u200b123456\\>'))

  await bot.postNotification('Alert: @everyone §4Kicked from **server**!')
  assert.equal(tracker.sentMessages.length, 1)
  const notifyMsg = tracker.sentMessages[0]
  assert.equal(notifyMsg.channelId, 'chan-notify')
  assert.deepEqual(notifyMsg.payload.allowed_mentions, { parse: [] })
  assert.ok(notifyMsg.payload.content.includes('@\u200beveryone'))
  assert.ok(!notifyMsg.payload.content.includes('§4'))
})

test('bot token is never leaked in any reply, log, or status even when errors include the token', async () => {
  const { bot, tracker, logs } = createHarness(
    {},
    {
      customHandler: async () => {
        throw new Error(`Fatal failure with token ${FAKE_BOT_TOKEN} at stack line 1`)
      }
    }
  )

  await bot.start()
  const client = tracker.instances[0]

  const ix = makeSlashInteraction({
    userId: 'user-control',
    subcommand: 'status'
  })
  await client.emitInteraction(ix)

  // Generic ephemeral error, no stack trace, no token
  assert.equal(ix.replies.length, 1)
  assert.equal(ix.replies[0].ephemeral, true)
  assert.equal(ix.replies[0].content, 'An internal error occurred while processing the command.')
  assert.ok(!JSON.stringify(ix.replies).includes(FAKE_BOT_TOKEN))

  // Also test failed login containing token
  tracker.failLoginWithToken = true
  await bot.start()

  const statusSnapshot = bot.status()
  assert.ok(!JSON.stringify(statusSnapshot).includes(FAKE_BOT_TOKEN))
  assert.ok(!JSON.stringify(logs).includes(FAKE_BOT_TOKEN))
  assert.ok(!redactSecrets(`leaked ${FAKE_BOT_TOKEN}`).includes(FAKE_BOT_TOKEN))
})

test('per-user flood limit drops interactions beyond 10 per 10s with an ephemeral notice', async () => {
  const { bot, tracker, commandLayer, advanceTime } = createHarness()
  await bot.start()
  const client = tracker.instances[0]

  for (let i = 0; i < 10; i += 1) {
    const ix = makeSlashInteraction({ userId: 'user-control', subcommand: 'status' })
    await client.emitInteraction(ix)
    assert.equal(ix.replies.length, 1)
    assert.match(ix.replies[0].content, /AlphaBot/)
  }
  assert.equal(commandLayer.calls.length, 10)

  // 11th interaction within 10s is dropped before reaching commandLayer
  const eleventh = makeSlashInteraction({ userId: 'user-control', subcommand: 'status' })
  await client.emitInteraction(eleventh)
  assert.equal(commandLayer.calls.length, 10)
  assert.equal(eleventh.replies.length, 1)
  assert.equal(eleventh.replies[0].ephemeral, true)
  assert.match(eleventh.replies[0].content, /Too many requests/i)

  // After 10s window expires, user can interact again
  advanceTime(10_001)
  const afterWindow = makeSlashInteraction({ userId: 'user-control', subcommand: 'status' })
  await client.emitInteraction(afterWindow)
  assert.equal(commandLayer.calls.length, 11)
})
