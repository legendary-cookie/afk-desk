const api = window.afkDesk

const state = {
  accounts: [],
  selectedId: null,
  statuses: new Map(),
  logs: new Map(),
  login: { code: '', url: 'https://microsoft.com/link' }
}

const el = Object.fromEntries([
  'account-list', 'account-count', 'add-account', 'empty-state', 'dashboard', 'account-title',
  'edit-account', 'connection-button', 'status-banner', 'status-name', 'status-detail', 'server-address',
  'detail-username', 'detail-server', 'detail-version', 'detail-antiafk', 'console-log', 'clear-console',
  'chat-form', 'chat-message', 'account-dialog', 'account-form', 'dialog-title', 'account-id', 'label',
  'username', 'host', 'port', 'version', 'anti-afk', 'anti-afk-interval', 'form-error', 'delete-account',
  'login-dialog', 'login-code', 'open-login', 'close-login', 'toast-region'
].map((id) => [id, document.getElementById(id)]))

async function init() {
  state.accounts = await api.listAccounts()
  state.selectedId = state.accounts[0]?.id || null
  bindEvents()
  render()
  api.onBotEvent(handleBotEvent)
}

function bindEvents() {
  el['add-account'].addEventListener('click', () => openAccountDialog())
  document.querySelector('[data-action="add"]').addEventListener('click', () => openAccountDialog())
  el['edit-account'].addEventListener('click', () => openAccountDialog(selectedAccount()))
  el['account-form'].addEventListener('submit', saveAccount)
  el['delete-account'].addEventListener('click', deleteAccount)
  el['connection-button'].addEventListener('click', toggleConnection)
  el['chat-form'].addEventListener('submit', sendChat)
  el['clear-console'].addEventListener('click', () => {
    state.logs.set(state.selectedId, [])
    renderConsole()
  })
  document.querySelectorAll('[data-control]').forEach((button) => button.addEventListener('click', () => run(() => api.control(state.selectedId, button.dataset.control))))
  document.querySelectorAll('[data-look]').forEach((button) => button.addEventListener('click', () => run(() => api.look(state.selectedId, button.dataset.look))))
  el['login-code'].addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.login.code)
    toast('Sign-in code copied.')
  })
  el['open-login'].addEventListener('click', () => run(() => api.openExternal(state.login.url)))
  el['close-login'].addEventListener('click', () => el['login-dialog'].close())
}

function render() {
  renderAccountList()
  const account = selectedAccount()
  el['empty-state'].hidden = Boolean(account)
  el.dashboard.hidden = !account
  if (!account) return

  const status = getStatus(account.id)
  el['account-title'].textContent = account.label
  el['server-address'].textContent = `${account.host}:${account.port}`
  el['detail-username'].textContent = account.username
  el['detail-server'].textContent = `${account.host}:${account.port}`
  el['detail-version'].textContent = account.version || 'Auto-detect'
  el['detail-antiafk'].textContent = account.antiAfk ? `Every ${account.antiAfkInterval} seconds` : 'Disabled'
  renderStatus(status)
  renderConsole()
}

function renderAccountList() {
  el['account-count'].textContent = state.accounts.length
  el['account-list'].replaceChildren(...state.accounts.map((account) => {
    const button = document.createElement('button')
    const status = getStatus(account.id).status
    button.type = 'button'
    button.className = 'account-item'
    button.setAttribute('aria-current', String(account.id === state.selectedId))
    button.innerHTML = `<span class="account-avatar" aria-hidden="true"></span><span class="account-copy"><strong></strong><span></span></span><span class="mini-status ${status}" aria-label="${status}"></span>`
    button.querySelector('.account-avatar').textContent = account.label.slice(0, 1).toUpperCase()
    button.querySelector('strong').textContent = account.label
    button.querySelector('.account-copy span').textContent = account.host
    button.addEventListener('click', () => {
      state.selectedId = account.id
      render()
    })
    return button
  }))
}

function renderStatus({ status, detail }) {
  const online = status === 'online'
  const active = online || status === 'connecting' || status === 'connected'
  el['status-banner'].className = `status-banner ${status === 'connected' ? 'connecting' : status}`
  el['status-name'].textContent = status
  el['status-detail'].textContent = detail
  el['connection-button'].textContent = active ? 'Disconnect' : 'Connect'
  el['connection-button'].className = `button ${active ? 'secondary' : 'primary'}`
  el['chat-message'].disabled = !online
  el['chat-form'].querySelector('button').disabled = !online
  document.querySelectorAll('[data-control], [data-look]').forEach((button) => { button.disabled = !online })
}

