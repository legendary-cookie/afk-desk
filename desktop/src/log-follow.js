'use strict'
;(function (root) {
  function atBottom({ scrollTop, scrollHeight, clientHeight }, tolerance = 2) {
    return scrollHeight - clientHeight - scrollTop <= tolerance
  }
  function createFollowState() {
    let following = true
    return {
      get following() { return following },
      scroll(metrics) { following = atBottom(metrics); return following },
      reset() { following = true }
    }
  }
  function attach(view, button, schedule = requestAnimationFrame) {
    const state = createFollowState()
    let generation = 0
    function update() { button.hidden = state.following }
    function bottom() { view.scrollTop = view.scrollHeight; update() }
    function reset() { state.reset(); bottom(); const current = ++generation; schedule(() => { if (current === generation && state.following) bottom() }) }
    // Only a scroll the user caused (wheel, touch, scrollbar drag, keys) may stop following.
    // Programmatic resets (re-render, re-parenting, layout changes) must never unpin the view.
    let userIntentUntil = 0
    const intent = () => { userIntentUntil = Date.now() + 1000 }
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) view.addEventListener(type, intent, { passive: true })
    view.addEventListener('scroll', () => {
      if (Date.now() <= userIntentUntil) state.scroll(view)
      else if (state.following) view.scrollTop = view.scrollHeight
      update()
    })
    button.addEventListener('click', reset)
    if (typeof ResizeObserver === 'function') {
      let width, height
      new ResizeObserver(entries => {
        const rect = entries[0].contentRect
        if (width !== undefined && (width !== rect.width || height !== rect.height)) reset()
        width = rect.width; height = rect.height
      }).observe(view)
    }
    update()
    return { state, reset, render(change) {
      const follow = state.following, top = view.scrollTop
      change()
      if (follow) bottom(); else { view.scrollTop = top; update() }
    } }
  }
  const api = { atBottom, createFollowState, attach }
  if (typeof module !== 'undefined') module.exports = api
  else root.afkLogFollow = api
})(typeof window === 'undefined' ? globalThis : window)
