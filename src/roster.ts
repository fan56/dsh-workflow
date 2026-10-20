/**
 * Roster agent-file reader — a self-contained copy of the
 * dsh-subagent-registry agent-markdown parser (its `agents-dir.ts`), which is
 * itself a copy of the dsh-tui-pi agent-manager logic. Shipping a copy is the
 * ecosystem's established pattern (zero package deps); upstream follow-up
 * ticket: have the registry export these readers so every consumer shares one
 * implementation (wayfinder ticket 03, route B).
 *
 * Format contract: `docs/AGENT-FORMAT.md` in dsh-subagent-registry v0.14.1
 * (version anchor — re-diff when the upstream contract evolves).
 *
 * Behavioral invariants kept from the registry:
 * - `name` is required and MUST equal the file stem, else the file is broken.
 * - `thinking` outside the whitelist → the file is BROKEN (fail-loud), not ignored.
 * - `deep` must be a non-negative integer (default 1); 0 = leaf (no spawn).
 * - `background` must be exactly `true`/`false` when present.
 * - Unknown keys are silently ignored (`displayName` camelCase is a known trap).
 * - Loose `key: value` parsing, optional quotes, CRLF tolerated.
 *
 * @module @aiwayds/dsh-workflow/roster
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunError } from './errors.ts'

/** Valid frontmatter `thinking` values, in canonical order (registry parity). */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** The subset of frontmatter this plugin consumes. */
export interface AgentMeta {
  name: string
  displayName?: string
  description?: string
  model?: string
  thinking?: ThinkingLevel
  deep: number
  background?: boolean
  maxRounds?: number
}

/** A parsed agent file: metadata + the raw persona body (used verbatim). */
export interface AgentFile {
  path: string
  meta: AgentMeta
  body: string
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** The agents directory: `$DSH_HOME/agents`, i.e. `~/.dsh/agents` by default. */
export function defaultAgentsDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agents')
}

/**
 * Parse one agent markdown file. `fileStem` is the basename without `.md`;
 * a frontmatter `name` that disagrees with it marks the file broken.
 */
export function parseAgentMarkdown(text: string, path: string, fileStem: string): { ok: true; agent: AgentFile } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: 'missing frontmatter (file must start with `---`)' }
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      close = i
      break
    }
  }
  if (close === -1) return { ok: false, error: 'unterminated frontmatter (no closing `---`)' }

  const values: Record<string, string> = {}
  for (let i = 1; i < close; i++) {
    const match = KEY_LINE.exec(lines[i]!)
    if (match === null) continue
    values[match[1]!] = stripQuotes(match[2]!.trim())
  }

  const name = values['name']?.trim()
  if (name === undefined || name === '') {
    return { ok: false, error: 'missing required frontmatter key `name`' }
  }
  if (name !== fileStem) {
    return { ok: false, error: `frontmatter name "${name}" does not match file stem "${fileStem}"` }
  }

  let deep = 1
  if (values['deep'] !== undefined && values['deep'] !== '') {
    const parsed = Number(values['deep'])
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { ok: false, error: `\`deep\` must be a non-negative integer, got "${values['deep']}"` }
    }
    deep = parsed
  }

  let thinking: ThinkingLevel | undefined
  if (values['thinking'] !== undefined && values['thinking'] !== '') {
    const candidate = values['thinking']
    if (!(THINKING_LEVELS as readonly string[]).includes(candidate)) {
      return { ok: false, error: `\`thinking\` must be one of ${THINKING_LEVELS.join('|')}, got "${candidate}"` }
    }
    thinking = candidate as ThinkingLevel
  }

  let background: boolean | undefined
  if (values['background'] !== undefined && values['background'] !== '') {
    if (values['background'] !== 'true' && values['background'] !== 'false') {
      return { ok: false, error: `\`background\` must be exactly true or false, got "${values['background']}"` }
    }
    background = values['background'] === 'true'
  }

  let maxRounds: number | undefined
  if (values['maxRounds'] !== undefined && values['maxRounds'] !== '') {
    const parsed = Number(values['maxRounds'])
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: `\`maxRounds\` must be a positive integer, got "${values['maxRounds']}"` }
    }
    maxRounds = parsed
  }

  const body = lines.slice(close + 1).join('\n')
  return {
    ok: true,
    agent: {
      path,
      body,
      meta: {
        name,
        deep,
        ...(values['display_name'] ? { displayName: values['display_name'] } : {}),
        ...(values['description'] ? { description: values['description'] } : {}),
        ...(values['model'] ? { model: values['model'] } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(maxRounds !== undefined ? { maxRounds } : {}),
      },
    },
  }
}

/** List the directory and parse every `*.md`; broken files are reported, not fatal. */
export function loadRoster(dir: string): { agents: Map<string, AgentFile>; broken: Array<{ file: string; error: string }> } {
  const agents = new Map<string, AgentFile>()
  const broken: Array<{ file: string; error: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { agents, broken }
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const stem = entry.slice(0, -3)
    const path = join(dir, entry)
    try {
      const result = parseAgentMarkdown(readFileSync(path, 'utf8'), path, stem)
      if (result.ok) agents.set(result.agent.meta.name, result.agent)
      else broken.push({ file: entry, error: result.error })
    } catch (error) {
      broken.push({ file: entry, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { agents, broken }
}

/**
 * Call-time authoritative read of one agent (the registry's own convention:
 * the roster is user-owned and editable at runtime, never cached).
 * Throws a roster-aware {@link WorkflowRunError} when the name is unknown.
 */
export function resolveAgent(dir: string, name: string): AgentFile {
  const safeName = /^[\w-]+$/.test(name) ? name : ''
  const path = safeName === '' ? '' : join(dir, `${name}.md`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    const { agents } = loadRoster(dir)
    const available = [...agents.keys()].sort().join(', ') || '(none)'
    throw new WorkflowRunError(`unknown agent "${name}" — no ${name}.md in ${dir} (available agents: ${available})`)
  }
  const result = parseAgentMarkdown(text, path, name)
  if (!result.ok) throw new WorkflowRunError(`agent "${name}": ${result.error}`)
  return result.agent
}