function renderConsole() {
  const logs = state.logs.get(state.selectedId) || []
  if (!logs.length) {
    const placeholder = document.createElement('div')
    placeholder.className = 'console-placeholder'
    placeholder.textContent = 'Server messages will appear here after you connect.'
    el['console-log'].replaceChildren(placeholder)
    return
  }
  el['console-log'].replaceChildren(...logs.map((entry) => {
    const line = document.createElement('div')
    line.className = `log-line ${entry.kind}`
    const time = document.createElement('time')
    time.dateTime = new Date(entry.at).toISOString()
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const message = document.createElement('span')
    message.textContent = entry.kind === 'sent' ? `You: ${entry.message}` : entry.message
    line.append(time, message)
    return line
  }))
  el['console-log'].scrollTop = el['console-log'].scrollHeight
}

function openAccountDialog(account) {
  el['account-form'].reset()
  el['form-error'].hidden = true
  el['account-id'].value = account?.id || ''
  el.label.value = account?.label || ''
  el.username.value = account?.username || ''
  el.host.value = account?.host || ''
  el.port.value = account?.port || 25565
  el.version.value = account?.version || ''
  el['anti-afk'].checked = account?.antiAfk !== false
  el['anti-afk-interval'].value = account?.antiAfkInterval || 45
  el['dialog-title'].textContent = account ? 'Edit account' : 'Add account'
  el['delete-account'].hidden = !account
  el['account-dialog'].showModal()
  setTimeout(() => (account ? el.label : el.username).focus(), 0)
}

async function saveAccount(event) {
  event.preventDefault()
  const input = {
    id: el['account-id'].value || undefined,
    label: el.label.value,
    username: el.username.value,
    host: el.host.value,
    port: Number(el.port.value),
    version: el.version.value,
    antiAfk: el['anti-afk'].checked,
    antiAfkInterval: Number(el['anti-afk-interval'].value)
  }
  try {
    const saved = await api.saveAccount(input)
    const index = state.accounts.findIndex((account) => account.id === saved.id)
    if (index === -1) state.accounts.push(saved)
    else state.accounts[index] = saved
    state.selectedId = saved.id
    el['account-dialog'].close()
    render()
    toast('Account saved.')
  } catch (error) {
    el['form-error'].textContent = cleanError(error)
    el['form-error'].hidden = false
  }
}

async function deleteAccount() {
  const id = el['account-id'].value
  if (!id || !confirm('Delete this account profile? Microsoft tokens for it remain on this computer.')) return
  await api.deleteAccount(id)
  state.accounts = state.accounts.filter((account) => account.id !== id)
  state.statuses.delete(id)
  state.logs.delete(id)
  state.selectedId = state.accounts[0]?.id || null
  el['account-dialog'].close()
  render()
  toast('Account deleted.')
}

async function toggleConnection() {
  const account = selectedAccount()
  if (!account) return
  const status = getStatus(account.id).status
  await run(() => ['online', 'connecting', 'connected'].includes(status) ? api.disconnect(account.id) : api.connect(account.id))
}

async function sendChat(event) {
  event.preventDefault()
  const message = el['chat-message'].value.trim()
  if (!message) return
  await run(() => api.sendChat(state.selectedId, message))
  el['chat-message'].value = ''
}

function handleBotEvent({ type, id, payload }) {
  if (type === 'status') state.statuses.set(id, payload)
  if (type === 'log') {
    const logs = state.logs.get(id) || []
    state.logs.set(id, [...logs.slice(-499), payload])
  }
  if (type === 'login-code') {
    state.login = {
      code: payload.code,
      url: payload.verificationUri || 'https://microsoft.com/link'
    }
    el['login-code'].textContent = payload.code || 'See console'
    if (!el['login-dialog'].open) el['login-dialog'].showModal()
  }
  render()
}

function selectedAccount() {
  return state.accounts.find((account) => account.id === state.selectedId)
}

function getStatus(id) {
  return state.statuses.get(id) || { status: 'offline', detail: 'Ready to connect' }
}

async function run(action) {
  try { return await action() }
  catch (error) { toast(cleanError(error), 'error') }
}

function cleanError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function toast(message, kind = '') {
  const item = document.createElement('div')
  item.className = `toast ${kind}`
  item.textContent = message
  el['toast-region'].append(item)
  setTimeout(() => item.remove(), 4000)
}

init().catch((error) => toast(cleanError(error), 'error'))
