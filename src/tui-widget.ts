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

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { snapshotWidgetRuns, type WidgetRunState } from './run-state.ts'

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

/** Render the mini lines (one per visible run) — the seam's contract. */
export function renderMini(width: number, now = Date.now()): string[] {
  const lines: string[] = []
  for (const run of snapshotWidgetRuns(now).slice(0, 3)) {
    const statuses = [...run.steps.values()]
    const completed = statuses.filter((s) => s.status === 'completed').length
    const failed = statuses.filter((s) => s.status === 'failed').length
    const running = statuses.filter((s) => s.status === 'running').length
    const tokens = statuses.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
    const current = [...run.steps.entries()].filter(([, s]) => s.status === 'running').map(([id]) => id).at(-1)
    const parts = [
      `▸ workflow: ${run.name}`,
      `${RUN_ICON[run.status]} ${donePart(run.status, statuses.length, completed, failed, running)}`,
      ...(current !== undefined ? [`▸ ${current}`] : []),
      ...(tokens > 0 ? [`· ${fmtTokens(tokens)} tok`] : []),
    ]
    lines.push(clip(parts.join('  '), Math.max(width, 20)))
  }
  return lines
}

function donePart(status: WidgetRunState['status'], total: number, completed: number, failed: number, running: number): string {
  if (status !== 'running') return `${completed}/${total}`
  const bits = [`${completed}/${total}`]
  if (running > 0) bits.push(`▶${running}`)
  if (failed > 0) bits.push(`✗${failed}`)
  return bits.join(' ')
}

const WIDGET_GRACE_MS = 60_000

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
export function flushWidgetFile(): void {
  const lines = renderMini(500)
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
