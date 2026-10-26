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

  function mountRemoteAccessSettingsUi(doc, options = {}) {
    if (!doc) return
    const openSettingsBtn = doc.getElementById('open-settings')
    const settingsDialog = doc.getElementById('settings-dialog')
    const settingsBody = settingsDialog?.querySelector?.('.settings-body')
    if (!openSettingsBtn || !settingsDialog || !settingsBody) return

    const isDesktop = options.isDesktop !== undefined
      ? Boolean(options.isDesktop)
      : (typeof window !== 'undefined' && Boolean(window.afkDesk && !window.afkDesk.isBrowser))

    let section = null
    let statusText = null
    let bindVal = null
    let portVal = null
    let allowedHostsVal = null
    let bindSelect = null
    let bindWarning = null
    let portInput = null
    let allowedHostsInput = null
    let adminPassInput = null
    let enabledCheck = null
    let tokenNameInput = null
    let tokenScopeSelect = null
    let createdTokenOutput = null
    let tokenListContainer = null
    let currentSettingsCache = null

    function ensureSection() {
      if (section) return section
      section = doc.createElement('div')
      section.id = 'remote-access-settings-section'
      section.className = 'form-section'

      const heading = doc.createElement('h3')
      heading.textContent = 'Remote access'

      if (!isDesktop) {
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
      } else {
        const subtitle = doc.createElement('p')
        subtitle.className = 'field-note'
        subtitle.textContent = 'Opt-in local web server for private networks. Disabled by default.'

        statusText = doc.createElement('small')
        statusText.id = 'remote-access-status'
        statusText.textContent = 'Status: Disabled'

        const toggleRow = doc.createElement('label')
        toggleRow.className = 'toggle-row'
        enabledCheck = doc.createElement('input')
        enabledCheck.type = 'checkbox'
        enabledCheck.id = 'remote-access-enabled'
        const toggleSpan = doc.createElement('span')
        toggleSpan.className = 'toggle'
        toggleSpan.setAttribute('aria-hidden', 'true')
        const toggleCopy = doc.createElement('span')
        const toggleStrong = doc.createElement('strong')
        toggleStrong.textContent = 'Enable remote access web server'
        const toggleSmall = doc.createElement('small')
        toggleSmall.textContent = 'Requires setting an administrator password (minimum 12 characters).'
        toggleCopy.append(toggleStrong, toggleSmall)
        toggleRow.append(enabledCheck, toggleSpan, toggleCopy)

        const grid = doc.createElement('div')
        grid.className = 'settings-visual-grid'

        const bindField = doc.createElement('label')
        bindField.className = 'field'
        const bindLabel = doc.createElement('span')
        bindLabel.textContent = 'Bind address'
        bindSelect = doc.createElement('select')
        bindSelect.id = 'remote-access-bind'
        bindWarning = doc.createElement('small')
        bindWarning.id = 'remote-access-bind-warning'
        bindWarning.textContent = '127.0.0.1 is loopback only.'
        bindField.append(bindLabel, bindSelect, bindWarning)

        bindSelect.addEventListener('change', () => {
          if (bindSelect.value === '0.0.0.0') {
            bindWarning.textContent = 'Warning: 0.0.0.0 exposes the server on all network interfaces.'
          } else if (bindSelect.value === '127.0.0.1') {
            bindWarning.textContent = '127.0.0.1 is loopback only.'
          } else {
            bindWarning.textContent = 'Bound to private network interface.'
          }
        })

        const portField = doc.createElement('label')
        portField.className = 'field'
        const portLabel = doc.createElement('span')
        portLabel.textContent = 'Port'
        portInput = doc.createElement('input')
        portInput.id = 'remote-access-port'
        portInput.type = 'number'
        portInput.min = '1'
        portInput.max = '65535'
        portInput.value = '8787'
        portField.append(portLabel, portInput)

        const hostsField = doc.createElement('label')
        hostsField.className = 'field'
        const hostsLabel = doc.createElement('span')
        hostsLabel.textContent = 'Allowed hosts (comma-separated)'
        allowedHostsInput = doc.createElement('input')
        allowedHostsInput.id = 'remote-access-allowed-hosts'
        allowedHostsInput.type = 'text'
        allowedHostsInput.placeholder = 'mybox.tailnet.ts.net'
        hostsField.append(hostsLabel, allowedHostsInput)

        const passField = doc.createElement('label')
        passField.className = 'field'
        const passLabel = doc.createElement('span')
        passLabel.textContent = 'Admin password (set or change)'
        adminPassInput = doc.createElement('input')
        adminPassInput.id = 'remote-access-password'
        adminPassInput.type = 'password'
        adminPassInput.autocomplete = 'new-password'
        adminPassInput.placeholder = 'Minimum 12 characters'
        passField.append(passLabel, adminPassInput)

        grid.append(bindField, portField, hostsField, passField)

        const applyBtn = doc.createElement('button')
        applyBtn.type = 'button'
        applyBtn.id = 'remote-access-apply'
        applyBtn.className = 'button secondary'
        applyBtn.textContent = 'Apply remote access settings'
        applyBtn.addEventListener('click', () => void applyRemoteSettings())

        const tokenHeading = doc.createElement('h4')
        tokenHeading.textContent = 'API tokens'

        const tokenCreateRow = doc.createElement('div')
        tokenCreateRow.className = 'settings-visual-grid'

        tokenNameInput = doc.createElement('input')
        tokenNameInput.id = 'remote-access-token-name'
        tokenNameInput.type = 'text'
        tokenNameInput.placeholder = 'Token name (e.g. Home Assistant)'

        tokenScopeSelect = doc.createElement('select')
        tokenScopeSelect.id = 'remote-access-token-scope'
        for (const s of ['read', 'control', 'admin']) {
          const opt = doc.createElement('option')
          opt.value = s
          opt.textContent = `Scope: ${s}`
          tokenScopeSelect.append(opt)
        }

        const createTokenBtn = doc.createElement('button')
        createTokenBtn.type = 'button'
        createTokenBtn.id = 'remote-access-token-create'
        createTokenBtn.className = 'button secondary'
        createTokenBtn.textContent = 'Create API token'
        createTokenBtn.addEventListener('click', () => void createRemoteToken())

        tokenCreateRow.append(tokenNameInput, tokenScopeSelect, createTokenBtn)

        createdTokenOutput = doc.createElement('pre')
        createdTokenOutput.id = 'remote-access-token-created'
        createdTokenOutput.className = 'persistent-log-view'
        createdTokenOutput.hidden = true

        tokenListContainer = doc.createElement('div')
        tokenListContainer.id = 'remote-access-token-list'

        section.append(
          heading,
          subtitle,
          statusText,
          toggleRow,
          grid,
          applyBtn,
          tokenHeading,
          tokenCreateRow,
          createdTokenOutput,
          tokenListContainer
        )
      }

      const targetSection = settingsBody.querySelector('#notifications-panel') || settingsBody.querySelector('.settings-about')
      if (targetSection) settingsBody.insertBefore(section, targetSection)
      else settingsBody.append(section)
      return section
    }

    async function applyRemoteSettings() {
      if (!globalScope.afkDesk?.saveSettings) return
      try {
        const base = currentSettingsCache || await globalScope.afkDesk.getSettings()
        const newPass = adminPassInput ? adminPassInput.value.trim() : ''
        const isEnabling = enabledCheck ? enabledCheck.checked : false
        const hasAdmin = Boolean(currentSettingsCache?.remoteAccess?.hasAdmin)
        if (isEnabling && !hasAdmin && (!newPass || newPass.length < 12)) {
          if (statusText) statusText.textContent = 'Error: Set an admin password (minimum 12 characters) before enabling remote access.'
          return
        }
        if (newPass && newPass.length < 12) {
          if (statusText) statusText.textContent = 'Error: Admin password must be at least 12 characters.'
          return
        }
        const payload = {
          ...base,
          remoteAccess: {
            _update: true,
            enabled: isEnabling,
            bind: bindSelect ? bindSelect.value : '127.0.0.1',
            port: Number(portInput ? portInput.value : 8787) || 8787,
            allowedHosts: allowedHostsInput ? allowedHostsInput.value.split(',').map((s) => s.trim()).filter(Boolean) : [],
            ...(newPass ? { adminPassword: newPass } : {})
          }
        }
        const saved = await globalScope.afkDesk.saveSettings(payload)
        currentSettingsCache = saved
        if (adminPassInput) adminPassInput.value = ''
        if (saved?.remoteAccess) renderRemoteSection(saved.remoteAccess)
      } catch (err) {
        if (statusText) statusText.textContent = `Error: ${String(err?.message || err)}`
      }
    }

    async function createRemoteToken() {
      if (!globalScope.afkDesk?.saveSettings) return
      try {
        const base = currentSettingsCache || await globalScope.afkDesk.getSettings()
        const saved = await globalScope.afkDesk.saveSettings({
          ...base,
          remoteAccess: {
            _update: true,
            action: 'create-token',
            tokenName: tokenNameInput?.value?.trim() || 'API token',
            tokenScope: tokenScopeSelect?.value || 'read'
          }
        })
        currentSettingsCache = saved
        if (saved?.remoteAccess?.createdToken && createdTokenOutput) {
          createdTokenOutput.textContent = `New token (shown once): ${saved.remoteAccess.createdToken}`
          createdTokenOutput.hidden = false
          if (tokenNameInput) tokenNameInput.value = ''
        }
        if (saved?.remoteAccess) renderRemoteSection(saved.remoteAccess)
      } catch (err) {
        if (statusText) statusText.textContent = `Error: ${String(err?.message || err)}`
      }
    }

    async function revokeRemoteToken(tokenId) {
      if (!globalScope.afkDesk?.saveSettings) return
      try {
        const base = currentSettingsCache || await globalScope.afkDesk.getSettings()
        const saved = await globalScope.afkDesk.saveSettings({
          ...base,
          remoteAccess: {
            _update: true,
            action: 'revoke-token',
            tokenId
          }
        })
        currentSettingsCache = saved
        if (saved?.remoteAccess) renderRemoteSection(saved.remoteAccess)
      } catch (err) {
        if (statusText) statusText.textContent = `Error: ${String(err?.message || err)}`
      }
    }

    function renderRemoteSection(ra) {
      if (!ra || typeof ra !== 'object') return
      ensureSection()

      if (!isDesktop) {
        if (bindVal) bindVal.value = String(ra.bind || '127.0.0.1')
        if (portVal) portVal.value = String(ra.port || 8787)
        if (allowedHostsVal) allowedHostsVal.value = Array.isArray(ra.allowedHosts) ? ra.allowedHosts.join(', ') : String(ra.allowedHosts || '')

        const statusParts = [ra.running ? 'Running on ' + ra.bind + ':' + ra.port : 'Stopped']
        if (ra.error) statusParts.push('Error: ' + ra.error)
        if (statusText) statusText.textContent = 'Status: ' + statusParts.join(' · ')

        const tokens = Array.isArray(ra.tokens) ? ra.tokens.filter((t) => !t.revokedAt) : []
        if (tokenListContainer) {
          tokenListContainer.replaceChildren(...tokens.map((t) => {
            const row = doc.createElement('div')
            row.className = 'macro-row'
            const label = doc.createElement('span')
            label.textContent = t.name + ' [' + t.scope + '] ' + (t.tokenHint || '')
            row.append(label)
            return row
          }))
        }
      } else {
        if (enabledCheck) enabledCheck.checked = Boolean(ra.enabled)
        if (portInput) portInput.value = String(ra.port || 8787)
        if (allowedHostsInput) allowedHostsInput.value = Array.isArray(ra.allowedHosts) ? ra.allowedHosts.join(', ') : String(ra.allowedHosts || '')

        if (bindSelect) {
          const interfaces = Array.isArray(ra.interfaces) ? ra.interfaces : (Array.isArray(ra.availableInterfaces) ? ra.availableInterfaces : [])
          const options = []
          const seen = new Set()
          const addOption = (addr, labelText) => {
            if (seen.has(addr)) return
            seen.add(addr)
            const opt = doc.createElement('option')
            opt.value = addr
            opt.textContent = labelText
            options.push(opt)
          }
          addOption('127.0.0.1', '127.0.0.1 (Loopback only)')
          for (const iface of interfaces) {
            addOption(iface.address, iface.label || `${iface.address} (${iface.name})`)
          }
          addOption('0.0.0.0', '0.0.0.0 (All interfaces — warning)')
          bindSelect.replaceChildren(...options)
          if (ra.bind && seen.has(ra.bind)) bindSelect.value = ra.bind
          else bindSelect.value = '127.0.0.1'
        }

        const statusParts = [ra.running ? 'Running on ' + ra.bind + ':' + ra.port : (ra.enabled ? 'Enabled' : 'Disabled')]
        if (ra.error) statusParts.push('Error: ' + ra.error)
        if (statusText) statusText.textContent = 'Status: ' + statusParts.join(' · ')

        const tokens = Array.isArray(ra.tokens) ? ra.tokens.filter((t) => !t.revokedAt) : []
        if (tokenListContainer) {
          if (!tokens.length) {
            const empty = doc.createElement('p')
            empty.className = 'field-note'
            empty.textContent = 'No active API tokens.'
            tokenListContainer.replaceChildren(empty)
          } else {
            tokenListContainer.replaceChildren(...tokens.map((t) => {
              const row = doc.createElement('div')
              row.className = 'macro-row'
              const label = doc.createElement('span')
              label.textContent = `${t.name} [${t.scope}] ${t.tokenHint || ''}`
              const revokeBtn = doc.createElement('button')
              revokeBtn.type = 'button'
              revokeBtn.className = 'button danger compact-btn'
              revokeBtn.textContent = 'Revoke'
              revokeBtn.addEventListener('click', () => void revokeRemoteToken(t.id))
              row.append(label, revokeBtn)
              return row
            }))
          }
        }
      }
    }

    openSettingsBtn.addEventListener('click', async () => {
      try {
        const s = await globalScope.afkDesk?.getSettings?.()
        currentSettingsCache = s
        if (s?.remoteAccess) renderRemoteSection(s.remoteAccess)
      } catch {}
    })
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createBrowserBridge, mountRemoteAccessSettingsUi }
  }

  if (typeof window !== 'undefined') {
    // No-op on window.afkDesk when it already exists (under Electron preload or test stubs)
    const isDesktop = Boolean(window.afkDesk && !window.afkDesk.isBrowser)
    if (!window.afkDesk) {
      window.afkDesk = createBrowserBridge()
    }
    if (typeof document !== 'undefined') {
      const mount = () => mountRemoteAccessSettingsUi(document, { isDesktop: isDesktop || Boolean(window.afkDesk && !window.afkDesk.isBrowser) })
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount)
      } else {
        mount()
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
