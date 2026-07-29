const api = window.afkDesk

const state = {
  accounts: [],
  selectedId: null,
  statuses: new Map(),
  logs: new Map(),
  login: { code: '', url: 'https://microsoft.com/link' }
}

const el = Object.fromEntries([
  'account-list', 'account-count', 'add-account', 'browser-access', 'empty-state', 'dashboard', 'account-title',
  'edit-account', 'connection-button', 'status-banner', 'status-name', 'status-detail', 'server-address',
  'detail-username', 'detail-server', 'detail-version', 'detail-antiafk', 'console-log', 'clear-console',
  'chat-form', 'chat-message', 'account-dialog', 'account-form', 'dialog-title', 'account-id', 'label',
  'username', 'host', 'port', 'version', 'anti-afk', 'anti-afk-interval', 'join-message', 'server-change-message',
  'message-delay', 'form-error', 'delete-account', 'login-dialog', 'login-code', 'open-login-private', 'open-login',
  'close-login', 'remote-dialog', 'close-remote', 'remote-local-url', 'open-dashboard', 'tailscale-command',
  'enable-tailscale', 'tailscale-result', 'remote-base-url', 'grant-label', 'grant-accounts', 'create-grant', 'generated-link', 'share-link',
  'copy-share-link', 'grant-list', 'toast-region'
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
  el['browser-access'].addEventListener('click', openRemoteDialog)
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
  el['open-login-private'].addEventListener('click', () => run(() => api.openIsolatedLogin(state.login.accountId, state.login.url, state.login.code)))
  el['close-login'].addEventListener('click', () => el['login-dialog'].close())
  el['close-remote'].addEventListener('click', () => el['remote-dialog'].close())
  el['open-dashboard'].addEventListener('click', () => run(() => api.openRemoteDashboard()))
  el['enable-tailscale'].addEventListener('click', enableTailscale)
  el['create-grant'].addEventListener('click', createRemoteGrant)
  el['copy-share-link'].addEventListener('click', async () => {
    await navigator.clipboard.writeText(el['share-link'].value)
    toast('Access link copied.')
  })
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
  const canInteract = online || status === 'connected'
  const active = online || status === 'connecting' || status === 'connected'
  el['status-banner'].className = `status-banner ${status === 'connected' ? 'connecting' : status}`
  el['status-name'].textContent = status
  el['status-detail'].textContent = detail
  el['connection-button'].textContent = active ? 'Disconnect' : 'Connect'
  el['connection-button'].className = `button ${active ? 'secondary' : 'primary'}`
  el['chat-message'].disabled = !canInteract
  el['chat-form'].querySelector('button').disabled = !canInteract
  document.querySelectorAll('[data-control], [data-look]').forEach((button) => { button.disabled = !canInteract })
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
  el['join-message'].value = account?.joinMessage || ''
  el['server-change-message'].value = account?.serverChangeMessage || ''
  el['message-delay'].value = account?.messageDelay ?? 2
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
    antiAfkInterval: Number(el['anti-afk-interval'].value),
    joinMessage: el['join-message'].value,
    serverChangeMessage: el['server-change-message'].value,
    messageDelay: Number(el['message-delay'].value)
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
      accountId: id,
      code: payload.code,
      url: payload.verificationUri || 'https://microsoft.com/link'
    }
    el['login-code'].textContent = payload.code || 'See console'
    if (!el['login-dialog'].open) el['login-dialog'].showModal()
  }
  render()
}

async function openRemoteDialog() {
  try {
    const status = await api.remoteStatus()
    el['remote-local-url'].textContent = status.localUrl
    el['tailscale-command'].textContent = `tailscale serve --bg ${status.port}`
    renderGrantAccounts()
    await renderGrantList()
    el['generated-link'].hidden = true
    el['remote-dialog'].showModal()
  } catch (error) { toast(cleanError(error), 'error') }
}

function renderGrantAccounts() {
  el['grant-accounts'].replaceChildren(...state.accounts.map((account) => {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = account.id
    const text = document.createElement('span')
    text.textContent = `${account.label} — ${account.host}`
    label.append(checkbox, text)
    return label
  }))
}

async function createRemoteGrant() {
  const accountIds = [...el['grant-accounts'].querySelectorAll('input:checked')].map((input) => input.value)
  const permissions = ['view', ...[...document.querySelectorAll('[data-permission]:checked:not(:disabled)')].map((input) => input.dataset.permission)]
  try {
    const created = await api.createRemoteGrant({ label: el['grant-label'].value, accountIds, permissions })
    const base = el['remote-base-url'].value.trim().replace(/\/$/, '')
    el['share-link'].value = base ? `${base}${created.sharePath}` : created.localUrl
    el['generated-link'].hidden = false
    await renderGrantList()
    el['share-link'].select()
  } catch (error) { toast(cleanError(error), 'error') }
}

async function enableTailscale() {
  el['enable-tailscale'].disabled = true
  try {
    const result = await api.enableTailscale()
    el['tailscale-result'].textContent = result.output || 'Tailscale browser access is enabled.'
    el['tailscale-result'].hidden = false
    if (result.url) el['remote-base-url'].value = result.url
  } catch (error) {
    el['tailscale-result'].textContent = `Could not enable Tailscale: ${cleanError(error)}`
    el['tailscale-result'].hidden = false
  } finally { el['enable-tailscale'].disabled = false }
}

async function renderGrantList() {
  const grants = await api.listRemoteGrants()
  if (!grants.length) {
    const empty = document.createElement('div')
    empty.className = 'grant-empty'
    empty.textContent = 'No browser access links created yet.'
    el['grant-list'].replaceChildren(empty)
    return
  }
  el['grant-list'].replaceChildren(...grants.sort((a, b) => b.createdAt - a.createdAt).map((grant) => {
    const item = document.createElement('div')
    item.className = `grant-item ${grant.revokedAt ? 'revoked' : ''}`
    const copy = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = grant.label
    const detail = document.createElement('span')
    detail.textContent = `${grant.accountIds.length} account${grant.accountIds.length === 1 ? '' : 's'} · ${grant.permissions.join(', ')}${grant.revokedAt ? ' · revoked' : ''}`
    copy.append(title, detail)
    item.append(copy)
    if (!grant.revokedAt) {
      const revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'button danger'
      revoke.textContent = 'Revoke'
      revoke.addEventListener('click', async () => {
        await api.revokeRemoteGrant(grant.id)
        await renderGrantList()
        toast('Browser access revoked.')
      })
      item.append(revoke)
    }
    return item
  }))
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
