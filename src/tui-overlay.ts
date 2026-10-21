/**
 * The workflow overlay state machine — the tree/segment renderer and
 * keyboard model behind the tui's Graph mode (ticket 07 Design v2/v3).
 *
 * OWNERSHIP: all rendering logic lives in this package. The tui side is a
 * generic driver: it detects the overlay manifest, imports this module, and
 * only pumps keyboard events and slices the viewport. Pure logic, no pi-tui,
 * fully unit-testable.
 *
 * The view is a TREE; execution remains the needs-DAG. Each step hangs off
 * its primary parent (needs[0]); steps without a parent hang off the root;
 * foreach children are natural tree children (`<id>#<index>`). Extra
 * dependencies degrade to a row annotation. Phases (when declared) split
 * the tree into powerline-style segment tabs, symbol-only, arrows pointing
 * right; steps without a phase land in the trailing ungrouped segment.
 *
 * @module @aiwayds/dsh-workflow/tui-overlay
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflow } from './loader.ts'
import { isForeachStep, type ForeachStepDef, type StepDef, type WorkflowDef } from './types.ts'

export type OverlayStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface OverlayNode {
  id: string
  label: string
  status: OverlayStatus
  tokens?: number
  error?: string
  attempts?: number
  replayed?: boolean
  confirm?: boolean
  /** Foreach aggregate: completed/total children. */
  foreach?: { done: number; total: number }
  children: OverlayNode[]
  collapsed?: boolean
  /** Phase annotation copied from the step definition (segment grouping). */
  phase?: string
}

export interface OverlaySegment {
  title: string
  status: 'done' | 'active' | 'failed' | 'pending'
  done: number
  total: number
  /** The segment's member nodes (primary-parent hanging is irrelevant here). */
  members: OverlayNode[]
}

const STATUS_ICON: Record<OverlayStatus, string> = {
  pending: '○',
  running: '▶',
  completed: '✅',
  failed: '✗',
  skipped: '⏭',
}

const LABELS = {
  en: { workflow: 'workflow', ungrouped: 'ungrouped', confirm: 'confirm', replayed: 'replayed' },
  zh: { workflow: '工作流', ungrouped: '未分组', confirm: '需确认', replayed: '重放' },
} as const

export type OverlayLocale = keyof typeof LABELS

/**
 * Build the overlay from a run directory (`workflow.yaml` snapshot for the
 * definition + `run.json` for the live state). Returns null when the
 * snapshot is missing or unparsable — the driver then shows nothing.
 */
