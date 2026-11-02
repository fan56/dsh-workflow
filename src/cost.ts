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
  /** Assistant turns in the child log — one per agent-loop round. */
  rounds?: number
  /** ToolCall content blocks across the child log. */
  toolCalls?: number
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
  try {
    // cordis guards PROPERTY access by the plugin's inject list — a bare
    // `host.sessionPersistence` read THROWS on an unlisted plugin and the
    // exception tunnels out through the caller's `.catch` (real-host
    // verified: the whole fold died silently right here). Everything goes
    // through the untyped `get`, inside this one try.
    const getter = (host as { get?: (key: string) => unknown }).get
    if (typeof getter !== 'function') {
      return undefined
    }
    const candidate = getter.call(host, 'sessionPersistence') as PersistenceLike | undefined
    if (candidate !== undefined && typeof candidate.open === 'function') return candidate
  } catch {
    /* service absent */
  }
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fold one child session's usage. Best-effort on every leg; `undefined` when
 * the log stays unavailable — never throws. Persistence flushes lazily after
 * child settlement, so a first read can legitimately return an empty log:
 * retry with a short backoff before giving up (real-host verified).
 */
export async function foldChildUsage(host: unknown, childId: SessionId): Promise<UsageSummary | undefined> {
  const persistence = getPersistence(host)
  if (persistence === undefined) return undefined
  for (let attempt = 0; attempt < 6; attempt++) {
    const summary = await tryFoldOnce(persistence, childId)
    if (summary !== undefined) return summary
    if (attempt < 5) await sleep(500)
  }
  return undefined
}

async function tryFoldOnce(persistence: PersistenceLike, childId: SessionId): Promise<UsageSummary | undefined> {
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
    let rounds = 0
    let toolCalls = 0
    for (const event of events) {
      if (event.type === 'request/header') {
        route = pickRoute(event.data)
        continue
      }
      if (event.type !== 'assistant/message') continue
      rounds += 1
      const data = event.data as { message?: { content?: unknown } } | undefined
      const content = data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'toolCall') toolCalls += 1
        }
      }
      const usage = (event.data as { usage?: Record<string, unknown> } | undefined)?.usage
      if (typeof usage !== 'object' || usage === null) continue
      const u = usage as Record<string, unknown>
      if (typeof u.inputTokens === 'number') inputTokens += u.inputTokens
      if (typeof u.outputTokens === 'number') outputTokens += u.outputTokens
      if (typeof u.reasoningTokens === 'number') reasoningTokens = (reasoningTokens ?? 0) + u.reasoningTokens
      // The host spells the cache-hit field `cacheReadTokens` (real logs);
      // `cacheRead` kept as a defensive alias.
      const cacheRead = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : (typeof u.cacheRead === 'number' ? u.cacheRead : undefined)
      if (cacheRead !== undefined) cacheReadTokens = (cacheReadTokens ?? 0) + cacheRead
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
      ...(rounds > 0 ? { rounds } : {}),
      ...(toolCalls > 0 ? { toolCalls } : {}),
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
