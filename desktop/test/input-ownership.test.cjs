'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager } = require('../electron/bot-manager.cjs')

// Timers the test fires by hand, so physics and repeat timers are deterministic.
class ManualTimers {
  constructor() { this.pending = [] }
  schedule = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    this.pending.push(timer)
    return timer
  }
  clear = (timer) => { if (timer) timer.cleared = true }
  active() { return this.pending.filter((timer) => !timer.cleared) }
  fire(delay) {
    const timer = this.active().find((entry) => entry.delay === delay)
    assert.ok(timer, `no active timer with delay ${delay}`)
    timer.cleared = true
    timer.callback()
  }
}

function fakeBot() {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.inventory = new EventEmitter()
  bot.inventory.items = () => []
  bot.inventory.slots = []
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  bot.quickBarSlot = 0
  bot.controls = []
  bot.calls = []
  bot.setControlState = (control, state) => bot.controls.push([control, state])
  bot.stopDigging = () => bot.calls.push('stopDigging')
  bot.deactivateItem = () => bot.calls.push('deactivateItem')
  bot.activateItem = () => bot.calls.push('activateItem')
  bot.quit = () => bot.emit('end')
  return bot
}

function setup(t, account = {}) {
  const bot = fakeBot()
  const timers = new ManualTimers()
  const manager = new BotManager({
    profilesPath: 'profiles', emit: () => {}, createBot: () => bot,
    scheduleAntiAfkTimer: timers.schedule, clearAntiAfkTimer: timers.clear
  })
  manager.connect({ id: 'a', username: 'u', host: 'localhost', antiAfk: false, autoReconnect: false, ...account })
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, velocity: { x: 0, y: 0, z: 0 } }
  t.after(() => manager.disconnect('a'))
  return { manager, bot, timers, session: manager.sessions.get('a') }
}

const pressed = (bot, control) => bot.controls.filter(([name]) => name === control).at(-1)?.[1] === true
const settle = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test('two owners share one input: it stays pressed until both release', (t) => {
  const { manager, bot } = setup(t)
  manager.claimInput('a', 'sneak', 'macro:1')
  manager.claimInput('a', 'sneak', 'antiAfk')
  assert.deepEqual(bot.controls, [['sneak', true]], 'pressed once, on the first claim')
  manager.releaseInput('a', 'sneak', 'macro:1')
  assert.equal(pressed(bot, 'sneak'), true)
  assert.deepEqual(manager.inputOwners('a', 'sneak'), ['antiAfk'])
  manager.releaseInput('a', 'sneak', 'antiAfk')
  assert.deepEqual(bot.controls.at(-1), ['sneak', false])
  assert.deepEqual(manager.inputOwners('a', 'sneak'), [])
})

test('an owner can only release its own claim, and claiming twice is a single claim', (t) => {
  const { manager, bot } = setup(t)
  manager.claimInput('a', 'jump', 'macro:1')
  manager.claimInput('a', 'jump', 'macro:1')
  manager.releaseInput('a', 'jump', 'macro:2')
  assert.equal(pressed(bot, 'jump'), true)
  manager.releaseInput('a', 'jump', 'macro:1')
  assert.equal(pressed(bot, 'jump'), false)
  assert.equal(bot.controls.filter(([name]) => name === 'jump').length, 2)
})

test('releaseOwner releases that owner on every input and leaves other owners alone', (t) => {
  const { manager, bot } = setup(t)
  manager.claimInput('a', 'forward', 'macro:1')
  manager.claimInput('a', 'sneak', 'macro:1')
  manager.claimInput('a', 'sneak', 'manual')
  manager.releaseOwner('a', 'macro:1')
  assert.equal(pressed(bot, 'forward'), false)
  assert.equal(pressed(bot, 'sneak'), true)
  assert.deepEqual(manager.inputOwners('a', 'sneak'), ['manual'])
  manager.releaseOwner('missing-account', 'macro:1')
})

test('claimInput validates the input name and the owner', (t) => {
  const { manager } = setup(t)
  assert.throws(() => manager.claimInput('a', 'fly', 'macro:1'), /Unknown input/)
  assert.throws(() => manager.claimInput('a', 'jump', ''), /owner is required/)
  assert.throws(() => manager.claimInput('nobody', 'jump', 'macro:1'), /not online/)
})

// ---------------------------------------------------------------------------
// Physics follows movement claims of any owner
// ---------------------------------------------------------------------------

