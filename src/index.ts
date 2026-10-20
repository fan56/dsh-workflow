/**
 * dsh-workflow — declarative YAML workflows for DeepSeek Harness.
 *
 * Durable daily pipelines (release waves, migration waves, inspections) over
 * the host's own subagent primitives. Official bundle form, zero core
 * patches, never claims `ctx.workflowEngine` — the native workflow tool owns
 * one-off orchestration; this plugin owns named, resumable pipelines.
 *
 * M1 scope (docs/SPEC.md §5): YAML loader (fail-loud), serial engine, bare
 * dispatch, and the minimal `/workflow run|list|help` command for real-host
 * smoke tests. Run Store, persona surgery, jobs, and the full command family
 * follow in M2/M3.
 *
 * @module @aiwayds/dsh-workflow
 */

import { registerWorkflowCommand, type CommandHost } from './commands.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-workflow'

/**
 * Services required by this plugin. `commands` is the trigger path and
 * `subagents` the execution seam; `agents`/`tools`/`systemPrompt` are the
 * out-of-band child composition's surface (persona section + leaf restrict
 * install on the child scope at the start edge — cordis rejects the property
 * access without the inject declaration, proven by a real-host boot).
 * All of them come with every dsh-base profile.
 */
export const inject = ['commands', 'subagents', 'agents', 'tools', 'systemPrompt']

export function apply(context: CommandHost): void {
  // The command handler assembles its own engine per run (dispatch needs the
  // invoking agent as the children's parent), so plugin setup is one row.
  registerWorkflowCommand(context)
}

export { loadWorkflow } from './loader.ts'
export { createEngine } from './engine.ts'
export { createDispatch } from './dispatch.ts'
export { loadRoster, resolveAgent, parseAgentMarkdown, defaultAgentsDir } from './roster.ts'
export { installChildCompositionListener, reserveChildComposition } from './composition.ts'
export { foldChildUsage } from './cost.ts'
export { createRunStore } from './run-store.ts'
export { createRunProjector } from './projection.ts'
export { WorkflowLoadError, WorkflowRunError, RosterError } from './errors.ts'
export type {
  WorkflowDef, AnyStepDef, StepDef, ForeachStepDef, WorkflowInputDecl, ExecutorSpec,
} from './types.ts'
export type { RunOutcome, StepOutcome, Engine, DispatchFn } from './engine.ts'
export type { UsageSummary } from './cost.ts'
