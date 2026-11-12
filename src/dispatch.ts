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
    /**
     * 0.2.2-rc.2 flattened `SubagentActivationSpec`: the start-request fields
     * (`prompt`/`parent`/`agentOptions`/`outputSchema`/`maxDepth`) ride the
     * spec itself. Pre-rc.2 lines read the same fields from a nested
     * `request` block — {@linkcode rc2ChildSurface} picks the branch, and the
     * legacy object is cast at the call site (the declared shape stays the
     * current line's, so a future host reshape is visible to tsc again
     * instead of hiding behind a self-declared nested block).
     */
    startActivation(spec: {
      provider: string
      label: string
      childId?: SessionId
      prompt: Array<{ type: string; text: string }>
      parent: Agent
      agentOptions?: { model?: string; reasoningEffort?: string }
      outputSchema?: Record<string, unknown>
      maxDepth?: number
      signal?: AbortSignal
      delivery: 'parent' | 'caller'
    }): Promise<{
      childId: SessionId
      result: Promise<{ output: ReadonlyArray<{ type?: string; text?: string }>; structured?: unknown; stopReason: string }>
      dispose: () => Promise<void>
    }>
  }
}

/**
 * Whether the host's subagents service speaks the 0.2.2-rc.2 child surface
 * (flattened `SubagentActivationSpec`). Same detector the registry uses
 * (dsh-subagent-registry host-compat.ts): `waitForTreeWork` shipped with
 * rc.2 (new tree types/index.d.ts:185) and is absent on every pre-rc.2 line
 * this plugin's unchanged peer floors (>=0.2.0-rc.2) still cover.
 */
function rc2ChildSurface(host: DispatchHost): boolean {
  return typeof (host.subagents as { waitForTreeWork?: unknown }).waitForTreeWork === 'function'
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

/** Split a `provider/model` route (registry's `splitModel` parity): no slash = provider only. */
function splitModelRoute(route: string): { provider?: string; model?: string } {
  const slash = route.indexOf('/')
  if (slash === -1) return { provider: route }
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
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
    // A frontmatter route is `provider/model` and must be SPLIT — passing the
    // whole string as `model` makes the host look for a model literally named
    // "provider/model" under the current provider (real-host verified failure).
    const routeOverride = request.model !== undefined
      ? splitModelRoute(request.model)
      : agent.meta.model !== undefined
        ? splitModelRoute(agent.meta.model)
        : {}
    const effectiveThinking = request.thinking ?? agent.meta.thinking
    const agentOptions = {
      ...(routeOverride.provider !== undefined ? { provider: routeOverride.provider } : {}),
      ...(routeOverride.model !== undefined ? { model: routeOverride.model } : {}),
      ...(effectiveThinking !== undefined ? { reasoningEffort: effectiveThinking } : {}),
    }
    const hasAgentOptions = routeOverride.provider !== undefined || routeOverride.model !== undefined || effectiveThinking !== undefined

    // Depth policy: a relative budget for spawners, a deny list for leaves.
    const toolFilter = deep === 0 ? { deny: leafDenyList(host) } : undefined
    const maxDepth = deep >= 1 ? resolveChildDepth(factoryOptions.parent, undefined) + deep : undefined

    const childId = randomUUID() as unknown as SessionId
    const label = `[wf] ${factoryOptions.runId}/${request.label}`
    reserveChildComposition(childId, factoryOptions.parent.id as SessionId, { persona: agent.body, ...(toolFilter !== undefined ? { toolFilter } : {}) })

    let activation: Awaited<ReturnType<DispatchHost['subagents']['startActivation']>>
    try {
      // 0.2.2-rc.2 flattened `SubagentActivationSpec` (types.d.ts:23 —
      // `extends Omit<SubagentStartRequest, 'label' | 'signal'>`): the host
      // implementation reads `spec.parent.id` (lib/index.js:3024) and
      // `spec.prompt` (lib/index.js:1557) off the spec ITSELF, so a nested
      // `request` block is a TypeError on every dispatch. Pre-rc.2 lines
      // read the nested block; the feature-detect keeps both alive.
      const spec = (rc2ChildSurface(host)
        ? {
            provider,
            label,
            childId,
            prompt: [{ type: 'text', text: request.prompt }],
            parent: factoryOptions.parent,
            ...(hasAgentOptions ? { agentOptions } : {}),
            ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
            ...(maxDepth !== undefined ? { maxDepth } : {}),
            // rc.2 makes `signal` a required spec field; a never-aborted
            // signal preserves the old optional semantics when the caller
            // supplies none.
            signal: request.signal ?? new AbortController().signal,
            delivery: 'caller' as const,
          }
        : {
            provider,
            label,
            childId,
            request: {
              prompt: [{ type: 'text', text: request.prompt }],
              parent: factoryOptions.parent,
              ...(hasAgentOptions ? { agentOptions } : {}),
              ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
              ...(maxDepth !== undefined ? { maxDepth } : {}),
            },
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
            delivery: 'caller',
          }) as Parameters<DispatchHost['subagents']['startActivation']>[0]
      activation = await host.subagents.startActivation(spec)
    } catch (error) {
      // Failed before the start edge — the parked composition is unreachable.
      releaseChildComposition(childId)
      throw error
    }

    factoryOptions.events?.childStarted(activation.childId, request.label)
    try {
      const result = await activation.result
      factoryOptions.events?.childSettled(activation.childId, result.stopReason)
      // Dispose BEFORE the cost fold: disposal reaches child quiescence and
      // flushes the child's log — folding earlier races the persistence and
      // reads nothing (real-host verified).
      await activation.dispose()
      // The activation's returned childId is the identity the host actually
      // persisted under — the request's optional childId is not authoritative.
      const usage = await foldChildUsage(host, activation.childId).catch(() => undefined)
      const outcome: DispatchOutcome = {
        text: joinOutput(result.output),
        stopReason: result.stopReason,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        ...(usage !== undefined ? { usage } : {}),
      }
      return outcome
    } catch (error) {
      try {
        await activation.dispose()
      } catch {
        /* the primary error matters more */
      }
      throw error
    }
  }
}

export type { UsageSummary }
export { RosterError }
