/**
 * The serial execution engine (M1): topological `needs` order, one step at a
 * time, real dispatch per step. Foreach steps load and validate but throw a
 * clear "not implemented until M3" error when executed — M1's acceptance
 * target is the serial hello workflow; concurrency and checkpointing follow
 * in later milestones per docs/SPEC.md.
 *
 * Dispatch is injected so tests run against a fake; the production factory
 * lives in `dispatch.ts`. Everything the engine does is fail-loud: a step's
 * terminal status is always explicit, never implicit success.
 *
 * @module @aiwayds/dsh-workflow/engine
 */

import { WorkflowRunError, RosterError } from './errors.ts'
import { resolveOverArray, resolveTemplate, type RefScope } from './refs.ts'
import { isForeachStep, type AnyStepDef, type StepDef, type WorkflowDef } from './types.ts'
import type { UsageSummary } from './cost.ts'

/** What one dispatch attempt must produce. Mirrors the host's SubagentResult shape. */
export interface DispatchOutcome {
  text: string
  structured?: unknown
  stopReason: string
  /** Folded from the child's own Session log (best-effort; wayfinder ticket 01). */
  usage?: UsageSummary
}

export interface DispatchRequest {
  agentName: string
  model?: string
  thinking?: string
  prompt: string
  label: string
  outputSchema?: Record<string, unknown>
  signal?: AbortSignal
}

export type DispatchFn = (request: DispatchRequest) => Promise<DispatchOutcome>

export type StepStatus = 'completed' | 'failed' | 'skipped'

export interface StepOutcome {
  id: string
  status: StepStatus
  /** The step's text output (or the foreach's array of child outcomes, later milestones). */
  output?: string
  structured?: unknown
  actionOutput?: unknown
  error?: string
  attempts: number
  /** Folded per-child token/model usage (present when the cost fold succeeded). */
  usage?: UsageSummary
  /** True when this outcome was replayed from a prior run's checkpoint, not re-executed. */
  replayed?: boolean
  /** The child session this step dispatched (bound at dispatch; L1 repair evidence). */
  childId?: string
}

export interface RunOutcome {
  runId: string
  status: 'completed' | 'failed'
  steps: Record<string, StepOutcome>
}

export interface RunOptions {
  inputs?: Record<string, unknown>
  runId?: string
  signal?: AbortSignal
  /** Called before a `confirm: true` step dispatches; false skips the step. */
  confirm?: (stepId: string) => Promise<boolean>
  /**
   * Monitoring hooks for the Run Store and Session projection. Observers
   * must be self-contained (they own their failure policy — the engine calls
   * them bare; see run-store/projection for warn-and-degrade implementations).
   */
  observers?: {
    stepStarted?(stepId: string): void
    stepSettled?(outcome: StepOutcome): void
  }
  /**
   * Checkpoints from a prior run (resume): a prior `completed` outcome for
   * the same stable step id is replayed verbatim unless the step's cache
   * policy is `never`. Foreach children checkpoint under `<foreachId>#<index>`.
   */
  prior?: Record<string, StepOutcome>
}

const DEFAULT_MAX_CONCURRENCY = 4
const EMPTY_REFS: RefScope = {}

/** Default action evaluator: a strict-mode `(input) => json` function body. */
function runAction(body: string, input: unknown): unknown {
  // eslint-disable-next-line no-new-func -- the action is the workflow owner's own code (dual-track trust boundary, docs/SPEC.md §3)
  const fn = new Function('input', `"use strict";\n${body}`)
  const result = fn(input)
  // Force the JSON boundary the hard rules promise: functions/symbols/cycles die here.
  return JSON.parse(JSON.stringify(result ?? null)) as unknown
}

/** Convert a JS RegExp source that may carry a `(?i)` prefix into a RegExp. */
function compileAcceptanceRegex(source: string): RegExp {
  if (source.startsWith('(?i)')) return new RegExp(source.slice(4), 'i')
  return new RegExp(source)
}

function checkAcceptance(step: StepDef, text: string): string | undefined {
  for (const [i, rule] of (step.acceptance ?? []).entries()) {
    if (rule['output-contains'] !== undefined && !text.includes(rule['output-contains'])) {
      return `acceptance[${i}]: output does not contain "${rule['output-contains']}"`
    }
    if (rule['output-matches'] !== undefined) {
      let re: RegExp
      try {
        re = compileAcceptanceRegex(rule['output-matches'])
      } catch (error) {
        return `acceptance[${i}]: invalid regex: ${error instanceof Error ? error.message : String(error)}`
      }
      if (!re.test(text)) return `acceptance[${i}]: output does not match /${rule['output-matches']}/`
    }
  }
  return undefined
}

/** Topologically order plain steps by `needs`; throws on unknown/cyclic deps (belt-and-braces behind the loader). */
export function topoOrder(steps: AnyStepDef[]): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') throw new WorkflowRunError(`dependency cycle: ${[...trail, id].join(' -> ')}`)
    const step = byId.get(id)
    if (step === undefined) throw new WorkflowRunError(`unknown step "${id}" in needs`)
    state.set(id, 'visiting')
    for (const dep of step.needs ?? []) visit(dep, [...trail, id])
    state.set(id, 'done')
    order.push(id)
  }
  for (const step of steps) visit(step.id, [])
  return order
}

