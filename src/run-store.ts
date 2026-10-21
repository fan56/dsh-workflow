/**
 * The Run Store — the durable record of one workflow run (wayfinder tickets
 * 02/05, layout adapted from the community capsule anatomy):
 *
 *   <root>/<runId>/
 *     run.json          rewritten snapshot: status, per-step outcomes, cost
 *     events.jsonl      append-only {seq,time,type,data} lines, closed vocabulary
 *     workflow.yaml     immutable definition snapshot
 *     results/<stepId>.json   per-step settled output
 *
 * Every write is wrapped: a store failure warns and degrades — monitoring
 * must never affect execution. Path pieces are validated against a safe-id
 * pattern (no separators, no `..`) so run/step ids can never escape the
 * run directory.
 *
 * @module @aiwayds/dsh-workflow/run-store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StepOutcome } from './engine.ts'
import type { WorkflowDef } from './types.ts'

/** The closed event vocabulary events.jsonl may contain. */
export type RunStoreEventType =
  | 'run-started'
  | 'run-completed'
  | 'run-failed'
  | 'step-started'
  | 'step-completed'
  | 'step-failed'
  | 'step-skipped'

// `#` is legal: foreach child checkpoints are named <foreachId>#<index>.
const SAFE_ID = /^[a-z0-9][a-z0-9#-]{0,63}$/

export interface RunStoreOptions {
  runId: string
  /** Directory the `.dsh/workflow-runs` store lives under (default: cwd). */
  root?: string
  warn?: (message: string) => void
}

export interface RunStore {
  readonly runDir: string
  /** Snapshot the definition and open the run. Idempotent per store instance. */
  begin(workflow: WorkflowDef, yamlText?: string, inputs?: Record<string, unknown>): void
  stepStarted(stepId: string): void
  stepSettled(stepId: string, outcome: StepOutcome): void
  /** Write the terminal snapshot. `finish` is terminal — later writes are dropped. */
  finish(outcome: { status: 'completed' | 'failed'; steps: Record<string, StepOutcome>; cost?: unknown }): void
}

export function createRunStore(options: RunStoreOptions): RunStore {
  const warn = options.warn ?? ((message: string) => console.warn(`[dsh-workflow] run store: ${message}`))
  if (!SAFE_ID.test(options.runId)) throw new Error(`run store: unsafe run id "${options.runId}"`)
  const root = options.root ?? process.cwd()
  const runDir = join(root, '.dsh', 'workflow-runs', options.runId)
  const resultsDir = join(runDir, 'results')
  const eventsPath = join(runDir, 'events.jsonl')
  const snapshotPath = join(runDir, 'workflow.yaml')
  const runJsonPath = join(runDir, 'run.json')

  const startedAt = new Date().toISOString()
  let finished = false
  let inputsSnapshot: Record<string, unknown> | undefined
  let eventSeq = 0
  const stepsSnapshot: Record<string, { status: string; attempts: number; error?: string; output?: string }> = {}

  function safeWrite(label: string, write: () => void): void {
    if (finished && label !== 'finish') return
    try {
      write()
    } catch (error) {
      warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function appendEvent(type: RunStoreEventType, data: Record<string, unknown>): void {
    safeWrite(`event append (${type})`, () => {
      appendFileSync(eventsPath, `${JSON.stringify({ seq: eventSeq++, time: new Date().toISOString(), type, ...data })}\n`)
    })
  }

  function writeRunJson(status: 'running' | 'completed' | 'failed', extra: Record<string, unknown> = {}): void {
    safeWrite(`run.json write (${status})`, () => {
      writeFileSync(runJsonPath, `${JSON.stringify({
        runId: options.runId,
        status,
        startedAt,
        ...(status !== 'running' ? { finishedAt: new Date().toISOString() } : {}),
        steps: stepsSnapshot,
        ...(inputsSnapshot !== undefined ? { inputs: inputsSnapshot } : {}),
        ...extra,
      }, null, 2)}\n`)
    })
  }

  const store: RunStore = {
    runDir,
    begin(workflow, yamlText, inputs) {
      inputsSnapshot = inputs
      safeWrite('run directory create', () => {
        mkdirSync(resultsDir, { recursive: true })
        if (yamlText !== undefined) writeFileSync(snapshotPath, yamlText)
        else writeFileSync(snapshotPath, JSON.stringify(workflow, null, 2))
      })
      appendEvent('run-started', { name: workflow.name })
      writeRunJson('running')
    },
    stepStarted(stepId) {
      if (!SAFE_ID.test(stepId)) return
      stepsSnapshot[stepId] = { status: 'running', attempts: 0 }
      appendEvent('step-started', { stepId })
      writeRunJson('running')
    },
    stepSettled(stepId, outcome) {
      if (!SAFE_ID.test(stepId)) return
      const type: RunStoreEventType =
        outcome.status === 'completed' ? 'step-completed' : outcome.status === 'skipped' ? 'step-skipped' : 'step-failed'
      stepsSnapshot[stepId] = {
        status: outcome.status,
        attempts: outcome.attempts,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined && outcome.output.length <= 4000 ? { output: outcome.output } : {}),
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.replayed === true ? { replayed: true } : {}),
      }
      appendEvent(type, { stepId, attempts: outcome.attempts, ...(outcome.error !== undefined ? { error: outcome.error } : {}) })
      safeWrite(`results/${stepId}.json write`, () => {
        writeFileSync(join(resultsDir, `${stepId}.json`), `${JSON.stringify({
          stepId,
          status: outcome.status,
          attempts: outcome.attempts,
          ...(outcome.output !== undefined ? { output: outcome.output } : {}),
          ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
          ...(outcome.actionOutput !== undefined ? { actionOutput: outcome.actionOutput } : {}),
          ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        }, null, 2)}\n`)
      })
      writeRunJson('running')
    },
    finish({ status, cost }) {
      appendEvent(status === 'completed' ? 'run-completed' : 'run-failed', {})
      writeRunJson(status, { ...(cost !== undefined ? { cost } : {}) })
      finished = true
    },
  }
  return store
}

// ---------------------------------------------------------------------------
// Read side: checkpoint loading, listing, pruning
// ---------------------------------------------------------------------------

/** One run's row in the store listing. */
export interface RunSummary {
  runId: string
  status: string
  name?: string
  startedAt?: string
  finishedAt?: string
}

export interface StoredRun {
  meta: Record<string, unknown>
  steps: Record<string, StepOutcome>
  workflowText: string
  inputs?: Record<string, unknown>
}

function runDirOf(root: string, runId: string): string {
  if (!SAFE_ID.test(runId)) throw new Error(`run store: unsafe run id "${runId}"`)
  return join(root, '.dsh', 'workflow-runs', runId)
}

/** Load one run's durable state for resume/rerun/show. Undefined when absent/unreadable. */
export function loadRun(root: string, runId: string, warn?: (m: string) => void): StoredRun | undefined {
  const runDir = runDirOf(root, runId)
  const noopWarn = warn ?? (() => {})
  try {
    if (!existsSync(join(runDir, 'run.json'))) return undefined
    const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>
    const workflowText = existsSync(join(runDir, 'workflow.yaml'))
      ? readFileSync(join(runDir, 'workflow.yaml'), 'utf8')
      : ''
    const steps: Record<string, StepOutcome> = {}
    const rawSteps = (meta.steps ?? {}) as Record<string, Record<string, unknown>>
    for (const [stepId, raw] of Object.entries(rawSteps)) {
      // Full outputs live in results/<stepId>.json; run.json carries a truncated view.
      let full: Record<string, unknown> = raw
      try {
        const resultPath = join(runDir, 'results', `${stepId}.json`)
        if (existsSync(resultPath)) full = { ...raw, ...(JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>) }
      } catch {
        noopWarn(`results/${stepId}.json unreadable; using the run.json view`)
      }
      steps[stepId] = {
        id: stepId,
        status: (full['status'] as StepOutcome['status'] ?? 'failed'),
        attempts: (full['attempts'] as number ?? 1),
        ...(typeof full['output'] === 'string' ? { output: full['output'] } : {}),
        ...(full['structured'] !== undefined ? { structured: full['structured'] } : {}),
        ...(full['actionOutput'] !== undefined ? { actionOutput: full['actionOutput'] } : {}),
        ...(full['usage'] !== undefined ? { usage: full['usage'] as StepOutcome['usage'] } : {}),
        ...(typeof full['error'] === 'string' ? { error: full['error'] } : {}),
      }
    }
    return {
      meta,
      steps,
      workflowText,
      ...((meta.inputs !== undefined && typeof meta.inputs === 'object') ? { inputs: meta.inputs as Record<string, unknown> } : {}),
    }
  } catch (error) {
    noopWarn(`loadRun(${runId}) failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** List runs, newest first (by run.json mtime). Only directories with a run.json. */
export function listRuns(root: string, limit = 20): RunSummary[] {
  const dir = join(root, '.dsh', 'workflow-runs')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const rows: Array<{ runId: string; mtime: number; summary: RunSummary }> = []
  for (const runId of entries) {
    if (!SAFE_ID.test(runId)) continue
    const runJsonPath = join(dir, runId, 'run.json')
    try {
      if (!existsSync(runJsonPath)) continue
      const meta = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>
      rows.push({
        runId,
        mtime: 0,
        summary: {
          runId,
          status: typeof meta['status'] === 'string' ? meta['status'] : '?',
          ...(typeof meta['name'] === 'string' ? { name: meta['name'] } : {}),
          ...(typeof meta['startedAt'] === 'string' ? { startedAt: meta['startedAt'] } : {}),
          ...(typeof meta['finishedAt'] === 'string' ? { finishedAt: meta['finishedAt'] } : {}),
        },
      })
    } catch {
      /* skip unparsable rows */
    }
  }
  // Sort newest-first by finishedAt/startedAt string (ISO sorts lexically).
  rows.sort((a, b) => String(b.summary.finishedAt ?? b.summary.startedAt ?? '').localeCompare(String(a.summary.finishedAt ?? a.summary.startedAt ?? '')))
  return rows.slice(0, limit).map((r) => r.summary)
}

/** Delete terminal runs beyond the newest `keep`. Returns the deleted run ids. */
export function pruneRuns(root: string, keep = 100, warn?: (m: string) => void): string[] {
  const summaries = listRuns(root, 10000)
  const deletable = summaries.filter((s) => s.status === 'completed' || s.status === 'failed').slice(keep)
  const deleted: string[] = []
  for (const row of deletable) {
    try {
      rmSync(runDirOf(root, row.runId), { recursive: true, force: true })
      deleted.push(row.runId)
    } catch (error) {
      warn?.(`prune ${row.runId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return deleted
}
