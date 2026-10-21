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

/** Structural view of the seam this module detects and registers into. */
interface TuiWidgetsSeam {
  register(widget: { id: string; render(width: number): string[] }): unknown
}

/**
 * Detect the generic widget seam and register this plugin's widget.
 * Absent seam (no tui-pi installed) = a silent no-op: the command family
 * is the product, the widget is presence, never a requirement.
 */
export function installTuiWidget(context: unknown): void {
  try {
    const widgets = (context as { tuiWidgets?: TuiWidgetsSeam }).tuiWidgets
    if (widgets === undefined || typeof widgets.register !== 'function') return
    widgets.register({ id: 'dsh-workflow', render: (width: number) => renderMini(width) })
  } catch {
    /* presence must never break plugin load */
  }
}
