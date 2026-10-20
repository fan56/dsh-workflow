/**
 * The `/workflow` command — M1 minimal surface: `run`, `list`, `help`.
 * The full command family (runs/show/stop/rerun/resume/prune/save) lands in
 * M3 with checkpoint resume; since M2 every `run` also writes the durable
 * Run Store and projects into the host's `tool-workflow/*` Session events
 * (the official workflow-run UI node renders them).
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
import { createEngine, type RunOutcome } from './engine.ts'
import { createDispatch, type DispatchHost } from './dispatch.ts'
import { installChildCompositionListener } from './composition.ts'
import { createRunStore } from './run-store.ts'
import { createRunProjector } from './projection.ts'
import { defaultAgentsDir } from './roster.ts'

/** Structural view of the host context this module needs (kept minimal on purpose). */
export interface CommandHost extends DispatchHost {
  /** Register a disposer-scoped effect (cordis lifecycle). */
  effect(fn: () => () => void): void
  commands: {
    register(definition: {
      name: string
      description: string
      handler: (invocation: { agent: Agent; rawInput: string; signal?: AbortSignal }) =>
        Promise<{ kind: 'success' | 'error'; text?: string }>
    }): () => void
  }
}

const HELP = `usage:
  /workflow run <file.workflow.yaml> [json-args]
  /workflow list [dir]
  /workflow help`

function renderOutcome(outcome: RunOutcome): string {
  const lines = [`workflow run ${outcome.runId}: ${outcome.status}`]
  for (const step of Object.values(outcome.steps)) {
    const attempts = step.attempts > 1 ? ` (${step.attempts} attempts)` : ''
    const usage = step.usage === undefined ? '' : ` · ${step.usage.totalTokens} tok`
    const suffix = step.status === 'completed' ? `${attempts}${usage}` : ` — ${step.status}${step.error === undefined ? '' : `: ${step.error}`}`
    lines.push(`  ${step.id}: ${suffix}`)
    if (step.status === 'completed' && step.output !== undefined && step.output !== '') {
      const preview = step.output.length > 300 ? `${step.output.slice(0, 300)}…` : step.output
      lines.push(`    ↳ ${preview.replace(/\n+/g, ' ⏎ ')}`)
    }
  }
  return lines.join('\n')
}

/** Map a subagent stop reason onto the projection's agent-end vocabulary. */
function agentOutcomeOf(stopReason: string): 'completed' | 'failed' | 'cancelled' {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'cancelled'
  return 'failed'
}

export function registerWorkflowCommand(host: CommandHost): void {
  // One listener for the whole plugin: parks the persona/leaf composition at
  // dispatch and installs it on each child scope at the start edge.
  host.effect(() => installChildCompositionListener(host))

  host.effect(() => host.commands.register({
    name: 'workflow',
    description: 'Run and inspect declarative YAML workflows (dsh-workflow plugin)',
    handler: async (invocation) => {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/)
      // The host process runs in the session's workspace, so relative
      // workflow paths resolve there.
      const cwd = process.cwd()

      if (sub === undefined || sub === '' || sub === 'help') {
        return { kind: 'success', text: HELP }
      }

      if (sub === 'list') {
        const dir = rest[0] !== undefined && rest[0] !== '' ? resolvePath(rest[0]!) : cwd
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

      if (sub === 'run') {
        const file = rest[0]
        if (file === undefined || file === '') return { kind: 'error', text: 'run needs a file: /workflow run <file.workflow.yaml> [json-args]' }
        const path = resolvePath(cwd, file)
        let text: string
        try {
          text = readFileSync(path, 'utf8')
        } catch (error) {
          return { kind: 'error', text: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
        }
        let inputs: Record<string, unknown> = {}
        if (rest[1] !== undefined) {
          try {
            const parsed: unknown = JSON.parse(rest.slice(1).join(' '))
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) inputs = parsed as Record<string, unknown>
            else return { kind: 'error', text: 'json-args must be a JSON object' }
          } catch (error) {
            return { kind: 'error', text: `json-args is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        try {
          const { workflow } = loadWorkflow(text, { filePath: file })
          const runId = Math.random().toString(36).slice(2, 10)
          const store = createRunStore({ runId, root: cwd })
          const projector = createRunProjector(invocation.agent.session as unknown as Parameters<typeof createRunProjector>[0], { runId })
          store.begin(workflow, text)
          projector.runStarted(workflow.name)
          // Per-run dispatch: every child is attributed to the invoking agent
          // (the seam requires parent to be the exact live Agent), carries the
          // roster persona at the start edge, and reports child edges so the
          // projection's agent-start/agent-end pairs stay exact.
          const engine = createEngine({
            dispatch: createDispatch(host, {
              parent: invocation.agent,
              runId,
              agentsDir: defaultAgentsDir(),
              events: {
                childStarted: (childId, label) => projector.agentStarted(label, String(childId)),
                childSettled: (childId, stopReason) => projector.agentEnded(agentOutcomeOf(stopReason)),
              },
            }),
          })
          const outcome = await engine.run(workflow, {
            inputs,
            runId,
            signal: invocation.signal,
            observers: {
              stepStarted: (stepId) => store.stepStarted(stepId),
              stepSettled: (step: Parameters<typeof store.stepSettled>[1]) => store.stepSettled(step.id, step),
            },
          })
          store.finish({ status: outcome.status, steps: outcome.steps })
          projector.runFinished(outcome.status === 'completed' ? 'completed' : 'error')
          return { kind: outcome.status === 'completed' ? 'success' : 'error', text: renderOutcome(outcome) }
        } catch (error) {
          if (error instanceof WorkflowLoadError) return { kind: 'error', text: error.message }
          return { kind: 'error', text: `run failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      return { kind: 'error', text: `unknown subcommand "${sub}"\n${HELP}` }
    },
  }))
}
