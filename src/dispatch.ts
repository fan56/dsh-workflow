/**
 * Production dispatch over the host subagent seam — the shape the official
 * workflow-ptc engine itself uses (wayfinder ticket 01, implementation-level
 * evidence from dsh-workflow-ptc's `startChild()`).
 *
 * M1 scope: bare dispatch (prompt + roster model/thinking resolution). The
 * persona surgery, `[wf]` label namespace hardening, explicit maxDepth, and
 * leaf toolFilter arrive in M2 per docs/SPEC.md — this file is the seam they
 * plug into.
 *
 * @module @aiwayds/dsh-workflow/dispatch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveAgent, type AgentFile } from './roster.ts'
import type { DispatchFn, DispatchOutcome } from './engine.ts'

/** Minimal structural view of the host services this module touches. */
export interface DispatchHost {
  subagents: {
    startActivation(spec: {
      provider: string
      label: string
      request: {
        prompt: Array<{ type: string; text: string }>
        parent: Agent
        agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
        outputSchema?: Record<string, unknown>
      }
      signal?: AbortSignal
      delivery: 'parent' | 'caller'
    }): Promise<{
      result: Promise<{ output: ReadonlyArray<{ type?: string; text?: string }>; structured?: unknown; stopReason: string }>
      dispose: () => Promise<void>
    }>
  }
}

export interface DispatchFactoryOptions {
  /** The dispatching agent (every child is attributed to it). */
  parent: Agent
  /** The run's identity, used in child labels. */
  runId: string
  /** The step's identity within the run. */
  stepId: string
  agentsDir?: string
}

/** Join a host SubagentResult's output blocks into the final text. */
function joinOutput(output: ReadonlyArray<{ type?: string; text?: string }>): string {
  return output
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
    .trim()
}

/** Apply roster-level routing defaults under a step's explicit overrides. */
function resolveRouting(agent: AgentFile, model?: string, thinking?: string): { model?: string; reasoningEffort?: string } {
  const effectiveModel = model ?? agent.meta.model
  const effectiveThinking = thinking ?? agent.meta.thinking
  return {
    ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
    ...(effectiveThinking !== undefined ? { reasoningEffort: effectiveThinking } : {}),
  }
}

/**
 * Build the real DispatchFn. Each call re-reads the roster (call-time
 * authority — the roster is user-owned and mutable at runtime).
 */
export function createDispatch(host: DispatchHost, factoryOptions: DispatchFactoryOptions): DispatchFn {
  const agentsDir = factoryOptions.agentsDir ?? undefined
  return async (request) => {
    const agent = agentsDir === undefined
      ? undefined
      : safeResolve(agentsDir, request.agentName)
    const routing = agent === undefined ? {} : resolveRouting(agent, request.model, request.thinking)
    const label = `[wf] ${factoryOptions.runId}/${factoryOptions.stepId}`
    const activation = await host.subagents.startActivation({
      provider: 'spawn',
      label,
      request: {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: factoryOptions.parent,
        ...(Object.keys(routing).length > 0 ? { agentOptions: routing } : {}),
        ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
      },
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      delivery: 'caller',
    })
    try {
      const result = await activation.result
      const outcome: DispatchOutcome = {
        text: joinOutput(result.output),
        stopReason: result.stopReason,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
      }
      return outcome
    } finally {
      await activation.dispose()
    }
  }
}

function safeResolve(dir: string, name: string): AgentFile | undefined {
  try {
    return resolveAgent(dir, name)
  } catch {
    // A missing/broken roster file surfaces through dispatch itself; the
    // routing defaults are best-effort until M2's fail-fast roster check.
    return undefined
  }
}
