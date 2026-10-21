/**
 * L1 repair — reconcile interrupted steps against their child sessions
 * (ticket 08, borrowing host-native capabilities).
 *
 * When a run is interrupted mid-step, the run store shows the step as
 * `running` (no terminal record) — but the CHILD's own session log holds
 * the truth: if the child's last turn ended `completed`, the step actually
 * finished and its output can be recovered from the log, turning an
 * interruption into a zero-cost replay instead of a re-run.
 *
 * Every leg is best-effort: a missing child, an unreadable log, or an
 * ambiguous ending leaves the step as-is for L3 (full re-run). The child
 * session id comes from the run store's `step-child` binding, which is
 * recorded at dispatch time — runs executed before this binding exists
 * degrade to L3 as well.
 *
 * @module @aiwayds/dsh-workflow/repair
 */

import type { StepOutcome } from './engine.ts'

/** Structural minimum of the host's session persistence (cost.ts parity). */
interface PersistenceLike {
  open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: ReadonlyArray<{ type: string; data?: unknown }> }>
    close(): Promise<void>
  }>
}

export interface RepairResult {
  repaired: string[]
  inspected: string[]
}

function getPersistence(host: unknown): PersistenceLike | undefined {
  const getter = (host as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const candidate = getter.call(host, 'sessionPersistence') as PersistenceLike | undefined
    if (candidate !== undefined && typeof candidate.open === 'function') return candidate
  } catch {
    /* service absent */
  }
  return undefined
}

/** Pull the final assistant text out of a child log's message shapes (defensive: shapes vary by host version). */
function lastAssistantText(events: ReadonlyArray<{ type: string; data?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: unknown } } | undefined
    const content = data?.message?.content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
        .filter((t) => t !== '')
        .join('\n')
        .trim()
      if (text !== '') return text
    }
  }
  return undefined
}

/** The turn/end reason kind of the child's last turn, if any. */
function lastEndKind(events: ReadonlyArray<{ type: string; data?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
    return typeof reason?.kind === 'string' ? reason.kind : undefined
  }
  return undefined
}

/**
 * Reconcile a stored run's steps against their child sessions. Mutates
 * `steps` in place: a step recorded as non-completed whose child actually
 * finished is flipped to completed with the recovered output, flagged
 * `replayed` (provenance: recovered by L1 repair).
 */
export async function reconcileInterruptedSteps(
  host: unknown,
  steps: Record<string, StepOutcome>,
): Promise<RepairResult> {
  const persistence = getPersistence(host)
  const result: RepairResult = { repaired: [], inspected: [] }
  if (persistence === undefined) return result

  for (const [stepId, step] of Object.entries(steps)) {
    if (step.status === 'completed' || step.status === 'skipped') continue
    const childId = step.childId
    if (childId === undefined) continue
    result.inspected.push(stepId)
    let handle: Awaited<ReturnType<PersistenceLike['open']>>
    try {
      handle = await persistence.open(childId, 'read')
    } catch {
      continue
    }
    try {
      const { events } = await handle.read()
      const kind = lastEndKind(events)
      if (kind !== 'completed') continue
      const text = lastAssistantText(events)
      if (text === undefined || text === '') continue
      step.status = 'completed'
      step.output = text
      step.replayed = true
      step.error = undefined
      result.repaired.push(stepId)
    } catch {
      continue
    } finally {
      try {
        await handle.close()
      } catch {
        /* best-effort close */
      }
    }
  }
  return result
}
