const state = { accounts: [], selectedId: null, viewer: null, clearedBefore: new Map(), etag: '' }
const byId = (id) => document.getElementById(id)
const elements = Object.fromEntries(['viewer','error-state','empty-state','dashboard','accounts','title','server','connection','status','log','clear','chat-form','chat','movement','health','hunger','coordinates','dimension','inventory','inventory-count','toast'].map((id) => [id, byId(id)]))

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store', headers: state.etag ? { 'If-None-Match': state.etag } : {} })
    if (response.status === 304) return
    if (!response.ok) throw new Error(response.status === 401 ? 'This browser session is not authorized. Open a fresh access link.' : 'Could not reach AFK Desk.')
    const value = await response.json()
    state.etag = response.headers.get('etag') || ''
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
    const avatar = createPlayerHead(item)
    const label = document.createElement('span')
    label.textContent = item.label
    button.append(avatar, label)
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
  renderTelemetry(account.telemetry)
  renderLog(account)
}

function renderTelemetry(telemetry) {
  elements.health.textContent = telemetry ? `${formatNumber(telemetry.health)} / 20` : '—'
  elements.hunger.textContent = telemetry ? `${formatNumber(telemetry.food)} / 20` : '—'
  elements.coordinates.textContent = telemetry?.position ? `${telemetry.position.x}, ${telemetry.position.y}, ${telemetry.position.z}` : '—'
  elements.dimension.textContent = telemetry ? String(telemetry.dimension || 'unknown').replace(/^minecraft:/,'') : '—'
  const items = telemetry?.inventory || []
  elements['inventory-count'].textContent = telemetry ? `${items.length} slots` : '—'
  if (!items.length) {
    const empty=document.createElement('div'); empty.className='placeholder compact'; empty.textContent=telemetry?'Inventory is empty.':'Connect to view items.'; elements.inventory.replaceChildren(empty); return
  }
  elements.inventory.replaceChildren(...items.map((item) => {
    const row=document.createElement('div'); row.className='inventory-item'
    const name=document.createElement('strong'); name.textContent=item.displayName
    const count=document.createElement('span'); count.textContent=`×${item.count}`
    row.append(name,count); return row
  }))
}
function formatNumber(value) { return Number.isInteger(value)?String(value):Number(value||0).toFixed(1) }

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
    appendLogMessage(message, entry)
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
function createPlayerHead(account) {
  const avatar = document.createElement('span')
  avatar.className = 'player-head'
  avatar.setAttribute('aria-hidden','true')
  if (!validSkinUrl(account.skinUrl)) {
    avatar.textContent = account.minecraftName?.slice(0,1).toUpperCase() || account.label.slice(0,1).toUpperCase()
    return avatar
  }
  avatar.classList.add('has-skin')
  avatar.style.backgroundImage = `url("${account.skinUrl}")`
  const overlay = document.createElement('span')
  overlay.style.backgroundImage = `url("${account.skinUrl}")`
  avatar.append(overlay)
  return avatar
}
function validSkinUrl(value) { try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='textures.minecraft.net' && /^\/texture\/[a-z0-9]+$/i.test(url.pathname) } catch { return false } }
function appendLogMessage(container,entry) {
  if (entry.kind==='sent') { container.textContent=`You: ${entry.message}`; return }
  if (!Array.isArray(entry.segments)||!entry.segments.length) { container.textContent=entry.message; return }
  for (const segment of entry.segments) {
    const part=document.createElement('span')
    part.textContent=String(segment.text||'')
    if (/^#[0-9a-f]{6}$/i.test(segment.color||'')) part.style.color=segment.color
    if (segment.bold) part.classList.add('chat-bold')
    if (segment.italic) part.classList.add('chat-italic')
    if (segment.underlined) part.classList.add('chat-underlined')
    if (segment.strikethrough) part.classList.add('chat-strikethrough')
    container.append(part)
  }
}
async function run(fn) { try { await fn() } catch(error) { toast(error.message) } }
function toast(message) { elements.toast.textContent=message; elements.toast.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(() => { elements.toast.hidden=true },4000) }

refresh()
setInterval(refresh,2500)