for (const owner of ['manual', 'macro:1', 'antiAfk']) {
  test(`a ${owner} movement claim turns physics on for a physics-paused bot and restores it after release`, (t) => {
    const { manager, bot, timers } = setup(t, { environmentalMovement: false })
    assert.equal(bot.physicsEnabled, false)
    manager.claimInput('a', 'forward', owner)
    assert.equal(bot.physicsEnabled, true)
    manager.releaseInput('a', 'forward', owner)
    assert.equal(bot.physicsEnabled, true, 'physics lingers briefly after the last release')
    timers.fire(200)
    assert.equal(bot.physicsEnabled, false)
  })
}

test('physics stays on while any movement claim is held, even after another owner released', (t) => {
  const { manager, bot, timers } = setup(t, { environmentalMovement: false })
  manager.claimInput('a', 'forward', 'macro:1')
  manager.claimInput('a', 'sneak', 'manual')
  manager.releaseInput('a', 'sneak', 'manual')
  assert.equal(timers.active().length, 0, 'no restore is scheduled while the macro still moves')
  assert.equal(bot.physicsEnabled, true)
  manager.releaseInput('a', 'forward', 'macro:1')
  timers.fire(200)
  assert.equal(bot.physicsEnabled, false)
})

test('a pending physics restore never switches physics off under a newer claim', (t) => {
  const { manager, bot, timers } = setup(t, { environmentalMovement: false })
  manager.claimInput('a', 'jump', 'macro:1')
  manager.releaseInput('a', 'jump', 'macro:1')
  const restore = timers.active().find((timer) => timer.delay === 200)
  manager.claimInput('a', 'forward', 'macro:2')
  assert.equal(restore.cleared, true)
  restore.callback()
  assert.equal(bot.physicsEnabled, true)
})

test('click claims leave physics alone', (t) => {
  const { manager, bot, timers } = setup(t, { environmentalMovement: false })
  manager.worldAction = async () => ({})
  manager.claimInput('a', 'rightClick', 'macro:1')
  manager.releaseInput('a', 'rightClick', 'macro:1')
  assert.equal(bot.physicsEnabled, false)
  assert.equal(timers.active().length, 0)
})

// ---------------------------------------------------------------------------
// Manual controls and anti-AFK keep their behaviour
// ---------------------------------------------------------------------------

test('manual setControlState and control use the manual owner and keep the timer behaviour', (t) => {
  const { manager, bot, timers } = setup(t)
  manager.setControlState('a', 'forward', true)
  assert.deepEqual(manager.inputOwners('a', 'forward'), ['manual'])
  manager.control('a', 'back', 300)
  assert.equal(pressed(bot, 'back'), true)
  timers.fire(300)
  assert.equal(pressed(bot, 'back'), false)
  assert.deepEqual(manager.inputOwners('a', 'back'), [])
  manager.setControlState('a', 'forward', false)
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
  assert.throws(() => manager.setControlState('a', 'fly', true), /Unknown movement control/)
  assert.throws(() => manager.setControlState('a', 'forward', 'yes'), /true or false/)
})

test('a manual release does not cancel a macro hold, but a stray release still clears the key', (t) => {
  const { manager, bot } = setup(t)
  manager.claimInput('a', 'sneak', 'macro:1')
  manager.setControlState('a', 'sneak', false)
  assert.equal(pressed(bot, 'sneak'), true)
  manager.releaseOwner('a', 'macro:1')

  bot.controls.length = 0
  manager.setControlState('a', 'jump', false)
  assert.deepEqual(bot.controls, [['jump', false]])
})

test('anti-AFK holds go through the antiAfk owner and a manual release leaves them alone', (t) => {
  const { manager, bot, session } = setup(t)
  session.antiAfkSettings = { duration: 0.5, jump: true, look: false, sneak: false, swing: false, walk: false }
  manager.runAntiAfkCycle('a')
  assert.deepEqual(manager.inputOwners('a', 'jump'), ['antiAfk'])
  manager.setControlState('a', 'jump', false)
  assert.deepEqual(manager.inputOwners('a', 'jump'), ['antiAfk'])
  const hold = [...session.antiAfkActionTimers][0]
  hold.callback()
  assert.deepEqual(manager.inputOwners('a', 'jump'), [])
  assert.deepEqual(bot.controls.at(-1), ['jump', false])
})

