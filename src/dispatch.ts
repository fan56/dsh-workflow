/**
 * Production dispatch over the host subagent seam — the shape the official
 * workflow-ptc engine itself uses (wayfinder ticket 01, implementation-level
 * evidence from dsh-workflow-ptc's `startChild()`).
 *
 * M2 scope (docs/SPEC.md §5):
 * - **Roster authority**: every dispatch re-reads the agent file and fails
 *   fast with a {@link RosterError} when it is missing/broken (no retry —
 *   re-reading won't heal).
 * - **Persona surgery**: the 0.2.1 activation request carries no persona,
 *   so the child's composition is parked via `reserveChildComposition` and
 *   installed on the child scope at the `subagent/start` edge.
 * - **Depth policy**: `deep >= 1` agents get an explicit
 *   `maxDepth = childDepth + deep` (never the host's tool-facing default);
 *   `deep: 0` leaves get NO maxDepth (an absolute 0 would fail their own
 *   start) and a leaf `toolFilter.deny` instead — the reliable lever, per
 *   the presentAs breakage.
 * - **Cost fold**: after the child settles, its own Session log is folded
 *   into a `UsageSummary` attached to the outcome (best-effort).
 *
 * @module @aiwayds/dsh-workflow/dispatch
 */

import { randomUUID } from 'node:crypto'
import { resolveChildDepth } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RosterError } from './errors.ts'
import { resolveAgent } from './roster.ts'
import { reserveChildComposition, releaseChildComposition, type CompositionHost } from './composition.ts'
import { foldChildUsage, type UsageSummary } from './cost.ts'
import type { DispatchFn, DispatchOutcome } from './engine.ts'

/** Structural view of the host context this module touches (kept minimal). */
export interface DispatchHost extends CompositionHost {
  logger?: { warn(message: string): void }
  tools?: {
    view?: { restrictableNames?: ReadonlySet<string> }
  }
  subagents: CompositionHost['subagents'] & {
    startActivation(spec: {
      provider: string
      label: string
      childId?: SessionId
      request: {
        prompt: Array<{ type: string; text: string }>
        parent: Agent
        agentOptions?: { model?: string; reasoningEffort?: string }
        outputSchema?: Record<string, unknown>
        maxDepth?: number
      }
      signal?: AbortSignal
      delivery: 'parent' | 'caller'
    }): Promise<{
      result: Promise<{ output: ReadonlyArray<{ type?: string; text?: string }>; structured?: unknown; stopReason: string }>
      dispose: () => Promise<void>
    }>
  }
}

/** The registry's spawn-tool deny list (wayfinder ticket 03): the tools a leaf must not reach. */
const SPAWN_TOOL_NAMES = ['subagent', 'subagent_fork', 'workflow', 'ralph'] as const

/** Host-known-tool intersection, read defensively (an unknown host shape denies nothing). */
function leafDenyList(host: DispatchHost): readonly string[] {
  const known = host.tools?.view?.restrictableNames
  const defaults: readonly string[] = SPAWN_TOOL_NAMES
  return known === undefined ? defaults : defaults.filter((name) => known.has(name))
}

export interface DispatchFactoryOptions {
  /** The dispatching agent (every child is attributed to it). */
  parent: Agent
  /** The run's identity, used in child labels. */
  runId: string
  /** The roster directory — call-time authority for every executor.agent. */
  agentsDir: string
  /** The subagent provider (default `spawn`, same as the registry). */
  provider?: string
  /** Child lifecycle callbacks for the session projection (pair per attempt). */
  events?: {
    childStarted(childId: SessionId, label: string): void
    childSettled(childId: SessionId, stopReason: string): void
  }
}

/** Join a host SubagentResult's output blocks into the final text. */
function joinOutput(output: ReadonlyArray<{ type?: string; text?: string }>): string {
  return output
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
    .trim()
}

/** Build the real DispatchFn: resolve roster, compose out-of-band, start, await, fold cost. */
export function createDispatch(host: DispatchHost, factoryOptions: DispatchFactoryOptions): DispatchFn {
  const provider = factoryOptions.provider ?? 'spawn'
  const warn = host.logger?.warn ?? ((message: string) => console.warn(`[dsh-workflow] dispatch: ${message}`))
  return async (request) => {
    // Roster authority: re-read per dispatch (the roster is user-owned and
    // mutable at runtime). A missing/broken file fails the step fast.
    const agent = resolveAgent(factoryOptions.agentsDir, request.agentName)
    const deep = agent.meta.deep

    // Routing: explicit step overrides over the agent file's frontmatter.
    const effectiveModel = request.model ?? agent.meta.model
    const effectiveThinking = request.thinking ?? agent.meta.thinking

    // Depth policy: a relative budget for spawners, a deny list for leaves.
    const toolFilter = deep === 0 ? { deny: leafDenyList(host) } : undefined
    const maxDepth = deep >= 1 ? resolveChildDepth(factoryOptions.parent, undefined) + deep : undefined

    const childId = randomUUID() as unknown as SessionId
    const label = `[wf] ${factoryOptions.runId}/${request.label}`
    reserveChildComposition(childId, factoryOptions.parent.id as SessionId, { persona: agent.body, ...(toolFilter !== undefined ? { toolFilter } : {}) })

    let activation: Awaited<ReturnType<DispatchHost['subagents']['startActivation']>>
    try {
      activation = await host.subagents.startActivation({
        provider,
        label,
        childId,
        request: {
          prompt: [{ type: 'text', text: request.prompt }],
          parent: factoryOptions.parent,
          ...(effectiveModel !== undefined || effectiveThinking !== undefined
            ? { agentOptions: { ...(effectiveModel !== undefined ? { model: effectiveModel } : {}), ...(effectiveThinking !== undefined ? { reasoningEffort: effectiveThinking } : {}) } }
            : {}),
          ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
        },
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        delivery: 'caller',
      })
    } catch (error) {
      // Failed before the start edge — the parked composition is unreachable.
      releaseChildComposition(childId)
      throw error
    }

    factoryOptions.events?.childStarted(childId, request.label)
    try {
      const result = await activation.result
      factoryOptions.events?.childSettled(childId, result.stopReason)
      const usage = await foldChildUsage(host, childId).catch(() => undefined)
      const outcome: DispatchOutcome = {
        text: joinOutput(result.output),
        stopReason: result.stopReason,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        ...(usage !== undefined ? { usage } : {}),
      }
      return outcome
    } finally {
      try {
        await activation.dispose()
      } catch (error) {
        warn(`child ${label} disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export type { UsageSummary }
export { RosterError }
