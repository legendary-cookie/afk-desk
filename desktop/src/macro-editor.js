'use strict'

;(function initMacroEditorGlobal() {
  const TRIGGER_TYPES = Object.freeze({
    manual: { label: 'Manual (Run now)', editions: ['java', 'bedrock'] },
    join: { label: 'On server join', editions: ['java', 'bedrock'] },
    worldChange: { label: 'On world / server change', editions: ['java'] },
    timer: { label: 'Timer interval', editions: ['java', 'bedrock'] },
    schedule: { label: 'Daily schedule (HH:MM)', editions: ['java', 'bedrock'] },
    chat: { label: 'Chat message match', editions: ['java', 'bedrock'] },
    death: { label: 'On death', editions: ['java'] },
    disconnected: { label: 'On disconnect', editions: ['java', 'bedrock'] },
    healthBelow: { label: 'Health drops below', editions: ['java'] },
    hungerBelow: { label: 'Hunger drops below', editions: ['java'] },
    inventoryFull: { label: 'Inventory becomes full', editions: ['java'] },
    inventoryChanged: { label: 'Inventory changes', editions: ['java'] },
    windowOpen: { label: 'Server window opens', editions: ['java'] }
  })

  const STEP_GROUPS = Object.freeze([
    {
      group: 'Communication',
      types: ['chat', 'notify']
    },
    {
      group: 'Movement',
      types: ['move', 'look', 'control']
    },
    {
      group: 'Clicking',
      types: ['leftClick', 'rightClick']
    },
    {
      group: 'Inventory & GUI',
      types: ['selectHotbar', 'holdItem', 'useInventory', 'useGui', 'closeGui', 'waitForWindow', 'drop', 'dropAll', 'deposit']
    },
    {
      group: 'Flow control',
      types: ['wait', 'set', 'if', 'repeat', 'stop']
    },
    {
      group: 'Connection',
      types: ['disconnect', 'reconnect']
    }
  ])

  const STEP_TYPES = Object.freeze({
    chat: { label: 'Send chat / command', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'chat', message: '/afk' }) },
    wait: { label: 'Wait / delay', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'wait', ms: 1000 }) },
    notify: { label: 'Send notification', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'notify', message: 'Macro alert', desktop: true, webhook: false }) },
    move: { label: 'Move (walk)', editions: ['java'], defaultStep: () => ({ type: 'move', control: 'forward', durationMs: 500 }) },
    look: { label: 'Look / rotate', editions: ['java'], defaultStep: () => ({ type: 'look', mode: 'relative', yaw: 0.45, pitch: 0 }) },
    control: { label: 'Sneak / jump / sprint', editions: ['java'], defaultStep: () => ({ type: 'control', control: 'sneak', action: 'hold' }) },
    leftClick: { label: 'Left click', editions: ['java'], defaultStep: () => ({ type: 'leftClick', action: 'once' }) },
    rightClick: { label: 'Right click', editions: ['java'], defaultStep: () => ({ type: 'rightClick', action: 'once' }) },
    selectHotbar: { label: 'Select hotbar slot', editions: ['java'], defaultStep: () => ({ type: 'selectHotbar', slot: 0 }) },
    holdItem: { label: 'Hold item by name', editions: ['java'], defaultStep: () => ({ type: 'holdItem', name: 'cooked_beef' }) },
    useInventory: { label: 'Click player inventory', editions: ['java'], defaultStep: () => ({ type: 'useInventory', select: { slot: 9 }, click: 'left' }) },
    useGui: { label: 'Click open GUI slot', editions: ['java'], defaultStep: () => ({ type: 'useGui', select: { slot: 0 }, click: 'left' }) },
    closeGui: { label: 'Close open GUI', editions: ['java'], defaultStep: () => ({ type: 'closeGui' }) },
    waitForWindow: { label: 'Wait for server window', editions: ['java'], defaultStep: () => ({ type: 'waitForWindow', title: '', giveUpAfterMs: 10000 }) },
    drop: { label: 'Drop item', editions: ['java'], defaultStep: () => ({ type: 'drop', select: { slot: 36 }, count: 1 }) },
    dropAll: { label: 'Drop all matching items', editions: ['java'], defaultStep: () => ({ type: 'dropAll', filter: '' }) },
    deposit: { label: 'Deposit item', editions: ['java'], defaultStep: () => ({ type: 'deposit', select: { slot: 36 }, count: 64 }) },
    disconnect: { label: 'Disconnect account', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'disconnect' }) },
    reconnect: { label: 'Reconnect account', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'reconnect', delayMs: 5000 }) },
    set: { label: 'Set variable', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'set', variable: 'state', value: 'ready' }) },
    if: { label: 'If / Else branch', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'if', condition: { type: 'healthBelow', value: 10 }, then: [{ type: 'chat', message: '/heal' }], else: [] }) },
    repeat: { label: 'Repeat loop', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'repeat', times: 3, steps: [{ type: 'wait', ms: 1000 }] }) },
    stop: { label: 'Stop macro run', editions: ['java', 'bedrock'], defaultStep: () => ({ type: 'stop' }) }
  })

  const CONDITION_TYPES = Object.freeze([
    { value: 'always', label: 'Always' },
    { value: 'online', label: 'Connection status' },
    { value: 'healthBelow', label: 'Health below' },
    { value: 'hungerBelow', label: 'Hunger below' },
    { value: 'hasItem', label: 'Has inventory item' },
    { value: 'inventoryFull', label: 'Inventory is full' },
    { value: 'windowOpen', label: 'Server window is open' },
    { value: 'variableEquals', label: 'Variable equals' },
    { value: 'not', label: 'NOT (invert condition)' }
  ])

  const TEMPLATES = Object.freeze({
    'join-afk': () => ({
      name: 'Join /afk',
      enabled: true,
      targets: { mode: 'all' },
      trigger: { type: 'join', cooldownMs: 0 },
      stopWhen: [],
      concurrency: 'skip',
      onError: 'continue',
      defaultDelayMs: 1000,
      maxRuntimeMs: null,
      steps: [
        { type: 'wait', ms: 1500, jitterMs: 500 },
        { type: 'chat', message: '/afk' }
      ]
    }),
    'timer-look': () => ({
      name: 'Timer anti-AFK look-around',
      enabled: true,
      targets: { mode: 'all' },
      trigger: { type: 'timer', intervalMs: 45000, jitterMs: 5000 },
      stopWhen: [],
      concurrency: 'skip',
      onError: 'continue',
      defaultDelayMs: 500,
      maxRuntimeMs: null,
      steps: [
        { type: 'look', mode: 'relative', yaw: 0.35, pitch: 0 },
        { type: 'wait', ms: 400 },
        { type: 'look', mode: 'relative', yaw: -0.35, pitch: 0 }
      ]
    }),
    'hunger-eat': () => ({
      name: 'Auto-eat when hunger < 14',
      enabled: true,
      targets: { mode: 'all' },
      trigger: { type: 'hungerBelow', below: 14 },
      stopWhen: [],
      concurrency: 'skip',
      onError: 'continue',
      defaultDelayMs: 250,
      maxRuntimeMs: null,
      steps: [
        { type: 'holdItem', name: 'cooked_beef' },
        { type: 'rightClick', action: 'hold' },
        { type: 'wait', ms: 1800 },
        { type: 'rightClick', action: 'release' }
      ]
    }),
    'inv-deposit': () => ({
      name: 'Inventory full → deposit',
      enabled: true,
      targets: { mode: 'all' },
      trigger: { type: 'inventoryFull' },
      stopWhen: [],
      concurrency: 'skip',
      onError: 'continue',
      defaultDelayMs: 500,
      maxRuntimeMs: null,
      steps: [
        { type: 'deposit', select: { slot: 9 }, count: 64 },
        { type: 'notify', message: 'Deposited full inventory stack.', desktop: true, webhook: false }
      ]
    }),
    'kick-reconnect': () => ({
      name: 'Disconnect → notify & reconnect',
      enabled: true,
      targets: { mode: 'all' },
      trigger: { type: 'disconnected' },
      stopWhen: [],
      concurrency: 'skip',
      onError: 'continue',
      defaultDelayMs: 500,
      maxRuntimeMs: null,
      steps: [
        { type: 'notify', message: 'Account disconnected, reconnecting in 10s…', desktop: true, webhook: false },
        { type: 'wait', ms: 10000 },
        { type: 'reconnect', delayMs: 1000 }
      ]
    })
  })

  function newMacroId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return `macro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function pathEquals(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
  }

  function formatDuration(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n < 0) return '0ms'
    if (n < 1000) return `${Math.round(n)}ms`
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s`
  }

  function statusLabel(status, reason) {
    const map = {
      started: 'Running',
      step: 'Running',
      stepFailed: 'Running (step failed)',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
      stopped: 'Stopped',
      skipped: 'Skipped',
      idle: 'Idle'
    }
    const base = map[status] || String(status || 'Idle')
    return reason ? `${base} (${reason})` : base
  }

  function statusTone(status) {
    if (status === 'started' || status === 'step' || status === 'running') return 'running'
    if (status === 'completed') return 'completed'
    if (status === 'failed' || status === 'stepFailed') return 'failed'
    if (status === 'cancelled' || status === 'stopped' || status === 'interrupted' || status === 'skipped') return 'warning'
    return 'idle'
  }

  function createMacroEditor(ctx) {
    const { api, state, el, toast, cleanError } = ctx

    let macros = []
    let validationMap = {}
    let selectedMacroId = null
    let draft = null
    let draftValidationErrors = []
    let history = []
    let historyIndex = -1
    let selectedStepPath = [0]
    let stepInsertTarget = null // null = root end, or { listPath: number[], index?: number }
    let collapsedPaths = new Set()
    let draggedStepPath = null
    let activeTab = 'editor'
    // Live run tracking: key `${macroId}:${accountId}` -> RunEvent, and macroId -> latest status summary
    const liveByMacroAccount = new Map()
    const lastStatusByMacro = new Map()
    const runsCache = new Map()

    function bind() {
      populateTriggerSelect()
      populateTemplatePicker()
      el['close-automation']?.addEventListener('click', () => el['automation-dialog']?.close())
      el['macro-library-search']?.addEventListener('input', renderLibraryList)
      el['macro-new-btn']?.addEventListener('click', () => createNewMacro())
      el['macro-template-picker']?.addEventListener('change', (event) => {
        const key = event.target.value
        event.target.value = ''
        if (key && TEMPLATES[key]) createNewMacro(TEMPLATES[key]())
      })
      el['macro-duplicate-btn']?.addEventListener('click', () => void duplicateSelectedMacro())
      el['macro-delete-btn']?.addEventListener('click', () => void deleteSelectedMacro())
      el['macro-import-btn']?.addEventListener('click', openImportPanel)
      el['macro-export-btn']?.addEventListener('click', () => void openExportPanel())
      el['macro-import-file']?.addEventListener('change', handleImportFile)
      el['macro-json-confirm-import']?.addEventListener('click', () => void applyJsonImport())
      el['macro-json-copy']?.addEventListener('click', () => void copyJsonExport())
      el['macro-json-close']?.addEventListener('click', () => { el['macro-json-panel'].hidden = true })

      el['macro-tab-editor']?.addEventListener('click', () => switchTab('editor'))
      el['macro-tab-runs']?.addEventListener('click', () => switchTab('runs'))
      el['macro-undo-btn']?.addEventListener('click', undoDraft)
      el['macro-redo-btn']?.addEventListener('click', redoDraft)
      el['macro-close-editor-btn']?.addEventListener('click', closeEditorView)
      el['macro-save-btn']?.addEventListener('click', () => void saveCurrentMacro())

      el['macro-watch-account']?.addEventListener('change', () => {
        renderLiveHeader()
        renderSteps()
      })
      el['macro-run-now']?.addEventListener('click', () => void runSelectedMacroNow())
      el['macro-stop-run']?.addEventListener('click', () => void stopWatchedAccount())
      el['macro-refresh-runs']?.addEventListener('click', () => void loadRunsForSelected())

      el['macro-name-input']?.addEventListener('input', () => {
        if (!draft) return
        draft.name = el['macro-name-input'].value
        pushHistoryDebounced()
      })
      el['macro-editor-enabled']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        draft.enabled = el['macro-editor-enabled'].checked
      })
      el['macro-trigger-type']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        const type = el['macro-trigger-type'].value
        const cooldownMs = draft.trigger?.cooldownMs || 0
        draft.trigger = defaultTriggerFor(type, cooldownMs)
        renderTriggerFields()
        renderSteps()
      })
      el['macro-trigger-cooldown']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        const sec = Math.max(0, Math.min(Number(el['macro-trigger-cooldown'].value) || 0, 86400))
        draft.trigger.cooldownMs = Math.round(sec * 1000)
      })
      el['macro-target-mode']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        const mode = el['macro-target-mode'].value
        if (mode === 'all') draft.targets = { mode: 'all' }
        else if (mode === 'accounts') {
          const defaultIds = state.selectedId ? [state.selectedId] : state.accounts.slice(0, 1).map((a) => a.id)
          draft.targets = { mode: 'accounts', accountIds: defaultIds }
        } else {
          draft.targets = { mode: 'tags', tags: [] }
        }
        renderTargetsSection()
        syncEditionCapabilities()
        renderSteps()
      })
      el['macro-target-tags-input']?.addEventListener('change', () => {
        if (!draft || draft.targets?.mode !== 'tags') return
        pushHistory()
        draft.targets.tags = el['macro-target-tags-input'].value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        renderTargetsSection()
      })
      el['macro-concurrency']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        draft.concurrency = el['macro-concurrency'].value === 'override' ? 'override' : 'skip'
      })
      el['macro-on-error']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        draft.onError = el['macro-on-error'].value === 'stop' ? 'stop' : 'continue'
      })
      el['macro-default-delay']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        draft.defaultDelayMs = Math.max(0, Math.min(Math.round(Number(el['macro-default-delay'].value) || 0), 60000))
      })
      el['macro-max-runtime']?.addEventListener('change', () => {
        if (!draft) return
        pushHistory()
        const sec = Number(el['macro-max-runtime'].value) || 0
        draft.maxRuntimeMs = sec > 0 ? Math.max(1000, Math.round(sec * 1000)) : null
      })
      el['macro-add-stop-cond']?.addEventListener('click', () => {
        if (!draft) return
        pushHistory()
        draft.stopWhen ||= []
        draft.stopWhen.push({ type: 'healthBelow', value: 6 })
        renderStopConditions()
      })
      el['macro-open-step-picker']?.addEventListener('click', () => {
        stepInsertTarget = null
        toggleStepPicker()
      })

      el['automation-dialog']?.addEventListener('keydown', handleDialogKeyDown)
      el['automation-dialog']?.addEventListener('cancel', (event) => {
        if (!el['macro-step-picker']?.hidden) {
          event.preventDefault()
          el['macro-step-picker'].hidden = true
          return
        }
      })

      if (typeof api.onMacroRun === 'function') {
        api.onMacroRun(handleMacroRunEvent)
      }
    }

    function defaultTriggerFor(type, cooldownMs = 0) {
      const base = cooldownMs > 0 ? { type, cooldownMs } : { type }
      if (type === 'timer') return { ...base, intervalMs: 60000, jitterMs: 0 }
      if (type === 'schedule') return { ...base, at: '08:00' }
      if (type === 'chat') return { ...base, match: 'contains', pattern: '', sources: ['chat', 'system'] }
      if (type === 'healthBelow') return { ...base, below: 8 }
      if (type === 'hungerBelow') return { ...base, below: 14 }
      if (type === 'windowOpen') return { ...base, title: '' }
      return base
    }

    function targetEditionsForDraft(currentDraft = draft) {
      const editions = new Set()
      if (!currentDraft?.targets) return editions
      const accounts = state.accounts || []
      if (currentDraft.targets.mode === 'all') {
        accounts.forEach((a) => editions.add(a.edition === 'bedrock' ? 'bedrock' : 'java'))
      } else if (currentDraft.targets.mode === 'accounts') {
        const set = new Set(currentDraft.targets.accountIds || [])
        accounts.filter((a) => set.has(a.id)).forEach((a) => editions.add(a.edition === 'bedrock' ? 'bedrock' : 'java'))
      } else if (currentDraft.targets.mode === 'tags') {
        const tags = new Set(currentDraft.targets.tags || [])
        accounts.filter((a) => Array.isArray(a.tags) && a.tags.some((t) => tags.has(t))).forEach((a) => editions.add(a.edition === 'bedrock' ? 'bedrock' : 'java'))
      }
      return editions
    }

    function unsupportedEditionReason(supportedEditions) {
      const targetEditions = targetEditionsForDraft()
      if (targetEditions.has('bedrock') && !supportedEditions.includes('bedrock')) {
        return 'Not supported on Bedrock Edition target accounts (Java Edition only).'
      }
      if (targetEditions.has('java') && !supportedEditions.includes('java')) {
        return 'Not supported on Java Edition target accounts.'
      }
      return ''
    }

    function populateTriggerSelect() {
      if (!el['macro-trigger-type']) return
      const options = Object.entries(TRIGGER_TYPES).map(([type, info]) => {
        const opt = document.createElement('option')
        opt.value = type
        opt.textContent = info.label
        return opt
      })
      el['macro-trigger-type'].replaceChildren(...options)
    }

    function populateTemplatePicker() {
      const picker = el['macro-template-picker']
      if (!picker) return
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = 'Templates…'
      const options = Object.entries(TEMPLATES).map(([key, make]) => {
        const opt = document.createElement('option')
        opt.value = key
        opt.textContent = make().name
        return opt
      })
      picker.replaceChildren(placeholder, ...options)
    }

    function syncEditionCapabilities() {
      if (!el['macro-trigger-type']) return
      for (const option of el['macro-trigger-type'].options) {
        const info = TRIGGER_TYPES[option.value]
        if (!info) continue
        const reason = unsupportedEditionReason(info.editions)
        option.disabled = Boolean(reason)
        option.title = reason || ''
        option.textContent = reason ? `${info.label} (Java only)` : info.label
      }
      if (!el['macro-step-picker']?.hidden) renderStepPicker()
    }

    async function open() {
      populateWatchAccounts()
      await refreshLibrary()
      if (!selectedMacroId && macros.length) {
        selectMacro(macros[0].id)
      } else if (selectedMacroId) {
        const found = macros.find((m) => m.id === selectedMacroId)
        if (found) selectMacro(found.id)
        else if (macros.length) selectMacro(macros[0].id)
        else setDraft(null)
      } else {
        setDraft(null)
      }
      if (!el['automation-dialog'].open) el['automation-dialog'].showModal()
      el['macro-library-search']?.focus()
    }

    function populateWatchAccounts() {
      if (!el['macro-watch-account']) return
      const current = el['macro-watch-account'].value || state.selectedId || ''
      const options = (state.accounts || []).map((account) => {
        const opt = document.createElement('option')
        opt.value = account.id
        opt.textContent = `${account.profileName || account.label || account.username}${account.edition === 'bedrock' ? ' (Bedrock)' : ''}`
        return opt
      })
      if (!options.length) {
        const empty = document.createElement('option')
        empty.value = ''
        empty.textContent = 'No accounts'
        options.push(empty)
      }
      el['macro-watch-account'].replaceChildren(...options)
      if (current && (state.accounts || []).some((a) => a.id === current)) {
        el['macro-watch-account'].value = current
      } else if (state.selectedId) {
        el['macro-watch-account'].value = state.selectedId
      }
    }

    async function refreshLibrary() {
      try {
        if (api.macros?.list) {
          const result = await api.macros.list()
          macros = Array.isArray(result?.macros) ? result.macros : []
          validationMap = result?.validation && typeof result.validation === 'object' ? result.validation : {}
        } else {
          macros = []
          validationMap = {}
        }
        await Promise.all(macros.slice(0, 30).map(async (macro) => {
          if (api.macros?.runs && !lastStatusByMacro.has(macro.id)) {
            try {
              const records = await api.macros.runs(macro.id)
              if (Array.isArray(records) && records.length) {
                runsCache.set(macro.id, records)
                const last = records[records.length - 1]
                lastStatusByMacro.set(macro.id, { status: last.status, reason: last.reason, at: last.endedAt || last.startedAt })
              }
            } catch {}
          }
        }))
        renderLibraryList()
        renderLiveHeader()
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function triggerSummaryText(trigger = {}) {
      const type = trigger.type || 'manual'
      if (type === 'timer') {
        const sec = Math.round((trigger.intervalMs || 60000) / 1000)
        const jit = trigger.jitterMs ? ` ±${Math.round(trigger.jitterMs / 1000)}s` : ''
        return `Timer: every ${sec}s${jit}`
      }
      if (type === 'schedule') return `Schedule: ${trigger.at || '08:00'}`
      if (type === 'chat') return `Chat ${trigger.match === 'glob' ? 'glob' : 'contains'}: “${trigger.pattern || ''}”`
      if (type === 'healthBelow') return `Health < ${trigger.below ?? 8}`
      if (type === 'hungerBelow') return `Hunger < ${trigger.below ?? 14}`
      if (type === 'windowOpen') return trigger.title ? `Window: “${trigger.title}”` : 'Window opens'
      return TRIGGER_TYPES[type]?.label || `On ${type}`
    }

    function targetsSummaryText(targets = {}) {
      if (targets.mode === 'all') return 'All accounts'
      if (targets.mode === 'tags') {
        const tags = Array.isArray(targets.tags) ? targets.tags : []
        return tags.length ? `Tags: ${tags.join(', ')}` : 'Tags: none'
      }
      const ids = Array.isArray(targets.accountIds) ? targets.accountIds : []
      if (!ids.length) return 'No accounts'
      const names = ids.map((id) => {
        const acc = (state.accounts || []).find((a) => a.id === id)
        return acc ? (acc.profileName || acc.label || acc.id) : id
      })
      return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
    }

    function renderLibraryList() {
      if (!el['macro-library-list']) return
      const query = (el['macro-library-search']?.value || '').trim().toLowerCase()
      const filtered = macros.filter((macro) => {
        if (!query) return true
        const hay = `${macro.name} ${macro.trigger?.type || ''} ${macro.trigger?.pattern || ''} ${(macro.steps || []).map((s) => `${s.type} ${s.message || ''}`).join(' ')}`.toLowerCase()
        return hay.includes(query)
      })

      if (!filtered.length) {
        const empty = document.createElement('div')
        empty.className = 'macro-library-empty'
        empty.textContent = macros.length ? 'No macros match your search.' : 'No macros yet. Click “＋ New” to create one.'
        el['macro-library-list'].replaceChildren(empty)
        return
      }

      el['macro-library-list'].replaceChildren(...filtered.map((macro) => {
        const item = document.createElement('div')
        const isSelected = macro.id === selectedMacroId
        const errors = validationMap[macro.id] || []
        const hasErrors = errors.length > 0
        item.className = `macro-library-item${isSelected ? ' selected' : ''}${hasErrors ? ' has-errors' : ''}`
        item.dataset.macroId = macro.id
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(isSelected))
        item.tabIndex = 0

        const top = document.createElement('div')
        top.className = 'macro-library-item-top'

        const titleWrap = document.createElement('div')
        titleWrap.className = 'macro-library-item-title'
        const nameEl = document.createElement('strong')
        nameEl.textContent = macro.name || 'Untitled macro'
        titleWrap.append(nameEl)
        if (macro.origin?.v2Only) {
          const v2Badge = document.createElement('span')
          v2Badge.className = 'macro-badge v2-only'
          v2Badge.textContent = 'v2 only'
          v2Badge.title = 'Uses Macro Engine v2 features not representable in beta.9'
          titleWrap.append(v2Badge)
        }

        const toggleLabel = document.createElement('label')
        toggleLabel.className = 'compact-toggle macro-item-toggle'
        const toggleInput = document.createElement('input')
        toggleInput.type = 'checkbox'
        toggleInput.className = 'macro-enable-checkbox'
        toggleInput.checked = macro.enabled !== false && !hasErrors
        toggleInput.disabled = hasErrors
        toggleInput.setAttribute('aria-label', `Enable ${macro.name || 'macro'}`)
        const errorReason = hasErrors ? errors.map((e) => e.message).join(' ') : ''
        if (hasErrors) {
          toggleInput.title = `Cannot enable: ${errorReason}`
          toggleLabel.title = `Cannot enable: ${errorReason}`
        }
        const toggleText = document.createElement('span')
        toggleText.textContent = toggleInput.checked ? 'On' : 'Off'
        toggleLabel.addEventListener('click', (event) => event.stopPropagation())
        toggleInput.addEventListener('change', async (event) => {
          event.stopPropagation()
          try {
            const saved = await api.macros.setEnabled(macro.id, toggleInput.checked)
            const idx = macros.findIndex((m) => m.id === macro.id)
            if (idx !== -1 && saved) macros[idx] = saved
            if (draft && draft.id === macro.id) {
              draft.enabled = toggleInput.checked
              if (el['macro-editor-enabled']) el['macro-editor-enabled'].checked = toggleInput.checked
            }
            await refreshLibrary()
            toast(toggleInput.checked ? 'Macro enabled.' : 'Macro disabled.')
          } catch (error) {
            toggleInput.checked = !toggleInput.checked
            toast(cleanError(error), 'error')
          }
        })
        toggleLabel.append(toggleInput, toggleText)
        top.append(titleWrap, toggleLabel)

        const meta = document.createElement('div')
        meta.className = 'macro-library-item-meta'
        const trigSpan = document.createElement('span')
        trigSpan.className = 'macro-meta-pill'
        trigSpan.textContent = triggerSummaryText(macro.trigger)
        const targSpan = document.createElement('span')
        targSpan.className = 'macro-meta-pill'
        targSpan.textContent = targetsSummaryText(macro.targets)
        meta.append(trigSpan, targSpan)

        const statusRow = document.createElement('div')
        statusRow.className = 'macro-library-item-status'
        const lastStatus = lastStatusByMacro.get(macro.id)
        const chip = document.createElement('span')
        const tone = statusTone(lastStatus?.status)
        chip.className = `macro-status-chip ${tone}`
        chip.textContent = lastStatus ? statusLabel(lastStatus.status, lastStatus.reason) : 'Idle'
        statusRow.append(chip)

        item.append(top, meta, statusRow)

        if (hasErrors) {
          const errBox = document.createElement('div')
          errBox.className = 'macro-inline-error'
          errBox.setAttribute('role', 'alert')
          errBox.textContent = errorReason
          item.append(errBox)
        }

        item.addEventListener('click', () => selectMacro(macro.id))
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectMacro(macro.id)
          }
        })
        return item
      }))
    }

    function selectMacro(macroId) {
      const found = macros.find((m) => m.id === macroId)
      if (!found) return
      selectedMacroId = found.id
      draftValidationErrors = validationMap[found.id] || []
      setDraft(clone(found))
      renderLibraryList()
      if (activeTab === 'runs') void loadRunsForSelected()
    }

    function createNewMacro(templateData = null) {
      const base = templateData || {
        id: newMacroId(),
        name: `Macro ${macros.length + 1}`,
        enabled: true,
        targets: { mode: 'all' },
        trigger: { type: 'join', cooldownMs: 0 },
        stopWhen: [],
        concurrency: 'skip',
        onError: 'continue',
        defaultDelayMs: 1000,
        maxRuntimeMs: null,
        steps: [{ type: 'chat', message: '/afk' }]
      }
      if (!base.id) base.id = newMacroId()
      selectedMacroId = base.id
      draftValidationErrors = []
      switchTab('editor')
      setDraft(clone(base))
      renderLibraryList()
      el['macro-name-input']?.focus()
      el['macro-name-input']?.select()
    }

    async function duplicateSelectedMacro() {
      const source = draft || macros.find((m) => m.id === selectedMacroId)
      if (!source) return toast('Select a macro to duplicate.', 'error')
      const copy = clone(source)
      copy.id = newMacroId()
      copy.name = `${copy.name || 'Macro'} copy`.slice(0, 60)
      delete copy.origin
      try {
        if (api.macros?.save) {
          const saved = await api.macros.save(copy)
          await refreshLibrary()
          selectMacro(saved.id)
          toast('Macro duplicated.')
        }
      } catch (error) {
        selectedMacroId = copy.id
        setDraft(copy)
        toast(cleanError(error), 'error')
      }
    }

    async function deleteSelectedMacro() {
      const targetId = selectedMacroId || draft?.id
      if (!targetId) return
      const name = draft?.name || macros.find((m) => m.id === targetId)?.name || 'this macro'
      if (!confirm(`Delete macro "${name}"?`)) return
      try {
        if (api.macros?.remove) await api.macros.remove(targetId)
        macros = macros.filter((m) => m.id !== targetId)
        selectedMacroId = macros[0]?.id || null
        await refreshLibrary()
        if (selectedMacroId) selectMacro(selectedMacroId)
        else setDraft(null)
        toast('Macro deleted.')
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function openImportPanel() {
      if (!el['macro-json-panel']) return
      el['macro-json-label'].textContent = 'Paste macro JSON to import (or choose a .json file)'
      el['macro-json-io'].value = ''
      el['macro-json-error'].hidden = true
      el['macro-json-confirm-import'].hidden = false
      el['macro-json-panel'].hidden = false
      el['macro-json-io'].focus()
    }

    async function handleImportFile(event) {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        const text = await file.text()
        el['macro-json-io'].value = text
        el['macro-json-panel'].hidden = false
        await applyJsonImport()
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    async function applyJsonImport() {
      const json = el['macro-json-io']?.value.trim() || ''
      if (!json) {
        el['macro-json-error'].textContent = 'Paste JSON to import.'
        el['macro-json-error'].hidden = false
        return
      }
      try {
        const result = await api.macros.importJson(json)
        if (Array.isArray(result?.errors) && result.errors.length) {
          el['macro-json-error'].textContent = result.errors.map((e) => e.message || String(e)).join(' ')
          el['macro-json-error'].hidden = false
          return
        }
        el['macro-json-error'].hidden = true
        el['macro-json-panel'].hidden = true
        await refreshLibrary()
        if (result?.macros?.length) selectMacro(result.macros[0].id)
        toast(`Imported ${result?.macros?.length || 1} macro(s).`)
      } catch (error) {
        el['macro-json-error'].textContent = cleanError(error)
        el['macro-json-error'].hidden = false
      }
    }

    async function openExportPanel() {
      try {
        const ids = selectedMacroId ? [selectedMacroId] : []
        const exported = await api.macros.exportJson(ids)
        el['macro-json-label'].textContent = ids.length ? 'Exported selected macro JSON (secrets stripped)' : 'Exported macro library JSON (secrets stripped)'
        el['macro-json-io'].value = exported || ''
        el['macro-json-error'].hidden = true
        el['macro-json-confirm-import'].hidden = true
        el['macro-json-panel'].hidden = false
        el['macro-json-io'].focus()
        el['macro-json-io'].select()
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    async function copyJsonExport() {
      const text = el['macro-json-io']?.value || ''
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        toast('Macro JSON copied to clipboard.')
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function setDraft(nextDraft) {
      draft = nextDraft
      history = nextDraft ? [clone(nextDraft)] : []
      historyIndex = nextDraft ? 0 : -1
      selectedStepPath = nextDraft?.steps?.length ? [0] : []
      collapsedPaths = new Set()
      syncUndoRedoButtons()
      renderEditor()
    }

    let historyTimer = null
    function pushHistoryDebounced() {
      clearTimeout(historyTimer)
      historyTimer = setTimeout(() => pushHistory(), 250)
    }

    function pushHistory() {
      if (!draft) return
      const snap = clone(draft)
      if (historyIndex >= 0 && JSON.stringify(history[historyIndex]) === JSON.stringify(snap)) return
      history = history.slice(0, historyIndex + 1)
      history.push(snap)
      if (history.length > 50) history.shift()
      historyIndex = history.length - 1
      syncUndoRedoButtons()
    }

    function undoDraft() {
      if (historyIndex <= 0) return
      historyIndex -= 1
      draft = clone(history[historyIndex])
      syncUndoRedoButtons()
      renderEditor()
    }

    function redoDraft() {
      if (historyIndex < 0 || historyIndex >= history.length - 1) return
      historyIndex += 1
      draft = clone(history[historyIndex])
      syncUndoRedoButtons()
      renderEditor()
    }

    function syncUndoRedoButtons() {
      if (el['macro-undo-btn']) el['macro-undo-btn'].disabled = historyIndex <= 0
      if (el['macro-redo-btn']) el['macro-redo-btn'].disabled = historyIndex < 0 || historyIndex >= history.length - 1
    }

    function switchTab(tab) {
      activeTab = tab === 'runs' ? 'runs' : 'editor'
      el['macro-tab-editor']?.classList.toggle('active', activeTab === 'editor')
      el['macro-tab-Editor']?.setAttribute('aria-selected', String(activeTab === 'editor'))
      if (el['macro-tab-editor']) el['macro-tab-editor'].setAttribute('aria-selected', String(activeTab === 'editor'))
      el['macro-tab-runs']?.classList.toggle('active', activeTab === 'runs')
      if (el['macro-tab-runs']) el['macro-tab-runs'].setAttribute('aria-selected', String(activeTab === 'runs'))
      if (el['macro-editor-view']) el['macro-editor-view'].hidden = activeTab !== 'editor' || !draft
      if (el['macro-runs-view']) el['macro-runs-view'].hidden = activeTab !== 'runs' || !draft
      if (activeTab === 'runs' && draft) void loadRunsForSelected()
    }

    function closeEditorView() {
      if (!el['macro-step-picker']?.hidden) {
        el['macro-step-picker'].hidden = true
        return
      }
      if (draft) {
        selectedMacroId = null
        setDraft(null)
        renderLibraryList()
        el['macro-library-search']?.focus()
      } else {
        el['automation-dialog']?.close()
      }
    }

    function renderEditor() {
      const hasDraft = Boolean(draft)
      if (el['macro-empty-editor']) el['macro-empty-editor'].hidden = hasDraft
      if (el['macro-editor-view']) el['macro-editor-view'].hidden = !hasDraft || activeTab !== 'editor'
      if (el['macro-runs-view']) el['macro-runs-view'].hidden = !hasDraft || activeTab !== 'runs'
      if (el['macro-save-btn']) el['macro-save-btn'].disabled = !hasDraft
      if (el['macro-duplicate-btn']) el['macro-duplicate-btn'].disabled = !hasDraft
      if (el['macro-delete-btn']) el['macro-delete-btn'].disabled = !hasDraft
      if (!hasDraft) {
        if (el['macro-validation-banner']) el['macro-validation-banner'].hidden = true
        return
      }

      el['macro-name-input'].value = draft.name || ''
      const hasBlockingErrors = draftValidationErrors.length > 0
      el['macro-editor-enabled'].checked = draft.enabled !== false && !hasBlockingErrors
      el['macro-editor-enabled'].disabled = hasBlockingErrors
      el['macro-editor-enabled-wrap'].title = hasBlockingErrors
        ? `Fix validation errors before enabling: ${draftValidationErrors.map((e) => e.message).join(' ')}`
        : ''

      syncEditionCapabilities()
      el['macro-trigger-type'].value = draft.trigger?.type || 'manual'
      el['macro-trigger-cooldown'].value = Number(((draft.trigger?.cooldownMs || 0) / 1000).toFixed(2))
      renderTriggerFields()

      el['macro-target-mode'].value = draft.targets?.mode || 'all'
      el['macro-concurrency'].value = draft.concurrency === 'override' ? 'override' : 'skip'
      el['macro-on-error'].value = draft.onError === 'stop' ? 'stop' : 'continue'
      el['macro-default-delay'].value = draft.defaultDelayMs ?? 1000
      el['macro-max-runtime'].value = draft.maxRuntimeMs ? Math.round(draft.maxRuntimeMs / 1000) : 0
      renderTargetsSection()
      renderStopConditions()
      renderSteps()
      renderValidationErrors()
      renderLiveHeader()
    }

    function renderTriggerFields() {
      const container = el['macro-trigger-fields']
      if (!container || !draft) return
      container.replaceChildren()
      const trigger = draft.trigger || (draft.trigger = { type: 'manual' })
      const type = trigger.type

      const triggerSpec = TRIGGER_TYPES[type]
      const editionWarn = triggerSpec ? unsupportedEditionReason(triggerSpec.editions) : ''
      if (editionWarn) {
        const warn = document.createElement('p')
        warn.className = 'macro-edition-warning full'
        warn.textContent = editionWarn
        container.append(warn)
      }

      if (type === 'timer') {
        const intervalSec = Math.max(1, Math.round((trigger.intervalMs ?? 60000) / 1000))
        const jitterSec = Math.max(0, Math.round((trigger.jitterMs ?? 0) / 1000))
        container.append(
          createLabeledNumber('Interval (seconds)', intervalSec, 1, 86400, 1, (val) => {
            pushHistory()
            trigger.intervalMs = Math.max(1000, Math.round(val * 1000))
            if ((trigger.jitterMs || 0) > trigger.intervalMs / 2) {
              trigger.jitterMs = Math.floor(trigger.intervalMs / 2)
              renderTriggerFields()
            }
          }, 'macro-trigger-interval-sec'),
          createLabeledNumber('Jitter ± (seconds)', jitterSec, 0, Math.floor(intervalSec / 2), 1, (val) => {
            pushHistory()
            trigger.jitterMs = Math.max(0, Math.min(Math.round(val * 1000), Math.floor((trigger.intervalMs || 60000) / 2)))
          }, 'macro-trigger-jitter-sec')
        )
      } else if (type === 'schedule') {
        container.append(
          createLabeledText('Daily local time (HH:MM)', trigger.at || '08:00', '08:00', 5, (val) => {
            pushHistory()
            trigger.at = val.trim()
          }, 'macro-trigger-schedule-at')
        )
      } else if (type === 'chat') {
        const matchSelect = createLabeledSelect(
          'Pattern match mode',
          [
            { value: 'contains', label: 'Contains text' },
            { value: 'glob', label: 'Glob (* and {capture})' }
          ],
          trigger.match || 'contains',
          (val) => {
            pushHistory()
            trigger.match = val
          },
          'macro-trigger-chat-match'
        )
        const patternField = createLabeledText(
          'Chat pattern',
          trigger.pattern || '',
          trigger.match === 'glob' ? '* whispered: {msg}' : '[AFK]',
          200,
          (val) => {
            pushHistory()
            trigger.pattern = val
          },
          'macro-trigger-chat-pattern'
        )
        const sourcesGroup = document.createElement('div')
        sourcesGroup.className = 'field full'
        const sourcesLabel = document.createElement('span')
        sourcesLabel.textContent = 'Chat sources'
        const sourcesRow = document.createElement('div')
        sourcesRow.className = 'macro-inline-checks'
        const currentSources = Array.isArray(trigger.sources) && trigger.sources.length ? trigger.sources : ['chat', 'system', 'actionBar']
        for (const [srcValue, srcLabel] of [['chat', 'Player chat'], ['system', 'System messages'], ['actionBar', 'Action bar']]) {
          const checkLabel = document.createElement('label')
          checkLabel.className = 'check-row'
          const input = document.createElement('input')
          input.type = 'checkbox'
          input.checked = currentSources.includes(srcValue)
          input.addEventListener('change', () => {
            pushHistory()
            const next = []
            sourcesRow.querySelectorAll('input[type="checkbox"]').forEach((box) => {
              if (box.checked) next.push(box.dataset.source)
            })
            trigger.sources = next.length ? next : ['chat']
          })
          input.dataset.source = srcValue
          checkLabel.append(input, document.createTextNode(` ${srcLabel}`))
          sourcesRow.append(checkLabel)
        }
        sourcesGroup.append(sourcesLabel, sourcesRow)
        container.append(matchSelect, patternField, sourcesGroup)
      } else if (type === 'healthBelow' || type === 'hungerBelow') {
        container.append(
          createLabeledNumber(
            type === 'healthBelow' ? 'Health threshold (0–20)' : 'Hunger threshold (0–20)',
            trigger.below ?? (type === 'healthBelow' ? 8 : 14),
            0,
            20,
            1,
            (val) => {
              pushHistory()
              trigger.below = Math.max(0, Math.min(20, val))
            },
            'macro-trigger-below'
          )
        )
      } else if (type === 'windowOpen') {
        container.append(
          createLabeledText(
            'Window title contains (optional)',
            trigger.title || '',
            'e.g. Chest or Teleporter',
            80,
            (val) => {
              pushHistory()
              trigger.title = val.trim()
            },
            'macro-trigger-window-title'
          )
        )
      }
    }

    function renderTargetsSection() {
      if (!draft) return
      const mode = draft.targets?.mode || 'all'
      const accountsList = el['macro-target-accounts-list']
      const tagsBox = el['macro-target-tags-box']
      if (accountsList) {
        accountsList.hidden = mode !== 'accounts'
        if (mode === 'accounts') {
          const selected = new Set(draft.targets.accountIds || [])
          accountsList.replaceChildren(...(state.accounts || []).map((acc) => {
            const row = document.createElement('label')
            row.className = 'check-row macro-account-check'
            const input = document.createElement('input')
            input.type = 'checkbox'
            input.value = acc.id
            input.checked = selected.has(acc.id)
            input.addEventListener('change', () => {
              pushHistory()
              const next = []
              accountsList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
                if (box.checked) next.push(box.value)
              })
              draft.targets = { mode: 'accounts', accountIds: next }
              syncEditionCapabilities()
              renderTriggerFields()
              renderSteps()
            })
            const text = document.createElement('span')
            text.textContent = `${acc.profileName || acc.label || acc.username} (${acc.edition === 'bedrock' ? 'Bedrock' : 'Java'})`
            row.append(input, text)
            return row
          }))
        }
      }
      if (tagsBox) {
        tagsBox.hidden = mode !== 'tags'
        if (mode === 'tags') {
          const currentTags = Array.isArray(draft.targets.tags) ? draft.targets.tags : []
          el['macro-target-tags-input'].value = currentTags.join(', ')
          const knownTags = [...new Set((state.accounts || []).flatMap((a) => Array.isArray(a.tags) ? a.tags : []))]
          const chipContainer = el['macro-target-tags-suggestions']
          if (chipContainer) {
            chipContainer.replaceChildren(...knownTags.map((tag) => {
              const btn = document.createElement('button')
              btn.type = 'button'
              const active = currentTags.includes(tag)
              btn.className = `macro-tag-chip${active ? ' active' : ''}`
              btn.textContent = `#${tag}`
              btn.addEventListener('click', () => {
                pushHistory()
                const set = new Set(draft.targets.tags || [])
                if (set.has(tag)) set.delete(tag)
                else set.add(tag)
                draft.targets.tags = [...set]
                renderTargetsSection()
                syncEditionCapabilities()
              })
              return btn
            }))
          }
        }
      }
    }

    function renderStopConditions() {
      const container = el['macro-stop-when-list']
      if (!container || !draft) return
      const list = Array.isArray(draft.stopWhen) ? draft.stopWhen : (draft.stopWhen = [])
      if (!list.length) {
        const empty = document.createElement('p')
        empty.className = 'macro-muted-hint'
        empty.textContent = 'No stop conditions. Add one to automatically stop the macro when a condition is met.'
        container.replaceChildren(empty)
        return
      }
      container.replaceChildren(...list.map((cond, index) => {
        const row = document.createElement('div')
        row.className = 'macro-condition-row'
        row.append(
          createConditionEditor(cond, (updated) => {
            pushHistory()
            draft.stopWhen[index] = updated
            renderStopConditions()
          }),
          createIconButton('×', 'Remove stop condition', () => {
            pushHistory()
            draft.stopWhen.splice(index, 1)
            renderStopConditions()
          })
        )
        return row
      }))
    }

    function createConditionEditor(cond = { type: 'always' }, onChange, depth = 0) {
      const wrap = document.createElement('div')
      wrap.className = 'macro-condition-editor'
      const typeSelect = document.createElement('select')
      typeSelect.setAttribute('aria-label', 'Condition type')
      const allowedTypes = depth >= 3 ? CONDITION_TYPES.filter((t) => t.value !== 'not') : CONDITION_TYPES
      typeSelect.replaceChildren(...allowedTypes.map((item) => {
        const opt = document.createElement('option')
        opt.value = item.value
        opt.textContent = item.label
        return opt
      }))
      typeSelect.value = cond.type || 'always'
      typeSelect.addEventListener('change', () => {
        const nextType = typeSelect.value
        if (nextType === 'online') onChange({ type: 'online', value: true })
        else if (nextType === 'healthBelow') onChange({ type: 'healthBelow', value: 8 })
        else if (nextType === 'hungerBelow') onChange({ type: 'hungerBelow', value: 14 })
        else if (nextType === 'hasItem') onChange({ type: 'hasItem', name: 'cobblestone', count: 1 })
        else if (nextType === 'windowOpen') onChange({ type: 'windowOpen', name: '' })
        else if (nextType === 'variableEquals') onChange({ type: 'variableEquals', name: 'state', value: 'ready' })
        else if (nextType === 'not') onChange({ type: 'not', condition: { type: 'online', value: true } })
        else onChange({ type: nextType })
      })
      wrap.append(typeSelect)

      const type = cond.type || 'always'
      if (type === 'online') {
        const boolSelect = document.createElement('select')
        boolSelect.setAttribute('aria-label', 'Online state')
        for (const [val, text] of [['true', 'Is online'], ['false', 'Is offline']]) {
          const opt = document.createElement('option')
          opt.value = val
          opt.textContent = text
          boolSelect.append(opt)
        }
        boolSelect.value = cond.value === false ? 'false' : 'true'
        boolSelect.addEventListener('change', () => onChange({ type: 'online', value: boolSelect.value === 'true' }))
        wrap.append(boolSelect)
      } else if (type === 'healthBelow' || type === 'hungerBelow') {
        const input = document.createElement('input')
        input.type = 'number'
        input.min = '0'
        input.max = '20'
        input.value = String(cond.value ?? 8)
        input.setAttribute('aria-label', 'Threshold value (0-20)')
        input.addEventListener('change', () => onChange({ type, value: Math.max(0, Math.min(20, Number(input.value) || 0)) }))
        wrap.append(input)
      } else if (type === 'hasItem') {
        const nameInput = document.createElement('input')
        nameInput.placeholder = 'Item name (e.g. diamond)'
        nameInput.value = cond.name || ''
        nameInput.setAttribute('aria-label', 'Condition item name')
        nameInput.addEventListener('change', () => onChange({ ...cond, type: 'hasItem', name: nameInput.value.trim() }))
        const countInput = document.createElement('input')
        countInput.type = 'number'
        countInput.min = '1'
        countInput.max = '2304'
        countInput.value = String(cond.count ?? 1)
        countInput.setAttribute('aria-label', 'Minimum item count')
        countInput.addEventListener('change', () => onChange({ ...cond, type: 'hasItem', count: Math.max(1, Number(countInput.value) || 1) }))
        wrap.append(nameInput, countInput)
      } else if (type === 'windowOpen') {
        const titleInput = document.createElement('input')
        titleInput.placeholder = 'Optional title match'
        titleInput.value = cond.name || ''
        titleInput.setAttribute('aria-label', 'Window title match')
        titleInput.addEventListener('change', () => onChange({ type: 'windowOpen', name: titleInput.value.trim() }))
        wrap.append(titleInput)
      } else if (type === 'variableEquals') {
        const varInput = document.createElement('input')
        varInput.placeholder = 'Variable name'
        varInput.value = cond.name || ''
        varInput.setAttribute('aria-label', 'Variable name')
        varInput.addEventListener('change', () => onChange({ ...cond, type: 'variableEquals', name: varInput.value.trim() }))
        const valInput = document.createElement('input')
        valInput.placeholder = 'Expected value'
        valInput.value = String(cond.value ?? '')
        valInput.setAttribute('aria-label', 'Expected variable value')
        valInput.addEventListener('change', () => onChange({ ...cond, type: 'variableEquals', value: valInput.value }))
        wrap.append(varInput, valInput)
      } else if (type === 'not') {
        wrap.append(
          createConditionEditor(
            cond.condition || { type: 'online', value: true },
            (inner) => onChange({ type: 'not', condition: inner }),
            depth + 1
          )
        )
      }
      return wrap
    }

    function toggleStepPicker(forceOpen = null) {
      if (!el['macro-step-picker']) return
      const nextOpen = forceOpen !== null ? forceOpen : el['macro-step-picker'].hidden
      el['macro-step-picker'].hidden = !nextOpen
      if (nextOpen) {
        renderStepPicker()
        el['macro-step-picker'].querySelector('button:not(:disabled)')?.focus()
      }
    }

    function renderStepPicker() {
      const picker = el['macro-step-picker']
      if (!picker) return
      const groups = STEP_GROUPS.map(({ group, types }) => {
        const section = document.createElement('div')
        section.className = 'macro-picker-group'
        const heading = document.createElement('h4')
        heading.textContent = group
        const grid = document.createElement('div')
        grid.className = 'macro-picker-grid'
        for (const type of types) {
          const spec = STEP_TYPES[type]
          if (!spec) continue
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'macro-picker-btn'
          btn.dataset.stepType = type
          const reason = unsupportedEditionReason(spec.editions)
          btn.disabled = Boolean(reason)
          if (reason) btn.title = reason
          btn.textContent = `＋ ${spec.label}`
          btn.addEventListener('click', () => {
            insertStepOfType(type)
            picker.hidden = true
          })
          grid.append(btn)
        }
        section.append(heading, grid)
        return section
      })
      picker.replaceChildren(...groups)
    }

    function resolveStepListByPath(rootSteps, listPath) {
      // listPath encoding matches stepPath parent:
      // [] -> rootSteps
      // [i] -> rootSteps[i].steps (for repeat)
      // [i, 0] -> rootSteps[i].then (for if)
      // [i, 1] -> rootSteps[i].else (for if)
      let currentList = rootSteps
      let cursor = 0
      while (cursor < listPath.length) {
        const stepIdx = listPath[cursor]
        const step = currentList?.[stepIdx]
        if (!step) return null
        if (step.type === 'if') {
          const branch = listPath[cursor + 1]
          currentList = branch === 1 ? (step.else ||= []) : (step.then ||= [])
          cursor += 2
        } else if (step.type === 'repeat') {
          currentList = (step.steps ||= [])
          cursor += 1
        } else {
          return null
        }
      }
      return currentList
    }

    function splitStepPath(stepPath) {
      if (!Array.isArray(stepPath) || !stepPath.length) return { listPath: [], index: -1 }
      return {
        listPath: stepPath.slice(0, -1),
        index: stepPath[stepPath.length - 1]
      }
    }

    function insertStepOfType(type, explicitTarget = stepInsertTarget) {
      if (!draft) return
      const spec = STEP_TYPES[type]
      if (!spec) return
      pushHistory()
      const newStep = spec.defaultStep()
      draft.steps ||= []

      if (explicitTarget && Array.isArray(explicitTarget.listPath)) {
        const list = resolveStepListByPath(draft.steps, explicitTarget.listPath)
        if (list) {
          const idx = typeof explicitTarget.index === 'number' ? explicitTarget.index : list.length
          list.splice(idx, 0, newStep)
          selectedStepPath = [...explicitTarget.listPath, idx]
          stepInsertTarget = null
          renderSteps()
          focusSelectedStepCard()
          return
        }
      }

      if (Array.isArray(selectedStepPath) && selectedStepPath.length) {
        const { listPath, index } = splitStepPath(selectedStepPath)
        const list = resolveStepListByPath(draft.steps, listPath)
        if (list && index >= 0 && index <= list.length) {
          list.splice(index + 1, 0, newStep)
          selectedStepPath = [...listPath, index + 1]
          renderSteps()
          focusSelectedStepCard()
          return
        }
      }

      draft.steps.push(newStep)
      selectedStepPath = [draft.steps.length - 1]
      renderSteps()
      focusSelectedStepCard()
    }

    function countStepsRecursive(steps) {
      if (!Array.isArray(steps)) return 0
      let total = 0
      for (const s of steps) {
        total += 1
        if (s.type === 'if') total += countStepsRecursive(s.then) + countStepsRecursive(s.else)
        else if (s.type === 'repeat') total += countStepsRecursive(s.steps)
      }
      return total
    }

    function renderSteps() {
      const container = el['macro-step-list']
      if (!container || !draft) return
      const steps = Array.isArray(draft.steps) ? draft.steps : (draft.steps = [])
      if (el['macro-steps-count']) el['macro-steps-count'].textContent = String(countStepsRecursive(steps))

      if (!steps.length) {
        const empty = document.createElement('div')
        empty.className = 'macro-steps-empty'
        empty.textContent = 'No steps yet. Press Space, /, or “＋ Add step” to insert an action.'
        container.replaceChildren(empty)
        return
      }

      container.replaceChildren(...renderStepListNodes(steps, [], '/steps', 0))
    }

    function watchedLiveEvent() {
      if (!draft) return null
      const accountId = el['macro-watch-account']?.value || state.selectedId || ''
      return liveByMacroAccount.get(`${draft.id}:${accountId}`) || null
    }

    function renderStepListNodes(steps, listPath, validationPrefix, depth) {
      const live = watchedLiveEvent()
      return steps.map((step, index) => {
        const stepPath = [...listPath, index]
        const stepKey = JSON.stringify(stepPath)
        const valPath = `${validationPrefix}/${index}`
        const isSelected = pathEquals(selectedStepPath, stepPath)
        const isRunningHere = live && (live.status === 'step' || live.status === 'started') && pathEquals(live.stepPath, stepPath)
        const isFailedHere = live && live.status === 'stepFailed' && pathEquals(live.stepPath, stepPath)

        const card = document.createElement('div')
        card.className = `macro-step-card${isSelected ? ' selected' : ''}${isRunningHere ? ' live-running' : ''}${isFailedHere ? ' live-failed' : ''}`
        card.dataset.stepPath = stepKey
        card.dataset.validationPath = valPath
        card.dataset.stepType = step.type
        card.setAttribute('role', 'listitem')
        card.tabIndex = 0
        card.draggable = true

        card.addEventListener('click', (event) => {
          event.stopPropagation()
          if (!pathEquals(selectedStepPath, stepPath)) {
            selectedStepPath = stepPath
            updateStepSelectionClasses()
          }
        })
        card.addEventListener('focus', () => {
          selectedStepPath = stepPath
          updateStepSelectionClasses()
        })

        // Drag and drop reordering within the same step list
        card.addEventListener('dragstart', (event) => {
          event.stopPropagation()
          draggedStepPath = stepPath
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', stepKey)
          requestAnimationFrame(() => card.classList.add('dragging'))
        })
        card.addEventListener('dragover', (event) => {
          event.stopPropagation()
          if (!draggedStepPath || pathEquals(draggedStepPath, stepPath)) return
          if (!pathEquals(draggedStepPath.slice(0, -1), listPath)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          card.classList.add('drag-over')
        })
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'))
        card.addEventListener('drop', (event) => {
          event.stopPropagation()
          event.preventDefault()
          card.classList.remove('drag-over')
          if (!draggedStepPath || !pathEquals(draggedStepPath.slice(0, -1), listPath)) return
          const fromIdx = draggedStepPath[draggedStepPath.length - 1]
          const toIdx = index
          draggedStepPath = null
          if (fromIdx !== toIdx) moveStepInList(listPath, fromIdx, toIdx)
        })
        card.addEventListener('dragend', () => {
          draggedStepPath = null
          card.classList.remove('dragging', 'drag-over')
        })

        const header = document.createElement('div')
        header.className = 'macro-step-header'

        const left = document.createElement('div')
        left.className = 'macro-step-title'
        const handle = document.createElement('span')
        handle.className = 'macro-drag-handle'
        handle.textContent = '⋮⋮'
        handle.setAttribute('aria-hidden', 'true')

        const badge = document.createElement('span')
        badge.className = 'macro-step-index'
        badge.textContent = `#${stepPath.map((n) => n + 1).join('.')}`

        const typeSelect = document.createElement('select')
        typeSelect.className = 'macro-step-type-select'
        typeSelect.setAttribute('aria-label', 'Step action type')
        for (const { group, types } of STEP_GROUPS) {
          const optgroup = document.createElement('optgroup')
          optgroup.label = group
          for (const t of types) {
            const spec = STEP_TYPES[t]
            if (!spec) continue
            const opt = document.createElement('option')
            opt.value = t
            const reason = unsupportedEditionReason(spec.editions)
            opt.disabled = Boolean(reason)
            if (reason) opt.title = reason
            opt.textContent = reason ? `${spec.label} (Java only)` : spec.label
            optgroup.append(opt)
          }
          typeSelect.append(optgroup)
        }
        typeSelect.value = step.type
        typeSelect.addEventListener('change', () => {
          pushHistory()
          const nextType = typeSelect.value
          const replacement = STEP_TYPES[nextType]?.defaultStep() || { type: nextType }
          steps[index] = replacement
          selectedStepPath = stepPath
          renderSteps()
        })

        left.append(handle, badge, typeSelect)

        if (isRunningHere) {
          const liveBadge = document.createElement('span')
          liveBadge.className = 'macro-status-chip running'
          liveBadge.textContent = 'Running step'
          left.append(liveBadge)
        } else if (isFailedHere) {
          const failBadge = document.createElement('span')
          failBadge.className = 'macro-status-chip failed'
          failBadge.textContent = `Step failed: ${live.error?.message || 'error'}`
          left.append(failBadge)
        }

        const spec = STEP_TYPES[step.type]
        const stepEditionReason = spec ? unsupportedEditionReason(spec.editions) : ''
        if (stepEditionReason) {
          const warnBadge = document.createElement('span')
          warnBadge.className = 'macro-badge edition-warn'
          warnBadge.textContent = 'Java only'
          warnBadge.title = stepEditionReason
          left.append(warnBadge)
        }

        const actions = document.createElement('div')
        actions.className = 'macro-step-actions'
        const upBtn = createIconButton('↑', 'Move step up', () => moveStepByOffset(stepPath, -1))
        upBtn.className = 'icon-button step-move-up'
        upBtn.disabled = index === 0
        const downBtn = createIconButton('↓', 'Move step down', () => moveStepByOffset(stepPath, 1))
        downBtn.className = 'icon-button step-move-down'
        downBtn.disabled = index === steps.length - 1
        const dupBtn = createIconButton('⧉', 'Duplicate step', () => duplicateStepAtPath(stepPath))
        dupBtn.className = 'icon-button step-duplicate'
        const delBtn = createIconButton('×', 'Delete step', () => deleteStepAtPath(stepPath))
        delBtn.className = 'icon-button step-delete'
        actions.append(upBtn, downBtn, dupBtn, delBtn)

        header.append(left, actions)
        card.append(header)

        // Step-specific fields
        const fields = buildStepFields(step, stepPath, valPath, depth)
        if (fields) card.append(fields)

        // Step-specific validation errors
        const stepErrors = draftValidationErrors.filter((err) => err.path === valPath || (err.path.startsWith(`${valPath}/`) && !err.path.slice(valPath.length + 1).includes('/')))
        if (stepErrors.length) {
          const errEl = document.createElement('p')
          errEl.className = 'macro-field-error'
          errEl.setAttribute('role', 'alert')
          errEl.textContent = stepErrors.map((e) => e.message).join(' ')
          card.append(errEl)
        }

        return card
      })
    }

    function updateStepSelectionClasses() {
      const cards = el['macro-step-list']?.querySelectorAll('.macro-step-card') || []
      const targetKey = JSON.stringify(selectedStepPath)
      cards.forEach((card) => {
        card.classList.toggle('selected', card.dataset.stepPath === targetKey)
      })
    }

    function focusSelectedStepCard() {
      requestAnimationFrame(() => {
        const targetKey = JSON.stringify(selectedStepPath)
        const card = [...(el['macro-step-list']?.querySelectorAll('.macro-step-card') || [])].find((c) => c.dataset.stepPath === targetKey)
        card?.focus()
      })
    }

    function moveStepInList(listPath, fromIdx, toIdx) {
      if (!draft) return
      const list = resolveStepListByPath(draft.steps, listPath)
      if (!list || fromIdx < 0 || fromIdx >= list.length || toIdx < 0 || toIdx >= list.length) return
      pushHistory()
      const [moved] = list.splice(fromIdx, 1)
      list.splice(toIdx, 0, moved)
      selectedStepPath = [...listPath, toIdx]
      renderSteps()
      focusSelectedStepCard()
    }

    function moveStepByOffset(stepPath = selectedStepPath, delta = -1) {
      const { listPath, index } = splitStepPath(stepPath)
      moveStepInList(listPath, index, index + delta)
    }

    function duplicateStepAtPath(stepPath = selectedStepPath) {
      if (!draft) return
      const { listPath, index } = splitStepPath(stepPath)
      const list = resolveStepListByPath(draft.steps, listPath)
      if (!list || index < 0 || index >= list.length) return
      pushHistory()
      const copy = clone(list[index])
      list.splice(index + 1, 0, copy)
      selectedStepPath = [...listPath, index + 1]
      renderSteps()
      focusSelectedStepCard()
    }

    function deleteStepAtPath(stepPath = selectedStepPath) {
      if (!draft) return
      const { listPath, index } = splitStepPath(stepPath)
      const list = resolveStepListByPath(draft.steps, listPath)
      if (!list || index < 0 || index >= list.length) return
      pushHistory()
      list.splice(index, 1)
      if (list.length) {
        selectedStepPath = [...listPath, Math.min(index, list.length - 1)]
      } else {
        selectedStepPath = listPath.length ? listPath.slice(0, 1) : []
      }
      renderSteps()
      focusSelectedStepCard()
    }

    function buildStepFields(step, stepPath, valPath, depth) {
      const body = document.createElement('div')
      body.className = 'macro-step-body'
      const type = step.type

      if (type === 'chat') {
        body.append(
          createLabeledText('Message or /command (supports {var})', step.message ?? '', '/afk', 256, (val) => {
            pushHistory()
            step.message = val
          }, 'step-chat-message')
        )
      } else if (type === 'wait') {
        const isRange = step.minMs !== undefined || step.maxMs !== undefined
        const modeSelect = createLabeledSelect(
          'Wait mode',
          [
            { value: 'fixed', label: 'Fixed duration (± jitter)' },
            { value: 'range', label: 'Random min–max range' }
          ],
          isRange ? 'range' : 'fixed',
          (mode) => {
            pushHistory()
            if (mode === 'range') {
              delete step.ms
              delete step.jitterMs
              step.minMs = 500
              step.maxMs = 1500
            } else {
              delete step.minMs
              delete step.maxMs
              step.ms = 1000
            }
            renderSteps()
          },
          'step-wait-mode'
        )
        body.append(modeSelect)
        if (isRange) {
          body.append(
            createLabeledNumber('Min wait (ms)', step.minMs ?? 500, 0, 3600000, 50, (val) => {
              pushHistory()
              step.minMs = Math.max(0, Math.round(val))
            }, 'step-wait-min'),
            createLabeledNumber('Max wait (ms)', step.maxMs ?? 1500, 0, 3600000, 50, (val) => {
              pushHistory()
              step.maxMs = Math.max(step.minMs || 0, Math.round(val))
            }, 'step-wait-max')
          )
        } else {
          body.append(
            createLabeledNumber('Duration (ms)', step.ms ?? 1000, 0, 3600000, 50, (val) => {
              pushHistory()
              step.ms = Math.max(0, Math.round(val))
            }, 'step-wait-ms'),
            createLabeledNumber('Jitter ± (ms)', step.jitterMs ?? 0, 0, 60000, 50, (val) => {
              pushHistory()
              const j = Math.max(0, Math.round(val))
              if (j > 0) step.jitterMs = j
              else delete step.jitterMs
            }, 'step-wait-jitter')
          )
        }
      } else if (type === 'notify') {
        body.append(
          createLabeledText('Notification message', step.message ?? '', 'Alert message', 256, (val) => {
            pushHistory()
            step.message = val
          }, 'step-notify-message'),
          createCheckboxField('Desktop notification', step.desktop !== false, (checked) => {
            pushHistory()
            step.desktop = checked
          }),
          createCheckboxField('Send to webhook', step.webhook === true, (checked) => {
            pushHistory()
            step.webhook = checked
          })
        )
      } else if (type === 'move') {
        const useDistance = step.distance !== undefined && step.durationMs === undefined
        body.append(
          createLabeledSelect(
            'Direction',
            [
              { value: 'forward', label: 'Forward' },
              { value: 'back', label: 'Backward' },
              { value: 'left', label: 'Strafe left' },
              { value: 'right', label: 'Strafe right' }
            ],
            step.control || 'forward',
            (val) => { pushHistory(); step.control = val },
            'step-move-control'
          ),
          createLabeledSelect(
            'Move by',
            [
              { value: 'duration', label: 'Duration (ms)' },
              { value: 'distance', label: 'Distance (blocks)' }
            ],
            useDistance ? 'distance' : 'duration',
            (mode) => {
              pushHistory()
              if (mode === 'distance') {
                delete step.durationMs
                step.distance = 1
              } else {
                delete step.distance
                step.durationMs = 500
              }
              renderSteps()
            },
            'step-move-mode'
          ),
          useDistance
            ? createLabeledNumber('Distance (blocks)', step.distance ?? 1, 0.5, 64, 0.5, (val) => {
                pushHistory()
                step.distance = Math.max(0.5, Math.min(64, val))
              }, 'step-move-distance')
            : createLabeledNumber('Duration (ms)', step.durationMs ?? 500, 100, 10000, 50, (val) => {
                pushHistory()
                step.durationMs = Math.max(100, Math.min(10000, Math.round(val)))
              }, 'step-move-duration')
        )
      } else if (type === 'look') {
        const mode = step.mode || 'relative'
        body.append(
          createLabeledSelect(
            'Look mode',
            [
              { value: 'relative', label: 'Relative delta (yaw / pitch)' },
              { value: 'absolute', label: 'Absolute angles (yaw / pitch)' },
              { value: 'at', label: 'Look at block or entity' }
            ],
            mode,
            (nextMode) => {
              pushHistory()
              step.mode = nextMode
              if (nextMode === 'at') {
                delete step.yaw
                delete step.pitch
                step.target = 'block'
                step.x = 0; step.y = 64; step.z = 0
              } else {
                delete step.target; delete step.x; delete step.y; delete step.z; delete step.entity
                step.yaw = 0; step.pitch = 0
              }
              renderSteps()
            },
            'step-look-mode'
          )
        )
        if (mode === 'at') {
          const target = step.target || 'block'
          body.append(
            createLabeledSelect(
              'Target type',
              [
                { value: 'block', label: 'Block coordinates (X, Y, Z)' },
                { value: 'entity', label: 'Entity by name' }
              ],
              target,
              (nextTarget) => {
                pushHistory()
                step.target = nextTarget
                if (nextTarget === 'entity') {
                  delete step.x; delete step.y; delete step.z
                  step.entity = 'villager'
                } else {
                  delete step.entity
                  step.x = 0; step.y = 64; step.z = 0
                }
                renderSteps()
              },
              'step-look-target'
            )
          )
          if (target === 'entity') {
            body.append(
              createLabeledText('Entity name', step.entity ?? '', 'e.g. villager or player name', 64, (val) => {
                pushHistory()
                step.entity = val.trim()
              }, 'step-look-entity')
            )
          } else {
            body.append(
              createLabeledNumber('X', step.x ?? 0, -30000000, 30000000, 1, (val) => { pushHistory(); step.x = val }, 'step-look-x'),
              createLabeledNumber('Y', step.y ?? 64, -2048, 2048, 1, (val) => { pushHistory(); step.y = val }, 'step-look-y'),
              createLabeledNumber('Z', step.z ?? 0, -30000000, 30000000, 1, (val) => { pushHistory(); step.z = val }, 'step-look-z')
            )
          }
        } else {
          body.append(
            createLabeledNumber('Yaw (radians)', step.yaw ?? 0, -6.28, 6.28, 0.05, (val) => { pushHistory(); step.yaw = val }, 'step-look-yaw'),
            createLabeledNumber('Pitch (radians)', step.pitch ?? 0, -1.57, 1.57, 0.05, (val) => { pushHistory(); step.pitch = val }, 'step-look-pitch')
          )
        }
      } else if (type === 'control') {
        body.append(
          createLabeledSelect(
            'Control state',
            [
              { value: 'sneak', label: 'Sneak (Shift)' },
              { value: 'jump', label: 'Jump (Space)' },
              { value: 'sprint', label: 'Sprint (Ctrl)' }
            ],
            step.control || 'sneak',
            (val) => { pushHistory(); step.control = val },
            'step-control-name'
          ),
          createLabeledSelect(
            'Action',
            [
              { value: 'hold', label: 'Hold down' },
              { value: 'release', label: 'Release' }
            ],
            step.action || 'hold',
            (val) => { pushHistory(); step.action = val },
            'step-control-action'
          )
        )
      } else if (type === 'leftClick') {
        body.append(
          createLabeledSelect(
            'Click action',
            [
              { value: 'once', label: 'Click once' },
              { value: 'hold', label: 'Hold left button' },
              { value: 'release', label: 'Release left button' }
            ],
            step.action || 'once',
            (val) => { pushHistory(); step.action = val },
            'step-leftclick-action'
          ),
          createLabeledSelect(
            'Target filter',
            [
              { value: '', label: 'Blocks or entities' },
              { value: 'blocks', label: 'Blocks only' },
              { value: 'entities', label: 'Entities only' }
            ],
            step.only || '',
            (val) => {
              pushHistory()
              if (val) step.only = val
              else delete step.only
            },
            'step-leftclick-only'
          )
        )
      } else if (type === 'rightClick') {
        body.append(
          createLabeledSelect(
            'Click action',
            [
              { value: 'once', label: 'Click once' },
              { value: 'hold', label: 'Hold right button' },
              { value: 'release', label: 'Release right button' }
            ],
            step.action || 'once',
            (val) => { pushHistory(); step.action = val },
            'step-rightclick-action'
          )
        )
      } else if (type === 'selectHotbar') {
        body.append(
          createLabeledNumber('Hotbar slot (0–8)', step.slot ?? 0, 0, 8, 1, (val) => {
            pushHistory()
            step.slot = Math.max(0, Math.min(8, Math.round(val)))
          }, 'step-hotbar-slot')
        )
      } else if (type === 'holdItem') {
        body.append(
          createLabeledText('Item name', step.name ?? '', 'e.g. diamond_sword', 80, (val) => {
            pushHistory()
            step.name = val.trim()
          }, 'step-holditem-name')
        )
      } else if (type === 'useInventory' || type === 'useGui') {
        body.append(
          ...createSlotOrItemSelector(step, true),
          createLabeledSelect(
            'Click button',
            [
              { value: 'left', label: 'Left click' },
              { value: 'right', label: 'Right click' },
              { value: 'shift', label: 'Shift click' },
              { value: 'drop', label: 'Drop key (Q)' }
            ],
            step.click || 'left',
            (val) => { pushHistory(); step.click = val },
            'step-gui-click'
          )
        )
      } else if (type === 'waitForWindow') {
        body.append(
          createLabeledText('Window title contains (optional)', step.title ?? '', 'e.g. Server Selector', 80, (val) => {
            pushHistory()
            const trimmed = val.trim()
            if (trimmed) step.title = trimmed
            else delete step.title
          }, 'step-waitwindow-title'),
          createLabeledNumber('Timeout (ms)', step.giveUpAfterMs ?? 10000, 100, 300000, 500, (val) => {
            pushHistory()
            step.giveUpAfterMs = Math.max(100, Math.min(300000, Math.round(val)))
          }, 'step-waitwindow-timeout')
        )
      } else if (type === 'drop' || type === 'deposit') {
        body.append(
          ...createSlotOrItemSelector(step, false),
          createLabeledNumber('Item count (1–64)', step.count ?? 1, 1, 64, 1, (val) => {
            pushHistory()
            step.count = Math.max(1, Math.min(64, Math.round(val)))
          }, 'step-item-count')
        )
      } else if (type === 'dropAll') {
        body.append(
          createLabeledText('Item name filter (optional, empty = all unlocked)', step.filter ?? '', 'e.g. cobblestone', 80, (val) => {
            pushHistory()
            const trimmed = val.trim()
            if (trimmed) step.filter = trimmed
            else delete step.filter
          }, 'step-dropall-filter')
        )
      } else if (type === 'reconnect') {
        body.append(
          createLabeledNumber('Reconnect delay (ms)', step.delayMs ?? 0, 0, 3600000, 500, (val) => {
            pushHistory()
            step.delayMs = Math.max(0, Math.round(val))
          }, 'step-reconnect-delay')
        )
      } else if (type === 'set') {
        body.append(
          createLabeledText('Variable name', step.variable ?? '', 'e.g. target', 40, (val) => {
            pushHistory()
            step.variable = val.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
          }, 'step-set-variable'),
          createLabeledText('Value', String(step.value ?? ''), 'Value', 256, (val) => {
            pushHistory()
            step.value = val
          }, 'step-set-value')
        )
      } else if (type === 'if') {
        const condWrap = document.createElement('div')
        condWrap.className = 'field full'
        const condLabel = document.createElement('span')
        condLabel.textContent = 'If condition'
        condWrap.append(
          condLabel,
          createConditionEditor(step.condition || { type: 'always' }, (updated) => {
            pushHistory()
            step.condition = updated
            renderSteps()
          })
        )
        body.append(
          condWrap,
          createNestedBlock('Then steps', step.then ||= [], [...stepPath, 0], `${valPath}/then`, depth + 1),
          createNestedBlock('Else steps', step.else ||= [], [...stepPath, 1], `${valPath}/else`, depth + 1)
        )
      } else if (type === 'repeat') {
        const isWhile = step.while !== undefined && step.while !== null
        body.append(
          createLabeledSelect(
            'Repeat mode',
            [
              { value: 'times', label: 'Fixed number of times' },
              { value: 'while', label: 'While condition is true' }
            ],
            isWhile ? 'while' : 'times',
            (mode) => {
              pushHistory()
              if (mode === 'while') {
                delete step.times
                step.while = { type: 'online', value: true }
                step.maxIterations = 1000
              } else {
                delete step.while
                delete step.maxIterations
                step.times = 3
              }
              renderSteps()
            },
            'step-repeat-mode'
          )
        )
        if (isWhile) {
          const whileWrap = document.createElement('div')
          whileWrap.className = 'field full'
          const whileLabel = document.createElement('span')
          whileLabel.textContent = 'While condition'
          whileWrap.append(
            whileLabel,
            createConditionEditor(step.while, (updated) => {
              pushHistory()
              step.while = updated
              renderSteps()
            })
          )
          body.append(
            whileWrap,
            createLabeledNumber('Max iterations', step.maxIterations ?? 1000, 1, 100000, 1, (val) => {
              pushHistory()
              step.maxIterations = Math.max(1, Math.round(val))
            }, 'step-repeat-max')
          )
        } else {
          body.append(
            createLabeledNumber('Repeat count (times)', step.times ?? 3, 1, 100000, 1, (val) => {
              pushHistory()
              step.times = Math.max(1, Math.round(val))
            }, 'step-repeat-times')
          )
        }
        body.append(createNestedBlock('Repeat loop steps', step.steps ||= [], stepPath, `${valPath}/steps`, depth + 1))
      }

      return body.childNodes.length ? body : null
    }

    function createSlotOrItemSelector(step, allowLore) {
      const sel = step.select || (step.select = { slot: 0 })
      const currentMode = sel.lore !== undefined ? 'lore' : sel.name !== undefined ? 'name' : 'slot'
      const modes = [
        { value: 'slot', label: 'By slot number' },
        { value: 'name', label: 'By item name' }
      ]
      if (allowLore) modes.push({ value: 'lore', label: 'By item lore text' })

      const modeSelect = createLabeledSelect('Select item by', modes, currentMode, (nextMode) => {
        pushHistory()
        if (nextMode === 'slot') step.select = { slot: 0 }
        else if (nextMode === 'name') step.select = { name: 'diamond' }
        else step.select = { lore: 'Soulbound' }
        renderSteps()
      }, 'step-select-mode')

      const valueField = currentMode === 'slot'
        ? createLabeledNumber('Slot (0–255)', sel.slot ?? 0, 0, 255, 1, (val) => {
            pushHistory()
            step.select = { slot: Math.max(0, Math.min(255, Math.round(val))) }
          }, 'step-select-slot')
        : currentMode === 'lore'
          ? createLabeledText('Lore contains', sel.lore ?? '', 'e.g. Soulbound', 80, (val) => {
              pushHistory()
              step.select = { lore: val.trim() }
            }, 'step-select-lore')
          : createLabeledText('Item name', sel.name ?? '', 'e.g. diamond_sword', 80, (val) => {
              pushHistory()
              step.select = { name: val.trim() }
            }, 'step-select-name')

      return [modeSelect, valueField]
    }

    function createNestedBlock(label, childSteps, listPath, valPrefix, depth) {
      const block = document.createElement('div')
      block.className = 'macro-nested-block full'
      const pathKey = JSON.stringify(listPath)
      const isCollapsed = collapsedPaths.has(pathKey)

      const header = document.createElement('div')
      header.className = 'macro-nested-header'
      const toggleBtn = document.createElement('button')
      toggleBtn.type = 'button'
      toggleBtn.className = 'macro-nested-toggle'
      toggleBtn.setAttribute('aria-expanded', String(!isCollapsed))
      toggleBtn.textContent = `${isCollapsed ? '▸' : '▾'} ${label} (${childSteps.length})`
      toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        if (collapsedPaths.has(pathKey)) collapsedPaths.delete(pathKey)
        else collapsedPaths.add(pathKey)
        renderSteps()
      })

      const addControls = document.createElement('div')
      addControls.className = 'macro-nested-actions'
      const quickAddSelect = document.createElement('select')
      quickAddSelect.className = 'compact-select step-add-nested-select'
      quickAddSelect.setAttribute('aria-label', `Add step to ${label}`)
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = '＋ Add nested step…'
      quickAddSelect.append(placeholder)
      for (const { group, types } of STEP_GROUPS) {
        const og = document.createElement('optgroup')
        og.label = group
        for (const t of types) {
          const spec = STEP_TYPES[t]
          if (!spec) continue
          const opt = document.createElement('option')
          opt.value = t
          const reason = unsupportedEditionReason(spec.editions)
          opt.disabled = Boolean(reason)
          opt.textContent = spec.label
          og.append(opt)
        }
        quickAddSelect.append(og)
      }
      quickAddSelect.addEventListener('change', (event) => {
        event.stopPropagation()
        const chosen = quickAddSelect.value
        quickAddSelect.value = ''
        if (chosen) {
          collapsedPaths.delete(pathKey)
          insertStepOfType(chosen, { listPath, index: childSteps.length })
        }
      })
      addControls.append(quickAddSelect)
      header.append(toggleBtn, addControls)
      block.append(header)

      if (!isCollapsed) {
        const listEl = document.createElement('div')
        listEl.className = 'macro-nested-steps'
        listEl.setAttribute('role', 'list')
        if (!childSteps.length) {
          const hint = document.createElement('p')
          hint.className = 'macro-muted-hint'
          hint.textContent = 'Empty block. Use “＋ Add nested step…” above to add steps inside.'
          listEl.append(hint)
        } else {
          listEl.append(...renderStepListNodes(childSteps, listPath, valPrefix, depth))
        }
        block.append(listEl)
      }
      return block
    }

    function createLabeledText(labelText, value, placeholder, maxLength, onChange, inputClass = '') {
      const label = document.createElement('label')
      label.className = 'field'
      const span = document.createElement('span')
      span.textContent = labelText
      const input = document.createElement('input')
      if (inputClass) input.className = inputClass
      input.type = 'text'
      input.maxLength = maxLength || 256
      input.placeholder = placeholder || ''
      input.value = value ?? ''
      input.addEventListener('input', () => onChange(input.value))
      label.append(span, input)
      return label
    }

    function createLabeledNumber(labelText, value, min, max, step, onChange, inputClass = '') {
      const label = document.createElement('label')
      label.className = 'field'
      const span = document.createElement('span')
      span.textContent = labelText
      const input = document.createElement('input')
      if (inputClass) input.className = inputClass
      input.type = 'number'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(value ?? 0)
      input.addEventListener('change', () => onChange(Number(input.value)))
      label.append(span, input)
      return label
    }

    function createLabeledSelect(labelText, options, value, onChange, selectClass = '') {
      const label = document.createElement('label')
      label.className = 'field'
      const span = document.createElement('span')
      span.textContent = labelText
      const select = document.createElement('select')
      if (selectClass) select.className = selectClass
      select.replaceChildren(...options.map((opt) => {
        const elOpt = document.createElement('option')
        elOpt.value = opt.value
        elOpt.textContent = opt.label
        return elOpt
      }))
      select.value = value
      select.addEventListener('change', () => onChange(select.value))
      label.append(span, select)
      return label
    }

    function createCheckboxField(labelText, checked, onChange) {
      const label = document.createElement('label')
      label.className = 'check-row'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = Boolean(checked)
      input.addEventListener('change', () => onChange(input.checked))
      const span = document.createElement('span')
      span.textContent = labelText
      label.append(input, span)
      return label
    }

    function createIconButton(symbol, ariaLabel, onClick) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'icon-button'
      btn.textContent = symbol
      btn.title = ariaLabel
      btn.setAttribute('aria-label', ariaLabel)
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        onClick()
      })
      return btn
    }

    function renderValidationErrors() {
      const banner = el['macro-validation-banner']
      const trigErr = el['macro-trigger-error']
      const targErr = el['macro-targets-error']
      const stepsErr = el['macro-steps-error']
      if (!banner) return

      if (!draftValidationErrors.length) {
        banner.hidden = true
        if (trigErr) trigErr.hidden = true
        if (targErr) targErr.hidden = true
        if (stepsErr) stepsErr.hidden = true
        return
      }

      banner.textContent = draftValidationErrors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join(' · ')
      banner.hidden = false

      const triggerMsgs = draftValidationErrors.filter((e) => e.path.startsWith('/trigger')).map((e) => e.message)
      if (trigErr) {
        trigErr.textContent = triggerMsgs.join(' ')
        trigErr.hidden = triggerMsgs.length === 0
      }

      const targetMsgs = draftValidationErrors.filter((e) => e.path.startsWith('/targets')).map((e) => e.message)
      if (targErr) {
        targErr.textContent = targetMsgs.join(' ')
        targErr.hidden = targetMsgs.length === 0
      }

      const rootStepMsgs = draftValidationErrors.filter((e) => e.path === '/steps').map((e) => e.message)
      if (stepsErr) {
        stepsErr.textContent = rootStepMsgs.join(' ')
        stepsErr.hidden = rootStepMsgs.length === 0
      }
    }

    async function saveCurrentMacro() {
      if (!draft) return
      draft.name = el['macro-name-input']?.value.trim() || 'Untitled macro'
      try {
        const saved = await api.macros.save(draft)
        draftValidationErrors = []
        selectedMacroId = saved.id
        await refreshLibrary()
        selectMacro(saved.id)
        toast('Macro saved.')
      } catch (error) {
        if (Array.isArray(error?.validation)) {
          draftValidationErrors = error.validation
        } else {
          const msg = cleanError(error)
          draftValidationErrors = [{ path: '', message: msg }]
        }
        renderValidationErrors()
        renderSteps()
        toast(cleanError(error), 'error')
      }
    }

    async function runSelectedMacroNow() {
      const macroId = draft?.id || selectedMacroId
      const accountId = el['macro-watch-account']?.value || state.selectedId
      if (!macroId) return toast('Select a macro to run.', 'error')
      if (!accountId) return toast('Select an account to run this macro on.', 'error')
      try {
        if (draft && !macros.some((m) => m.id === draft.id)) {
          await saveCurrentMacro()
        }
        const res = await api.macros.run(accountId, macroId)
        if (res?.status) {
          lastStatusByMacro.set(macroId, { status: res.status, at: Date.now() })
          renderLibraryList()
          renderLiveHeader()
        }
        if (activeTab === 'runs') await loadRunsForSelected()
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    async function stopWatchedAccount() {
      const accountId = el['macro-watch-account']?.value || state.selectedId
      if (!accountId) return
      try {
        await api.macros.stop(accountId)
        toast('Stopped running macro.')
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function handleMacroRunEvent(event) {
      if (!event || !event.macroId) return
      const key = `${event.macroId}:${event.accountId || ''}`
      liveByMacroAccount.set(key, event)
      lastStatusByMacro.set(event.macroId, {
        status: event.status,
        reason: event.reason,
        error: event.error,
        at: event.at || Date.now()
      })
      if (el['automation-dialog']?.open) {
        renderLibraryList()
        renderLiveHeader()
        if (draft && draft.id === event.macroId) {
          renderSteps()
          if (activeTab === 'runs' && ['completed', 'failed', 'cancelled', 'stopped', 'interrupted', 'skipped'].includes(event.status)) {
            void loadRunsForSelected()
          }
        }
      }
    }

    function renderLiveHeader() {
      const chip = el['macro-live-chip']
      if (!chip) return
      const macroId = draft?.id || selectedMacroId
      const accountId = el['macro-watch-account']?.value || state.selectedId || ''
      const live = macroId ? (liveByMacroAccount.get(`${macroId}:${accountId}`) || lastStatusByMacro.get(macroId)) : null
      if (!live) {
        chip.className = 'macro-status-chip idle'
        chip.textContent = 'Idle'
        return
      }
      const tone = statusTone(live.status)
      chip.className = `macro-status-chip ${tone}`
      const stepInfo = Array.isArray(live.stepPath) && live.status === 'step'
        ? ` · step #${live.stepPath.map((n) => n + 1).join('.')}`
        : ''
      chip.textContent = `${statusLabel(live.status, live.reason)}${stepInfo}`
    }

    async function loadRunsForSelected() {
      const macroId = draft?.id || selectedMacroId
      const listEl = el['macro-runs-list']
      if (!listEl || !macroId) return
      try {
        const records = api.macros?.runs ? await api.macros.runs(macroId) : []
        const list = Array.isArray(records) ? records.slice().reverse() : []
        runsCache.set(macroId, list)
        if (el['macro-runs-badge']) el['macro-runs-badge'].textContent = String(list.length)
        if (!list.length) {
          const empty = document.createElement('p')
          empty.className = 'macro-muted-hint'
          empty.textContent = 'No recorded runs for this macro yet.'
          listEl.replaceChildren(empty)
          return
        }
        listEl.replaceChildren(...list.map((rec) => {
          const card = document.createElement('article')
          card.className = 'macro-run-record'
          const top = document.createElement('div')
          top.className = 'macro-run-record-top'

          const chip = document.createElement('span')
          chip.className = `macro-status-chip ${statusTone(rec.status)}`
          chip.textContent = statusLabel(rec.status, rec.reason)

          const trig = document.createElement('span')
          trig.className = 'macro-meta-pill'
          trig.textContent = `Trigger: ${rec.trigger || 'manual'}`

          const dur = document.createElement('span')
          dur.className = 'macro-meta-pill'
          const elapsed = rec.endedAt && rec.startedAt ? rec.endedAt - rec.startedAt : 0
          dur.textContent = `Duration: ${formatDuration(elapsed)}`

          const time = document.createElement('time')
          time.className = 'macro-run-time'
          if (rec.startedAt) time.textContent = new Date(rec.startedAt).toLocaleTimeString()

          top.append(chip, trig, dur, time)
          card.append(top)

          const steps = Array.isArray(rec.steps) ? rec.steps : []
          const failedSteps = steps.filter((s) => !s.ok)
          const summary = document.createElement('div')
          summary.className = 'macro-run-steps-summary'
          summary.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'} executed${failedSteps.length ? ` · ${failedSteps.length} failed` : ''}`
          card.append(summary)

          if (rec.error?.message) {
            const errLine = document.createElement('div')
            errLine.className = 'macro-inline-error'
            errLine.textContent = `${rec.error.code ? `[${rec.error.code}] ` : ''}${rec.error.message}`
            card.append(errLine)
          }

          if (failedSteps.length) {
            const failList = document.createElement('ul')
            failList.className = 'macro-run-failed-list'
            for (const f of failedSteps) {
              const li = document.createElement('li')
              const pathLabel = Array.isArray(f.path) ? `#${f.path.map((n) => n + 1).join('.')}` : ''
              li.textContent = `Step ${pathLabel} (${f.type}): ${f.error || 'Failed'}`
              failList.append(li)
            }
            card.append(failList)
          }

          return card
        }))
      } catch (error) {
        toast(cleanError(error), 'error')
      }
    }

    function handleDialogKeyDown(event) {
      const target = event.target
      const inInput = Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))
      const ctrlOrMeta = event.ctrlKey || event.metaKey

      // Ctrl+Enter saves from anywhere in the editor
      if (ctrlOrMeta && event.key === 'Enter' && draft) {
        event.preventDefault()
        event.stopPropagation()
        void saveCurrentMacro()
        return
      }

      // Ctrl+K inside automation dialog opens Add Step picker instead of command center
      if (ctrlOrMeta && event.key.toLowerCase() === 'k' && draft) {
        event.preventDefault()
        event.stopPropagation()
        toggleStepPicker(true)
        return
      }

      // Undo / Redo when not typing in an input
      if (ctrlOrMeta && !inInput && event.key.toLowerCase() === 'z' && draft) {
        event.preventDefault()
        if (event.shiftKey) redoDraft()
        else undoDraft()
        return
      }
      if (ctrlOrMeta && !inInput && event.key.toLowerCase() === 'y' && draft) {
        event.preventDefault()
        redoDraft()
        return
      }

      // Duplicate step with Ctrl+D
      if (ctrlOrMeta && event.key.toLowerCase() === 'd' && draft) {
        event.preventDefault()
        duplicateStepAtPath(selectedStepPath)
        return
      }

      if (event.key === 'Escape') {
        if (!el['macro-step-picker']?.hidden) {
          event.preventDefault()
          event.stopPropagation()
          el['macro-step-picker'].hidden = true
          focusSelectedStepCard()
          return
        }
        if (inInput && target?.closest?.('.macro-step-card')) {
          event.preventDefault()
          event.stopPropagation()
          target.closest('.macro-step-card').focus()
          return
        }
      }

      if (inInput || !draft || activeTab !== 'editor') return

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const delta = event.key === 'ArrowDown' ? 1 : -1
        if (event.altKey || event.shiftKey || ctrlOrMeta) {
          event.preventDefault()
          moveStepByOffset(selectedStepPath, delta)
          return
        }
        const cards = [...(el['macro-step-list']?.querySelectorAll('.macro-step-card') || [])]
        if (!cards.length) return
        event.preventDefault()
        const currentKey = JSON.stringify(selectedStepPath)
        const currentIdx = cards.findIndex((c) => c.dataset.stepPath === currentKey)
        const nextIdx = currentIdx === -1 ? 0 : Math.max(0, Math.min(cards.length - 1, currentIdx + delta))
        selectedStepPath = JSON.parse(cards[nextIdx].dataset.stepPath)
        updateStepSelectionClasses()
        cards[nextIdx].focus()
        return
      }

      if (event.key === 'Enter' && target?.classList?.contains('macro-step-card')) {
        const firstField = target.querySelector('.macro-step-body input, .macro-step-body select, .macro-step-type-select')
        if (firstField) {
          event.preventDefault()
          firstField.focus()
        }
        return
      }

      if ((event.key === ' ' || event.key === '/') && !target?.closest?.('button')) {
        event.preventDefault()
        toggleStepPicker(true)
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedStepPath.length) {
          event.preventDefault()
          deleteStepAtPath(selectedStepPath)
        }
      }
    }

    bind()

    return {
      open,
      refreshLibrary,
      handleMacroRunEvent
    }
  }

  window.afkMacroEditor = { createMacroEditor }
})()
