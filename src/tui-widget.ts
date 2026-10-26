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

const RUN_ICON: Record<WidgetRunState['status'], string> = { running: '▶', completed: '✅', failed: '✗' }

/** Step-level icons (superset of the run icons — pending/skipped steps render too). */
const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '▶',
  completed: '✅',
  failed: '✗',
  skipped: '⏭',
}

/**
 * Which run the widget shows. `auto` = oldest running run (falls back to
 * the oldest visible); a numeric focus pins a specific run until cycling
 * changes it. The tui's cycle hotkey writes "next" into the focus signal
 * file; the widget applies it on its next frame (state is this module's).
 */
let focusMode: 'auto' | number = 'auto'

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
}

/** Content row budget of the panel (the user's spec: 7 lines). */
const PANEL_ROWS = 7

/**
 * Render the panel — ONE focused run per frame (auto = oldest running),
 * drawn as a boxed panel pinned above the input: fixed 7 content rows,
 * the RUNNING step kept centered in the step window, hotkeys on the
 * footer row. The lines file carries the whole framed panel.
 */
export function renderMini(width: number, now = Date.now()): string[] {
  const runs = snapshotWidgetRuns(now)
  const run = pickFocusedRun(runs)
  if (run === undefined) return []
  if (focusMode !== 'auto' && !runs.some((r) => r.runId === keyOf(run))) focusMode = 'auto'

  const statuses = [...run.steps.values()]
  const stepIds = [...run.steps.keys()]
  const completed = statuses.filter((s) => s.status === 'completed').length
  const failed = statuses.filter((s) => s.status === 'failed').length
  const tokens = statuses.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)

  const icon = RUN_ICON[run.status]
  // Title row.
  const titleBits = [`workflow: ${run.name}`, `${icon} ${completed}/${statuses.length}`]
  if (failed > 0) titleBits.push(`✗${failed}`)
  titleBits.push(`· ${fmtTokens(tokens)} tok`)
  if (runs.length > 1) {
    const idx = runs.findIndex((r) => r.runId === run.runId)
    titleBits.push(`run ${idx + 1}/${runs.length}`)
  }
  const title = titleBits.join('  ')

  // Step window: PANEL_ROWS - 2 (title + hotkey footer) rows, the RUNNING
  // step kept centered — "执行的任务永远在中间". The `… earlier` / `… more`
  // markers CONSUME window rows (they are part of the 7-line budget).
  const stepBudget = PANEL_ROWS - 2
  const runningIdx = stepIds.findIndex((id) => run.steps.get(id)?.status === 'running')
  let windowStart: number
  if (stepIds.length <= stepBudget) windowStart = 0
  else if (runningIdx >= 0) windowStart = Math.min(Math.max(0, runningIdx - Math.floor(stepBudget / 2)), stepIds.length - stepBudget)
  else windowStart = Math.max(0, stepIds.length - stepBudget)
  const windowed = stepIds.slice(windowStart, windowStart + stepBudget)

  // Body lines: title + step rows (+ markers inside the step budget) + hotkey.
  const bodyLines: string[] = [title]
  if (windowStart > 0) bodyLines.push(`  … ${windowStart} earlier`)
  for (const id of windowed) {
    if (bodyLines.length >= PANEL_ROWS - 1) break
    const st = run.steps.get(id)!
    const icon = STATUS_ICON[st.status === 'running' ? 'running' : st.status]
    const bits = [`${icon} ${id}`]
    if (st.totalTokens !== undefined) bits.push(`${fmtTokens(st.totalTokens)} tok`)
    bodyLines.push(clip(`  ${bits.join('  ')}`, Math.max(width - 4, 20)))
  }
  if (windowStart + stepBudget < stepIds.length) {
    if (bodyLines.length >= PANEL_ROWS - 1) bodyLines.pop()
    bodyLines.push(`  … ${stepIds.length - windowStart - stepBudget} more`)
  }
  const hotkeys = runs.length > 1 ? 'Alt+W 切换 run · Ctrl+K 树' : 'Ctrl+K 树'
  bodyLines.push(hotkeys)

  // Frame to width.
  const inner = Math.max(width - 2, 20)
  const framed: string[] = []
  framed.push(clip(`╭─ ${bodyLines[0]!.trim()} `, inner).replace(/([^─])$/, '$1─') + '╮')
  for (const line of bodyLines.slice(1)) {
    framed.push(`│ ${clip(line, inner - 2).padEnd(inner - 2)} │`)
  }
  framed.push(`╰${'─'.repeat(inner - 2)}╯`)
  return framed
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

function donePart(status: WidgetRunState['status'], total: number, completed: number, failed: number, running: number): string {
  if (status !== 'running') return `${completed}/${total}`
  const bits = [`${completed}/${total}`]
  if (running > 0) bits.push(`▶${running}`)
  if (failed > 0) bits.push(`✗${failed}`)
  return bits.join(' ')
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
