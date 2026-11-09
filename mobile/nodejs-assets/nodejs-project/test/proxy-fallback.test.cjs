'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager } = require('../bot-manager.cjs')
const hud = require('../hud.cjs')
const { hasRaid, pickConsumable } = require('../safety.cjs')

function fixture(t, account = {}) {
  let now = 1_000_000
  const timers = new Map()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(global, 'setTimeout', (callback, delay = 0) => {
    const timer = { callback, at: now + delay, unref() {} }; timers.set(timer, timer); return timer
  })
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer))
  t.mock.method(global, 'setInterval', () => ({ unref() {} }))
  t.mock.method(global, 'clearInterval', () => {})
  const tick = ms => {
    const end = now + ms
    for (let n = 0; n < 10000; n++) {
      const next = [...timers.values()].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) { now = end; return }
      now = next.at; timers.delete(next); next.callback()
    }
    throw new Error('Timers did not settle')
  }
  const bot = new EventEmitter()
  Object.assign(bot, { username: 'Player', health: 20, food: 20, game: {dimension: 'overworld'}, players: {},
    inventory: new EventEmitter(), _client: new EventEmitter(), messages: [] })
  bot.inventory.items = () => []; bot.inventory.slots = []
  bot._client.write = () => {}
  bot.chat = message => bot.messages.push({ message, at: now })
  bot.quit = () => bot.emit('end', 'quit')
  const events = []
  const manager = new BotManager({ profilesPath: 'profiles', emit: (...event) => events.push(event), createBot: () => bot })
  manager.connect({ id: 'proxy', username: 'fixture', host: 'play.veridianmc.net', antiAfk: false, autoReconnect: false,
    messageDelay: 0, serverChangeMessage: '/server towny', serverChangeRetryMinutes: 1, ...account })
  bot.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 } }
  bot.emit('spawn'); bot.emit('health')
  t.after(() => { manager.disconnect('proxy'); t.mock.restoreAll() })
  return { bot, manager, events, tick, session: manager.sessions.get('proxy') }
}
const kick = 'You were kicked from towny: An internal server connection error occurred.'

test('Veridian fallback chat rejoins every account, retries indefinitely with cooldown and backoff, then confirms', t => {
  const { bot, manager, session, tick, events } = fixture(t)
  bot.emit('messagestr', kick)
  bot.emit('messagestr', 'You are now AFK.')
  tick(0)
  assert.deepEqual(bot.messages.map(entry => entry.message), ['/server towny'])
  manager.emitTelemetry('proxy')
  assert.match(events.filter(([type]) => type === 'status').at(-1)[2].detail, /^Rejoining towny \(attempt 1, next in 20s\)$/)
  assert.match(events.filter(([type]) => type === 'telemetry').at(-1)[2].safetyStatus, /^Rejoining towny/)
  for (const wait of [60_000, 60_000, 60_000, 120_000, 300_000, 300_000]) {
    const sent = bot.messages.length
    bot.emit('messagestr', kick)
    // Repeated chat, tab updates and same-dimension respawns must not bypass backoff.
    bot.emit('messagestr', kick)
    bot.emit('respawn'); bot.emit('health')
    bot._client.emit('playerlist_header', {header: 'Lobby', footer: 'AFK'})
    tick(wait - 1)
    assert.equal(bot.messages.length, sent)
    tick(1)
    assert.equal(bot.messages.length, sent + 1)
  }
  assert.equal(session.serverChangeRetryAttempts, 7)
  assert.ok(bot.messages.every((entry, index) => index === 0 || entry.at - bot.messages[index - 1].at >= 60_000))
  bot.emit('messagestr', 'Welcome to towny, Player!')
  assert.equal(session.serverChangeRetryTimer, null)
  assert.equal(session.pendingMessageConfirmation, null)
  tick(6 * 60 * 60_000)
  assert.equal(bot.messages.length, 7)
  assert.equal(manager.rejoinStatus(session), '')
})

test('no kick for twenty seconds confirms quietly; a later kick schedules after the command cooldown', t => {
  const { bot, session, tick } = fixture(t)
  bot.emit('messagestr', kick); tick(0)
  tick(19_999); assert.ok(session.pendingMessageConfirmation)
  tick(1); assert.equal(session.pendingMessageConfirmation, null)
  bot.emit('messagestr', kick); tick(39_999)
  assert.equal(bot.messages.length, 1)
  tick(1); assert.equal(bot.messages.length, 2)
})

