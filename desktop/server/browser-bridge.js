'use strict'
;(function initBrowserBridge(globalScope) {
  function createBrowserBridge({
    fetchImpl = typeof fetch === 'function' ? fetch.bind(globalScope) : null,
    WebSocketImpl = typeof WebSocket === 'function' ? WebSocket : null,
    locationObj = typeof location === 'object' ? location : { protocol: 'http:', host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' },
    documentObj = typeof document === 'object' ? document : null,
    confirmImpl = typeof globalScope.confirm === 'function' ? globalScope.confirm.bind(globalScope) : null
  } = {}) {
    let csrfToken = null
    let currentScope = null
    let capabilities = {
      mode: 'server',
      headless: true,
      isolatedLoginWindow: false,
      openExternal: false,
      autoLaunch: false,
      fileDialogs: false,
      windowControls: false,
      deviceCodeSignIn: true,
      bedrock: true
    }
    let sessionPromise = null
    let loginDialogPromise = null
    let ws = null
    let wsReconnectTimer = null
    let wsReconnectDelay = 2000
    let wsStopped = false

    // Startup race resolution (Option A):
    // Browser-bridge buffers bot and macro events received before any listener subscribes
    // (bounded to the last 200 events) and replays them to the first subscriber.
    // This prevents missed initial status/telemetry snapshots if the WebSocket connects
    // before renderer event listeners are registered.
    const MAX_BUFFERED_EVENTS = 200
    const bufferedBotEvents = []
    const bufferedMacroEvents = []

    const botListeners = new Set()
    const macroListeners = new Set()

    function getOrigin() {
      if (locationObj?.origin && locationObj.origin !== 'null') return locationObj.origin
      const proto = locationObj?.protocol === 'https:' ? 'https:' : 'http:'
      const host = locationObj?.host || '127.0.0.1:8787'
      return `${proto}//${host}`
    }

    function applyCapabilitiesToDom(caps = capabilities) {
      if (!documentObj) return
      if (caps.autoLaunch === false) {
        const autoLaunchInput = documentObj.getElementById('start-with-windows')
        const row = autoLaunchInput?.closest?.('.toggle-row') || autoLaunchInput?.parentElement
        if (row) row.hidden = true
      }
      if (caps.isolatedLoginWindow === false) {
        const btn = documentObj.getElementById('open-login-private')
        if (btn) btn.hidden = true
      }
      if (caps.openExternal === false) {
        const btn = documentObj.getElementById('open-login')
        if (btn) btn.hidden = true
      }
      if (caps.fileDialogs === false && documentObj.querySelectorAll) {
        documentObj.querySelectorAll('[data-capability="fileDialogs"]').forEach((el) => { el.hidden = true })
      }
      if (caps.windowControls === false && documentObj.querySelectorAll) {
        documentObj.querySelectorAll('[data-capability="windowControls"]').forEach((el) => { el.hidden = true })
      }
    }

    function ensureWebSocket() {
      if (wsStopped || !WebSocketImpl || ws) return
      if (!csrfToken && !currentScope) return
      try {
        const wsProto = locationObj?.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${wsProto}//${locationObj?.host || '127.0.0.1:8787'}/ws`
        const socket = new WebSocketImpl(wsUrl, [`afk-csrf.${csrfToken}`])
        ws = socket

        const addSocketListener = (evt, handler) => {
          if (typeof socket.addEventListener === 'function') socket.addEventListener(evt, handler)
          else if (typeof socket.on === 'function') socket.on(evt, handler)
        }

        addSocketListener('open', () => {
          wsReconnectDelay = 2000
        })

        addSocketListener('message', (event) => {
          let parsed
          try {
            const raw = typeof event === 'object' && event !== null && 'data' in event ? event.data : event
            parsed = JSON.parse(String(raw || '{}'))
          } catch {
            return
          }
          if (parsed.channel === 'bot:event' && parsed.payload) {
            if (botListeners.size === 0) {
              if (bufferedBotEvents.length >= MAX_BUFFERED_EVENTS) bufferedBotEvents.shift()
              bufferedBotEvents.push(parsed.payload)
            } else {
              for (const listener of botListeners) {
                try { listener(parsed.payload) } catch {}
              }
            }
          } else if (parsed.channel === 'macro-run' && parsed.payload) {
            if (macroListeners.size === 0) {
              if (bufferedMacroEvents.length >= MAX_BUFFERED_EVENTS) bufferedMacroEvents.shift()
              bufferedMacroEvents.push(parsed.payload)
            } else {
              for (const listener of macroListeners) {
                try { listener(parsed.payload) } catch {}
              }
            }
          }
        })

        addSocketListener('close', (event) => {
          if (ws === socket) ws = null
          const code = typeof event === 'number' ? event : event?.code
          if (code === 4401 || code === 1008) {
            csrfToken = null
            currentScope = null
            clearTimeout(wsReconnectTimer)
            wsReconnectTimer = null
            wsStopped = true
            promptLoginDialog(code === 4401 ? 'Your session expired. Sign in again.' : 'Connection closed. Sign in again.')
            return
          }
          if (!wsStopped && csrfToken && (botListeners.size > 0 || macroListeners.size > 0)) {
            clearTimeout(wsReconnectTimer)
            const delay = wsReconnectDelay
            wsReconnectDelay = Math.min(30000, wsReconnectDelay * 2)
            wsReconnectTimer = setTimeout(() => ensureWebSocket(), delay)
          }
        })

        addSocketListener('error', () => {
          try { socket.close() } catch {}
        })
      } catch {}
    }

    function closeWebSocket() {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
      if (ws) {
        const s = ws
        ws = null
        try { s.close() } catch {}
      }
    }

    function promptLoginDialog(errorMessage = '') {
      if (!documentObj || !documentObj.body) {
        return Promise.reject(new Error('Authentication required.'))
      }
      if (loginDialogPromise) return loginDialogPromise

      loginDialogPromise = new Promise((resolve) => {
        let dialog = documentObj.getElementById('afk-remote-auth-dialog')
        if (dialog) dialog.remove()

        dialog = documentObj.createElement('dialog')
        dialog.id = 'afk-remote-auth-dialog'

        const form = documentObj.createElement('form')
        form.className = 'login-content'

        const eyebrow = documentObj.createElement('div')
        eyebrow.className = 'eyebrow'
        eyebrow.textContent = 'AFK Desk Remote Access'

        const heading = documentObj.createElement('h2')
        heading.textContent = 'Sign in to continue'

        const desc = documentObj.createElement('p')
        desc.textContent = 'Enter the administrator password for this AFK Desk server.'

        const userLabel = documentObj.createElement('label')
        userLabel.className = 'field full'
        const userSpan = documentObj.createElement('span')
        userSpan.textContent = 'Username'
        const userInput = documentObj.createElement('input')
        userInput.type = 'text'
        userInput.autocomplete = 'username'
        userInput.value = 'admin'
        userInput.required = true
        userLabel.append(userSpan, userInput)

        const passLabel = documentObj.createElement('label')
        passLabel.className = 'field full'
        const passSpan = documentObj.createElement('span')
        passSpan.textContent = 'Password'
        const passInput = documentObj.createElement('input')
        passInput.type = 'password'
        passInput.autocomplete = 'current-password'
        passInput.required = true
        passLabel.append(passSpan, passInput)

        const errorBox = documentObj.createElement('p')
        errorBox.className = 'form-error'
        errorBox.setAttribute('role', 'alert')
        if (errorMessage) {
          errorBox.textContent = String(errorMessage)
          errorBox.hidden = false
        } else {
          errorBox.hidden = true
        }

        const submitBtn = documentObj.createElement('button')
        submitBtn.type = 'submit'
        submitBtn.className = 'button primary full-button'
        submitBtn.textContent = 'Sign in'

        form.append(eyebrow, heading, desc, userLabel, passLabel, errorBox, submitBtn)
        dialog.append(form)
        documentObj.body.append(dialog)

        dialog.addEventListener('cancel', (ev) => ev.preventDefault())

        form.addEventListener('submit', async (ev) => {
          ev.preventDefault()
          submitBtn.disabled = true
          errorBox.hidden = true
          try {
            await performLogin(passInput.value, userInput.value.trim() || 'admin')
            dialog.close()
            dialog.remove()
            loginDialogPromise = null
            resolve(true)
          } catch (err) {
            errorBox.textContent = String(err?.message || err)
            errorBox.hidden = false
            submitBtn.disabled = false
            try { passInput?.focus?.() } catch {}
          }
        })

        if (typeof dialog.showModal === 'function') dialog.showModal()
        else dialog.setAttribute('open', 'true')
        setTimeout(() => { try { passInput?.focus?.() } catch {} }, 0)
      })

      return loginDialogPromise
    }

    async function performLogin(password, username = 'admin') {
      const response = await fetchImpl('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Origin: getOrigin()
        },
        body: JSON.stringify({ username, password })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) {
        throw new Error(data?.error?.message || `Login failed (HTTP ${response.status}).`)
      }
      csrfToken = data.csrfToken || null
      currentScope = data.scope || 'admin'
      wsStopped = false
      wsReconnectDelay = 2000
      if (data.capabilities) {
        capabilities = data.capabilities
        applyCapabilitiesToDom(capabilities)
      }
      ensureWebSocket()
      return data
    }

    async function fetchSession() {
      const response = await fetchImpl('/api/session', {
        method: 'GET',
        credentials: 'same-origin'
      })
      if (response.status === 401 || response.status === 403) {
        csrfToken = null
        currentScope = null
        wsStopped = true
        closeWebSocket()
        promptLoginDialog(response.status === 401 ? 'Authentication required.' : 'Access forbidden.')
        return null
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) return null
      csrfToken = data.csrfToken || null
      currentScope = data.scope || 'read'
      wsStopped = false
      wsReconnectDelay = 2000
      if (data.capabilities) {
        capabilities = data.capabilities
        applyCapabilitiesToDom(capabilities)
      }
      ensureWebSocket()
      return data
    }

    async function ensureAuthenticated() {
      if (csrfToken) return
      if (!sessionPromise) {
        sessionPromise = fetchSession().finally(() => { sessionPromise = null })
      }
      const session = await sessionPromise
      if (session) return
      await promptLoginDialog()
    }

    async function apiRequest(pathUrl, { method = 'GET', body = undefined, retryOn401 = true } = {}) {
      await ensureAuthenticated()
      const headers = {}
      if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json'
        headers.Origin = getOrigin()
        if (csrfToken) headers['X-AFK-CSRF'] = csrfToken
      }
      const response = await fetchImpl(pathUrl, {
        method,
        credentials: 'same-origin',
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      if (response.status === 401 && retryOn401) {
        csrfToken = null
        currentScope = null
        closeWebSocket()
        await promptLoginDialog('Your session expired. Sign in again.')
        return apiRequest(pathUrl, { method, body, retryOn401: false })
      }
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) {
        const err = new Error(payload?.error?.message || `Request failed (${response.status})`)
        err.code = payload?.error?.code || `HTTP_${response.status}`
        err.status = response.status
        throw err
      }
      return payload
    }

    async function invoke(channel, args) {
      const body = args === undefined ? { channel } : { channel, args }
      let data
      try { data = await apiRequest('/api/invoke', { method: 'POST', body }) }
      catch (error) {
        if (error.code !== 'CONFIRM_REQUIRED' || !confirmImpl || !await confirmImpl('Confirm this action? It may disconnect an account or discard inventory items.')) throw error
        data = await apiRequest('/api/invoke', { method: 'POST', body: { ...body, confirmed: true } })
      }
      return data.result
    }

    async function logout({ everywhere = false } = {}) {
      try {
        await apiRequest('/api/logout', { method: 'POST', body: { everywhere }, retryOn401: false })
      } finally {
        csrfToken = null
        currentScope = null
        closeWebSocket()
      }
    }

    const bridge = {
      listAccounts: () => invoke('accounts:list'),
      saveAccount: (account) => invoke('accounts:save', account),
      deleteAccount: (id) => invoke('accounts:delete', id),
      reorderAccounts: (orderedIds) => invoke('accounts:reorder', orderedIds),
      duplicateProfile: (id) => invoke('accounts:duplicate-profile', id),
      connect: (id) => invoke('bot:connect', id),
      disconnect: (id) => invoke('bot:disconnect', id),
      sendChat: (id, message) => invoke('bot:chat', { id, message }),
      completeChat: (id, text) => invoke('bot:complete-chat', { id, text }),
      control: (id, control, duration) => invoke('bot:control', { id, control, duration }),
      setControlState: (id, control, active) => invoke('bot:control-state', { id, control, active }),
      look: (id, direction) => invoke('bot:look', { id, direction }),
      lookDelta: (id, yawDelta, pitchDelta) => invoke('bot:look-delta', { id, yawDelta, pitchDelta }),
      dropStack: (id, slot) => invoke('bot:drop-stack', { id, slot }),
      dropItems: (id, slot, count) => invoke('bot:drop-items', { id, slot, count }),
      depositSlot: (id, slot, count) => invoke('bot:deposit-slot', { id, slot, count }),
      setItemLock: (id, slot, locked) => invoke('bot:item-lock', { id, slot, locked }),
      moveInventorySlot: (id, sourceSlot, destinationSlot) => invoke('bot:inventory-move', { id, sourceSlot, destinationSlot }),
      equipInventoryItem: (id, slot, destination) => invoke('bot:equip-item', { id, slot, destination }),
      setAutoDeposit: (id, enabled) => invoke('bot:auto-deposit', { id, enabled }),
      clickWindowSlot: (id, slot) => invoke('bot:window-click', { id, slot }),
      closeServerWindow: (id) => invoke('bot:window-close', id),
      getWorldSnapshot: (id, radius, blockRefreshMs) => invoke('bot:world-snapshot', { id, radius, blockRefreshMs }),
      worldAction: (id, action, target) => invoke('bot:world-action', { id, action, target }),
      listLogs: (id, options = {}) => invoke('logs:list', { id, ...options }),
      clearLogs: (id) => invoke('logs:clear', id),
      runAutomation: (id, macroId) => invoke('macros:run', { accountId: id, macroId }),
      stopAutomation: (id) => invoke('macros:stop', { accountId: id }),
      macros: {
        list: () => invoke('macros:list'),
        save: (macro) => invoke('macros:save', macro),
        remove: (id) => invoke('macros:delete', id),
        setEnabled: (macroId, enabled) => invoke('macros:set-enabled', { macroId, enabled }),
        run: (accountId, macroId) => invoke('macros:run', { accountId, macroId }),
        stop: (accountId) => invoke('macros:stop', { accountId }),
        runs: (macroId) => invoke('macros:runs', macroId),
        importJson: (json) => invoke('macros:import', json),
        exportJson: (ids) => invoke('macros:export', ids)
      },
      notify: {
        list: () => invoke('notify:list'),
        save: (input) => invoke('notify:save', input),
        delete: (id) => invoke('notify:delete', id),
        test: (id) => invoke('notify:test', id)
      },
      getProxyHealth: () => invoke('proxy:health'),
      openIsolatedLogin: (id, url, code) => invoke('auth:open-isolated', { id, url, code }),
      openExternal: (url) => invoke('system:open-external', url),
      getSettings: () => invoke('settings:get'),
      saveSettings: (settings) => {
        if (settings && typeof settings === 'object') {
          const { remoteAccess: _omit, ...rest } = settings
          return invoke('settings:save', rest)
        }
        return invoke('settings:save', settings)
      },
      getAppVersion: () => invoke('app:version'),
      getSupportedVersions: () => invoke('app:supported-versions'),
      setUiScale: (percent) => {
        if (!documentObj?.documentElement) return
        const factor = Math.max(0.75, Math.min(Number(percent) || 100, 125)) / 100
        documentObj.documentElement.style.zoom = String(factor)
      },
      onBotEvent: (callback) => {
        const isFirst = botListeners.size === 0
        botListeners.add(callback)
        if (isFirst && bufferedBotEvents.length > 0) {
          const replay = bufferedBotEvents.slice()
          bufferedBotEvents.length = 0
          for (const item of replay) {
            try { callback(item) } catch {}
          }
        }
        ensureWebSocket()
        return () => botListeners.delete(callback)
      },
      onMacroRun: (callback) => {
        const isFirst = macroListeners.size === 0
        macroListeners.add(callback)
        if (isFirst && bufferedMacroEvents.length > 0) {
          const replay = bufferedMacroEvents.slice()
          bufferedMacroEvents.length = 0
          for (const item of replay) {
            try { callback(item) } catch {}
          }
        }
        ensureWebSocket()
        return () => macroListeners.delete(callback)
      },
      getCapabilities: async () => {
        const res = await invoke('app:capabilities')
        if (res) {
          capabilities = res
          applyCapabilitiesToDom(capabilities)
        }
        return capabilities
      },
      capabilities: () => ({ ...capabilities }),
      login: performLogin,
      logout,
      getSession: fetchSession,
      tokens: {
        list: async () => (await apiRequest('/api/tokens', { method: 'GET' })).tokens,
        create: async (opts) => apiRequest('/api/tokens', { method: 'POST', body: opts }),
        revoke: async (id) => apiRequest(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
      },
      _getCsrfToken: () => csrfToken,
      _close: () => {
        wsStopped = true
        closeWebSocket()
      }
    }

    return bridge
  }

  function mountRemoteAccessSettingsUi(doc) {
    if (!doc) return
    const openSettingsBtn = doc.getElementById('open-settings')
    const settingsDialog = doc.getElementById('settings-dialog')
    const settingsBody = settingsDialog?.querySelector?.('.settings-body')
    if (!openSettingsBtn || !settingsDialog || !settingsBody) return

    let section = null
    let statusText = null
    let bindVal = null
    let portVal = null
    let allowedHostsVal = null
    let tokenListContainer = null

    function ensureSection() {
      if (section) return section
      section = doc.createElement('div')
      section.id = 'remote-access-settings-section'
      section.className = 'form-section'

      const heading = doc.createElement('h3')
      heading.textContent = 'Remote access'

      const note = doc.createElement('p')
      note.id = 'remote-access-desktop-only-note'
      note.className = 'field-note'
      note.textContent = 'Remote access settings can only be configured in the desktop app.'

      statusText = doc.createElement('small')
      statusText.id = 'remote-access-status'
      statusText.textContent = 'Status: Disabled'

      const grid = doc.createElement('div')
      grid.className = 'settings-visual-grid'

      const bindField = doc.createElement('label')
      bindField.className = 'field'
      const bindLabel = doc.createElement('span')
      bindLabel.textContent = 'Bind address'
      bindVal = doc.createElement('input')
      bindVal.id = 'remote-access-bind'
      bindVal.type = 'text'
      bindVal.readOnly = true
      bindVal.disabled = true
      bindField.append(bindLabel, bindVal)

      const portField = doc.createElement('label')
      portField.className = 'field'
      const portLabel = doc.createElement('span')
      portLabel.textContent = 'Port'
      portVal = doc.createElement('input')
      portVal.id = 'remote-access-port'
      portVal.type = 'text'
      portVal.readOnly = true
      portVal.disabled = true
      portField.append(portLabel, portVal)

      const hostsField = doc.createElement('label')
      hostsField.className = 'field'
      const hostsLabel = doc.createElement('span')
      hostsLabel.textContent = 'Allowed hosts'
      allowedHostsVal = doc.createElement('input')
      allowedHostsVal.id = 'remote-access-allowed-hosts'
      allowedHostsVal.type = 'text'
      allowedHostsVal.readOnly = true
      allowedHostsVal.disabled = true
      hostsField.append(hostsLabel, allowedHostsVal)

      grid.append(bindField, portField, hostsField)

      const tokenHeading = doc.createElement('h4')
      tokenHeading.textContent = 'API tokens'

      tokenListContainer = doc.createElement('div')
      tokenListContainer.id = 'remote-access-token-list'

      section.append(
        heading,
        note,
        statusText,
        grid,
        tokenHeading,
        tokenListContainer
      )

      const aboutSection = settingsBody.querySelector('.settings-about')
      if (aboutSection) settingsBody.insertBefore(section, aboutSection)
      else settingsBody.append(section)
      return section
    }

    function renderRemoteSection(ra) {
      if (!ra || typeof ra !== 'object') return
      ensureSection()
      bindVal.value = String(ra.bind || '127.0.0.1')
      portVal.value = String(ra.port || 8787)
      allowedHostsVal.value = Array.isArray(ra.allowedHosts) ? ra.allowedHosts.join(', ') : String(ra.allowedHosts || '')

      const statusParts = [ra.running ? 'Running on ' + ra.bind + ':' + ra.port : 'Stopped']
      if (ra.error) statusParts.push('Error: ' + ra.error)
      statusText.textContent = 'Status: ' + statusParts.join(' · ')

      const tokens = Array.isArray(ra.tokens) ? ra.tokens.filter((t) => !t.revokedAt) : []
      tokenListContainer.replaceChildren(...tokens.map((t) => {
        const row = doc.createElement('div')
        row.className = 'macro-row'
        const label = doc.createElement('span')
        label.textContent = t.name + ' [' + t.scope + '] ' + (t.tokenHint || '')
        row.append(label)
        return row
      }))
    }

    openSettingsBtn.addEventListener('click', async () => {
      try {
        const s = await globalScope.afkDesk?.getSettings?.()
        if (s?.remoteAccess) renderRemoteSection(s.remoteAccess)
      } catch {}
    })
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createBrowserBridge, mountRemoteAccessSettingsUi }
  }

  if (typeof window !== 'undefined') {
    // No-op on window.afkDesk when it already exists (under Electron preload or test stubs)
    if (!window.afkDesk) {
      window.afkDesk = createBrowserBridge()
    }
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mountRemoteAccessSettingsUi(document))
      } else {
        mountRemoteAccessSettingsUi(document)
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
