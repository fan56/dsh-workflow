/**
 * Live run state for the tui widget — a tiny module-level snapshot the
 * widget renders from. The command path feeds it (run started / step
 * update / run settled); the widget only reads. No timers: a settled run
 * stays visible for a grace window and then simply stops being returned.
 *
 * @module @aiwayds/dsh-workflow/run-state
 */

export type WidgetStepStatus = 'running' | 'completed' | 'failed' | 'skipped'

export interface WidgetStepState {
  status: WidgetStepStatus
  totalTokens?: number
}

export interface WidgetRunState {
  runId: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  settledAt?: number
  steps: Map<string, WidgetStepState>
}

const active = new Map<string, WidgetRunState>()
/** How long a settled run stays visible to the widget (ms). */
const SETTLED_GRACE_MS = 60_000

export function widgetRunStarted(runId: string, name: string): void {
  active.set(runId, { runId, name, status: 'running', startedAt: Date.now(), steps: new Map() })
}

export function widgetStepUpdate(
  runId: string,
  stepId: string,
  status: WidgetStepStatus,
  totalTokens?: number,
): void {
  const run = active.get(runId)
  if (run === undefined) return
  run.steps.set(stepId, { status, ...(totalTokens !== undefined ? { totalTokens } : {}) })
}

export function widgetRunSettled(runId: string, status: 'completed' | 'failed'): void {
  const run = active.get(runId)
  if (run === undefined) return
  run.status = status
  run.settledAt = Date.now()
}

/**
 * Snapshot for the widget: every running run first, then settled runs
 * inside the grace window, oldest-first by start time.
 */
export function snapshotWidgetRuns(now = Date.now()): WidgetRunState[] {
  const runs = [...active.values()]
    .filter((run) => run.status === 'running' || (run.settledAt !== undefined && now - run.settledAt < SETTLED_GRACE_MS))
    .sort((a, b) => a.startedAt - b.startedAt)
  // Garbage-collect the grace-expired entries while we are here.
  for (const [runId, run] of active) {
    if (run.status !== 'running' && run.settledAt !== undefined && now - run.settledAt >= SETTLED_GRACE_MS) {
      active.delete(runId)
    }
  }
  return runs
}

/** Test/diagnostic escape hatch: drop everything. */
export function resetWidgetRuns(): void {
  active.clear()
}