export function buildOverlay(runDir: string, locale: OverlayLocale = 'en'): WorkflowOverlay | null {
  let workflow: WorkflowDef
  let steps: Record<string, { status: string; attempts?: number; error?: string; usage?: { totalTokens?: number } }>
  let runStatus: string
  try {
    const yamlText = readFileSync(join(runDir, 'workflow.yaml'), 'utf8')
    // No filePath: the name/stem interlock is for user-edited files — the
    // snapshot always lives at workflow.yaml.
    workflow = loadWorkflow(yamlText).workflow
    const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>
    runStatus = typeof meta['status'] === 'string' ? meta['status'] : 'running'
    steps = {}
    const rawSteps = (meta['steps'] ?? {}) as Record<string, Record<string, unknown>>
    for (const [id, raw] of Object.entries(rawSteps)) {
      const usage = (raw['usage'] ?? undefined) as { totalTokens?: number } | undefined
      steps[id] = {
        status: typeof raw['status'] === 'string' ? raw['status'] : 'pending',
        attempts: typeof raw['attempts'] === 'number' ? raw['attempts'] : undefined,
        ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
        ...(usage !== undefined && typeof usage.totalTokens === 'number' ? { usage } : {}),
      }
    }
  } catch {
    return null
  }

  const stateOf = (id: string): OverlayStatus => {
    const raw = steps[id]?.status
    if (raw === 'completed' || raw === 'failed' || raw === 'skipped') return raw
    if (raw === 'running') return 'running'
    return 'pending'
  }

  const statusRank: Record<OverlayStatus, number> = { completed: 0, skipped: 1, pending: 2, running: 3, failed: 4 }

  // Tree assembly: primary-parent hanging (needs[0]), foreach aggregates children.
  const nodes = new Map<string, OverlayNode>()
  const root: OverlayNode = {
    id: '(root)',
    label: `${LABELS[locale].workflow}: ${workflow.name}`,
    status: runStatus === 'completed' ? 'completed' : runStatus === 'failed' ? 'failed' : 'running',
    children: [],
  }
  const toNode = (def: StepDef): OverlayNode => {
    const state = stateOf(def.id)
    const node: OverlayNode = {
      id: def.id,
      label: def.id,
      status: state,
      children: [],
      ...(def.confirm === true ? { confirm: true } : {}),
      ...(steps[def.id]?.attempts !== undefined ? { attempts: steps[def.id]!.attempts } : {}),
      ...(steps[def.id]?.error !== undefined ? { error: steps[def.id]!.error } : {}),
      ...(steps[def.id]?.usage !== undefined ? { tokens: steps[def.id]!.usage!.totalTokens } : {}),
      ...(def.phase !== undefined ? { phase: def.phase } : {}),
    }
    return node
  }
  for (const def of workflow.steps) {
    if (isForeachStep(def)) {
      // The aggregate node carries the foreach def's id/phase only — children
      // come from the run state, never from the template.
      const node: OverlayNode = {
        id: def.id,
        label: def.id,
        status: stateOf(def.id),
        children: [],
      }
      // Foreach children: every `<id>#<index>` in the run state.
      const childIds = Object.keys(steps).filter((id) => id.startsWith(`${def.id}#`)).sort((a, b) => Number(a.split('#')[1]) - Number(b.split('#')[1]))
      let done = 0
      for (const childId of childIds) {
        const childState = steps[childId]!
        const child: OverlayNode = {
          id: childId,
          label: childId,
          status: stateOf(childId),
          children: [],
          ...(childState.attempts !== undefined ? { attempts: childState.attempts } : {}),
          ...(childState.error !== undefined ? { error: childState.error } : {}),
          ...(childState.usage !== undefined ? { tokens: childState.usage!.totalTokens } : {}),
        }
        if (child.status === 'completed') done += 1
        node.children.push(child)
      }
      node.foreach = { done, total: childIds.length }
      nodes.set(def.id, node)
      continue
    }
    nodes.set(def.id, toNode(def))
  }
  // The primary-parent DAG stays in the DEFINITION for execution; the tree
  // view deliberately does NOT consume it — parents usually live in an
  // earlier phase, and drawing the parent edges would drag cross-phase steps
  // into every segment (real-test verified: adapt/verify appeared twice).
  // Extra dependencies degrade to a row annotation instead.
  for (const def of workflow.steps) {
    const node = nodes.get(def.id)!
    if ((def.needs?.length ?? 0) > 1) node.label = `${node.label} ⤷+${(def.needs!.length - 1)}`
  }

  // Phase segments: declared order wins; undeclared steps land in the
  // trailing ungrouped segment; no declaration = a single implicit segment.
  const declared = workflow.phases ?? []
  const phaseOfDef = (stepId: string): string | undefined => {
    const def = workflow.steps.find((d) => d.id === stepId)
    return def !== undefined && 'phase' in def && typeof (def as { phase?: string }).phase === 'string' ? (def as { phase: string }).phase : undefined
  }
  const segmentOf = (node: OverlayNode): string => {
    const phase = phaseOfDef(node.id)
    if (phase !== undefined && phase !== '') return phase
    return declared.length > 0 ? LABELS[locale].ungrouped : ''
  }
  const phaseTitles = declared.length > 0 ? [...declared, ...(nodes.size > 0 && declared.length > 0 ? [LABELS[locale].ungrouped] : [])] : ['']
  const segments: OverlaySegment[] = phaseTitles.map((title) => ({ title: title === '' ? workflow.name : title, status: 'pending', done: 0, total: 0, members: [] }))

  // Segment status/counts roll up from their steps (foreach aggregates as one).
  for (const def of workflow.steps) {
    const node = nodes.get(def.id)!
    const seg = segments.find((s) => s.title === segmentOf(node))
    if (seg === undefined) continue
    seg.members.push(node)
    seg.total += 1
    if (node.status === 'completed') seg.done += 1
    // Segment rank: failed > active > done > pending (no plain-status mixing).
    const segRank: Record<string, number> = { pending: 0, done: 1, active: 2, failed: 3 }
    if (node.status === 'running' && segRank['active'] > (segRank[seg.status] ?? 0)) seg.status = 'active'
    if (node.status === 'failed') seg.status = 'failed'
    if (node.status === 'completed' && seg.status === 'pending') seg.status = 'done'
  }
  if (declared.length > 0 && segments.at(-1)!.total === 0) segments.pop() // empty ungrouped segment hides itself

  return new WorkflowOverlay(root, segments, locale)
}

