/**
 * Session projection — fold a run's lifecycle into the host's
 * `tool-workflow/*` Session event family so the official
 * `dsh-client-ui-workflow-run` conversation node renders it in tui and web
 * for free (wayfinder ticket 02: the community capsule's proven trick; we
 * consume the same event names and shapes the official tool writes).
 *
 * Recording is observational: an append failure warns once and disables all
 * later writes for the run — the execution is never affected, exactly like
 * the official tool's recorder.
 *
 * @module @aiwayds/dsh-workflow/projection
 */

export interface RunProjector {
  runStarted(name: string): void
  agentStarted(label: string, childId: string): void
  agentEnded(status: 'completed' | 'failed' | 'cancelled'): void
  runFinished(stopReason: 'completed' | 'error' | 'cancelled'): void
}

/** Structural minimum of the Session surface the projector appends to. */
export interface ProjectorSession {
  append(type: string, data: Record<string, unknown>): unknown
}

export interface RunProjectorOptions {
  runId: string
  warn?: (message: string) => void
}

export function createRunProjector(session: ProjectorSession, options: RunProjectorOptions): RunProjector {
  const warn = options.warn ?? ((message: string) => console.warn(`[dsh-workflow] projection: ${message}`))
  let enabled = true
  let seq = 0

  function append(type: string, data: Record<string, unknown>): boolean {
    if (!enabled) return false
    try {
      session.append(type, data)
      return true
    } catch (error) {
      enabled = false
      warn(`disabled durable record for run ${options.runId} after ${type} append failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return {
    runStarted(name) {
      append('tool-workflow/run-start', { runId: options.runId, name })
    },
    agentStarted(label, childId) {
      seq += 1
      append('tool-workflow/agent-start', { runId: options.runId, seq, label, childId })
    },
    agentEnded(status) {
      append('tool-workflow/agent-end', { runId: options.runId, seq, outcome: status })
    },
    runFinished(stopReason) {
      append('tool-workflow/run-end', { runId: options.runId, stopReason })
    },
  }
}
