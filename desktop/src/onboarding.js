(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.afkOnboarding = factory()
})(typeof window === 'undefined' ? globalThis : window, function () {
  const steps = [
    { title: 'Add an account', copy: 'Choose Add account to set up your Minecraft identity.', target: 'add-account' },
    { title: 'Add a server profile', copy: 'In Add account, enter a profile name and server address, then save it.', target: 'add-account' },
    { title: 'Start your bot', copy: 'Select your saved profile and choose Connect to start the bot.', target: 'connection-button', fallback: 'add-account' },
    { title: 'Open POV', copy: 'Select a profile and choose POV to see your bot’s view.', target: 'open-pov', fallback: 'add-account' },
    { title: 'Set up notifications', copy: 'Open Settings to enable desktop alerts or configure Discord and Telegram notifications.', target: 'open-settings' }
  ]
  function create({ document, window, save, onError }) {
    const get = id => document.getElementById(id)
    const overlay = get('onboarding'), highlight = get('onboarding-highlight')
    const next = get('onboarding-next'), back = get('onboarding-back'), dismiss = get('onboarding-dismiss')
    let index = 0, previousFocus, closing = false
    function render() {
      const step = steps[index]
      get('onboarding-title').textContent = step.title
      get('onboarding-copy').textContent = step.copy
      get('onboarding-progress').textContent = `Step ${index + 1} of ${steps.length}`
      back.disabled = index === 0
      next.textContent = index === steps.length - 1 ? 'Finish' : 'Next'
      let target = get(step.target)
      if (!target || !target.getClientRects().length) target = get(step.fallback)
      if (!target || !target.getClientRects().length) { highlight.hidden = true; return }
      highlight.hidden = false
      const rect = target.getBoundingClientRect()
      Object.assign(highlight.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` })
    }
    function open() { previousFocus = document.activeElement; index = 0; overlay.hidden = false; render(); next.focus() }
    async function close() {
      if (closing) return
      closing = true
      try { await save(); overlay.hidden = true; previousFocus?.focus() } catch (error) { onError(error) } finally { closing = false }
    }
    next.addEventListener('click', () => { if (index === steps.length - 1) close(); else { index++; render() } })
    back.addEventListener('click', () => { if (index > 0) { index--; render() } })
    dismiss.addEventListener('click', close)
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const buttons = [dismiss, ...(back.disabled ? [] : [back]), next]
        const position = buttons.indexOf(document.activeElement)
        if (event.shiftKey && position <= 0) { event.preventDefault(); buttons[buttons.length - 1].focus() }
        else if (!event.shiftKey && position === buttons.length - 1) { event.preventDefault(); buttons[0].focus() }
      }
    })
    window.addEventListener('resize', () => { if (!overlay.hidden) render() })
    window.addEventListener('scroll', () => { if (!overlay.hidden) render() }, true)
    return { open }
  }
  return { steps, create }
})