test('changing anti-AFK settings releases only the antiAfk claims', (t) => {
  const { manager, bot, session } = setup(t)
  session.antiAfkSettings = { duration: 0.5, jump: true, look: false, sneak: false, swing: false, walk: false }
  manager.claimInput('a', 'forward', 'macro:1')
  manager.runAntiAfkCycle('a')
  manager.setAntiAfk('a', { antiAfk: false })
  assert.deepEqual(manager.inputOwners('a', 'jump'), [])
  assert.deepEqual(manager.inputOwners('a', 'forward'), ['macro:1'])
  assert.equal(pressed(bot, 'forward'), true)
})

test('anti-AFK is paused while a macro holds movement and resumes afterwards', (t) => {
  const { manager, bot, session } = setup(t)
  session.antiAfkSettings = { duration: 0.5, jump: true, look: false, sneak: false, swing: false, walk: false }
  manager.claimInput('a', 'forward', 'macro:1')
  manager.runAntiAfkCycle('a')
  assert.deepEqual(manager.inputOwners('a', 'jump'), [])
  assert.deepEqual(bot.controls, [['forward', true]])
  manager.releaseOwner('a', 'macro:1')
  manager.runAntiAfkCycle('a')
  assert.deepEqual(manager.inputOwners('a', 'jump'), ['antiAfk'])
})

test('a manual hold does not pause anti-AFK', (t) => {
  const { manager, session } = setup(t)
  session.antiAfkSettings = { duration: 0.5, jump: true, look: false, sneak: false, swing: false, walk: false }
  manager.setControlState('a', 'forward', true)
  manager.runAntiAfkCycle('a')
  assert.deepEqual(manager.inputOwners('a', 'jump'), ['antiAfk'])
})

// ---------------------------------------------------------------------------
// Held clicks and session teardown
// ---------------------------------------------------------------------------

test('a held left click digs repeatedly and release stops the dig and its repeat timer', async (t) => {
  const { manager, bot, timers } = setup(t)
  const actions = []
  manager.worldAction = async (id, action) => { actions.push(action) }
  manager.claimInput('a', 'leftClick', 'macro:1')
  manager.claimInput('a', 'leftClick', 'macro:2')
  await settle()
  assert.deepEqual(actions, ['dig-crosshair'])
  timers.fire(100)
  await settle()
  assert.deepEqual(actions, ['dig-crosshair', 'dig-crosshair'])
  manager.releaseInput('a', 'leftClick', 'macro:1')
  assert.equal(timers.active().length, 1, 'still held by the second owner')
  manager.releaseInput('a', 'leftClick', 'macro:2')
  assert.deepEqual(actions.at(-1), 'stop-dig')
  assert.equal(timers.active().length, 0)
  assert.deepEqual(bot.controls, [], 'clicks never touch the movement keys')
})

test('a held right click uses the item once and release stops using it', async (t) => {
  const { manager, bot } = setup(t)
  manager.claimInput('a', 'rightClick', 'macro:1')
  assert.deepEqual(bot.calls, ['activateItem'])
  manager.releaseInput('a', 'rightClick', 'macro:1')
  await settle()
  assert.deepEqual(bot.calls, ['activateItem', 'deactivateItem'])
})

test('clearing the session drops every claim and repeat timer', async (t) => {
  const { manager, session, timers } = setup(t)
  manager.worldAction = async () => ({})
  manager.claimInput('a', 'forward', 'macro:1')
  manager.claimInput('a', 'leftClick', 'macro:1')
  await settle()
  assert.equal(timers.active().length, 1)
  manager.disconnect('a')
  assert.equal(session.inputClaims.size, 0)
  assert.equal(session.inputActionTimers.size, 0)
  assert.equal(timers.active().length, 0)
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
  manager.releaseInput('a', 'forward', 'macro:1')
})

// ---------------------------------------------------------------------------
// worldAction('walk')
// ---------------------------------------------------------------------------

// Fake time: advances Date.now and timers together in 50 ms polls, with the bot moving
// `blocksPerPoll` along x while the forward key is held.
async function advanceWalk(t, bot, { polls, blocksPerPoll }) {
  for (let poll = 0; poll < polls; poll += 1) {
    if (bot.controls.at(-1)?.[1] === true) bot.entity.position.x += blocksPerPoll
    t.mock.timers.tick(50)
    await settle()
  }
}

