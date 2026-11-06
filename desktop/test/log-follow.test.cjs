const test = require('node:test')
const assert = require('node:assert/strict')
const { atBottom, createFollowState, attach } = require('../src/log-follow.js')

test('following resumes at the bottom with a small rounding tolerance', () => {
  const state = createFollowState()
  assert.equal(state.following, true)
  assert.equal(state.scroll({ scrollTop: 50, scrollHeight: 200, clientHeight: 100 }), false)
  assert.equal(atBottom({ scrollTop: 99, scrollHeight: 200, clientHeight: 100 }), true)
  assert.equal(state.scroll({ scrollTop: 100, scrollHeight: 200, clientHeight: 100 }), true)
})

test('updates preserve history position and jump resumes following after layout', () => {
  const events = {}, frames = []
  const view = { scrollTop: 100, scrollHeight: 200, clientHeight: 100, addEventListener: (name, fn) => { events[name] = fn } }
  const button = { addEventListener: (name, fn) => { events['button' + name] = fn } }
  const follow = attach(view, button, fn => frames.push(fn))
  events.wheel(); view.scrollTop = 40; events.scroll()
  follow.render(() => { view.scrollHeight = 250 })
  assert.equal(view.scrollTop, 40); assert.equal(button.hidden, false)
  events.buttonclick(); assert.equal(view.scrollTop, 250); assert.equal(button.hidden, true)
  view.scrollTop = 0 // Reparenting can discard the browser's scroll position.
  frames.shift()()
  assert.equal(view.scrollTop, 250)
  follow.render(() => { view.scrollHeight = 300 })
  assert.equal(view.scrollTop, 300)
})

test('programmatic scroll resets (re-render, re-parenting) never stop following', () => {
  const events = {}
  const view = { scrollTop: 0, scrollHeight: 400, clientHeight: 100, addEventListener: (name, fn) => { events[name] = fn } }
  const button = { addEventListener: (name, fn) => { events['button' + name] = fn } }
  const follow = attach(view, button, () => {})
  view.scrollTop = 0; events.scroll() // browser reset with no user input
  assert.equal(follow.state.following, true)
  assert.equal(view.scrollTop, 400)
  assert.equal(button.hidden, true)
  events.wheel(); view.scrollTop = 50; events.scroll() // the user scrolls up
  assert.equal(follow.state.following, false)
  assert.equal(button.hidden, false)
})
