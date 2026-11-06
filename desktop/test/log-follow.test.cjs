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
  view.scrollTop = 40; events.scroll()
  follow.render(() => { view.scrollHeight = 250 })
  assert.equal(view.scrollTop, 40); assert.equal(button.hidden, false)
  events.buttonclick(); assert.equal(view.scrollTop, 250); assert.equal(button.hidden, true)
  view.scrollTop = 0 // Reparenting can discard the browser's scroll position.
  frames.shift()()
  assert.equal(view.scrollTop, 250)
  follow.render(() => { view.scrollHeight = 300 })
  assert.equal(view.scrollTop, 300)
})
