const state = { accounts: [], selectedId: null, viewer: null, clearedBefore: new Map() }
const byId = (id) => document.getElementById(id)
const elements = Object.fromEntries(['viewer','error-state','empty-state','dashboard','accounts','title','server','connection','status','log','clear','chat-form','chat','movement','toast'].map((id) => [id, byId(id)]))

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' })
    if (!response.ok) throw new Error(response.status === 401 ? 'This browser session is not authorized. Open a fresh access link.' : 'Could not reach AFK Desk.')
    const value = await response.json()
    state.accounts = value.accounts
    state.viewer = value.viewer
    if (!state.accounts.some((account) => account.id === state.selectedId)) state.selectedId = state.accounts[0]?.id || null
    render()
  } catch (error) {
    elements['error-state'].textContent = error.message
    elements['error-state'].hidden = false
    elements.dashboard.hidden = true
  }
}

function render() {
  elements['error-state'].hidden = true
  elements.viewer.textContent = `Access: ${state.viewer.label}`
  elements['empty-state'].hidden = state.accounts.length > 0
  elements.dashboard.hidden = state.accounts.length === 0
  if (!state.accounts.length) return
  const account = current()
  const permissions = new Set(state.viewer.permissions)
  elements.accounts.replaceChildren(...state.accounts.map((item) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tab'
    button.textContent = item.label
    button.setAttribute('aria-current', String(item.id === account.id))
    button.addEventListener('click', () => { state.selectedId = item.id; render() })
    return button
  }))
  elements.title.textContent = account.label
  elements.server.textContent = account.server
  elements.status.className = `status ${account.status}`
  elements.status.querySelector('strong').textContent = account.status
  elements.status.querySelector('small').textContent = account.detail
  const active = ['online','connecting','connected','reconnecting'].includes(account.status)
  const canInteract = ['online','connected'].includes(account.status)
  elements.connection.textContent = account.status === 'reconnecting' ? 'Cancel reconnect' : active ? 'Disconnect' : 'Connect'
  elements.connection.disabled = !permissions.has('connect')
  elements.chat.disabled = !permissions.has('chat') || !canInteract
  elements['chat-form'].querySelector('button').disabled = elements.chat.disabled
  elements.movement.querySelectorAll('button').forEach((button) => { button.disabled = !permissions.has('control') || !canInteract })
  renderLog(account)
}

function renderLog(account) {
  const cutoff = state.clearedBefore.get(account.id) || 0
  const logs = account.logs.filter((entry) => entry.at > cutoff)
  if (!logs.length) {
    const placeholder = document.createElement('div')
    placeholder.className = 'placeholder'
    placeholder.textContent = 'No server messages yet.'
    elements.log.replaceChildren(placeholder)
    return
  }
  elements.log.replaceChildren(...logs.map((entry) => {
    const line = document.createElement('div')
    line.className = `line ${entry.kind}`
    const time = document.createElement('time')
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    const message = document.createElement('span')
    message.textContent = entry.kind === 'sent' ? `You: ${entry.message}` : entry.message
    line.append(time,message)
    return line
  }))
  elements.log.scrollTop = elements.log.scrollHeight
}

async function action(name, payload = {}) {
  const response = await fetch('/api/action', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-AFKDesk-Request':'1' },
    body:JSON.stringify({ accountId:state.selectedId, action:name, payload })
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value.error || 'Action failed.')
  await refresh()
}

elements.connection.addEventListener('click', () => run(() => action(['online','connecting','connected','reconnecting'].includes(current().status) ? 'disconnect' : 'connect')))
elements['chat-form'].addEventListener('submit', (event) => {
  event.preventDefault()
  const message = elements.chat.value.trim()
  if (!message) return
  run(async () => { await action('chat',{ message }); elements.chat.value='' })
})
elements.clear.addEventListener('click', () => { state.clearedBefore.set(state.selectedId,Date.now()); render() })
document.querySelectorAll('[data-control]').forEach((button) => button.addEventListener('click', () => run(() => action('control',{ control:button.dataset.control }))))
document.querySelectorAll('[data-look]').forEach((button) => button.addEventListener('click', () => run(() => action('look',{ direction:button.dataset.look }))))

function current() { return state.accounts.find((account) => account.id === state.selectedId) }
async function run(fn) { try { await fn() } catch(error) { toast(error.message) } }
function toast(message) { elements.toast.textContent=message; elements.toast.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(() => { elements.toast.hidden=true },4000) }

refresh()
setInterval(refresh,2000)
