/**
 * The tui widget — dsh-workflow's own presence in the user's tui.
 *
 * This plugin NEVER depends on a tui: it detects the generic widget seam
 * (`ctx.tuiWidgets`, shipped by @aiwayds/dsh-tui-pi) and, only when present,
 * registers a pure frame renderer (`render(width): string[]` — the seam's
 * line protocol, no pi-tui import here). Without a tui the command family
 * works exactly the same; the widget is a presence bonus, not a requirement.
 *
 * @module @aiwayds/dsh-workflow/tui-widget
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { snapshotWidgetRuns, widgetRunStarted, type WidgetRunState } from './run-state.ts'

/** Visible-width clip: CJK/fullwidth counts double so the line never wraps. */
function clip(text: string, width: number): string {
  let visible = 0
  let end = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0
    visible += code > 0x2e80 ? 2 : 1
    if (visible > width) {
      end = i
      break
    }
    if (code > 0xffff) i++
  }
  const clipped = text.slice(0, end)
  return visible > width ? `${clipped}…` : clipped
}

function fmtTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
  return String(total)
}

function keyOf(run: WidgetRunState): string {
  return run.runId
}

function pickFocusedRun(runs: WidgetRunState[]): WidgetRunState | undefined {
  if (runs.length === 0) return undefined
  if (focusMode === 'auto') {
    return runs.find((run) => run.status === 'running') ?? runs[0]
  }
  return runs[focusMode] ?? runs[0]
}

/** Content row budget of the panel (the user's spec: 7 lines). */
const PANEL_ROWS = 7

/** Visible width (CJK/fullwidth counts double). */
function visibleWidth(text: string): number {
  let visible = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    visible += code > 0x2e80 ? 2 : 1
  }
  return visible
}

/** Visible-width pad: spaces to the target width (CJK-aware). */
function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/** Visible-width clip from the LEFT (horizontal scroll window). */
function clipLeft(text: string, skip: number, width: number): string {
  let out = ''
  let visible = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const w = code > 0x2e80 ? 2 : 1
    if (visible >= skip && visible + w <= skip + width) out += ch
    visible += w
    if (visible >= skip + width) break
  }
  return out
}

/** Step-level icons. */
const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '▶',
  completed: '✅',
  failed: '✗',
  skipped: '⏭',
}

const RUN_ICON: Record<WidgetRunState['status'], string> = { running: '▶', completed: '✅', failed: '✗' }

/**
 * Which run the widget shows. `auto` = oldest running run (falls back to
 * the oldest visible); a numeric focus pins a specific run until cycling
 * changes it. The tui's cycle hotkey writes "next" into the focus signal
 * file; the widget applies it on its next frame (state is this module's).
 */
let focusMode: 'auto' | number = 'auto'
/** Horizontal scroll offset (visible columns) — the left/right hotkey moves it. */
let hScroll = 0

/** Apply a cycle signal from the tui keybinding (best-effort, no-op when <2 runs). */
export function cycleWidgetFocus(now = Date.now()): void {
  const runs = snapshotWidgetRuns(now)
  if (runs.length < 2) return
  if (focusMode === 'auto') focusMode = 0
  else focusMode = (focusMode + 1) % runs.length
  flushWidgetFile(now)
}

/** Reset to auto (a new run starting also resets the pin). */
export function resetWidgetFocus(): void {
  focusMode = 'auto'
  hScroll = 0
}

/**
 * Render the panel — ONE focused run per frame (auto = oldest running),
 * drawn as a boxed todos-style panel pinned above the input: fixed 7
 * content rows (title + 5 tree rows + hotkey footer), the RUNNING step
 * kept centered in the window, live subagent count right-aligned in the
 * title, left/right hotkeys panning the horizontal viewport over
 * truncated content.
 */
