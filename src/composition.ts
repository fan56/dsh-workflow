/**
 * Out-of-band child composition for activation hosts — a trimmed copy of the
 * dsh-subagent-registry's mechanism (wayfinder ticket 03; the registry's
 * `host-compat.ts` is the construction drawing).
 *
 * The 0.2.1 line carries no `persona`/`toolFilter` on `SubagentStartRequest`
 * (composition moved to host agent presets). This plugin keeps its
 * markdown-roster semantics without presets: each fresh dispatch reserves
 * the child's durable id and parks its composition here, and the
 * `subagent/start` listener installs it on the child's own agent scope —
 * the same window the host itself uses (`applyChildOverrides` runs during
 * creation setup, before the first prompt is queued), so the persona shadows
 * the deployment persona for that child alone.
 *
 * @module @aiwayds/dsh-workflow/composition
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A fresh child's persona and optional leaf tool scoping. */
export interface ChildComposition {
  readonly persona: string
  readonly toolFilter?: { deny: readonly string[] }
}

const pending = new Map<SessionId, { composition: ChildComposition; parentId: SessionId }>()

/** Park the composition to install on this child at the start edge. */
export function reserveChildComposition(childId: SessionId, parentId: SessionId, composition: ChildComposition): void {
  pending.set(childId, { composition, parentId })
}

/** Drop a reservation whose dispatch failed before the start edge. */
export function releaseChildComposition(childId: SessionId): void {
  pending.delete(childId)
}

/** The persona section name and order the host itself uses for a child's shadowing persona. */
const CHILD_PERSONA_SECTION = 'deployment:persona-prefix'

function installChildComposition(child: Agent, composition: ChildComposition): void {
  child.ctx.systemPrompt.section({
    name: CHILD_PERSONA_SECTION,
    order: child.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: composition.persona,
  })
  if (composition.toolFilter !== undefined) child.ctx.tools.restrict(composition.toolFilter)
}

/** Structural view of the context this module needs. */
export interface CompositionHost {
  on(event: 'subagent/start', handler: (info: { id: SessionId }) => void): () => void
  on(event: 'agent/disposed', handler: (payload: { agent: { id: SessionId } }) => void): () => void
  agents: { get(id: SessionId): Agent | undefined }
  subagents: { startActivation: unknown }
}

/**
 * Install the reserved child compositions on activation hosts. A fresh agent
 * scope materializes for every run of a parked child, and agent-scoped
 * contributions unwind with that scope — so the listener re-installs at
 * every start edge of a reserved child, and prunes the reservation only when
 * the delegating parent session is disposed (the child's own `agent/disposed`
 * fires at every run settlement; pruning there would break a later wake).
 */
export function installChildCompositionListener(host: CompositionHost): () => void {
  if (typeof host.subagents.startActivation !== 'function') return () => {}
  const releases = [
    host.on('subagent/start', (info) => {
      const reserved = pending.get(info.id)
      if (reserved === undefined) return
      const child = host.agents.get(info.id)
      if (child === undefined) return
      installChildComposition(child, reserved.composition)
    }),
    host.on('agent/disposed', (payload) => {
      for (const [childId, reserved] of pending) {
        if (reserved.parentId === payload.agent.id) pending.delete(childId)
      }
    }),
  ]
  return () => {
    for (const release of releases) release()
  }
}
