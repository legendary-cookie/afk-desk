'use strict'

;(function initNotificationsPanelGlobal() {
  const EVENT_KINDS = Object.freeze([
    { id: 'connected', label: 'Connected' },
    { id: 'disconnected', label: 'Disconnected' },
    { id: 'kicked', label: 'Kicked' },
    { id: 'banned', label: 'Banned' },
    { id: 'reconnecting', label: 'Reconnecting' },
    { id: 'death', label: 'Death' },
    { id: 'lowHealth', label: 'Low health' },
    { id: 'inventoryFull', label: 'Inventory full' },
    { id: 'macro', label: 'Macro alert / failure' },
    { id: 'test', label: 'Test messages' }
  ])

  const DEFAULT_EVENTS = Object.freeze(['disconnected', 'kicked', 'banned', 'death', 'lowHealth', 'macro'])
  const GUIDE_URL = 'https://github.com/legendary-cookie/afk-desk/blob/main/docs/user-guide/notifications.md'

  function maskHint(channel) {
    if (!channel?.hasSecret) return ''
    const raw = String(channel.secretHint || '').replace(/^•+\s*/, '').slice(-4) || '1234'
    return `•••• ${raw}`
  }

  function unchangedPlaceholder(channel) {
    const masked = maskHint(channel) || '•••• 1234'
    return `${masked} (unchanged)`
  }

  function createNotificationsPanel(ctx) {
    const { api, state, el, toast, cleanError } = ctx
    let channels = []
    let editingChannel = null

    async function callList() {
      if (typeof api.notify?.list === 'function') return api.notify.list()
      if (typeof api['notify:list'] === 'function') return api['notify:list']()
      if (typeof api.notifyList === 'function') return api.notifyList()
      return channels
    }

    async function callSave(payload) {
      if (typeof api.notify?.save === 'function') return api.notify.save(payload)
      if (typeof api['notify:save'] === 'function') return api['notify:save'](payload)
      if (typeof api.notifySave === 'function') return api.notifySave(payload)
      const existing = channels.find((c) => c.id === payload.id)
      const rawSecret = payload.type === 'discord' ? payload.webhookUrl : payload.botToken
      const hasSecret = Boolean(rawSecret || existing?.hasSecret)
      const secretHint = rawSecret ? `••••${String(rawSecret).slice(-4)}` : (existing?.secretHint || '••••1234')
      const saved = {
        id: existing?.id || `notify-${Date.now()}`,
        type: payload.type,
        name: payload.name,
        enabled: payload.enabled !== false,
        events: payload.events || [],
        accountIds: payload.accountIds ?? null,
        includeTimestamp: payload.includeTimestamp === true,
        chatId: payload.chatId || existing?.chatId || '',
        hasSecret,
        secretHint
      }
      const idx = channels.findIndex((c) => c.id === saved.id)
      if (idx === -1) channels.push(saved)
      else channels[idx] = saved
      return saved
    }

    async function callDelete(id) {
      if (typeof api.notify?.delete === 'function') return api.notify.delete(id)
      if (typeof api.notify?.remove === 'function') return api.notify.remove(id)
      if (typeof api['notify:delete'] === 'function') return api['notify:delete'](id)
      if (typeof api.notifyDelete === 'function') return api.notifyDelete(id)
      channels = channels.filter((c) => c.id !== id)
    }

    async function callTest(id) {
      if (typeof api.notify?.test === 'function') return api.notify.test(id)
      if (typeof api['notify:test'] === 'function') return api['notify:test'](id)
      if (typeof api.notifyTest === 'function') return api.notifyTest(id)
      return { ok: true }
    }

    function bind() {
      buildEventsGrid()
      el['add-notification-channel']?.addEventListener('click', () => openChannelDialog(null))
      el['close-notification-channel']?.addEventListener('click', closeChannelDialog)
      el['cancel-notification-channel']?.addEventListener('click', closeChannelDialog)
      el['notification-channel-form']?.addEventListener('submit', handleSaveChannel)
      el['notify-channel-type']?.addEventListener('change', syncChannelTypeFields)
      el['notify-account-mode']?.addEventListener('change', syncAccountFilterFields)
      el['delete-notification-channel']?.addEventListener('click', () => {
        if (editingChannel?.id) void handleDeleteChannel(editingChannel)
      })
      el['test-notification-channel']?.addEventListener('click', () => {
        if (editingChannel?.id) void handleTestChannel(editingChannel)
      })

      document.querySelectorAll('.notify-guide-link').forEach((link) => {
        link.addEventListener('click', (event) => {
          event.preventDefault()
          const url = link.dataset.externalUrl || GUIDE_URL
          if (typeof api.openExternal === 'function') {
            void api.openExternal(url).catch((err) => toast(cleanError(err), 'error'))
          }
        })
      })
    }

    function buildEventsGrid() {
      const grid = el['notify-events-grid']
      if (!grid) return
      grid.replaceChildren(...EVENT_KINDS.map((kind) => {
        const label = document.createElement('label')
        label.className = 'check-row'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.value = kind.id
        input.dataset.eventKind = kind.id
        const span = document.createElement('span')
        span.textContent = kind.label
        label.append(input, span)
        return label
      }))
    }

    async function load() {
      try {
        const list = await callList()
        channels = Array.isArray(list) ? list : []
        renderChannelList()
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function formatEventsSummary(events) {
      if (!Array.isArray(events) || !events.length) return 'No events selected'
      if (events.length === EVENT_KINDS.length) return 'All events'
      if (events.length <= 4) return events.join(', ')
      return `${events.slice(0, 3).join(', ')} +${events.length - 3} more`
    }

    function renderChannelList() {
      const container = el['notification-channel-list']
      if (!container) return
      if (!channels.length) {
        const empty = document.createElement('div')
        empty.className = 'notification-channel-empty'
        empty.textContent = 'No notification channels configured yet. Click “＋ Add channel” to add Discord or Telegram.'
        container.replaceChildren(empty)
        return
      }

      container.replaceChildren(...channels.map((channel) => {
        const row = document.createElement('div')
        row.className = 'notification-channel-row'
        row.dataset.channelId = channel.id
        row.setAttribute('role', 'listitem')

        const icon = document.createElement('span')
        const isDiscord = channel.type === 'discord'
        icon.className = `notify-type-badge ${isDiscord ? 'discord' : 'telegram'}`
        icon.textContent = isDiscord ? 'Discord' : 'Telegram'

        const copy = document.createElement('div')
        copy.className = 'notification-channel-copy'
        const titleRow = document.createElement('div')
        titleRow.className = 'notification-channel-title'
        const nameEl = document.createElement('strong')
        nameEl.textContent = channel.name || 'Unnamed channel'
        const secretBadge = document.createElement('span')
        secretBadge.className = 'notify-secret-hint'
        secretBadge.textContent = channel.hasSecret ? maskHint(channel) : 'No secret saved'
        titleRow.append(nameEl, secretBadge)

        const metaRow = document.createElement('small')
        metaRow.className = 'notification-channel-meta'
        const acctSummary = Array.isArray(channel.accountIds) ? `${channel.accountIds.length} account(s)` : 'All accounts'
        metaRow.textContent = `${formatEventsSummary(channel.events)} · ${acctSummary}${channel.includeTimestamp ? ' · timestamped' : ''}`
        copy.append(titleRow, metaRow)

        const actions = document.createElement('div')
        actions.className = 'notification-channel-actions'

        const toggleLabel = document.createElement('label')
        toggleLabel.className = 'compact-toggle'
        const toggleInput = document.createElement('input')
        toggleInput.type = 'checkbox'
        toggleInput.className = 'notify-channel-enable-toggle'
        toggleInput.checked = channel.enabled !== false
        toggleInput.setAttribute('aria-label', `Enable ${channel.name}`)
        const toggleSpan = document.createElement('span')
        toggleSpan.textContent = toggleInput.checked ? 'Enabled' : 'Disabled'
        toggleInput.addEventListener('change', async () => {
          try {
            await callSave({
              id: channel.id,
              type: channel.type,
              name: channel.name,
              enabled: toggleInput.checked,
              events: channel.events || [],
              accountIds: channel.accountIds ?? null,
              includeTimestamp: channel.includeTimestamp === true,
              chatId: channel.chatId || ''
            })
            await load()
            toast(toggleInput.checked ? 'Notification channel enabled.' : 'Notification channel disabled.')
          } catch (error) {
            toggleInput.checked = !toggleInput.checked
            toast(cleanError(error), 'error')
          }
        })
        toggleLabel.append(toggleInput, toggleSpan)

        const testBtn = document.createElement('button')
        testBtn.type = 'button'
        testBtn.className = 'button secondary compact-btn notify-test-btn'
        testBtn.textContent = 'Send test'
        testBtn.addEventListener('click', () => void handleTestChannel(channel))

        const editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'button secondary compact-btn notify-edit-btn'
        editBtn.textContent = 'Edit'
        editBtn.addEventListener('click', () => openChannelDialog(channel))

        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'button danger compact-btn notify-delete-btn'
        delBtn.textContent = 'Delete'
        delBtn.addEventListener('click', () => void handleDeleteChannel(channel))

        actions.append(toggleLabel, testBtn, editBtn, delBtn)
        row.append(icon, copy, actions)
        return row
      }))
    }

    function openChannelDialog(channel = null) {
      editingChannel = channel
      el['notification-channel-form']?.reset()
      if (el['notify-channel-error']) el['notify-channel-error'].hidden = true

      el['notification-channel-dialog-title'].textContent = channel ? 'Edit notification channel' : 'Add notification channel'
      el['notify-channel-id'].value = channel?.id || ''
      el['notify-channel-type'].value = channel?.type || 'discord'
      el['notify-channel-name'].value = channel?.name || ''
      el['notify-channel-enabled'].checked = channel ? channel.enabled !== false : true

      // Security requirement F: never echo secrets back into inputs; show placeholder "•••• 1234 (unchanged)"
      el['notify-webhook-url'].value = ''
      el['notify-webhook-url'].placeholder = channel?.type === 'discord' && channel?.hasSecret
        ? unchangedPlaceholder(channel)
        : 'https://discord.com/api/webhooks/...'

      el['notify-bot-token'].value = ''
      el['notify-bot-token'].placeholder = channel?.type === 'telegram' && channel?.hasSecret
        ? unchangedPlaceholder(channel)
        : '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ'

      el['notify-chat-id'].value = channel?.chatId || ''

      const activeEvents = new Set(channel ? (channel.events || []) : DEFAULT_EVENTS)
      el['notify-events-grid']?.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        box.checked = activeEvents.has(box.value)
      })

      const hasAccountFilter = Array.isArray(channel?.accountIds)
      el['notify-account-mode'].value = hasAccountFilter ? 'selected' : 'all'
      populateAccountChecklist(hasAccountFilter ? channel.accountIds : [])
      syncAccountFilterFields()
      syncChannelTypeFields()

      el['notify-include-timestamp'].checked = channel ? channel.includeTimestamp === true : true
      el['delete-notification-channel'].hidden = !channel
      el['test-notification-channel'].hidden = !channel

      if (!el['notification-channel-dialog'].open) el['notification-channel-dialog'].showModal()
      el['notify-channel-name']?.focus()
    }

    function closeChannelDialog() {
      if (el['notification-channel-dialog']?.open) el['notification-channel-dialog'].close()
    }

    function syncChannelTypeFields() {
      const type = el['notify-channel-type']?.value || 'discord'
      if (el['notify-discord-fields']) el['notify-discord-fields'].hidden = type !== 'discord'
      if (el['notify-telegram-fields']) el['notify-telegram-fields'].hidden = type !== 'telegram'
    }

    function populateAccountChecklist(selectedIds = []) {
      const container = el['notify-accounts-checklist']
      if (!container) return
      const set = new Set(selectedIds)
      container.replaceChildren(...(state.accounts || []).map((acc) => {
        const label = document.createElement('label')
        label.className = 'check-row'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.value = acc.id
        input.checked = set.has(acc.id)
        const text = document.createElement('span')
        text.textContent = acc.profileName || acc.label || acc.username
        label.append(input, text)
        return label
      }))
    }

    function syncAccountFilterFields() {
      const mode = el['notify-account-mode']?.value || 'all'
      if (el['notify-accounts-checklist']) {
        el['notify-accounts-checklist'].hidden = mode !== 'selected'
      }
    }

    async function handleSaveChannel(event) {
      event.preventDefault()
      if (el['notify-channel-error']) el['notify-channel-error'].hidden = true

      const type = el['notify-channel-type'].value
      const name = el['notify-channel-name'].value.trim()
      if (!name) {
        showError('Channel name is required.')
        return
      }

      const events = []
      el['notify-events-grid']?.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        if (box.checked) events.push(box.value)
      })

      let accountIds = null
      if (el['notify-account-mode'].value === 'selected') {
        accountIds = []
        el['notify-accounts-checklist']?.querySelectorAll('input[type="checkbox"]').forEach((box) => {
          if (box.checked) accountIds.push(box.value)
        })
      }

      const payload = {
        id: el['notify-channel-id'].value || undefined,
        type,
        name,
        enabled: el['notify-channel-enabled'].checked,
        events,
        accountIds,
        includeTimestamp: el['notify-include-timestamp'].checked
      }

      if (type === 'discord') {
        const webhookUrl = el['notify-webhook-url'].value.trim()
        if (!editingChannel?.hasSecret && !webhookUrl) {
          showError('Enter a Discord webhook URL.')
          return
        }
        // Only send webhookUrl when changed (non-empty)
        if (webhookUrl) payload.webhookUrl = webhookUrl
      } else {
        const botToken = el['notify-bot-token'].value.trim()
        const chatId = el['notify-chat-id'].value.trim()
        if (!editingChannel?.hasSecret && !botToken) {
          showError('Enter a Telegram bot token.')
          return
        }
        if (!chatId) {
          showError('Enter a Telegram chat ID.')
          return
        }
        if (botToken) payload.botToken = botToken
        payload.chatId = chatId
      }

      try {
        await callSave(payload)
        closeChannelDialog()
        await load()
        toast('Notification channel saved.')
      } catch (error) {
        showError(cleanError(error))
      }
    }

    function showError(message) {
      if (!el['notify-channel-error']) return
      el['notify-channel-error'].textContent = message
      el['notify-channel-error'].hidden = false
    }

    async function handleTestChannel(channel) {
      try {
        const result = await callTest(channel.id)
        if (result && result.ok === false) {
          toast(`Test notification failed: ${result.error || 'Unknown error'}`, 'error')
        } else {
          toast(`Test notification sent to ${channel.name || channel.type}.`)
        }
      } catch (error) {
        toast(`Test notification failed: ${cleanError(error)}`, 'error')
      }
    }

    async function handleDeleteChannel(channel) {
      if (!channel?.id || !confirm(`Delete notification channel "${channel.name}"?`)) return
      try {
        await callDelete(channel.id)
        if (el['notification-channel-dialog']?.open) closeChannelDialog()
        await load()
        toast('Notification channel deleted.')
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    bind()

    return {
      load,
      openChannelDialog
    }
  }

  window.afkNotificationsPanel = { createNotificationsPanel }
})()
