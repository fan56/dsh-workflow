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
  en: { workflow: 'workflow', ungrouped: 'ungrouped', live: 'live', confirm: 'confirm', steps: 'steps' },
  zh: { workflow: '工作流', ungrouped: '未分组', live: '进行中', confirm: '需确认', steps: '步' },
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

interface TreeRow {
  text: string
  depth: number
  running: boolean
  status: string
  stepId?: string
}

/**
 * Render the panel — the timeline view (web workflow-run node 的终端翻译):
 * a summary header row, then the step tree with status dots, per-step agent
 * counts, foreach expansions and the RUNNING step centered in the window.
 * 7 content rows per the user's spec.
 */
export function renderMini(width: number, now = Date.now()): string[] {
  const runs = snapshotWidgetRuns(now)
  const run = pickFocusedRun(runs)
  if (run === undefined) return []
  if (focusMode !== 'auto' && !runs.some((r) => r.runId === keyOf(run))) focusMode = 'auto'

  const statuses = [...run.steps.values()]
  const totalSteps = statuses.length
  const doneSteps = statuses.filter((s) => s.status === 'completed' || s.status === 'skipped').length
  const failed = statuses.filter((s) => s.status === 'failed').length
  const tokens = statuses.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  const live = statuses.filter((s) => s.status === 'running').length
  const liveChildren = statuses.reduce((sum, s) => sum + (s.children ?? 0), 0)

  const t = LABELS[overlayLocale]
  const runIcon = RUN_ICON[run.status]

  // ---- Header row: summary ----
  const headerLeft = `${run.name}`
  const headerRight = `${runIcon} ${doneSteps}/${totalSteps} ${t.steps ?? 'steps'} · ${fmtTokens(tokens)} tok`
  const header = joinRow(headerLeft, headerRight, width)

  // ---- 链式横排 + 正在执行的 stage 居中 ----
  // 根步骤一行横排、──▶ 串联；正在执行（或失败）的 stage 居中放大，
  // 四件套各占一行 └─ 竖排；结束即收起，自动切到下一个。
  const roots = run.stepIds.filter((id) => !id.includes('#'))
  const glyphOf = (id: string): string => {
    const st = run.steps.get(id)?.status ?? 'pending'
    return st === 'completed' ? '✓' : st === 'running' ? '▶' : st === 'failed' ? '✗' : st === 'skipped' ? '↷' : '·'
  }
  const stepName = (id: string): string => (id.includes('#') ? id.split('#')[1]! : id)
  const chainSegs = roots.map((id) => `${glyphOf(id)}${stepName(id)}`)
  // 链行按步边界贪心折行（超出宽度就换行续排）
  const chainRows: string[] = []
  let cur = ''
  for (const s of chainSegs) {
    const piece = cur === '' ? s : `${cur} ──▶ ${s}`
    if (visibleWidth(piece) > width - 4 && cur !== '') {
      chainRows.push(cur)
      cur = s
    } else {
      cur = piece
    }
  }
  if (cur !== '') chainRows.push(cur)

  const runningId = roots.find((id) => run.steps.get(id)?.status === 'running')
  const failedId = roots.find((id) => run.steps.get(id)?.status === 'failed')
  const focusId = runningId ?? failedId
  const focusStep = focusId !== undefined ? run.steps.get(focusId) : undefined
  const statParts = stepStatParts(focusStep, now)

  // ---- 组装 7 行 ----
  const lines: string[] = []
  lines.push(joinRow(`${run.name}  ${runIcon} ${run.status === 'running' ? `${live} ${t.live}` : `${doneSteps}/${totalSteps}`}`, `${fmtTokens(tokens)} tok`, width))
  for (const row of chainRows) lines.push(joinRow(row, '', width))
  // 正在执行的 stage：四件套 └─ 竖排（链行里 ▶ 已标执行位，名字不重复画），
  // 整块水平居中。
  if (focusId !== undefined) {
    const blockRows = statParts.length
    const used = chainRows.length
    const leftover = Math.max(0, PANEL_ROWS - used - blockRows)
    for (let i = 0; i < Math.floor(leftover / 2); i++) lines.push(joinRow('', '', width))
    const blockWidth = Math.max(...statParts.map((part) => visibleWidth(`└─ ${part}`)), 1)
    const blockPad = Math.max(0, Math.floor((width - blockWidth) / 2))
    for (const part of statParts) lines.push(joinRow(' '.repeat(blockPad) + `└─ ${part}`, '', width))
  }
  const footer = runs.length > 1
    ? `Alt+W ${overlayLocale === 'zh' ? '切换' : 'cycle'} (${runs.findIndex((r) => r.runId === run.runId) + 1}/${runs.length}) · ←→ pan · Ctrl+K`
    : 'Ctrl+K tree'
  lines.push(joinRow(footer, '', width))
  return lines
}

function topIdsFromRun(run: WidgetRunState): string[] {
  return run.stepIds.filter((id) => !id.includes('#'))
}

function isForeachShape(id: string): boolean {
  return id.includes('#')
}

/** 紧凑数字:1_500_000→`1.5m`,20_965→`20k`,999→`999`。 */
function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')}m`
  }
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`
  return String(n)
}

/** 正在执行的 stage 四件套（每项独占一行 └─）。 */
function stepStatParts(
  step: { status: string; totalTokens?: number; startedAt?: number; endedAt?: number; rounds?: number; toolCalls?: number } | undefined,
  now: number,
): string[] {
  if (step === undefined) return []
  const parts: string[] = []
  const end = step.endedAt ?? (step.status === 'running' ? now : undefined)
  if (step.startedAt !== undefined && end !== undefined) {
    const secs = Math.max(1, Math.round((end - step.startedAt) / 1000))
    parts.push(secs >= 3600 ? `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m` : secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`)
  }
  if (step.rounds !== undefined) parts.push(`${step.rounds}轮`)
  if (step.toolCalls !== undefined) parts.push(`${step.toolCalls}调`)
  if (step.totalTokens !== undefined) parts.push(`${fmtCompact(step.totalTokens)}t`)
  return parts
}

/** 左文本 + 右对齐右段(可见宽计算,CJK 安全)。 */
function joinRow(left: string, right: string, width: number): string {
  const inner = Math.max(width - 2, 20)
  const leftClipped = clip(left, Math.max(8, inner - visibleWidth(right) - 2))
  const pad = Math.max(1, inner - visibleWidth(leftClipped) - visibleWidth(right))
  return `${leftClipped}${' '.repeat(pad)}${right}`
}

function frame(body: string[], width: number): string[] {
  const inner = Math.max(width - 2, 20)
  // body[0] is the full title row (left identity + right live count, joined
  // by renderMini) — visible-width clip to the inner width (CJK counts
  // double), then pad, so the row is exactly the inner width.
  const titleRow = padVisible(clip(body[0] ?? '', inner), inner)
  const framed: string[] = [`╭─ ${titleRow} ─╮`]
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
  return join(home, 'tui-widgets', `dsh-workflow.${process.pid}.cycle.signal`)
}

let pollTimer: ReturnType<typeof setInterval> | undefined

/** The widget lines file: `$DSH_HOME/tui-widgets/dsh-workflow.lines`. */
export function widgetFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'tui-widgets', `dsh-workflow.${process.pid}.lines`)
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
