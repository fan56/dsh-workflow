/**
 * The `/workflow` command family: run/resume/rerun/stop in the
 * foreground or as background `ctx.jobs` jobs, plus runs/show/prune over the
 * Run Store.
 *
 * Semantics (docs/SPEC.md §4 governance): run/resume/rerun default to
 * background (immediately return the run id + job id); `--wait` blocks and
 * renders the outcome. A `confirm: true` step only confirms in `--wait`
 * mode — in a background job it is skipped with an explicit error, never
 * silently approved.
 *
 * Registered on the host command registry (global scope) — tui and web both
 * consume that single registry, so this is the tui/web-universal surface
 * without any UI-specific patch (wayfinder ticket 01, face 5).
 *
 * @module @aiwayds/dsh-workflow/commands
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowLoadError } from './errors.ts'
import { loadWorkflow } from './loader.ts'
import { createEngine, type RunOutcome, type StepOutcome } from './engine.ts'
import { createDispatch, type DispatchHost } from './dispatch.ts'
import { installChildCompositionListener } from './composition.ts'
import { createRunStore, listRuns, loadRun, pruneRuns } from './run-store.ts'
import { createRunProjector } from './projection.ts'
import { defaultAgentsDir } from './roster.ts'
import { flushWidgetFile } from './tui-widget.ts'
import { reconcileInterruptedSteps } from './repair.ts'
import { widgetRunSettled, widgetRunStarted, widgetStepUpdate } from './run-state.ts'

/** Structural view of the jobs registry (the shape executeRun uses). */
export interface JobsHost {
  jobs: {
    start(spec: {
      kind: string
      label: string
      owner?: string
      run(handle: { append(line: string): void }): {
        cancel(): void
        done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string }>
      }
    }): string
  }
}

/** Structural view of the host context this module needs. */
export interface CommandHost extends DispatchHost, JobsHost {
  /** Register a disposer-scoped effect (cordis lifecycle). */
  effect(fn: () => () => void): void
  /** Register a system-prompt section (model guidance). */
  systemPrompt: {
    section(section: { name: string; text: string; order?: number }): unknown
    getSectionOrder(anchor: string): number
  }
  commands: {
    register(definition: {
      name: string
      description: string
      handler: (invocation: { agent: Agent; rawInput: string; signal?: AbortSignal }) =>
        Promise<{ kind: 'success' | 'error'; text?: string }>
    }): () => void
  }
}

interface ActiveRun {
  abort: AbortController
  name: string
  jobId?: string
}

/** Live background runs by runId — shared by the command family and the model tools. */
const activeRuns = new Map<string, ActiveRun>()

const HELP = `usage:
  /workflow run <file.workflow.yaml> [json-args] [--wait]
  /workflow resume <runId> [--wait]     checkpoint resume (completed steps replay, cache:never re-runs)
  /workflow rerun <runId> [--wait]      fresh run of a stored workflow with its original inputs
  /workflow runs [limit]                list recent runs
  /workflow show <runId>                render one run's steps, usage, and errors
  /workflow stop [runId]                stop the active (or named) background run
  /workflow prune [--keep N]            delete terminal runs beyond the newest N (default 100)
  /workflow list [dir]                  list *.workflow.yaml files
  /workflow help`

function agentOutcomeOf(stopReason: string): 'completed' | 'failed' | 'cancelled' {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'cancelled'
  return 'failed'
}

function renderOutcome(outcome: RunOutcome): string {
  const lines = [`workflow run ${outcome.runId}: ${outcome.status}`]
  for (const step of Object.values(outcome.steps)) {
    const replayed = step.replayed === true ? ' (replayed)' : ''
    const attempts = step.attempts > 1 ? ` (${step.attempts} attempts)` : ''
    const usage = step.usage === undefined ? '' : ` · ${step.usage.totalTokens} tok`
    const suffix = step.status === 'completed' ? `${replayed}${attempts}${usage}` : ` — ${step.status}${step.error === undefined ? '' : `: ${step.error}`}`
    lines.push(`  ${step.id}: ${suffix}`)
    if (step.status === 'completed' && step.output !== undefined && step.output !== '') {
      const preview = step.output.length > 300 ? `${step.output.slice(0, 300)}…` : step.output
      lines.push(`    ↳ ${preview.replace(/\n+/g, ' ⏎ ')}`)
    }
  }
  return lines.join('\n')
}

