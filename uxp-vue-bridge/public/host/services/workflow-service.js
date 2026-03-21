(function initTunanWorkflowService(global) {
  const UNSYNCED_LABEL = '未同步'
  const UNSELECTED_LABEL = '未选中工作流'

  function normalizeWorkflowName(value = '') {
    return String(value || '').trim()
  }

  function normalizeWorkflowKey(value = '') {
    return normalizeWorkflowName(value).toLowerCase()
  }

  function normalizeWorkflowFilename(value = '') {
    return String(value || '')
      .trim()
      .split(/[\\/]/)
      .pop()
      .toLowerCase()
  }

  function normalizeWorkflowPath(value = '') {
    return String(value || '')
      .trim()
      .replace(/\\/g, '/')
      .toLowerCase()
  }

  function countWorkflowNames(items = []) {
    const counts = new Map()

    for (const item of items) {
      const key = normalizeWorkflowKey(item?.name)
      if (!key) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }

    return counts
  }

  function findUniqueByName(items = [], name = '') {
    const targetKey = normalizeWorkflowKey(name)
    if (!targetKey) return null

    const matches = items.filter((item) => normalizeWorkflowKey(item?.name) === targetKey)
    return matches.length === 1 ? matches[0] : null
  }

  function resolveCurrentWorkflowTab(
    openedTabs = [],
    currentTab = null,
    preferredCurrentWorkflow = '',
    preferredCurrentWorkflowId = '',
  ) {
    if (!Array.isArray(openedTabs) || openedTabs.length === 0) {
      return null
    }

    const preferredId = String(preferredCurrentWorkflowId || '').trim()
    if (preferredId) {
      const matchedByPreferredId = openedTabs.find(
        (tab) => tab.id === preferredId || tab.workflowId === preferredId,
      )
      if (matchedByPreferredId) {
        return matchedByPreferredId
      }
    }

    const currentTabId =
      typeof currentTab === 'string'
        ? String(currentTab).trim()
        : String(currentTab?.id || currentTab?.tab_id || currentTab?.workflow_id || '').trim()
    if (currentTabId) {
      const matchedByCurrentId = openedTabs.find(
        (tab) => tab.id === currentTabId || tab.workflowId === currentTabId,
      )
      if (matchedByCurrentId) {
        return matchedByCurrentId
      }
    }

    const preferredName =
      normalizeWorkflowName(preferredCurrentWorkflow) ||
      normalizeWorkflowName(currentTab?.name || currentTab?.filename)
    const matchedByPreferredName = findUniqueByName(openedTabs, preferredName)
    if (matchedByPreferredName) {
      return matchedByPreferredName
    }

    return openedTabs.find((tab) => tab.isCurrent) || null
  }

  function resolveCurrentWorkflowName(
    openedTabs = [],
    currentTab = null,
    preferredCurrentWorkflow = '',
    preferredCurrentWorkflowId = '',
  ) {
    if (!Array.isArray(openedTabs) || openedTabs.length === 0) {
      return UNSYNCED_LABEL
    }

    return (
      resolveCurrentWorkflowTab(
        openedTabs,
        currentTab,
        preferredCurrentWorkflow,
        preferredCurrentWorkflowId,
      )?.name || UNSELECTED_LABEL
    )
  }

  class TunanWorkflowService {
    constructor(emit) {
      this.emit = emit
      this.requestBridge = null
      this.configProvider = null
      this.currentWorkflow = UNSYNCED_LABEL
      this.currentWorkflowId = 'current_active'
      this.workflows = []
      this.savedWorkflows = []
      this.openedTabs = []
      this.activeFrontend = null
      this.availableFrontends = { desktop: 0, browser: 0, unknown: 0 }
      this.frontendSessions = []
      this.selectedFrontendTarget = ''
      this.emitSuspended = false
    }

    setConfigProvider(configProvider) {
      this.configProvider = typeof configProvider === 'function' ? configProvider : null
    }

    setEmitSuspended(suspended) {
      this.emitSuspended = Boolean(suspended)
    }

    setRequestBridge(requestBridge) {
      this.requestBridge = typeof requestBridge === 'function' ? requestBridge : null
    }

    async request(message, options = {}) {
      if (!this.requestBridge) {
        throw new Error('工作流通信桥未初始化')
      }

      return this.requestBridge(message, options)
    }

    buildStatePayload(extra = {}) {
      return {
        ...extra,
        currentWorkflow: this.currentWorkflow,
        currentWorkflowId: this.currentWorkflowId,
        workflows: this.workflows,
        openedTabs: this.openedTabs,
        savedWorkflows: this.savedWorkflows,
        activeFrontend: this.activeFrontend,
        availableFrontends: this.availableFrontends,
        frontendSessions: this.frontendSessions,
        selectedFrontendTarget: this.selectedFrontendTarget,
      }
    }

    applyControlState(state = {}) {
      this.activeFrontend = state.session_kind
        ? { kind: state.session_kind, sessionId: state.session_id || null }
        : null
      this.availableFrontends = state.available_frontends || { desktop: 0, browser: 0, unknown: 0 }
      this.frontendSessions = Array.isArray(state.frontend_sessions) ? state.frontend_sessions : []

      const availableSessionIds = new Set(
        this.frontendSessions.map((item) => item?.session_id).filter(Boolean),
      )
      const selected = state.selected_session_id || ''
      this.selectedFrontendTarget = selected && availableSessionIds.has(selected) ? selected : ''
    }

    normalizeOpenedTab(tab = {}) {
      const name = normalizeWorkflowName(tab.name || tab.filename) || '未命名工作流'
      const filename = String(tab.filename || `${name}.json`)
        .trim()
        .split(/[\\/]/)
        .pop()

      return {
        id: String(tab.id || tab.tab_id || name),
        workflowId: String(tab.workflow_id || tab.workflowId || '').trim(),
        name,
        filename,
        filenameKey: normalizeWorkflowFilename(filename),
        path: String(tab.path || tab.workflow_path || ''),
        pathKey: normalizeWorkflowPath(tab.path || tab.workflow_path || ''),
        isModified: Boolean(tab.is_modified ?? tab.isModified),
        isSaved: tab.is_saved !== false && tab.isSaved !== false,
        isCurrent: Boolean(tab.is_current ?? tab.isCurrent),
        raw: tab,
      }
    }

    normalizeSavedWorkflow(item = {}) {
      const name = normalizeWorkflowName(item.name || item.filename) || '未命名工作流'
      const filename = String(item.filename || `${name}.json`)
        .trim()
        .split(/[\\/]/)
        .pop()
      const path = String(item.path || '')

      return {
        id: String(item.id || '').trim(),
        name,
        filename,
        filenameKey: normalizeWorkflowFilename(filename),
        type: item.type || 'saved',
        path,
        pathKey: normalizeWorkflowPath(path),
        lastModified: item.last_modified || item.lastModified || 0,
        isOpen: false,
        openTabId: '',
      }
    }

    findMatchingOpenedTab(savedWorkflow, duplicateNameCounts = new Map()) {
      if (!savedWorkflow) return null

      const savedId = String(savedWorkflow.id || '').trim()
      if (savedId) {
        const matchedByWorkflowId = this.openedTabs.find((tab) => tab.workflowId === savedId)
        if (matchedByWorkflowId) {
          return matchedByWorkflowId
        }
      }

      if (savedWorkflow.pathKey) {
        const matchedByPath = this.openedTabs.find((tab) => tab.pathKey === savedWorkflow.pathKey)
        if (matchedByPath) {
          return matchedByPath
        }
      }

      if (savedWorkflow.filenameKey) {
        const filenameMatches = this.openedTabs.filter(
          (tab) => tab.filenameKey === savedWorkflow.filenameKey,
        )
        if (filenameMatches.length === 1) {
          return filenameMatches[0]
        }
      }

      const savedNameKey = normalizeWorkflowKey(savedWorkflow.name)
      if (!savedNameKey || duplicateNameCounts.get(savedNameKey) !== 1) {
        return null
      }

      const nameMatches = this.openedTabs.filter(
        (tab) => normalizeWorkflowKey(tab.name) === savedNameKey,
      )
      return nameMatches.length === 1 ? nameMatches[0] : null
    }

    refreshSavedWorkflowOpenState() {
      const duplicateNameCounts = countWorkflowNames(this.savedWorkflows)
      this.savedWorkflows = this.savedWorkflows.map((item) => {
        const matchedOpenTab = this.findMatchingOpenedTab(item, duplicateNameCounts)
        return {
          ...item,
          isOpen: Boolean(matchedOpenTab),
          openTabId: matchedOpenTab?.id || '',
        }
      })
    }

    updateOpenedTabs(
      tabs = [],
      currentTab = null,
      preferredCurrentWorkflow = '',
      preferredCurrentWorkflowId = '',
    ) {
      this.openedTabs = Array.isArray(tabs) ? tabs.map((tab) => this.normalizeOpenedTab(tab)) : []
      this.workflows = this.openedTabs.map((tab) => tab.name).filter(Boolean)

      const resolvedCurrentTab = resolveCurrentWorkflowTab(
        this.openedTabs,
        currentTab,
        preferredCurrentWorkflow,
        preferredCurrentWorkflowId,
      )

      this.currentWorkflow = resolvedCurrentTab
        ? resolvedCurrentTab.name
        : resolveCurrentWorkflowName(
            this.openedTabs,
            currentTab,
            preferredCurrentWorkflow,
            preferredCurrentWorkflowId,
          )
      this.currentWorkflowId =
        resolvedCurrentTab?.id ||
        (this.currentWorkflow === UNSELECTED_LABEL ? 'unselected_workflow' : 'current_active')

      this.refreshSavedWorkflowOpenState()
      this.emitState()
      return this.buildStatePayload()
    }

    emitState(extra = {}) {
      if (this.emitSuspended) return

      this.emit?.({
        type: 'HOST_PUSH',
        result: this.buildStatePayload(extra),
      })
    }

    async setControlTarget(sessionId = '') {
      const response = await this.request(
        {
          type: 'set_control_target',
          session_id: sessionId || '',
          mode: sessionId ? 'manual' : 'auto',
        },
        { expectTypes: ['control_target_updated'] },
      )

      const state = response.data || {}
      this.applyControlState(state)
      this.updateOpenedTabs(state.tabs || [], state.current_tab || null)
      return this.buildStatePayload()
    }

    async fetchSavedWorkflows(force = false) {
      const response = await this.request(
        {
          type: 'get_workflows',
          force,
        },
        { expectTypes: ['workflows_list'] },
      )

      this.savedWorkflows = (response.workflows || [])
        .filter((item) => item?.id !== 'current_active')
        .map((item) => this.normalizeSavedWorkflow(item))

      this.refreshSavedWorkflowOpenState()
      this.emitState()
      return this.buildStatePayload()
    }

    async fetchOpenedTabs() {
      const response = await this.request(
        { type: 'get_tabs' },
        { expectTypes: ['get_tabs_response'], timeoutMs: 5000 },
      )

      const state = response.data || {
        tabs: response.tabs || [],
        current_tab: response.current_tab || response.current || null,
        session_kind: response.frontend_kind || null,
        session_id: response.frontend_session_id || null,
        selected_session_id: response.selected_session_id || '',
        available_frontends: response.available_frontends || this.availableFrontends,
        frontend_sessions: response.frontend_sessions || this.frontendSessions,
      }

      this.applyControlState(state)
      return this.updateOpenedTabs(state.tabs || [], state.current_tab || null)
    }

    async listWorkflows() {
      let tabsError = null
      let workflowsError = null

      try {
        await this.fetchOpenedTabs()
      } catch (error) {
        tabsError = error
      }

      try {
        await this.fetchSavedWorkflows(true)
      } catch (error) {
        workflowsError = error
      }

      if (tabsError && workflowsError) {
        throw workflowsError
      }

      return this.buildStatePayload({
        browserWorkflows: this.savedWorkflows,
      })
    }

    async switchToOpenedTab(tabId) {
      return this.request(
        {
          type: 'switch_tab',
          tab_id: tabId,
        },
        { expectTypes: ['switch_tab_response'] },
      )
    }

    async loadSavedWorkflow(workflowId) {
      return this.request(
        {
          type: 'load_workflow',
          workflow_id: workflowId,
        },
        { expectTypes: ['load_workflow_response'] },
      )
    }

    async switchWorkflow({ workflowId = null, workflowName = null } = {}) {
      const requestedWorkflowId = String(workflowId || '').trim()
      const requestedWorkflowName = normalizeWorkflowName(workflowName)
      if (!requestedWorkflowId && !requestedWorkflowName) {
        return this.buildStatePayload({ switched: false })
      }

      await this.fetchOpenedTabs().catch(() => {})

      let matchedOpenTab = null
      if (requestedWorkflowId) {
        matchedOpenTab =
          this.openedTabs.find(
            (tab) => tab.id === requestedWorkflowId || tab.workflowId === requestedWorkflowId,
          ) || null
      }

      if (!matchedOpenTab && requestedWorkflowName) {
        matchedOpenTab = findUniqueByName(this.openedTabs, requestedWorkflowName)
      }

      if (matchedOpenTab) {
        if (matchedOpenTab.id !== this.currentWorkflowId) {
          await this.switchToOpenedTab(matchedOpenTab.id)
          await this.fetchOpenedTabs().catch(() => {})
        }

        await this.fetchSavedWorkflows(true).catch(() => {})
        this.emitState({ switched: true })
        return this.buildStatePayload({ switched: true })
      }

      if (!this.savedWorkflows.length) {
        await this.fetchSavedWorkflows(true).catch(() => {})
      }

      let matchedSaved = null
      if (requestedWorkflowId) {
        matchedSaved =
          this.savedWorkflows.find(
            (item) => item.id === requestedWorkflowId || item.openTabId === requestedWorkflowId,
          ) || null
      }

      if (!matchedSaved && requestedWorkflowName) {
        matchedSaved = findUniqueByName(this.savedWorkflows, requestedWorkflowName)
      }

      if (!matchedSaved || !matchedSaved.id) {
        const debugName = requestedWorkflowName || requestedWorkflowId
        throw new Error(`未找到工作流: ${debugName}`)
      }

      if (matchedSaved.openTabId) {
        await this.switchToOpenedTab(matchedSaved.openTabId)
        await this.fetchOpenedTabs().catch(() => {})
        await this.fetchSavedWorkflows(true).catch(() => {})

        const nextPayload = {
          switched: true,
          pendingWorkflow: matchedSaved.name,
          alreadyOpen: true,
        }
        this.emitState(nextPayload)
        return this.buildStatePayload(nextPayload)
      }

      const loadResult = await this.loadSavedWorkflow(matchedSaved.id)
      await this.fetchOpenedTabs().catch(() => {})
      await this.fetchSavedWorkflows(true).catch(() => {})

      const nextPayload = {
        switched: true,
        pendingWorkflow: matchedSaved.name,
        alreadyOpen: Boolean(loadResult?.already_open),
      }

      this.emitState(nextPayload)
      return this.buildStatePayload(nextPayload)
    }
  }

  global.TunanWorkflowService = TunanWorkflowService
  global.TunanWorkflowLabels = {
    UNSYNCED_LABEL,
    UNSELECTED_LABEL,
  }
})(window)
