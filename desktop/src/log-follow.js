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
    view.addEventListener('scroll', () => { state.scroll(view); update() })
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