for (const confirmation of ['You are already connected to this server!', 'Connecting you to towny', 'Welcome to towny!']) {
  test(`confirmation during retry backoff cancels sends: ${confirmation}`, t => {
    const { bot, session, tick } = fixture(t)
    bot.emit('messagestr', kick); tick(0); bot.emit('messagestr', kick)
    assert.ok(session.serverChangeRetryTimer)
    bot.emit('messagestr', confirmation)
    tick(600_000)
    assert.equal(bot.messages.length, 1)
    assert.equal(session.serverChangeRetryMessage, '')
  })
}

for (const event of ['login', 'respawn', 'packet-login', 'packet-respawn']) {
  test(`same-dimension ${event} starts a server-change command`, t => {
    const { bot, tick } = fixture(t)
    if (event.startsWith('packet-')) bot._client.emit(event.slice(7), {dimension: 'overworld'})
    else if (event === 'tab') bot._client.emit('playerlist_header', {header: 'Lobby', footer: 'AFK'})
    else if (event === 'scoreboard') bot._client.emit('scoreboard_objective', {action: 2, name: 'sidebar', displayText: 'Lobby'})
    else bot.emit(event)
    bot.emit('health'); tick(0)
    assert.equal(bot.messages.length, 1)
  })
}

for (const event of ['tab', 'scoreboard']) {
  test(`${event} text changes alone never send a server-change command`, t => {
    const { bot, tick } = fixture(t)
    for (let i = 0; i < 5; i++) {
      if (event === 'tab') bot._client.emit('playerlist_header', {header: 'Lobby', footer: `Online ${i}`})
      else bot._client.emit('scoreboard_objective', {action: 2, name: 'sidebar', displayText: `Lobby ${i}`})
      tick(120_000)
    }
    assert.equal(bot.messages.length, 0)
  })
}

for (const message of ['You were sent to lobby', 'Server towny restart', 'Server towny closed', 'Server towny down', 'Connection error', 'Could not connect to a default or fallback server', 'Lost connection to towny']) {
  test(`default kick pattern handles ${message}`, t => {
    const { bot, tick } = fixture(t)
    bot.emit('messagestr', message.toUpperCase()); tick(0)
    assert.equal(bot.messages.length, 1)
  })
}

test('custom kick pattern and malformed pattern fallback are supported', t => {
  const { bot, manager, tick } = fixture(t, { serverChangeKickPattern: 'backend unavailable' })
  bot.emit('messagestr', 'BACKEND UNAVAILABLE'); tick(0)
  assert.equal(bot.messages.length, 1)
  bot.emit('messagestr', 'Connecting you to towny')
  manager.sessions.get('proxy').account.serverChangeKickPattern = '['
  bot.emit('messagestr', kick); tick(60_000)
  assert.equal(bot.messages.length, 2)
})

test('disconnect cancels queued commands and retries, including callbacks from the old session', t => {
  const { bot, manager, tick } = fixture(t)
  bot.emit('messagestr', kick); tick(0); bot.emit('messagestr', kick)
  manager.disconnect('proxy')
  bot.emit('messagestr', kick); bot.emit('respawn'); bot._client.emit('login', {})
  tick(600_000)
  assert.equal(bot.messages.length, 1)
})

function barBot() {
  const bot = new EventEmitter(); bot._client = new EventEmitter(); bot.game = {dimension: 'overworld'}
  const cached = [{entityUUID: 'raid', title: {translate: 'event.minecraft.raid'}, health: .5}]
  // Reproduce Mineflayer's read-only cache, which keeps old bars across worlds.
  Object.defineProperty(bot, 'bossBars', {get: () => cached})
  hud.installHud(bot, () => {})
  return bot
}
test('stale raid bars expire after ninety seconds in safety and HUD, allowing Ominous Bottles', t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now)
  const bot = barBot(); const bottle = {name: 'ominous_bottle', slot: 36}
  bot.health = 20; bot.inventory = {items: () => [bottle]}
  assert.equal(hasRaid(bot), true)
  assert.equal(pickConsumable({autoOminousBottle: true}, bot), null)
  now += 89_999; assert.equal(hasRaid(bot), true)
  now++; assert.equal(hasRaid(bot), false)
  assert.equal(hud.snapshot(bot).bossBars.length, 0)
  assert.equal(pickConsumable({autoOminousBottle: true}, bot), bottle)
  bot.emit('bossBarUpdated', bot.bossBars[0])
  assert.equal(hasRaid(bot), true)
  assert.equal(hud.snapshot(bot).bossBars.length, 1)
})