function renderRunRow(row: { runId: string; status: string; name?: string; finishedAt?: string }): string {
  return `  ${row.runId}  ${row.status.padEnd(9)}  ${row.name ?? '?'}${row.finishedAt !== undefined ? `  (${row.finishedAt})` : ''}`
}

export interface RegisteredWorkflowCommand {
  executeRun(agent: Agent, signal: AbortSignal | undefined, options: {
    workflow: ReturnType<typeof loadWorkflow>['workflow']
    yamlText: string
    inputs: Record<string, unknown>
    wait: boolean
    prior?: Record<string, StepOutcome>
  }): Promise<{ kind: 'success' | 'error'; text?: string }>
  activeRuns: Map<string, ActiveRun>
}

export function registerWorkflowCommand(host: CommandHost): RegisteredWorkflowCommand {
  // One listener for the whole plugin: parks the persona/leaf composition at
  // dispatch and installs it on each child scope at the start edge.
  host.effect(() => installChildCompositionListener(host))

  /** Shared execution path for run/resume/rerun: store + projection + dispatch + engine. */
  async function executeRunEx(agent: Agent, signal: AbortSignal | undefined, options: {
    workflow: ReturnType<typeof loadWorkflow>['workflow']
    yamlText: string
    inputs: Record<string, unknown>
    wait: boolean
    prior?: Record<string, StepOutcome>
  }): Promise<{ kind: 'success' | 'error'; text?: string }> {
    const { workflow, yamlText, inputs, wait } = options
    const runId = Math.random().toString(36).slice(2, 10)
    const cwd = process.cwd()
    const store = createRunStore({ runId, root: cwd })
    const projector = createRunProjector(agent.session as unknown as Parameters<typeof createRunProjector>[0], { runId })
    store.begin(workflow, yamlText, inputs)
    projector.runStarted(workflow.name)

    const abort = new AbortController()
    const active: ActiveRun = { abort, name: workflow.name }
    activeRuns.set(runId, active)

    let jobLine: ((line: string) => void) | undefined
    const engine = createEngine({
      dispatch: createDispatch(host, {
        parent: agent,
        runId,
        agentsDir: defaultAgentsDir(),
        events: {
          childStarted: (childId, label) => {
            store.bindChild(label, String(childId))
            projector.agentStarted(label, String(childId))
          },
          childSettled: (_childId, stopReason) => projector.agentEnded(agentOutcomeOf(stopReason)),
        },
      }),
    })

    const settle = (outcome: RunOutcome): void => {
      store.finish({ status: outcome.status, steps: outcome.steps })
      projector.runFinished(outcome.status === 'completed' ? 'completed' : 'error')
      activeRuns.delete(runId)
      widgetRunSettled(runId, outcome.status)
      flushWidgetFile()
    }

    const promise = engine.run(workflow, {
      inputs,
      runId,
      signal: abort.signal,
      prior: options.prior,
      // Background jobs cannot confirm: a confirm step skips with an explicit
      // error rather than being silently approved.
      confirm: wait === true ? undefined : async (stepId) => {
        throw new Error(`step "${stepId}" needs confirmation — re-run with --wait`)
      },
      observers: {
        stepStarted: (stepId) => {
          store.stepStarted(stepId)
          widgetStepUpdate(runId, stepId, 'running')
          flushWidgetFile()
        },
        stepSettled: (step) => {
          store.stepSettled(step.id, step)
          widgetStepUpdate(runId, step.id, step.status, step.usage?.totalTokens)
          flushWidgetFile()
          jobLine?.(`${step.id}: ${step.status}${step.usage !== undefined ? ` · ${step.usage.totalTokens} tok` : ''}`)
        },
      },
    })

    if (wait) {
      const outcome = await promise
      settle(outcome)
      return { kind: outcome.status === 'completed' ? 'success' : 'error', text: renderOutcome(outcome) }
    }

    const jobId = host.jobs.start({
      kind: 'workflow',
      label: `${workflow.name} (${runId})`,
      owner: agent.id,
      run(handle) {
        jobLine = (line) => {
          try {
            handle.append(line)
          } catch {
            /* the ring failing must never touch the run */
          }
        }
        return {
          cancel: () => {
            abort.abort(new Error('stopped via job_kill or /workflow stop'))
          },
          done: promise
            .then((outcome) => {
              settle(outcome)
              if (abort.signal.aborted) return { status: 'killed' as const, detail: 'stopped', result: renderOutcome(outcome) }
              return {
                status: outcome.status === 'completed' ? ('completed' as const) : ('failed' as const),
                ...(outcome.status !== 'completed' ? { detail: 'see /workflow show for the failing step' } : {}),
                result: renderOutcome(outcome),
              }
            })
            .catch((error: unknown) => ({ status: 'failed' as const, detail: error instanceof Error ? error.message : String(error) })),
        }
      },
    })
    active.jobId = jobId
    return {
      kind: 'success',
      text: `workflow "${workflow.name}" started in background — run ${runId}, job ${jobId}. Watch: /workflow show ${runId} · Stop: /workflow stop ${runId}`,
    }
  }

  host.effect(() => host.commands.register({
    name: 'workflow',
    description: 'Run, resume, and inspect declarative YAML workflows (dsh-workflow plugin)',
    handler: async (invocation) => {
      const words = invocation.rawInput.trim().split(/\s+/).filter((w) => w !== '')
      const [sub, ...rest] = words
      const cwd = process.cwd()
      const wait = rest.includes('--wait')
      const positional = rest.filter((w) => !w.startsWith('--'))
      const flagValue = (flag: string): string | undefined => {
        const idx = rest.indexOf(flag)
        return idx >= 0 ? rest[idx + 1] : undefined
      }

      if (sub === undefined || sub === '' || sub === 'help') {
        return { kind: 'success', text: HELP }
      }

      if (sub === 'list') {
        const dir = positional[0] !== undefined ? resolvePath(positional[0]) : cwd
        let entries: string[]
        try {
          entries = readdirSync(dir)
        } catch (error) {
          return { kind: 'error', text: `cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}` }
        }
        const files = entries.filter((e) => e.endsWith('.workflow.yaml') || e.endsWith('.workflow.yml')).sort()
        const rows = files.map((file) => {
          try {
            const { workflow } = loadWorkflow(readFileSync(join(dir, file), 'utf8'), { filePath: file })
            return `  ${file} — ${workflow.description}`
          } catch {
            return `  ${file} — (unparsable)`
          }
        })
        return { kind: 'success', text: rows.length === 0 ? `no *.workflow.yaml in ${dir}` : rows.join('\n') }
      }

      if (sub === 'runs') {
        const limit = positional[0] !== undefined ? Math.max(1, Math.min(1000, Number(positional[0]) || 20)) : 20
        const rows = listRuns(cwd, limit)
        if (rows.length === 0) return { kind: 'success', text: `no runs under ${join(cwd, '.dsh', 'workflow-runs')}` }
        return { kind: 'success', text: rows.map(renderRunRow).join('\n') }
      }

      if (sub === 'show') {
        const runId = positional[0]
        if (runId === undefined) return { kind: 'error', text: 'show needs a run id: /workflow show <runId> (find one with /workflow runs)' }
        const stored = loadRun(cwd, runId, (m) => host.logger?.warn(m))
        if (stored === undefined) return { kind: 'error', text: `no run "${runId}" under ${join(cwd, '.dsh', 'workflow-runs')}` }
        const metaName = typeof stored.meta['name'] === 'string' ? stored.meta['name'] : '?'
        const lines = [`run ${runId} (${String(stored.meta['status'] ?? '?')}): ${metaName}`]
        for (const step of Object.values(stored.steps)) {
          const usage = step.usage === undefined ? '' : ` · ${step.usage.totalTokens} tok`
          const replayed = step.replayed === true ? ' (replayed)' : ''
          const suffix = step.status === 'completed' ? `${replayed}${usage}` : ` — ${step.status}${step.error === undefined ? '' : `: ${step.error}`}`
          lines.push(`  ${step.id}: ${suffix}`)
          if (step.status === 'completed' && step.output !== undefined && step.output !== '') {
            const preview = step.output.length > 300 ? `${step.output.slice(0, 300)}…` : step.output
            lines.push(`    ↳ ${preview.replace(/\n+/g, ' ⏎ ')}`)
          }
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'stop') {
        const runId = positional[0] ?? [...activeRuns.keys()].at(-1)
        if (runId === undefined) return { kind: 'error', text: 'no active background runs' }
        const active = activeRuns.get(runId)
        if (active === undefined) return { kind: 'error', text: `run "${runId}" is not active (live: ${[...activeRuns.keys()].join(', ') || 'none'})` }
        active.abort.abort(new Error('stopped via /workflow stop'))
        if (active.jobId !== undefined) {
          try {
            (host.jobs as unknown as { kill?: (id: string) => unknown }).kill?.(active.jobId)
          } catch {
            /* the abort already settles the run; kill is belt-and-braces */
          }
        }
        return { kind: 'success', text: `stopping run ${runId} (${active.name})` }
      }

      if (sub === 'prune') {
        const keep = flagValue('--keep') !== undefined ? Math.max(0, Number(flagValue('--keep')) || 100) : 100
        const deleted = pruneRuns(cwd, keep, (m) => host.logger?.warn(m))
        return { kind: 'success', text: deleted.length === 0 ? 'nothing to prune' : `pruned ${deleted.length} run(s): ${deleted.join(', ')}` }
      }

      if (sub === 'resume' || sub === 'rerun' || sub === 'run') {
        const target = positional[0]
        let workflowText: string
        let inputs: Record<string, unknown> = {}
        let prior: Record<string, StepOutcome> | undefined

        if (sub === 'run') {
          if (target === undefined) return { kind: 'error', text: 'run needs a file: /workflow run <file.workflow.yaml> [json-args] [--wait]' }
          const path = resolvePath(cwd, target)
          try {
            workflowText = readFileSync(path, 'utf8')
          } catch (error) {
            return { kind: 'error', text: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
          }
          const jsonWords = rest.slice(rest.indexOf(target) + 1).filter((w) => !w.startsWith('--'))
          if (jsonWords.length > 0) {
            try {
              const parsed: unknown = JSON.parse(jsonWords.join(' '))
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) inputs = parsed as Record<string, unknown>
              else return { kind: 'error', text: 'json-args must be a JSON object' }
            } catch (error) {
              return { kind: 'error', text: `json-args is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
            }
          }
        } else {
          if (target === undefined) return { kind: 'error', text: `${sub} needs a run id (find one with /workflow runs)` }
          const stored = loadRun(cwd, target, (m) => host.logger?.warn(m))
          if (stored === undefined) return { kind: 'error', text: `no run "${target}" under ${join(cwd, '.dsh', 'workflow-runs')}` }
          workflowText = stored.workflowText
          inputs = stored.inputs ?? {}
          if (sub === 'resume') {
            // L1 repair: steps without a terminal record get reconciled
            // against their child sessions before becoming replay candidates.
            await reconcileInterruptedSteps(host, stored.steps)
            prior = stored.steps
          }
        }

        try {
          // The name/stem interlock is for user-edited files (the run
          // branch). resume/rerun load the system-written snapshot — no stem
          // to interlock against (real-host verified failure).
          const { workflow } = loadWorkflow(workflowText, sub === 'run' ? { filePath: target } : {})
          return await executeRunEx(invocation.agent, invocation.signal, { workflow, yamlText: workflowText, inputs, wait, prior })
        } catch (error) {
          if (error instanceof WorkflowLoadError) return { kind: 'error', text: error.message }
          return { kind: 'error', text: `${sub} failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      return { kind: 'error', text: `unknown subcommand "${sub}"\n${HELP}` }
    },
  }))
  return { executeRun: executeRunEx, activeRuns }
}
