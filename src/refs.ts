/**
 * Reference templates: the declared-data channel between steps.
 *
 * Syntax: `{{ path.to.value }}` — whitespace-tolerant. The first segment is
 * the scope root: `inputs` (declared inputs), `steps` (per-step outcomes),
 * `item` (foreach item, only inside a foreach child template).
 *
 * This module is the ONLY way data crosses steps (dual-track hard rule #1):
 * no script state, no globals — just declared JSON references.
 *
 * @module @aiwayds/dsh-workflow/refs
 */

import { WorkflowRunError } from './errors.ts'

const REF_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g

/** The value-resolution scope handed to {@link resolveTemplate}. */
export interface RefScope {
  inputs?: Record<string, unknown>
  /** Completed steps by id: `{ output: unknown, actionOutput?: unknown }`. */
  steps?: Record<string, { output?: unknown; 'action-output'?: unknown }>
  item?: unknown
}

/** Extract every reference token's dotted path (deduplicated, order kept). */
export function extractRefs(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(REF_PATTERN)) out.push(match[1]!)
  return [...new Set(out)]
}

/** The scope root a reference points at (`inputs` / `steps` / `item`). */
export function refRoot(path: string): string {
  return path.split('.')[0]!
}

function lookup(root: unknown, segments: string[]): unknown {
  let cursor: unknown = root
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Replace every `{{ref}}` in `text` with its value from `scope`.
 *
 * A reference that resolves to `undefined` throws — referencing data that
 * does not exist is an authoring mistake, and silently emitting the literal
 * `{{ref}}` into a child prompt would be exactly the kind of quiet corruption
 * this plugin exists to prevent.
 */
export function resolveTemplate(text: string, scope: RefScope): string {
  return text.replace(REF_PATTERN, (_whole, path: string) => {
    const value = resolveRef(path, scope)
    if (value === undefined) {
      throw new WorkflowRunError(`reference {{${path}}} resolved to nothing (missing input, upstream step, or item field)`)
    }
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  })
}

/** Resolve one dotted reference path against the scope. */
export function resolveRef(path: string, scope: RefScope): unknown {
  const [root, ...rest] = path.split('.')
  if (root === 'inputs') return lookup({ inputs: scope.inputs ?? {} }, ['inputs', ...rest])
  if (root === 'steps') return lookup({ steps: scope.steps ?? {} }, ['steps', ...rest])
  if (root === 'item') {
    if (rest.length === 0) return scope.item
    return lookup({ item: scope.item }, ['item', ...rest])
  }
  return undefined
}

/**
 * Resolve a `foreach.over` reference, which must land on an array.
 * Returns a human-readable failure instead of throwing (load-time lints use this).
 */
export function resolveOverArray(path: string, scope: RefScope): { ok: true; items: unknown[] } | { ok: false; reason: string } {
  const value = resolveRef(path, scope)
  if (value === undefined) return { ok: false, reason: `{{${path}}} resolved to nothing` }
  if (!Array.isArray(value)) return { ok: false, reason: `{{${path}}} is not an array (got ${typeof value})` }
  return { ok: true, items: value }
}
