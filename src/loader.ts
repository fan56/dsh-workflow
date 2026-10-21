/**
 * YAML workflow loader — the fail-loud gate.
 *
 * Discipline (wayfinder ticket 02): unknown keys are ERRORS, never ignored —
 * schema evolution happens through version bumps, not silent tolerance. Every
 * violation is collected and reported in one pass, so a broken file comes
 * back with its full defect list.
 *
 * Load-time checks are static only: structure, enums, cross-references, and
 * the reference-template scope. The roster existence lint lives here too
 * (advisory at load; run-time re-read stays authoritative — ticket 03).
 *
 * @module @aiwayds/dsh-workflow/loader
 */

import { basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { WorkflowLoadError, type WorkflowViolation } from './errors.ts'
import { extractRefs, refRoot } from './refs.ts'
import { loadRoster } from './roster.ts'
import {
  KEBAB_PATTERN, STEP_KEYS, TOP_LEVEL_KEYS, WORKFLOW_FORMAT, WORKFLOW_VERSION,
  isForeachStep, type AnyStepDef, type ForeachStepDef, type StepDef, type WorkflowDef,
  type WorkflowInputDecl,
} from './types.ts'

export interface LoadOptions {
  /** File path the text came from — enables the name↔file-stem interlock. */
  filePath?: string
  /** When set, every `executor.agent` must exist in this roster (advisory lint). */
  agentsDir?: string
}

export interface LoadSuccess {
  workflow: WorkflowDef
  warnings: string[]
}

const INPUT_TYPES = new Set(['string', 'number', 'boolean'])
const ON_ERROR_VALUES = new Set(['fail', 'skip', 'continue'])
const CACHE_VALUES = new Set(['always', 'on-failure', 'never'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, violations: WorkflowViolation[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) violations.push({ path: `${path}.${key}`, message: `unknown key "${key}" (allowed: ${allowed.join(', ')})` })
  }
}

/** Validate one reference's scope-root against what can legally exist here. */
function checkRefScope(text: string, path: string, violations: WorkflowViolation[], ctx: { stepIds: Set<string>; inputIds: Set<string>; allowItem: boolean }): void {
  for (const ref of extractRefs(text)) {
    const root = refRoot(ref)
    if (root === 'inputs') {
      const rest = ref.slice('inputs.'.length)
      if (rest === '' || !ctx.inputIds.has(rest.split('.')[0]!)) {
        violations.push({ path, message: `reference {{${ref}}} points at an undeclared input` })
      }
    } else if (root === 'steps') {
      const target = ref.split('.')[1]
      if (target === undefined || !ctx.stepIds.has(target)) {
        violations.push({ path, message: `reference {{${ref}}} points at an unknown step` })
      }
    } else if (root === 'item') {
      if (!ctx.allowItem) violations.push({ path, message: `reference {{${ref}}} uses "item" outside a foreach template` })
    } else {
      violations.push({ path, message: `reference {{${ref}}} has an unknown scope root "${root}" (inputs | steps | item)` })
    }
  }
}

/** Static lint of one step body (shared by plain and foreach-template steps). */
function checkStepBody(step: Record<string, unknown>, path: string, violations: WorkflowViolation[], ctx: { stepIds: Set<string>; inputIds: Set<string>; allowItem: boolean }): void {
  const executor = step['executor']
  if (!isPlainObject(executor)) {
    violations.push({ path: `${path}.executor`, message: 'executor is required and must be an object' })
  } else {
    checkUnknownKeys(executor, ['agent', 'model', 'thinking'], `${path}.executor`, violations)
    if (typeof executor['agent'] !== 'string' || executor['agent'] === '') {
      violations.push({ path: `${path}.executor.agent`, message: 'executor.agent is required (a roster agent name)' })
    } else if (!/^[\w-]+$/.test(executor['agent'] as string)) {
      violations.push({ path: `${path}.executor.agent`, message: 'executor.agent must be a bare roster name (no paths, no slashes)' })
    }
    for (const key of ['model', 'thinking'] as const) {
      const value = executor[key]
      if (value !== undefined && typeof value !== 'string') {
        violations.push({ path: `${path}.executor.${key}`, message: 'must be a string' })
      }
    }
  }
  if (typeof step['prompt'] !== 'string' || (step['prompt'] as string).trim() === '') {
    violations.push({ path: `${path}.prompt`, message: 'prompt is required and must be a non-empty string' })
  } else {
    checkRefScope(step['prompt'] as string, `${path}.prompt`, violations, ctx)
  }
  if (step['action'] !== undefined && (typeof step['action'] !== 'string' || step['action'] === '')) {
    violations.push({ path: `${path}.action`, message: 'action must be a non-empty string when present' })
  }
  const output = step['output']
  if (output !== undefined) {
    if (!isPlainObject(output) || output['type'] !== 'object') {
      violations.push({ path: `${path}.output`, message: 'output must be an object-root JSON Schema ({"type": "object", ...})' })
    } else {
      // Host structured capture rejects required names absent from properties —
      // catch it at load (real-host verified failure mode).
      const required = Array.isArray(output['required']) ? (output['required'] as unknown[]) : []
      const properties = isPlainObject(output['properties']) ? (output['properties'] as Record<string, unknown>) : undefined
      for (const name of required) {
        if (properties === undefined || typeof name !== 'string' || !(name in properties)) {
          violations.push({ path: `${path}.output`, message: `required names "${String(name)}" which is not in properties (host schema rule)` })
        }
      }
    }
  }
  const acceptance = step['acceptance']
  if (acceptance !== undefined) {
    if (!Array.isArray(acceptance)) {
      violations.push({ path: `${path}.acceptance`, message: 'acceptance must be an array of rules' })
    } else {
      acceptance.forEach((rule, i) => {
        if (!isPlainObject(rule)) {
          violations.push({ path: `${path}.acceptance.${i}`, message: 'rule must be an object' })
          return
        }
        checkUnknownKeys(rule, ['output-matches', 'output-contains'], `${path}.acceptance.${i}`, violations)
        const hasRule = rule['output-matches'] !== undefined || rule['output-contains'] !== undefined
        if (!hasRule) violations.push({ path: `${path}.acceptance.${i}`, message: 'rule needs output-matches or output-contains' })
        for (const key of ['output-matches', 'output-contains'] as const) {
          if (rule[key] !== undefined && typeof rule[key] !== 'string') {
            violations.push({ path: `${path}.acceptance.${i}.${key}`, message: 'must be a string' })
          }
        }
      })
    }
  }
}

/** Validate retry/on-error/cache/confirm — the keys plain and foreach steps share. */
function checkSharedStepKeys(step: Record<string, unknown>, path: string, violations: WorkflowViolation[]): { needs: string[] | undefined } {
  let needs: string[] | undefined
  if (step['needs'] !== undefined) {
    if (!Array.isArray(step['needs']) || step['needs'].some((n) => typeof n !== 'string')) {
      violations.push({ path: `${path}.needs`, message: 'needs must be an array of step ids' })
    } else {
      needs = step['needs'] as string[]
    }
  }
  if (step['on-error'] !== undefined && !ON_ERROR_VALUES.has(step['on-error'] as string)) {
    violations.push({ path: `${path}.on-error`, message: 'must be one of fail | skip | continue' })
  }
  if (step['cache'] !== undefined && !CACHE_VALUES.has(step['cache'] as string)) {
    violations.push({ path: `${path}.cache`, message: 'must be one of always | on-failure | never' })
  }
  if (step['confirm'] !== undefined && typeof step['confirm'] !== 'boolean') {
    violations.push({ path: `${path}.confirm`, message: 'must be a boolean' })
  }
  return { needs }
}

function checkStep(step: unknown, index: number, violations: WorkflowViolation[], ctx: { stepIds: Set<string>; inputIds: Set<string> }): void {
  const path = `steps.${index}`
  if (!isPlainObject(step)) {
    violations.push({ path, message: 'step must be an object' })
    return
  }
  checkUnknownKeys(step, STEP_KEYS, path, violations)
  if (typeof step['id'] !== 'string' || !KEBAB_PATTERN.test(step['id'])) {
    violations.push({ path: `${path}.id`, message: 'step id is required (kebab-case, ≤64 chars)' })
    return
  }
  const stepCtx = { stepIds: ctx.stepIds, inputIds: ctx.inputIds, allowItem: false }

  if (step['foreach'] !== undefined) {
    const foreach = step['foreach']
    if (step['executor'] !== undefined || step['prompt'] !== undefined) {
      violations.push({ path, message: 'a foreach step declares `foreach` and must not carry executor/prompt' })
    }
    if (!isPlainObject(foreach)) {
      violations.push({ path: `${path}.foreach`, message: 'foreach is required and must be an object' })
      return
    }
    checkUnknownKeys(foreach, ['over', 'as', 'max-concurrency', 'step'], `${path}.foreach`, violations)
    if (typeof foreach['over'] !== 'string' || foreach['over'] === '') {
      violations.push({ path: `${path}.foreach.over`, message: 'over is required (reference to an upstream array)' })
    } else {
      checkRefScope(`{{${foreach['over']}}}`, `${path}.foreach.over`, violations, stepCtx)
    }
    if (typeof foreach['as'] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(foreach['as'] ?? '')) {
      violations.push({ path: `${path}.foreach.as`, message: 'as is required (identifier for {{item}} aliasing)' })
    }
    if (foreach['max-concurrency'] !== undefined) {
      const mc = foreach['max-concurrency']
      if (!Number.isInteger(mc) || (mc as number) < 1 || (mc as number) > 64) {
        violations.push({ path: `${path}.foreach.max-concurrency`, message: 'must be an integer in [1, 64]' })
      }
    }
    const child = foreach['step']
    if (!isPlainObject(child)) {
      violations.push({ path: `${path}.foreach.step`, message: 'foreach.step (the template) is required' })
      return
    }
    const childAllowed = STEP_KEYS.filter((k) => k !== 'foreach' && k !== 'id')
    checkUnknownKeys(child, childAllowed, `${path}.foreach.step`, violations)
    if (child['id'] !== undefined) violations.push({ path: `${path}.foreach.step.id`, message: 'template steps take no id (checkpoint key is <foreachId>#<index>)' })
    checkStepBody(child, `${path}.foreach.step`, violations, { ...stepCtx, allowItem: true })
    checkSharedStepKeys(child, `${path}.foreach.step`, violations)
    return
  }

  // Plain step.
  checkStepBody(step, path, violations, stepCtx)
  const { needs } = checkSharedStepKeys(step, path, violations)
  if (needs !== undefined) {
    for (const dep of needs) {
      if (!ctx.stepIds.has(dep)) violations.push({ path: `${path}.needs`, message: `unknown step "${dep}"` })
    }
  }
  if (needs !== undefined && needs.includes(step['id'] as string)) {
    violations.push({ path: `${path}.needs`, message: 'a step cannot need itself' })
  }
}

/**
 * Parse and validate a workflow document. Throws {@link WorkflowLoadError}
 * with every violation at once; returns the definition plus advisory warnings.
 */
export function loadWorkflow(text: string, options: LoadOptions = {}): LoadSuccess {
  const filePath = options.filePath ?? '<inline>'
  const violations: WorkflowViolation[] = []
  const warnings: string[] = []

  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    throw new WorkflowLoadError(filePath, [{ path: '(root)', message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` }])
  }
  if (!isPlainObject(doc)) {
    throw new WorkflowLoadError(filePath, [{ path: '(root)', message: 'the document must be a mapping' }])
  }

  checkUnknownKeys(doc, TOP_LEVEL_KEYS, '(root)', violations)

  if (doc['format'] !== WORKFLOW_FORMAT) {
    violations.push({ path: 'format', message: `must be the literal "${WORKFLOW_FORMAT}"` })
  }
  if (doc['version'] !== WORKFLOW_VERSION) {
    violations.push({ path: 'version', message: `must be ${WORKFLOW_VERSION} (this plugin understands schema v${WORKFLOW_VERSION} only)` })
  }

  const name = doc['name']
  if (typeof name !== 'string' || !KEBAB_PATTERN.test(name)) {
    violations.push({ path: 'name', message: 'name is required (kebab-case, ≤64 chars)' })
  } else if (options.filePath !== undefined) {
    const stem = basename(options.filePath).replace(/\.workflow\.yaml$/, '').replace(/\.ya?ml$/, '')
    if (name !== stem) {
      violations.push({ path: 'name', message: `name "${name}" must equal the file stem "${stem}"` })
    }
  }
  if (typeof doc['description'] !== 'string' || (doc['description'] as string).trim() === '') {
    violations.push({ path: 'description', message: 'description is required and must be a non-empty string' })
  }

  // Inputs: declarations the reference checker validates against.
  const inputIds = new Set<string>()
  if (doc['inputs'] !== undefined) {
    if (!Array.isArray(doc['inputs'])) {
      violations.push({ path: 'inputs', message: 'inputs must be an array of declarations' })
    } else {
      doc['inputs'].forEach((input, i) => {
        const path = `inputs.${i}`
        if (!isPlainObject(input)) {
          violations.push({ path, message: 'input declaration must be an object' })
          return
        }
        checkUnknownKeys(input, ['id', 'type', 'required', 'default', 'description'], path, violations)
        if (typeof input['id'] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input['id'])) {
          violations.push({ path: `${path}.id`, message: 'input id is required (identifier)' })
          return
        }
        if (inputIds.has(input['id'])) violations.push({ path: `${path}.id`, message: `duplicate input id "${input['id']}"` })
        inputIds.add(input['id'])
        if (typeof input['type'] !== 'string' || !INPUT_TYPES.has(input['type'])) {
          violations.push({ path: `${path}.type`, message: 'type must be one of string | number | boolean' })
        }
        if (input['default'] !== undefined && input['required'] === true) {
          violations.push({ path: `${path}.default`, message: 'an input cannot be both required and defaulted' })
        }
      })
    }
  }

  // Steps: ids first (cross-references need them), then per-step checks.
  const stepIds = new Set<string>()
  const rawSteps = doc['steps']
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    violations.push({ path: 'steps', message: 'steps is required and must be a non-empty array' })
  } else {
    rawSteps.forEach((step, i) => {
      if (isPlainObject(step) && typeof step['id'] === 'string') {
        if (stepIds.has(step['id'])) violations.push({ path: `steps.${i}.id`, message: `duplicate step id "${step['id']}"` })
        stepIds.add(step['id'])
      }
    })
    rawSteps.forEach((step, i) => checkStep(step, i, violations, { stepIds, inputIds }))
    // Cycle detection over `needs` (plain steps only; foreach edges come from its own needs).
    const needsOf = new Map<string, string[]>()
    rawSteps.forEach((step) => {
      if (isPlainObject(step) && typeof step['id'] === 'string' && Array.isArray(step['needs'])) {
        needsOf.set(step['id'], step['needs'].filter((n): n is string => typeof n === 'string'))
      }
    })
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return
      if (state.get(id) === 'visiting') {
        violations.push({ path: `steps(needs)`, message: `dependency cycle: ${[...trail, id].join(' -> ')}` })
        return
      }
      state.set(id, 'visiting')
      for (const dep of needsOf.get(id) ?? []) visit(dep, [...trail, id])
      state.set(id, 'done')
    }
    for (const id of stepIds) visit(id, [])
  }

  if (violations.length > 0) throw new WorkflowLoadError(filePath, violations)

  // Advisory roster lint — never fatal at load (the roster is user-owned and
  // mutable at runtime; the run-time re-read is authoritative).
  if (options.agentsDir !== undefined) {
    const { agents, broken } = loadRoster(options.agentsDir)
    for (const rawStep of rawSteps as Record<string, unknown>[]) {
      const stepId = typeof rawStep['id'] === 'string' ? rawStep['id'] : '?'
      const body = (rawStep['foreach'] !== undefined ? rawStep['foreach'] : rawStep) as Record<string, unknown>
      const template = (body['step'] ?? body) as Record<string, unknown>
      const executor = template['executor'] as Record<string, unknown> | undefined
      const agentName = executor?.['agent']
      if (typeof agentName === 'string' && !agents.has(agentName)) {
        warnings.push(`roster lint: agent "${agentName}" (step "${stepId}") not found in ${options.agentsDir} — it may appear before run time`)
      }
    }
    for (const b of broken) warnings.push(`roster lint: skipping broken agent file ${b.file}: ${b.error}`)
  }

  return { workflow: doc as unknown as WorkflowDef, warnings }
}
