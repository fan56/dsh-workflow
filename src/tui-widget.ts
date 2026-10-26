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
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const w = code > 0x2e80 ? 2 : 1
    if (visible + w > width) {
      break
    }
    visible += w
  }
  return text.slice(0, endOfVisible(text, width))
}

function endOfVisible(text: string, width: number): number {
  let visible = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0
    const w = code > 0x2e80 ? 2 : 1
    if (visible + w > width) return i
    visible += w
    if (code > 0xffff) i++
  }
  return text.length
}

/** Visible width (CJK/fullwidth counts double). */
function visibleWidth(text: string): number {
  let visible = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    visible += code > 0x2e80 ? 2 : 1
  }
  return visible
}

/** Visible-width pad (CJK-aware, right border stays flush). */
function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/** Visible-width clip from the LEFT (horizontal pan window). */
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

/** Step-level icons; the running step renders a spinner frame instead. */
function stepIcon(status: string, frame: number): string {
  if (status === 'running') return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  return STATUS_ICON[status] ?? '○'
}

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '▶',
  completed: '✅',
  failed: '✗',
  skipped: '⏭',
}

const RUN_ICON: Record<WidgetRunState['status'], string> = { running: '▶', completed: '✅', failed: '✗' }

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const LABELS = {
  en: { workflow: 'workflow', ungrouped: 'ungrouped', live: 'live', confirm: 'confirm' },
  zh: { workflow: '工作流', ungrouped: '未分组', live: '进行中', confirm: '需确认' },
} as const

export type OverlayLocale = keyof typeof LABELS

let overlayLocale: OverlayLocale = 'en'

/** The widget's label language (the tui passes its active locale at boot). */
export function setWidgetLocale(locale: OverlayLocale): void {
  overlayLocale = locale
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

function fmtTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
  return String(total)
}

function fmtElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${seconds}s`
}

function renderStepLine(run: WidgetRunState, id: string, frame: number): string {
  const step = run.steps.get(id)
  const status = step?.status ?? 'pending'
  const icon = stepIcon(status, frame)
  const bits = [`${icon} ${id}`]
  if (status === 'running') {
    if (step?.children !== undefined && step.children > 0) bits.push(`subagent ×${step.children}`)
    if (step?.startedAt !== undefined) bits.push(fmtElapsed(Date.now() - step.startedAt))
  } else {
    if (step?.totalTokens !== undefined) bits.push(`${fmtTokens(step.totalTokens)} tok`)
    if (step?.children !== undefined && step.children > 0) bits.push(`⧉ ${step.children}`)
  }
  return bits.join('  ')
}

let focusMode: 'auto' | number = 'auto'
let spinnerFrame = 0

export function cycleWidgetFocus(now = Date.now()): void {
  const runs = snapshotWidgetRuns(now)
  if (runs.length < 2) return
  if (focusMode === 'auto') focusMode = 0
  else focusMode = (focusMode + 1) % runs.length
  flushWidgetFile(now)
}

export function resetWidgetFocus(): void {
  focusMode = 'auto'
}

/** Content row budget of the panel (the user's spec: 7 lines). */
const PANEL_ROWS = 7

/**
 * Render the panel — ONE focused run per frame (auto = oldest running),
 * drawn as a boxed todos-style panel pinned above the input: 7 content
 * rows (title + tree window + hotkey footer), the RUNNING step kept
 * centered, the live subagent count right-aligned in the title, and a
 * spinner on the running marker (the 250ms tick re-renders the file).
 */
export function renderMini(width: number, now = Date.now()): string[] {
  const runs = snapshotWidgetRuns(now)
  const run = pickFocusedRun(runs)
  if (run === undefined) return []
  if (focusMode !== 'auto' && !runs.some((r) => r.runId === keyOf(run))) focusMode = 'auto'

  const statuses = [...run.steps.values()]
  const completed = statuses.filter((s) => s.status === 'completed').length
  const failed = statuses.filter((s) => s.status === 'failed').length
  const tokens = statuses.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  const live = statuses.filter((s) => s.status === 'running').length

  const t = LABELS[overlayLocale]
  const titleLeft = `${t.workflow}: ${run.name}`
  const titleRight = `${RUN_ICON[run.status]} ${live} ${t.live} · ${fmtTokens(tokens)} tok`

  // Tree rows: top-level steps as primary branches, foreach children
  // (<parent>#<index>) nested under their foreach step.
  const rows: string[] = []
  const childMap = new Map<string, string[]>()
  const topIds: string[] = []
  for (const id of run.stepIds) {
    const hashIdx = id.indexOf('#')
    if (hashIdx > 0) {
      const parent = id.slice(0, hashIdx)
      if (!childMap.has(parent)) childMap.set(parent, [])
      childMap.get(parent)!.push(id)
    } else {
      topIds.push(id)
    }
  }
  const stepLine = (id: string): string => renderStepLine(run, id, spinnerFrame)
  topIds.forEach((id, i) => {
    const isLast = i === topIds.length - 1
    rows.push((isLast ? '└─ ' : '├─ ') + stepLine(id))
    const kids = childMap.get(id) ?? []
    kids.forEach((kid, j) => {
      const kidBranch = j === kids.length - 1 ? '└─ ' : '├─ '
      rows.push((isLast ? '   ' : '│  ') + kidBranch + stepLine(kid))
    })
  })

  const hotkeys = runs.length > 1
    ? `${overlayLocale === 'zh' ? 'Alt+W 切换' : 'Alt+W cycle'} · ←→ ${overlayLocale === 'zh' ? '拉动' : 'pan'} · Ctrl+K ${overlayLocale === 'zh' ? '树' : 'tree'}`
    : 'Ctrl+K tree'

  // Body = title + tree window (RUNNING centered) + hotkey footer, within
  // the 7-row budget (markers consume window rows).
  const body: string[] = [`${titleLeft}  ${titleRight}`]
  const budget = PANEL_ROWS - 2
  const runningTreeIdx = rows.findIndex((r) => r.includes('▶ ') || r.includes('⠋') || r.includes('⠙') || r.includes('⠸') || r.includes('⠼') || r.includes('⠴') || r.includes('⠦') || r.includes('⠧') || r.includes('⠇') || r.includes('⠏'))
  let start = 0
  if (rows.length > budget) {
    start = Math.min(Math.max(0, Math.max(0, runningTreeIdx) - Math.floor(budget / 2)), rows.length - budget)
  }
  const windowed = rows.slice(start, start + budget)
  if (start > 0) body.push(`  … ${start} ${overlayLocale === 'zh' ? '更早' : 'earlier'}`)
  body.push(...windowed)
  if (start + budget < rows.length) body.push(`  … ${rows.length - start - budget} more`)
  body.push(hotkeys)

  return frame(body, width, titleRight)
}

function frame(body: string[], width: number, titleRight: string): string[] {
  const inner = Math.max(width - 2, 20)
  // Title sides clip to fit so the top frame never exceeds the width
  // (a 180-visible-width CJK name would otherwise blow the border out).
  const titleLeft = clip(body[0] ?? '', Math.max(8, inner - visibleWidth(titleRight) - 8))
  const fill = Math.max(1, inner - visibleWidth(titleLeft) - visibleWidth(titleRight) - 4)
  const framed: string[] = [`╭─ ${titleLeft} ${'─'.repeat(fill)} ${titleRight} ─╮`]
  for (const line of body.slice(1)) {
    framed.push(`│ ${padVisible(clipLeft(line, hScroll, inner - 2), inner - 2)} │`)
  }
  framed.push(`╰${'─'.repeat(inner - 2)}╯`)
  return framed
}

let hScroll = 0

/**
 * The 250ms activity tick: advances the spinner and re-renders the widget
 * file while a run is active (the animation is file-mtime driven — the
 * tui re-reads on change). Started with the first run; stops after the
 * grace window.
 */
export function startWidgetTicker(): void {
  if (pollTimer !== undefined) return
  pollTimer = setInterval(() => {
    try {
      // Cycle signal first.
      const signalPath = cycleSignalFile()
      if (existsSync(signalPath)) {
        const content = readFileSync(signalPath, 'utf8').trim()
        rmSync(signalPath, { force: true })
        if (content === 'next') {
          cycleWidgetFocus()
          flushWidgetFile()
          return
        }
      }
      const runs = snapshotWidgetRuns()
      if (runs.some((run) => run.status === 'running')) {
        spinnerFrame += 1
        flushWidgetFile()
      } else {
        stopWidgetTicker()
      }
    } catch {
      /* the tick must never touch the run */
    }
  }, 250)
  pollTimer.unref?.()
}

function stopWidgetTicker(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
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
  // The ticker drives the spinner animation and the cycle signal while a
  // run is active; it stops itself after the grace window.
  startWidgetTicker()
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