function walkSetup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  return setup(t)
}

test('walk resolves once the distance is covered and releases its claim', async (t) => {
  const { manager, bot } = walkSetup(t)
  const walking = manager.worldAction('a', 'walk', { control: 'forward', distance: 3, owner: 'macro:1' })
  walking.catch(() => {})
  await settle()
  assert.deepEqual(manager.inputOwners('a', 'forward'), ['macro:1'])
  await advanceWalk(t, bot, { polls: 20, blocksPerPoll: 0.2 })
  assert.deepEqual(await walking, { distance: 3 })
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
  assert.deepEqual(bot.controls.at(-1), ['forward', false])
})

test('walk against a wall gives up after the bot stops making progress', async (t) => {
  const { manager, bot } = walkSetup(t)
  const walking = manager.worldAction('a', 'walk', { control: 'forward', distance: 50, owner: 'macro:1' })
  const outcome = walking.then(() => 'resolved', (error) => error)
  await settle()
  await advanceWalk(t, bot, { polls: 20, blocksPerPoll: 0.2 })
  await advanceWalk(t, bot, { polls: 38, blocksPerPoll: 0 })
  assert.equal(await Promise.race([outcome, settle().then(() => 'still walking')]), 'still walking', 'not yet 2 s without progress')
  await advanceWalk(t, bot, { polls: 4, blocksPerPoll: 0 })
  const error = await outcome
  assert.equal(error.code, 'TIMEOUT')
  assert.match(error.message, /not moving/)
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
})

test('walk against a wall that does not move at all also times out after two seconds', async (t) => {
  const { manager, bot } = walkSetup(t)
  const outcome = manager.worldAction('a', 'walk', { control: 'forward', distance: 1, owner: 'macro:1' }).then(() => 'resolved', (error) => error)
  await settle()
  await advanceWalk(t, bot, { polls: 41, blocksPerPoll: 0 })
  assert.equal((await outcome).code, 'TIMEOUT')
})

test('walk is capped by the distance-based time limit when progress is too slow to finish', async (t) => {
  const { manager, bot } = walkSetup(t)
  // 10 blocks allow 5000 ms; 0.05 blocks per poll keeps moving but cannot finish in time.
  const outcome = manager.worldAction('a', 'walk', { control: 'forward', distance: 10, owner: 'macro:1' }).then(() => 'resolved', (error) => error)
  await settle()
  await advanceWalk(t, bot, { polls: 98, blocksPerPoll: 0.05 })
  assert.equal(await Promise.race([outcome, settle().then(() => 'still walking')]), 'still walking')
  await advanceWalk(t, bot, { polls: 4, blocksPerPoll: 0.05 })
  const error = await outcome
  assert.equal(error.code, 'TIMEOUT')
  assert.match(error.message, /too long/)
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
})

test('walk stops with ABORTED when the signal fires and releases its claim', async (t) => {
  const { manager, bot } = walkSetup(t)
  const controller = new AbortController()
  const outcome = manager.worldAction('a', 'walk', { control: 'forward', distance: 5, owner: 'macro:1', signal: controller.signal }).then(() => 'resolved', (error) => error)
  await settle()
  controller.abort()
  await advanceWalk(t, bot, { polls: 1, blocksPerPoll: 0 })
  assert.equal((await outcome).code, 'ABORTED')
  assert.deepEqual(manager.inputOwners('a', 'forward'), [])
})

test('walk stops with SESSION_CHANGED when the account session is replaced', async (t) => {
  const { manager, bot } = walkSetup(t)
  const outcome = manager.worldAction('a', 'walk', { control: 'forward', distance: 5, owner: 'macro:1' }).then(() => 'resolved', (error) => error)
  await settle()
  manager.sessions.delete('a')
  await advanceWalk(t, bot, { polls: 1, blocksPerPoll: 0 })
  assert.equal((await outcome).code, 'SESSION_CHANGED')
})

test('walk validates its arguments before pressing anything', async (t) => {
  const { manager, bot } = setup(t)
  for (const bad of [{ control: 'jump', distance: 1, owner: 'o' }, { control: 'forward', distance: 0, owner: 'o' }, { control: 'forward', distance: 1 }]) {
    await assert.rejects(manager.worldAction('a', 'walk', bad), /movement control, positive distance/)
  }
  assert.deepEqual(bot.controls, [])
})
