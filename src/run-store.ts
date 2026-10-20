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

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
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

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface RunStoreOptions {
  runId: string
  /** Directory the `.dsh/workflow-runs` store lives under (default: cwd). */
  root?: string
  warn?: (message: string) => void
}

export interface RunStore {
  readonly runDir: string
  /** Snapshot the definition and open the run. Idempotent per store instance. */
  begin(workflow: WorkflowDef, yamlText?: string): void
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
        ...extra,
      }, null, 2)}\n`)
    })
  }

  const store: RunStore = {
    runDir,
    begin(workflow, yamlText) {
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
