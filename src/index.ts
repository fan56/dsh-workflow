/**
 * dsh-workflow — declarative YAML workflows for DeepSeek Harness.
 *
 * Durable daily pipelines (release waves, migration waves, inspections) over
 * the host's own subagent primitives. Official bundle form, zero core
 * patches, never claims `ctx.workflowEngine` — the native workflow tool owns
 * one-off orchestration; this plugin owns named, resumable pipelines.
 *
 * v1 scope complete (docs/SPEC.md §5, M1-M4): fail-loud YAML loader, serial
 * + foreach engine over the host subagent seam, Run Store with per-step cost
 * accounting, the /workflow command family, model tools, the dsh-workflow-config
 * usage skill, a tui widget (file seam), and checkpoint resume with L1 repair.
 *
 * @module @aiwayds/dsh-workflow
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { registerWorkflowCommand, type CommandHost } from './commands.ts'
import { createWorkflowTools } from './tools.ts'

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
export const inject = ['commands', 'subagents', 'agents', 'tools', 'systemPrompt', 'jobs', 'skills']

export function apply(context: CommandHost): void {
  // Usage skill (family convention: <plugin>-config): teaches the model how
  // to create/run/inspect workflows and configure the plugin. Served through
  // the host skills surface; silent no-op without it.
  context.effect(() => {
    const skills = (context as unknown as { skills?: { registerProvider(provider: unknown): unknown } }).skills
    if (skills === undefined) return () => {}
    const bodyUrl = new URL('../skills/dsh-workflow-config/SKILL.md', import.meta.url)
    const description = 'dsh-workflow 插件使用与配置指南。凡涉及创建/修改/删除/运行 workflow、.workflow.yaml 写法(schema/字段/示例)、phase 阶段与 foreach 扇出、断点续跑 resume、token 成本账、run 记录查询、roster agent 引用、插件安装,先读本指南。触发词:workflow、工作流、流水线、dsh-workflow、run、resume、增删改查。'
    const disposer = skills.registerProvider(() => ({
      name: 'dsh-workflow-config',
      list: () => Promise.resolve([{
        name: 'dsh-workflow-config',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'dsh-workflow-config',
        source: 'bundled',
        // Bundled-skill rank (tui-pi parity): the host validates the rank as
        // a finite number — a missing one rejects the whole skill.
        rank: 600,
        locator: bodyUrl,
      }]),
      async get() {
        const raw = readFileSync(fileURLToPath(bodyUrl), 'utf8')
        const body = raw.startsWith('---')
          ? raw.slice(raw.indexOf('\n', raw.indexOf('---') + 3) + 1).trim()
          : raw
        return {
          name: 'dsh-workflow-config',
          description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-workflow-config',
          source: 'bundled',
          content: body,
        }
      },
    }))
    return typeof disposer === 'function' ? (disposer as () => void) : () => {}
  })
  // Model guidance: without this section the model has no idea the plugin
  // exists — user requests like "给我创建一个 workflow" get hijacked by
  // whatever other workflow skill is installed (real-tui verified). Keep it
  // short: route the intent, sketch the schema, hand off to /workflow.
  context.effect(() => {
    const disposer = context.systemPrompt.section({
    name: 'dsh-workflow:usage',
    // Anchor next to the native workflow tool's guidance section (same
    // family of intent — the model reads them as one block).
    order: context.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: [
      '## dsh-workflow (durable YAML workflows)',
      'The /workflow command family runs DECLARATIVE YAML workflows that fan out subagents — durable, resumable pipelines (release waves, research sweeps, recurring checks).',
      '- When the user asks to CREATE a workflow ("建一个 workflow 搜集…", "make a pipeline that…"), WRITE a `<name>.workflow.yaml` file to the personal library `$DSH_HOME/workflows/` (default `~/.dsh/workflows/`; create the directory if it does not exist). Project-only workflows may instead live in the launch directory. After writing, run `/wf list` to confirm the new entry shows up, then tell the user to run it with `/workflow run <file>`. Do not invent other mechanisms.',
      '- Schema: top-level `format: dsh-workflow`, `version: 1`, `name` (kebab-case = file stem), `description`, optional `inputs`/`phases`; `steps[]` each with `id`, `executor.agent` (a name from ~/.dsh/agents/*.md), `prompt` (supports template references to declared inputs and upstream step outputs — double-brace syntax), optional `needs`, `foreach` (over/as/max-concurrency/step), `retry`, `on-error` (fail|skip|continue), `cache` (always|on-failure|never), `confirm`, `phase`, `output` (object JSON-schema), `acceptance`, `action` (pure per-step JS).',
      '- Hard rules: YAML declares structure; JS only inside one step action; unknown keys are errors. Run `/workflow help` for the family; full spec in the dsh-workflow repo docs/SPEC.md.',
      '- One-off delegation (a single subagent task) stays on the plain subagent tool — workflows are for durable, repeatable pipelines.',
    ].join('\n'),
    })
    return typeof disposer === 'function' ? () => { (disposer as () => void)() } : () => {}
  })
  // Model tools: the natural-language entry (works in headless/web/tui —
  // no slash command required). Shares the command family's executor.
  const command = registerWorkflowCommand(context)
  const tools = (context as unknown as { tools?: { register(tool: unknown): unknown } }).tools
  if (tools !== undefined) {
    for (const tool of createWorkflowTools({
      command,
      agentProvider: () => undefined,
      cwdProvider: () => process.cwd(),
    })) {
      const toolDisposer = tools.register(tool)
      void toolDisposer
    }
  }
  // The tui widget activates through the file seam: the command path calls
  // flushWidgetFile() on every run/step state change, writing the mini lines
  // plus the overlay manifest into \$DSH_HOME/tui-widgets/. No tui installed
  // = nobody reads the files, which is exactly the correct no-op.
}

export { loadWorkflow } from './loader.ts'
export { createEngine } from './engine.ts'
export { createDispatch } from './dispatch.ts'
export { loadRoster, resolveAgent, parseAgentMarkdown, defaultAgentsDir } from './roster.ts'
export { installChildCompositionListener, reserveChildComposition } from './composition.ts'
export { foldChildUsage } from './cost.ts'
export { createRunStore } from './run-store.ts'
export { createRunProjector } from './projection.ts'
export { flushWidgetFile, renderMini, widgetFile } from './tui-widget.ts'
export { widgetRunStarted, widgetStepUpdate, widgetRunSettled, snapshotWidgetRuns } from './run-state.ts'
export { WorkflowLoadError, WorkflowRunError, RosterError } from './errors.ts'
export type {
  WorkflowDef, AnyStepDef, StepDef, ForeachStepDef, WorkflowInputDecl, ExecutorSpec,
} from './types.ts'
export type { RunOutcome, StepOutcome, Engine, DispatchFn } from './engine.ts'
export type { UsageSummary } from './cost.ts'