export class WorkflowOverlay {
  private activePhase = 0
  private scrollOffsets: number[] = []
  private follow = true
  private collapsed = new Set<string>()

  private readonly root: OverlayNode
  private readonly segments: OverlaySegment[]
  private readonly locale: OverlayLocale

  constructor(root: OverlayNode, segments: OverlaySegment[], locale: OverlayLocale) {
    this.root = root
    this.segments = segments
    this.locale = locale
    this.scrollOffsets = this.segments.map(() => 0)
    // Land on the first active segment.
    this.activePhase = Math.max(0, this.segments.findIndex((s) => s.status === 'active'))
  }

  title(): string {
    const t = LABELS[this.locale]
    const counts = this.countAll()
    return `${t.workflow}: ${this.root.label.replace(`${t.workflow}: `, '')}`
      + `  ${this.root.status === 'running' ? '▶' : this.root.status === 'completed' ? '✅' : '✗'}`
      + ` · ${counts.completed}/${counts.total} · ${counts.tokens} tok`
  }

  /** The powerline segment row: ` 情报 ✅ ▶ 审计 ✅ ▶ 适配 ▶2/3 ▶ 验证 ▶ 发版 `. */
  segmentsRow(): string {
    if (this.segments.length <= 1 && this.segments[0]?.title === this.root.label.split(': ').at(-1)) return ''
    return this.segments
      .map((seg) => {
        const icon = seg.status === 'done' ? '✅' : seg.status === 'active' ? '▶' : seg.status === 'failed' ? '✗' : '○'
        const counts = seg.status === 'active' && seg.total > 0 ? `▶${seg.done}/${seg.total}` : seg.status === 'done' ? '✅' : ''
        return `${seg.title}${counts !== '' ? ` ${counts}` : icon === '○' ? '' : ` ${icon}`}`
      })
      .join(' ▶ ')
  }

  /** Total rendered line count for the active segment (the driver's viewport budget). */
  lineCount(width: number): number {
    return this.renderLines(width).length
  }

  /** Render one viewport line (the driver calls this per visible row). */
  renderLine(index: number, width: number): string {
    return this.renderLines(width)[index] ?? ''
  }

  /**
   * Keyboard model. Returns 'handled' for keys the overlay consumed,
   * 'passthrough' for quit-style keys the driver should handle.
   */
  onKey(key: string): 'handled' | 'passthrough' {
    const lineCount = this.currentLines.length
    switch (key) {
      case 'up':
        this.scrollOffsets[this.activePhase] = Math.max(0, this.scrollOffsets[this.activePhase]! - 1)
        this.follow = false
        return 'handled'
      case 'down':
        this.scrollOffsets[this.activePhase] = Math.min(Math.max(0, lineCount - 1), this.scrollOffsets[this.activePhase]! + 1)
        this.follow = false
        return 'handled'
      case 'left': {
        // Collapse the running node's subtree (or the scrolled-to node).
        const target = this.runningNode() ?? this.firstPending()
        if (target !== undefined) this.collapsed.add(target.id)
        return 'handled'
      }
      case 'right': {
        const target = this.runningNode() ?? this.firstPending()
        if (target !== undefined) this.collapsed.delete(target.id)
        return 'handled'
      }
      case 'tab':
        this.activePhase = Math.min(this.segments.length - 1, this.activePhase + 1)
        this.follow = false
        return 'handled'
      case 'shift+tab':
        this.activePhase = Math.max(0, this.activePhase - 1)
        this.follow = false
        return 'handled'
      case 'f':
        this.follow = !this.follow
        return 'handled'
      case 'q':
      case 'escape':
        return 'passthrough'
      default:
        return 'passthrough'
    }
  }