export function renderMini(width: number, now = Date.now()): string[] {
  const runs = snapshotWidgetRuns(now)
  const run = pickFocusedRun(runs)
  if (run === undefined) return []
  if (focusMode !== 'auto' && !runs.some((r) => r.runId === keyOf(run))) focusMode = 'auto'

  const statuses = [...run.steps.values()]
  const completed = statuses.filter((s) => s.status === 'completed').length
  const failed = statuses.filter((s) => s.status === 'failed').length
  const running = statuses.filter((s) => s.status === 'running').length
  const tokens = statuses.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)

  // Title row: left identity, right-aligned live count.
  const titleLeft = `workflow: ${run.name}`
  const titleRight = `${RUN_ICON[run.status]} ${running} live · ${fmtTokens(tokens)} tok`

  // Tree rows: top-level steps as primary branches, foreach children
  // (<parent>#<index>) nested under their foreach step.
  const rows: string[] = []
  const childMap = new Map<string, string[]>()
  const topIds: string[] = []
  for (const id of run.steps.keys()) {
    const hashIdx = id.indexOf('#')
    if (hashIdx > 0) {
      const parent = id.slice(0, hashIdx)
      if (!childMap.has(parent)) childMap.set(parent, [])
      childMap.get(parent)!.push(id)
    } else {
      topIds.push(id)
    }
  }
  topIds.forEach((id, i) => {
    const isLast = i === topIds.length - 1
    const branch = isLast ? '└─ ' : '├─ '
    rows.push(branch + stepRowText(run, id))
    const kids = childMap.get(id) ?? []
    kids.forEach((kid, j) => {
      const kidBranch = j === kids.length - 1 ? '└─ ' : '├─ '
      const indent = isLast ? '   ' : '│  '
      rows.push(indent + kidBranch + stepRowText(run, kid))
    })
  })

  const hotkeys = `Alt+W 切换 · ←→ 拉动 · Ctrl+K 树${runs.length > 1 ? ` · run ${runs.findIndex((r) => r.runId === run.runId) + 1}/${runs.length}` : ''}`

  // Body = title + tree rows + hotkey footer, windowed vertically so the
  // RUNNING row stays inside the 7-row budget.
  const body: string[] = [padVisible(titleLeft, Math.max(visibleWidth(titleLeft), width - visibleWidth(titleRight) - 4)) + titleRight]
  const budget = PANEL_ROWS - 2
  const runningTreeIdx = rows.findIndex((r) => r.includes('▶ ') && !r.includes('live'))
  let start = 0
  if (rows.length > budget) {
    const focusIdx = Math.max(0, runningTreeIdx)
    start = Math.min(Math.max(0, focusIdx - Math.floor(budget / 2)), rows.length - budget)
  }
  const windowed = rows.slice(start, start + budget)
  body.push(...windowed)
  if (windowStartHint(start, rows.length, budget) !== '') body.splice(1, 0, `  … ${start} earlier`)
  const lastIdx = body.length - 1
  if (start + budget < rows.length) {
    body.splice(lastIdx, 0, `  … ${rows.length - start - budget} more`)
  }
  body.push(hotkeys)

  return frame(body, width, titleRight)
}

function windowStartHint(start: number, total: number, budget: number): string {
  return start > 0 ? `… ${start} earlier` : ''
}

function stepRowText(run: WidgetRunState, id: string): string {
  const st = run.steps.get(id)
  if (st === undefined) return `${STATUS_ICON.pending} ${id}`
  const icon = STATUS_ICON[st.status] ?? '○'
  const bits = [`${icon} ${id}`]
  if (st.totalTokens !== undefined) bits.push(`${fmtTokens(st.totalTokens)} tok`)

  return bits.join('  ')
}

/** Frame the body rows: title row carries the right-aligned live count. */
function frame(body: string[], width: number, titleRight: string): string[] {
  const inner = Math.max(width - 2, 20)
  const top = `╭─ ${body[0] ?? ''} `
  const topFill = Math.max(1, inner - visibleWidth(top) + 1)
  const framed: string[] = [clip(top + '─'.repeat(topFill), inner + 2) + '╮']
  for (const line of body.slice(1)) {
    framed.push(`│ ${padVisible(clipLeft(line, hScroll, inner - 2), inner - 2)} │`)
  }
  framed.push(`╰${'─'.repeat(inner - 2)}╯`)
  return framed
}

