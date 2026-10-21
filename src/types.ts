/**
 * The workflow definition vocabulary — the TypeScript mirror of YAML schema v1.
 *
 * These types describe what the LOADER accepts from a `.workflow.yaml` file.
 * Keys that exist on the wire use their YAML spelling (kebab-case) so the
 * loader can validate the parsed document directly against these shapes.
 *
 * @module @aiwayds/dsh-workflow/types
 */

/** The literal format tag every workflow file must carry. */
export const WORKFLOW_FORMAT = 'dsh-workflow'

/** The schema version this plugin understands. A mismatch is a load error. */
export const WORKFLOW_VERSION = 1

/** Kebab-case identifier: workflow names and step ids. */
export const KEBAB_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** An input parameter declaration. */
export interface WorkflowInputDecl {
  id: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  default?: string | number | boolean
  description?: string
}

/** Which roster agent runs a step, plus optional runtime overrides. */
export interface ExecutorSpec {
  /** File-identity `name` of a `~/.dsh/agents/<name>.md` roster definition. */
  agent: string
  /** Optional runtime model route override (`provider/model`); never writes back. */
  model?: string
  /** Optional reasoning-effort override (one of the roster's thinking levels). */
  thinking?: string
}

/** Retry policy for an ordinary child failure. */
export interface RetrySpec {
  /** Total attempts per step = 1 + max retries. Must be a positive integer. */
  max: number
  /** Backoff between attempts in milliseconds (default 0). */
  'backoff-ms'?: number
}

/** One postcondition on a step's textual output. */
export interface AcceptanceRule {
  /** The output must match this regex. A leading `(?i)` enables case-insensitivity. */
  'output-matches'?: string
  /** The output must contain this substring. */
  'output-contains'?: string
}

/** A plain (non-foreach) step: one roster agent runs one prompt. */
export interface StepDef {
  id: string
  executor: ExecutorSpec
  /** Prompt template; `{{inputs.*}}` / `{{steps.<id>.output…}}` references resolve at run time. */
  prompt: string
  /** DAG edges: steps that must complete (status `completed`) before this one runs. */
  needs?: string[]
  retry?: RetrySpec
  /** What a failed step does to the run: fail it, skip it, or continue past it. */
  'on-error'?: 'fail' | 'skip' | 'continue'
  /**
   * Resume behavior (checkpointing lands in M3; validated from M1):
   * `always` replays a completed result, `on-failure` re-runs only after
   * failure, `never` always truly re-runs (mandatory for outward-facing steps).
   */
  cache?: 'always' | 'on-failure' | 'never'
  /** Ask the user once before dispatching an outward-facing action. */
  confirm?: boolean
  /** Optional object-root JSON Schema subset for a structured result. */
  output?: Record<string, unknown>
  /** Postconditions checked against the textual output. */
  acceptance?: AcceptanceRule[]
  /**
   * Pure input-shaping JS: `(input) => json`, merged into the prompt context
   * as `{{<step-id>.action-output}}`. No I/O, no shared state between steps —
   * the dual-track boundary. Authored by the workflow owner; runs in-process.
   */
  action?: string
  /**
   * Pure annotation (schema v1.1): which phase tab this step belongs to in
   * the tui visualization. No execution semantics. When the workflow declares
   * top-level `phases`, the value MUST match one of them (fail-loud — a
   * typo'd phase name is an authoring error).
   */
  phase?: string
}

/** A foreach step: fan out one templated child step per item of an upstream array. */
export interface ForeachStepDef {
  id: string
  needs?: string[]
  'on-error'?: 'fail' | 'skip' | 'continue'
  cache?: 'always' | 'on-failure' | 'never'
  foreach: {
    /** Reference to an upstream array, e.g. `steps.audit.output.repos`. */
    over: string
    /** The item's name inside the child template (`{{item}}`, `{{item.path}}`). */
    as: string
    /** Workflow-layer concurrency bound; children queue beyond it. Default 4. */
    'max-concurrency'?: number
    /** The template step run per item. Its `id` is forbidden (items are `<id>#<index>`). */
    step: Omit<StepDef, 'id'>
  }
}

/** Any step the loader accepts. */
export type AnyStepDef = StepDef | ForeachStepDef

export function isForeachStep(step: AnyStepDef): step is ForeachStepDef {
  return 'foreach' in step
}

/** A fully validated workflow document. */
export interface WorkflowDef {
  format: typeof WORKFLOW_FORMAT
  version: typeof WORKFLOW_VERSION
  name: string
  description: string
  inputs?: WorkflowInputDecl[]
  /** Optional phase titles in tab order (tui visualization; pure annotation). */
  phases?: string[]
  steps: AnyStepDef[]
}

/** Top-level keys the loader accepts — anything else is a violation. */
export const TOP_LEVEL_KEYS = ['format', 'version', 'name', 'description', 'inputs', 'phases', 'steps'] as const

/** Keys a plain step accepts. */
export const STEP_KEYS = [
  'id', 'executor', 'prompt', 'needs', 'retry', 'on-error', 'cache', 'confirm',
  'output', 'acceptance', 'action', 'phase', 'foreach',
] as const