  /** Scroll offset the driver should use for the active segment. */
  scrollOffset(): number {
    if (this.follow) {
      const index = this.currentLines.findIndex((line) => line.includes('▶'))
      if (index >= 0) this.scrollOffsets[this.activePhase] = Math.max(0, index - 2)
    }
    return this.scrollOffsets[this.activePhase] ?? 0
  }

  private currentLines: string[] = []

  private phaseOf(stepId: string): string {
    const node = this.root.children.find((c) => c.id === stepId)
    return node?.phase ?? (this.segments.length === 1 ? this.segments[0]!.title : LABELS[this.locale].ungrouped)
  }

  private activeSegmentTitle(): string {
    return this.segments[this.activePhase]?.title ?? ''
  }

  private formatNode(node: OverlayNode): string {
    const icon = STATUS_ICON[node.status]
    const bits = [`${icon} ${node.label}`]
    if (node.foreach !== undefined) bits.push(`▦ ${node.foreach.done}/${node.foreach.total}`)
    if (node.confirm === true) bits.push('?')
    if (node.replayed === true) bits.push('↻')
    if (node.tokens !== undefined) bits.push(`${node.tokens} tok`)
    if (node.error !== undefined) bits.push(`✗ ${node.error.slice(0, 60)}`)
    return bits.join('  ')
  }

  /** Render the active segment's tree lines (private; drivers use lineCount/renderLine). */
  private renderLines(width: number): string[] {
    void width
    const seg = this.segments[this.activePhase]!
    const lines: string[] = []
    // Segment members were resolved at build time (by each step's phase
    // annotation — NOT by tree position, since primary-parent hanging nests
    // steps from different phases inside each other). Needs parents are
    // execution semantics and deliberately not drawn.
    const members = seg.members
    const last = members.at(-1)
    for (const member of members) {
      this.pushMember(lines, member, '', member === last)
    }
    this.currentLines = lines
    const offset = Math.min(this.scrollOffsets[this.activePhase] ?? 0, Math.max(0, lines.length - 1))
    return lines.slice(offset)
  }

  private pushMember(lines: string[], member: OverlayNode, prefix: string, isLast: boolean): void {
    lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${this.formatNode(member)}`)
    if (this.collapsed.has(member.id)) {
      if (member.children.length > 0) lines.push(`${prefix}${isLast ? '   ' : '│  '}└─ … ${member.children.length} hidden`)
      return
    }
    const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`
    const last = member.children.at(-1)
    for (const child of member.children) {
      this.pushChild(lines, child, childPrefix, child === last)
    }
  }

  private pushChild(lines: string[], child: OverlayNode, prefix: string, isLast: boolean): void {
    lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${this.formatNode(child)}`)
    // Foreach children have no deeper levels today.
  }

  private findNode(predicate: (n: OverlayNode) => boolean): OverlayNode | undefined {
    for (const seg of this.segments) {
      for (const member of seg.members) {
        if (predicate(member)) return member
        for (const child of member.children) {
          if (predicate(child)) return child
        }
      }
    }
    return undefined
  }

  private runningNode(): OverlayNode | undefined {
    return this.findNode((n) => n.status === 'running')
  }

  private firstPending(): OverlayNode | undefined {
    return this.findNode((n) => n.status === 'pending')
  }

  private countAll(): { completed: number; total: number; tokens: number } {
    let completed = 0
    let total = 0
    let tokens = 0
    for (const seg of this.segments) {
      for (const member of seg.members) {
        total += 1
        if (member.status === 'completed' || member.status === 'skipped') completed += 1
        tokens += member.tokens ?? 0
        // Foreach children are NOT counted at the top level — the aggregate
        // member already represents them (its foreach.done/total carries the
        // split); only their token cost rolls up.
        for (const child of member.children) {
          tokens += child.tokens ?? 0
        }
      }
    }
    return { completed, total, tokens }
  }
}

/** Whether a run directory has an overlay-able snapshot (driver fast check). */
export function hasOverlaySnapshot(runDir: string): boolean {
  return existsSync(join(runDir, 'workflow.yaml')) && existsSync(join(runDir, 'run.json'))
}
