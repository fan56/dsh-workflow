/**
 * Per-child cost accounting — the self-built leg of the monitoring layer
 * (wayfinder ticket 01): the host's `SubagentResult` and `subagent/end`
 * carry no token usage, so after a child settles we open its own Session
 * log and fold `assistant/message.usage` plus the last `request/header`
 * (provider/model routing).
 *
 * Everything here is best-effort: a missing persistence service or an
 * unreadable child log returns `undefined` — a monitoring failure must
 * never affect execution.
 *
 * @module @aiwayds/dsh-workflow/cost
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  provider?: string
  model?: string
}

/** Structural minimum of the host's session persistence (untyped on purpose). */
interface PersistenceLike {
  open(id: SessionId, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: ReadonlyArray<{ type: string; data?: unknown }> }>
    close(): Promise<void>
  }>
}

function getPersistence(host: unknown): PersistenceLike | undefined {
  const candidate = (host as { sessionPersistence?: PersistenceLike }).sessionPersistence
  if (candidate !== undefined && typeof candidate.open === 'function') return candidate
  return undefined
}

function pickRoute(data: unknown): { provider?: string; model?: string } {
  if (typeof data !== 'object' || data === null) return {}
  const record = data as Record<string, unknown>
  const route = (record.route ?? record) as Record<string, unknown>
  return {
    ...(typeof route.provider === 'string' ? { provider: route.provider } : {}),
    ...(typeof route.model === 'string' ? { model: route.model } : {}),
  }
}

/**
 * Fold one child session's usage. Best-effort on every leg; `undefined` when
 * the log is unavailable (no persistence, dead session) — never throws.
 */
export async function foldChildUsage(host: unknown, childId: SessionId): Promise<UsageSummary | undefined> {
  const persistence = getPersistence(host)
  if (persistence === undefined) return undefined
  let handle: Awaited<ReturnType<PersistenceLike['open']>>
  try {
    handle = await persistence.open(childId, 'read')
  } catch {
    return undefined
  }
  try {
    const { events } = await handle.read()
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens: number | undefined
    let cacheReadTokens: number | undefined
    let route: { provider?: string; model?: string } = {}
    for (const event of events) {
      if (event.type === 'request/header') {
        route = pickRoute(event.data)
        continue
      }
      if (event.type !== 'assistant/message') continue
      const usage = (event.data as { usage?: Record<string, unknown> } | undefined)?.usage
      if (typeof usage !== 'object' || usage === null) continue
      const u = usage as Record<string, unknown>
      if (typeof u.inputTokens === 'number') inputTokens += u.inputTokens
      if (typeof u.outputTokens === 'number') outputTokens += u.outputTokens
      if (typeof u.reasoningTokens === 'number') reasoningTokens = (reasoningTokens ?? 0) + u.reasoningTokens
      if (typeof u.cacheRead === 'number') cacheReadTokens = (cacheReadTokens ?? 0) + u.cacheRead
    }
    if (inputTokens === 0 && outputTokens === 0 && route.provider === undefined && route.model === undefined) {
      return undefined
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...route,
    }
  } catch {
    return undefined
  } finally {
    try {
      await handle.close()
    } catch {
      /* best-effort close */
    }
  }
}