const WIDGET_GRACE_MS = 60_000

/**
 * The cycle signal file: the tui's cycle hotkey writes "next" into it; the
 * polling loop (active runs only) applies it and removes the file. A file
 * signal keeps the seam process-agnostic — no cordis service is involved.
 */
export function cycleSignalFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'tui-widgets', 'cycle.signal')
}

let pollTimer: ReturnType<typeof setInterval> | undefined

function startFocusSignalPolling(): void {
  if (pollTimer !== undefined) return
  pollTimer = setInterval(() => {
    try {
      const signalPath = cycleSignalFile()
      if (!existsSync(signalPath)) return
      const content = readFileSync(signalPath, 'utf8').trim()
      rmSync(signalPath, { force: true })
      if (content === 'next') {
        cycleWidgetFocus()
        flushWidgetFile()
      }
    } catch {
      /* polling must never touch the run */
    }
  }, 400)
  pollTimer.unref?.()
}

function stopFocusSignalPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

/** The widget lines file: `$DSH_HOME/tui-widgets/dsh-workflow.lines`. */
export function widgetFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'tui-widgets', 'dsh-workflow.lines')
}

let clearTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Write the current mini lines into the widget file — the generic file seam
 * (@aiwayds/dsh-tui-pi renders every `$DSH_HOME/tui-widgets/*.lines`; the
 * writer owns content and timing, the reader is a dumb line renderer).
 * Best-effort on every leg. Called from the command path on every
 * run/step state change; a settled run schedules one final clear after the
 * grace window so a finished workflow does not linger forever.
 */
export function flushWidgetFile(now = Date.now()): void {
  const lines = renderMini(500, now)
  // Cycle-signal polling lives only while a run is active.
  if (snapshotWidgetRuns(now).some((run) => run.status === 'running')) startFocusSignalPolling()
  else stopFocusSignalPolling()
  try {
    mkdirSync(dirname(widgetFile()), { recursive: true })
    if (lines.length === 0) rmSync(widgetFile(), { force: true })
    else writeFileSync(widgetFile(), `${lines.join('\n')}\n`)
    // Seed the personal workflow library with the bundled examples (idempotent:
    // existing files are never overwritten — the library is user-owned).
    try {
      const libDir = join(dirname(widgetFile()), '..', 'workflows')
      mkdirSync(libDir, { recursive: true })
      const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url))
      for (const example of ['fan.workflow.yaml', 'dsh-plugin-wave.workflow.yaml']) {
        const target = join(libDir, example)
        if (!existsSync(target)) copyFileSync(join(examplesDir, example), target)
      }
    } catch {
      /* seeding is a convenience, never a requirement */
    }
    // The overlay manifest: points the tui's generic driver at this package's
    // state machine (absolute path — a bare specifier would resolve from the
    // importer's node_modules, which does not contain this package).
    const overlayPath = fileURLToPath(import.meta.url).replace('tui-widget.js', 'tui-overlay.js')
    writeFileSync(join(dirname(widgetFile()), 'manifest.json'), `${JSON.stringify({
      module: overlayPath,
      exportName: 'buildOverlay',
    })}\n`)
  } catch {
    /* presence must never touch the run */
  }
  const hasVisibleSettled = snapshotWidgetRuns().some((run) => run.settledAt !== undefined)
  const anyRunning = snapshotWidgetRuns().some((run) => run.status === 'running')
  if (hasVisibleSettled && !anyRunning) {
    if (clearTimer !== undefined) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => {
      clearTimer = undefined
      flushWidgetFile()
    }, WIDGET_GRACE_MS + 500)
    clearTimer.unref?.()
  } else if (clearTimer !== undefined && anyRunning) {
    clearTimeout(clearTimer)
    clearTimer = undefined
  }
}

/** Test escape hatch: drop the pending clear timer. */
export function cancelWidgetClearTimer(): void {
  if (clearTimer !== undefined) clearTimeout(clearTimer)
  clearTimer = undefined
}
