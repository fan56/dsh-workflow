/**
 * The model-facing workflow tools — the natural-language entry that works in
 * every surface (tui, web, headless): the model calls these on the user's
 * behalf, no slash command required (ticket: "用户应该用自然语言就能使用、
 * 创建、修改 workflow").
 *
 * Creation stays file-based: the model writes a `<name>.workflow.yaml` (the
 * guidance section teaches the schema) and runs it through `workflow_run`.
 *
 * @module @aiwayds/dsh-workflow/tools
 */

import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowLoadError } from './errors.ts'
import { loadWorkflow } from './loader.ts'
import { listRuns, loadRun, pruneRuns } from './run-store.ts'
import { reconcileInterruptedSteps } from './repair.ts'
import type { RegisteredWorkflowCommand } from './commands.ts'

/** Everything the tools close over; built once in `apply`. */
export interface WorkflowToolsDeps {
  command: RegisteredWorkflowCommand
  /** The dispatching agent for tool-initiated runs (the calling model's agent). */
  agentProvider: () => Agent | undefined
  cwdProvider?: () => string
}

function resolveFile(cwd: string, file: string): string {
  const path = file.startsWith('/') || file.startsWith('~') ? file.replace(/^~(?=$|\/)/, process.env.HOME ?? '') : join(cwd, file)
  return path
}/** The two model-facing tools: run (execute a workflow file) and manage (runs/show/stop/resume/prune). */
export function createWorkflowTools(deps: WorkflowToolsDeps): ToolDefinition[] {
  const runTool: ToolDefinition = defineTool({
    name: 'workflow_run',
    description:
      'Run a dsh-workflow YAML pipeline (declarative multi-step agent workflow with phases, foreach fan-out, retry, and checkpoint resume). '
      + 'Use when the user asks to RUN or EXECUTE a workflow. The file is a <name>.workflow.yaml in or near the workspace '
      + '(list candidates with the workflow_manage action "runs"/"list" or by globbing *.workflow.yaml). '
      + 'Returns immediately with a background run id unless wait is true. Confirm-gated steps require wait.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Path of the .workflow.yaml file (absolute, ~/-relative, or workspace-relative).',
      },
      inputs: {
        type: 'string',
        description: 'Optional inputs as a JSON object string matching the declared inputs, e.g. {"rcVersion":"0.2.1-rc.2"}.',
      },
      wait: {
        type: 'boolean',
        description: 'Block until the run settles and return the full outcome (default false: background job, returns the run id immediately).',
      },
    },
    output: {
      schema: { type: 'json', description: 'The run acceptance text: run id, per-step status, token ledger, and errors.' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('workflow_run requires a calling agent')
      const cwd = deps.cwdProvider?.() ?? process.cwd()
      const path = resolveFile(cwd, args.file)
      let yamlText: string
      try {
        yamlText = readFileSync2(path)
      } catch (error) {
        throw new Error(`workflow_run: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      let inputs: Record<string, unknown> = {}
      if (typeof args.inputs === 'string' && args.inputs.trim() !== '') {
        const parsed: unknown = JSON.parse(args.inputs)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) inputs = parsed as Record<string, unknown>
        else throw new Error('workflow_run: inputs must be a JSON object string')
      }
      let workflow: ReturnType<typeof loadWorkflow>['workflow']
      try {
        workflow = loadWorkflow(yamlText, { filePath: args.file }).workflow
      } catch (error) {
        if (error instanceof WorkflowLoadError) throw new Error(`workflow_run: ${error.message}`)
        throw error
      }
      const result = await deps.command.executeRun(agent, exec.signal, {
        workflow,
        yamlText,
        inputs,
        wait: args.wait === true,
      })
      return result.text ?? (result.kind === 'success' ? 'ok' : 'failed')
    },
  })

  const manageTool: ToolDefinition = defineTool({
    name: 'workflow_manage',
    description:
      'Inspect and manage dsh-workflow runs: list recent runs, show one run\'s steps/tokens/errors, stop a live run, '
      + 'resume an interrupted run (completed steps replay from checkpoints; cache:never steps truly re-run), '
      + 'or prune old records. Use when the user asks about workflow status/history or wants to stop/resume/clean up.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'runs | show | stop | resume | rerun | prune',
      },
      runId: {
        type: 'string',
        description: 'The run id (required for show/stop/resume/rerun; optional for stop = newest live run).',
      },
      keep: {
        type: 'integer',
        description: 'prune: how many recent runs to keep (default 100).',
      },
      wait: {
        type: 'boolean',
        description: 'resume/rerun: block until the run settles (default false).',
      },
    },
    output: {
      schema: { type: 'json', description: 'The requested run/step information as text.' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('workflow_manage requires a calling agent')
      const cwd = deps.cwdProvider?.() ?? process.cwd()
      const action = args.action
      if (action === 'runs') {
        const rows = listRuns(cwd, 20)
        if (rows.length === 0) return 'no workflow runs recorded in this workspace'
        return rows.map((row) => `  ${row.runId}  ${row.status.padEnd(9)}  ${row.name ?? '?'}${row.finishedAt !== undefined ? `  (${row.finishedAt})` : ''}`).join('\n')
      }
      if (action === 'show') {
        if (typeof args.runId !== 'string') throw new Error('show needs a runId')
        const stored = loadRun(cwd, args.runId)
        if (stored === undefined) throw new Error(`no run "${args.runId}" recorded`)
        const lines = [`run ${args.runId} (${String(stored.meta['status'] ?? '?')}): ${String(stored.meta['name'] ?? '?')}`]
        for (const step of Object.values(stored.steps)) {
          const usage = step.usage === undefined ? '' : ` · ${step.usage.totalTokens} tok`
          lines.push(`  ${step.id}: ${step.status === 'completed' ? `✅${usage}` : ` — ${step.status}${step.error !== undefined ? `: ${step.error}` : ''}`}`)
        }
        return lines.join('\n')
      }
      if (action === 'stop') {
        const runId = typeof args.runId === 'string' ? args.runId : [...deps.command.activeRuns.keys()].at(-1)
        if (runId === undefined) throw new Error('no active workflow runs')
        const active = deps.command.activeRuns.get(runId)
        if (active === undefined) throw new Error(`run "${runId}" is not active`)
        active.abort.abort(new Error('stopped by the model (workflow_manage stop)'))
        return `stopping run ${runId} (${active.name})`
      }
      if (action === 'resume' || action === 'rerun') {
        if (typeof args.runId !== 'string') throw new Error(`${action} needs a runId`)
        const stored = loadRun(cwd, args.runId)
        if (stored === undefined) throw new Error(`no run "${args.runId}" recorded`)
        if (action === 'resume') await reconcileInterruptedSteps(exec.hostLike ?? undefined, stored.steps)
        const result = await deps.command.executeRun(agent, exec.signal, {
          workflow: loadWorkflow(stored.workflowText).workflow,
          yamlText: stored.workflowText,
          inputs: stored.inputs ?? {},
          wait: args.wait === true,
          ...(action === 'resume' ? { prior: stored.steps } : {}),
        })
        return result.text ?? (result.kind === 'success' ? 'ok' : 'failed')
      }
      if (action === 'prune') {
        const deleted = pruneRuns(cwd, typeof args.keep === 'number' ? args.keep : 100)
        return deleted.length === 0 ? 'nothing to prune' : `pruned ${deleted.length} run(s)`
      }
      throw new Error(`unknown action "${String(action)}" (runs | show | stop | resume | rerun | prune)`)
    },
  })

  return [runTool, manageTool]
}

// Minimal local read (the tools module never needed the loader's fs surface).
import { readFileSync } from 'node:fs'
function readFileSync2(path: string): string {
  return readFileSync(path.startsWith('~') ? path.replace(/^~(?=$|\/)/, process.env.HOME ?? '') : path, 'utf8')
}

// exec carries the host context on ToolRunContext-like shapes; the repair
// reconciliation is best-effort so an absent host reference is fine.
declare module '@deepseek-ai/dsh-tools' {
  interface ToolRunContext {
    hostLike?: unknown
  }
}
