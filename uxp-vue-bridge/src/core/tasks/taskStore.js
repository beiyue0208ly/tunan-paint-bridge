import { computed, ref } from 'vue'

export function createTaskStore() {
  const currentTask = ref(null)
  const lastTaskSnapshot = ref(null)

  const canRerun = computed(() => !!lastTaskSnapshot.value)
  const isRunning = computed(() => currentTask.value?.status === 'running')
  const isPending = computed(() => currentTask.value?.status === 'pending')

  function beginTask(kind, payload = {}, options = {}) {
    const task = {
      id: `task-${Date.now()}`,
      kind,
      payload,
      startedAt: Date.now(),
      status: options.status || 'running',
    }

    currentTask.value = task
    lastTaskSnapshot.value = {
      kind,
      payload,
    }
    return task
  }

  function finishTask(status = 'done', extra = {}) {
    if (!currentTask.value) return
    currentTask.value = {
      ...currentTask.value,
      ...extra,
      status,
      finishedAt: Date.now(),
    }
  }

  function setTaskStatus(status, extra = {}) {
    if (!currentTask.value) return
    currentTask.value = {
      ...currentTask.value,
      ...extra,
      status,
    }
  }

  function clearCurrentTask() {
    currentTask.value = null
  }

  return {
    currentTask,
    lastTaskSnapshot,
    canRerun,
    isRunning,
    isPending,
    beginTask,
    finishTask,
    setTaskStatus,
    clearCurrentTask,
  }
}
