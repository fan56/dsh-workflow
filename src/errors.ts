/**
 * Error vocabulary. Everything the loader rejects comes back as one
 * {@link WorkflowLoadError} carrying every violation at once — the model or
 * the author fixes the file in a single pass instead of whack-a-mole.
 *
 * @module @aiwayds/dsh-workflow/errors
 */

/** One concrete problem found while loading a workflow. */
export interface WorkflowViolation {
  /** Dotted path into the document, e.g. `steps.2.executor.agent`. */
  path: string
  message: string
}

/** Thrown when a workflow document fails validation. Fail-loud, never partial. */
export class WorkflowLoadError extends Error {
  readonly violations: WorkflowViolation[]

  constructor(filePath: string, violations: WorkflowViolation[]) {
    const lines = violations.map((v) => `  - ${v.path}: ${v.message}`).join('\n')
    super(`workflow "${filePath}" failed validation with ${violations.length} violation(s):\n${lines}`)
    this.name = 'WorkflowLoadError'
    this.violations = violations
  }
}

/** Thrown at run time for authoring mistakes a static pass cannot see (bad reference targets, action throws). */
export class WorkflowRunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowRunError'
  }
}

/**
 * Thrown when a step's roster agent cannot be resolved at dispatch time.
 * The engine treats this as fail-fast: re-reading a missing file will not
 * heal, so retrying is pure waste (wayfinder ticket 03, two-layer resolution).
 */
export class RosterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RosterError'
  }
}