export interface Engine {
  run(workflow: WorkflowDef, options?: RunOptions): Promise<RunOutcome>
}

export interface EngineOptions {
  dispatch: DispatchFn
  /** Fallback clock for backoff; tests pass 0-delay. */
  sleep?: (ms: number) => Promise<void>
}

export function createEngine(options: EngineOptions): Engine {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function runStep(
    step: StepDef,
    scope: RefScope,
    outcome: StepOutcome,
    runOptions: RunOptions,
  ): Promise<StepOutcome> {
    // Action first: its output joins the prompt context.
    let promptContext = scope
    if (step.action !== undefined) {
      try {
        const actionOutput = runAction(step.action, {
          inputs: scope.inputs ?? {},
          steps: scope.steps ?? {},
        })
        outcome.actionOutput = actionOutput
        promptContext = { ...scope, steps: { ...(scope.steps ?? {}), [step.id]: { output: undefined, 'action-output': actionOutput } } }
      } catch (error) {
        outcome.status = 'failed'
        outcome.error = `action failed: ${error instanceof Error ? error.message : String(error)}`
        return outcome
      }
    }

    let prompt: string
    try {
      prompt = resolveTemplate(step.prompt, promptContext)
    } catch (error) {
      outcome.status = 'failed'
      outcome.error = error instanceof Error ? error.message : String(error)
      return outcome
    }

    const maxRetries = step.retry?.max ?? 0
    const backoffMs = step.retry?.['backoff-ms'] ?? 0
    for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
      outcome.attempts = attempt
      try {
        const result = await options.dispatch({
          agentName: step.executor.agent,
          model: step.executor.model,
          thinking: step.executor.thinking,
          prompt,
          label: step.id,
          outputSchema: step.output,
          signal: runOptions.signal,
        })
        if (result.stopReason !== 'completed') {
          throw new WorkflowRunError(`child stop reason ${result.stopReason}${result.text !== '' ? `; partial output: ${result.text.slice(0, 400)}` : ''}`)
        }
        const acceptanceFailure = checkAcceptance(step, result.text)
        if (acceptanceFailure !== undefined) throw new WorkflowRunError(acceptanceFailure)
        outcome.status = 'completed'
        outcome.output = result.text
        outcome.structured = result.structured
        if (result.usage !== undefined) outcome.usage = result.usage
        return outcome
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error)
        // A roster miss re-reads to the same answer — retrying is pure waste.
        if (error instanceof RosterError) break
        if (attempt > maxRetries) break
        if (backoffMs > 0) await sleep(backoffMs)
      }
    }
    outcome.status = 'failed'
    return outcome
  }

  return {
    async run(workflow, runOptions = {}): Promise<RunOutcome> {
      const runId = runOptions.runId ?? Math.random().toString(36).slice(2, 10)
      const steps: Record<string, StepOutcome> = {}
      const scope: { inputs?: Record<string, unknown>; steps: Record<string, { output?: unknown; 'action-output'?: unknown }> } = {
        inputs: runOptions.inputs ?? {},
        steps: {},
      }

      const orderedIds = topoOrder(workflow.steps)
      const byId = new Map(workflow.steps.map((s) => [s.id, s]))

      for (const id of orderedIds) {
        const step = byId.get(id)!
        const outcome: StepOutcome = { id, status: 'completed', attempts: 0 }
        steps[id] = outcome
        // References prefer the structured result: `{{steps.x.output.items}}`
        // must traverse the validated object, not the rendered text.
        scope.steps[id] = {
          get output() { return outcome.structured ?? outcome.output },
          get 'action-output'() { return outcome.actionOutput },
        }
        runOptions.observers?.stepStarted?.(id)

        // Checkpoint replay (resume): a prior completed outcome for this
        // stable step id is reused verbatim unless cache policy forbids it.
        const prior = runOptions.prior?.[id]
        if (prior !== undefined && prior.status === 'completed' && (step.cache ?? 'on-failure') !== 'never') {
          Object.assign(outcome, prior, { replayed: true })
          runOptions.observers?.stepSettled?.(outcome)
          continue
        }

        if (isForeachStep(step)) {
          const over = step.foreach.over.replace(/^\{\{/, '').replace(/\}\}$/, '')
          const resolved = resolveOverArray(over, scope)
          if (!resolved.ok) {
            outcome.status = 'failed'
            outcome.error = `foreach.over unusable: ${resolved.reason}`
            runOptions.observers?.stepSettled?.(outcome)
            if ((step['on-error'] ?? 'fail') === 'fail') return { runId, status: 'failed', steps }
            if (step['on-error'] === 'skip') outcome.status = 'skipped'
            continue
          }

          // Bounded fan-out: workflow-layer semaphore (children queue beyond
          // max-concurrency — never bet on the host's overflow behavior).
          const concurrency = step.foreach['max-concurrency'] ?? DEFAULT_MAX_CONCURRENCY
          const childTemplate = step.foreach.step
          let running = 0
          const waiters: Array<() => void> = []
          const acquire = async (): Promise<void> => {
            if (running < concurrency) {
              running += 1
              return
            }
            await new Promise<void>((release) => waiters.push(release))
            running += 1
          }
          const release = (): void => {
            running -= 1
            waiters.shift()?.()
          }
          let stopDispatching = false
          const childOutcomes: StepOutcome[] = []
          await Promise.all(resolved.items.map(async (item, index) => {
            if (stopDispatching) return
            await acquire()
            if (stopDispatching) {
              release()
              return
            }
            try {
              const childId = `${id}#${index}`
              const childOutcome: StepOutcome = { id: childId, status: 'completed', attempts: 0 }
              childOutcomes[index] = childOutcome
              steps[childId] = childOutcome
              scope.steps[childId] = { get output() { return childOutcome.output }, get 'action-output'() { return childOutcome.actionOutput } }
              runOptions.observers?.stepStarted?.(childId)
              const childPrior = runOptions.prior?.[childId]
              if (childPrior !== undefined && childPrior.status === 'completed' && (childTemplate.cache ?? 'on-failure') !== 'never') {
                Object.assign(childOutcome, childPrior, { replayed: true })
              } else {
                await runStep({ ...childTemplate, id: childId } as StepDef, { inputs: scope.inputs, steps: scope.steps, item }, childOutcome, runOptions)
              }
              runOptions.observers?.stepSettled?.(childOutcome)
              if (childOutcome.status === 'failed' && (childTemplate['on-error'] ?? 'fail') === 'fail') {
                // Fail-fast fan-out: no NEW items dispatch; in-flight ones settle.
                stopDispatching = true
              }
            } finally {
              release()
            }
          }))

          const settled = childOutcomes.filter((o) => o !== undefined)
          const failed = settled.filter((o) => o.status === 'failed').length
          const completed = settled.length - failed
          const summary = {
            total: resolved.items.length,
            completed,
            failed,
            notDispatched: resolved.items.length - settled.length,
            items: settled.map((o) => ({
              index: Number(o.id.split('#')[1]),
              status: o.status,
              ...(o.replayed === true ? { replayed: true } : {}),
              ...(o.output !== undefined ? { output: o.output.slice(0, 2000) } : {}),
              ...(o.error !== undefined ? { error: o.error } : {}),
            })),
          }
          outcome.status = settled.length > 0 && failed === settled.length ? 'failed' : 'completed'
          if (outcome.status === 'failed' && stopDispatching) {
            outcome.error = `fail-fast fan-out stopped after ${settled.length}/${resolved.items.length} items`
          }
          outcome.output = JSON.stringify(summary)
          outcome.structured = summary
          if (outcome.status === 'failed') {
            const onError = step['on-error'] ?? 'fail'
            runOptions.observers?.stepSettled?.(outcome)
            if (onError === 'fail') return { runId, status: 'failed', steps }
            if (onError === 'skip') outcome.status = 'skipped'
            continue
          }
          runOptions.observers?.stepSettled?.(outcome)
          continue
        }

        // A skipped upstream cascades: its outputs never existed, so this
        // step cannot run meaningfully. A *failed* upstream under
        // `on-error: continue` does NOT cascade — "continue" means the run
        // carries on; a prompt that references the failed step's output will
        // fail loudly at render time with the precise missing reference.
        const skippedDep = (step.needs ?? []).find((dep) => steps[dep] !== undefined && steps[dep]!.status === 'skipped')
        if (skippedDep !== undefined) {
          outcome.status = 'skipped'
          outcome.error = `dependency "${skippedDep}" was skipped`
          runOptions.observers?.stepSettled?.(outcome)
          continue
        }

        if (step.confirm === true) {
          const granted = runOptions.confirm === undefined ? true : await runOptions.confirm(id)
          if (!granted) {
            outcome.status = 'skipped'
            outcome.error = 'confirmation declined'
            runOptions.observers?.stepSettled?.(outcome)
            continue
          }
        }

        await runStep(step, { inputs: scope.inputs, steps: scope.steps }, outcome, runOptions)

        if (outcome.status === 'failed') {
          const onError = step['on-error'] ?? 'fail'
          if (onError === 'fail') {
            runOptions.observers?.stepSettled?.(outcome)
            return { runId, status: 'failed', steps }
          }
          if (onError === 'skip') {
            outcome.status = 'skipped'
          }
          // `continue` keeps the failed state and lets dependents see it.
        }
        runOptions.observers?.stepSettled?.(outcome)
      }

      // Terminal status rides the TOP-LEVEL steps only. Foreach child
      // checkpoints (<id>#<index>) that failed are already summarized inside
      // their foreach step's structured output — they must not poison the run.
      const walked = orderedIds.every((sid) => {
        const s = steps[sid]
        return s !== undefined && (s.status === 'completed' || s.status === 'skipped')
      })
      return { runId, status: walked ? 'completed' : 'failed', steps }
    },
  }
}

export { DEFAULT_MAX_CONCURRENCY, EMPTY_REFS }
