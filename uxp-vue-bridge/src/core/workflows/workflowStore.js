import { ref } from 'vue'

export const UNSYNCED_WORKFLOW_LABEL = '未同步'
export const UNSELECTED_WORKFLOW_LABEL = '未选中工作流'

function normalizeWorkflowName(value = '') {
  return String(value || '').trim()
}

function normalizeWorkflowKey(value = '') {
  return normalizeWorkflowName(value).toLowerCase()
}

export function hasOpenedWorkflowTabs(openedTabs = []) {
  return Array.isArray(openedTabs) && openedTabs.length > 0
}

export function isRunnableWorkflowName(name) {
  return Boolean(
    name && name !== UNSYNCED_WORKFLOW_LABEL && name !== UNSELECTED_WORKFLOW_LABEL,
  )
}

export function isResolvedWorkflowState(name, openedTabs = []) {
  return hasOpenedWorkflowTabs(openedTabs) && name !== UNSYNCED_WORKFLOW_LABEL
}

export function resolveCurrentWorkflowTab(
  openedTabs = [],
  preferredCurrentWorkflow = '',
  preferredCurrentWorkflowId = '',
) {
  if (!hasOpenedWorkflowTabs(openedTabs)) {
    return null
  }

  const preferredId = String(preferredCurrentWorkflowId || '').trim()
  if (preferredId) {
    const matchedById = openedTabs.find(
      (tab) => tab?.id === preferredId || tab?.workflowId === preferredId,
    )
    if (matchedById) {
      return matchedById
    }
  }

  const preferredName = normalizeWorkflowName(preferredCurrentWorkflow)
  if (preferredName) {
    const nameMatches = openedTabs.filter(
      (tab) => normalizeWorkflowKey(tab?.name) === normalizeWorkflowKey(preferredName),
    )
    if (nameMatches.length === 1) {
      return nameMatches[0]
    }
  }

  return openedTabs.find((tab) => tab?.isCurrent) || null
}

export function resolveCurrentWorkflowName(
  openedTabs = [],
  preferredCurrentWorkflow = '',
  preferredCurrentWorkflowId = '',
) {
  if (!hasOpenedWorkflowTabs(openedTabs)) {
    return UNSYNCED_WORKFLOW_LABEL
  }

  return (
    resolveCurrentWorkflowTab(openedTabs, preferredCurrentWorkflow, preferredCurrentWorkflowId)
      ?.name || UNSELECTED_WORKFLOW_LABEL
  )
}

export function createWorkflowStore() {
  const currentWorkflow = ref(UNSYNCED_WORKFLOW_LABEL)
  const currentWorkflowId = ref('current_active')
  const workflows = ref([])
  const openedTabs = ref([])
  const savedWorkflows = ref([])
  const dropdownOpen = ref(false)
  const browserVisible = ref(false)

  function setCurrentWorkflow(name, workflowId = '') {
    const normalizedName = normalizeWorkflowName(name)
    if (normalizedName) {
      currentWorkflow.value = normalizedName
      currentWorkflowId.value =
        String(workflowId || '').trim() ||
        resolveCurrentWorkflowTab(openedTabs.value, normalizedName)?.id ||
        'current_active'
      return
    }

    currentWorkflow.value = hasOpenedWorkflowTabs(openedTabs.value)
      ? UNSELECTED_WORKFLOW_LABEL
      : UNSYNCED_WORKFLOW_LABEL
    currentWorkflowId.value = hasOpenedWorkflowTabs(openedTabs.value)
      ? 'unselected_workflow'
      : 'current_active'
  }

  function setWorkflows(nextWorkflows = []) {
    if (!Array.isArray(nextWorkflows)) return

    workflows.value = nextWorkflows.filter(Boolean)

    if (!workflows.value.length && !openedTabs.value.length) {
      currentWorkflow.value = UNSYNCED_WORKFLOW_LABEL
      currentWorkflowId.value = 'current_active'
    }
  }

  function setOpenedTabs(nextTabs = [], preferredCurrentWorkflow = '', preferredCurrentWorkflowId = '') {
    if (!Array.isArray(nextTabs)) return

    openedTabs.value = nextTabs
    workflows.value = nextTabs.map((tab) => tab?.name).filter(Boolean)

    const resolvedCurrentTab = resolveCurrentWorkflowTab(
      openedTabs.value,
      preferredCurrentWorkflow,
      preferredCurrentWorkflowId,
    )

    currentWorkflow.value =
      resolvedCurrentTab?.name ||
      resolveCurrentWorkflowName(
        openedTabs.value,
        preferredCurrentWorkflow,
        preferredCurrentWorkflowId,
      )
    currentWorkflowId.value =
      resolvedCurrentTab?.id ||
      (hasOpenedWorkflowTabs(openedTabs.value) ? 'unselected_workflow' : 'current_active')
  }

  function setSavedWorkflows(nextWorkflows = []) {
    if (!Array.isArray(nextWorkflows)) return
    savedWorkflows.value = nextWorkflows
  }

  function toggleDropdown(forceValue) {
    if (typeof forceValue === 'boolean') {
      dropdownOpen.value = forceValue
      return
    }

    dropdownOpen.value = !dropdownOpen.value
  }

  function toggleBrowser(forceValue) {
    if (typeof forceValue === 'boolean') {
      browserVisible.value = forceValue
      return
    }

    browserVisible.value = !browserVisible.value
  }

  function clear() {
    currentWorkflow.value = UNSYNCED_WORKFLOW_LABEL
    currentWorkflowId.value = 'current_active'
    workflows.value = []
    openedTabs.value = []
    savedWorkflows.value = []
    dropdownOpen.value = false
    browserVisible.value = false
  }

  return {
    currentWorkflow,
    currentWorkflowId,
    workflows,
    openedTabs,
    savedWorkflows,
    dropdownOpen,
    browserVisible,
    setCurrentWorkflow,
    setWorkflows,
    setOpenedTabs,
    setSavedWorkflows,
    toggleDropdown,
    toggleBrowser,
    clear,
  }
}
