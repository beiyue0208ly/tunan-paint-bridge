(function initTunanTaskCenter(global) {
  class TunanTaskCenter {
    constructor() {
      this.currentTask = null
      this.lastTaskSnapshot = null
    }

    beginTask(kind, payload = {}) {
      const task = {
        id: `task-${Date.now()}`,
        kind,
        payload,
        startedAt: Date.now(),
        status: 'running',
      }

      this.currentTask = task
      this.lastTaskSnapshot = { ...task }
      return task
    }

    finishTask(status, extra = {}) {
      if (!this.currentTask) return null

      this.currentTask = {
        ...this.currentTask,
        ...extra,
        status,
        finishedAt: Date.now(),
      }

      this.lastTaskSnapshot = {
        ...this.currentTask,
      }

      return this.currentTask
    }

    failTask(error) {
      return this.finishTask('error', {
        error: typeof error === 'string' ? error : error?.message || 'unknown error',
      })
    }

    getCurrentTask() {
      return this.currentTask
    }

    getLastTaskSnapshot() {
      return this.lastTaskSnapshot
    }

    clearCurrentTask() {
      this.currentTask = null
    }
  }

  global.TunanTaskCenter = TunanTaskCenter
})(window)