test('boss-bar expiry can be configured and all update actions refresh lastUpdated', t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now)
  const bot = new EventEmitter(); bot._client = new EventEmitter(); bot.bossBars = []
  hud.installBossBarTracking(bot, () => {}, {staleMs: 500})
  bot._client.emit('boss_bar', {action: 0, entityUUID: 'raid', title: 'Raid', health: .5})
  for (const action of [2, 3, 4, 5]) {
    now += 499
    bot._client.emit('boss_bar', {action, entityUUID: 'raid'})
    assert.equal(hasRaid(bot), true)
  }
  now += 500; assert.equal(hasRaid(bot), false)
})

for (const event of ['respawn', 'login', 'start_configuration', 'dimension']) {
  test(`boss bars clear on ${event} without resurrecting the Mineflayer cache`, () => {
    const bot = barBot()
    if (event === 'dimension') { bot.game.dimension = 'nether'; bot.emit('game') }
    else if (event === 'start_configuration') bot._client.emit(event, {})
    else { bot.emit(event); bot._client.emit(event, {}) }
    assert.equal(hasRaid(bot), false)
    assert.equal(hud.snapshot(bot).bossBars.length, 0)
    bot.emit('bossBarUpdated', bot.bossBars[0])
    assert.equal(hasRaid(bot), false)
  })
}
for (const event of ['bossBarDeleted', 'boss_bar', 'bossbar', 'boss_bar_update']) {
  test(`boss-bar removal works via ${event}`, () => {
    const bot = barBot()
    if (event === 'bossBarDeleted') bot.emit(event, bot.bossBars[0])
    else bot._client.emit(event, {entityUUID: 'raid', action: 1})
    assert.equal(hasRaid(bot), false)
    assert.equal(hud.snapshot(bot).bossBars.length, 0)
  })
}


test('synchronous proxy confirmation and send failures do not leave a stuck rejoin', t => {
  const { bot, session, tick } = fixture(t)
  bot.chat = () => { throw new Error('write failed') }
  bot.emit('messagestr', kick); tick(0)
  assert.ok(session.serverChangeRetryTimer)
  bot.chat = () => bot.emit('messagestr', 'Connecting you to towny')
  tick(60_000)
  assert.equal(session.serverChangeRetryMessage, '')
  assert.equal(session.pendingMessageConfirmation, null)
})

test('target confirmation uses whole server names and escapes regex characters', t => {
  const { bot, session, tick } = fixture(t, {serverChangeMessage: '/server towny.test'})
  bot.emit('messagestr', kick); tick(0)
  for (const line of ['Welcome to nottowny.test', 'Welcome to townyXtest', 'Connecting you to towny.test2']) {
    bot.emit('messagestr', line)
    assert.ok(session.pendingMessageConfirmation)
  }
  bot.emit('messagestr', 'Welcome to towny.test!')
  assert.equal(session.pendingMessageConfirmation, null)
})

test('confirmation removes a cooldown-deferred command from upcoming runs', t => {
  const { bot, manager, tick } = fixture(t)
  bot.emit('messagestr', kick); tick(0); tick(20_000)
  bot.emit('messagestr', kick); tick(0)
  assert.equal(manager.getUpcomingRuns('proxy').length, 1)
  bot.emit('messagestr', 'You are already connected to this server!')
  assert.deepEqual(manager.getUpcomingRuns('proxy'), [])
  tick(60_000)
  assert.equal(bot.messages.length, 1)
})

test('a stale rejoin state with nothing pending never blocks the next kick', t => {
  const { bot, tick, session } = fixture(t)
  session.serverChangeRetryMessage = session.account.serverChangeMessage
  session.pendingMessageConfirmation = null; session.serverChangeRetryTimer = null; session.messageConfirmationTimer = null
  session.queuedServerSwitches?.clear?.()
  bot.emit('messagestr', 'You were kicked from towny: An internal server connection error occurred.'); tick(0)
  assert.equal(bot.messages.length, 1)
})
