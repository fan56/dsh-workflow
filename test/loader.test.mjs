// Loader tests — every violation class the fail-loud gate rejects, plus the
// happy path and the advisory roster lint. Fully offline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { loadWorkflow } = await import('../lib/loader.js')
const { WorkflowLoadError } = await import('../lib/errors.js')

const VALID = `format: dsh-workflow
version: 1
name: sample
description: A valid document.
inputs:
  - id: target
    type: string
    required: true
steps:
  - id: first
    executor:
      agent: workhorse
    prompt: "Do {{inputs.target}} now."
  - id: second
    needs: [first]
    executor:
      agent: workhorse
    prompt: "Review: {{steps.first.output}}"
`

function loadText(text, options = {}) {
  return loadWorkflow(text, options)
}

test('valid document loads with no violations and no warnings', () => {
  const { workflow, warnings } = loadText(VALID)
  assert.equal(workflow.name, 'sample')
  assert.equal(workflow.steps.length, 2)
  assert.deepEqual(warnings, [])
})

test('unknown top-level and step keys are violations, never ignored', () => {
  const dirty = VALID.replace('description: A valid document.', 'description: A valid document.\npatterns: [x]')
    .replace('needs: [first]', 'needs: [first]\n    modelHint: fast')
  try {
    loadText(dirty)
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    assert.ok(error instanceof WorkflowLoadError)
    const paths = error.violations.map((v) => v.path)
    assert.ok(paths.includes('(root).patterns'), 'top-level unknown key flagged')
    assert.ok(paths.includes('steps.1.modelHint'), 'step unknown key flagged')
    assert.equal(error.violations.length, 2)
  }
})

test('name must equal the file stem when a filePath is given', () => {
  try {
    loadText(VALID, { filePath: 'other.workflow.yaml' })
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    assert.match(error.message, /must equal the file stem "other"/)
  }
})

test('reference checks: undeclared input and unknown step are violations', () => {
  const dirty = VALID.replace('{{inputs.target}}', '{{inputs.missing}}').replace('{{steps.first.output}}', '{{steps.ghost.output}}')
  try {
    loadText(dirty)
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    const messages = error.violations.map((v) => v.message).join('\n')
    assert.match(messages, /undeclared input/)
    assert.match(messages, /unknown step/)
  }
})

test('needs cycle is reported', () => {
  const cyclic = VALID.replace('needs: [first]', 'needs: [second]')
  try {
    loadText(cyclic)
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    assert.match(error.message, /dependency cycle/)
  }
})

test('foreach step: template takes no id, over must reference a known step array', () => {
  const doc = `format: dsh-workflow
version: 1
name: fanout
description: Foreach shape checks.
steps:
  - id: audit
    executor:
      agent: workhorse
    prompt: "list repos"
    output:
      type: object
  - id: adapt
    foreach:
      over: steps.audit.output.repos
      as: repo
      max-concurrency: 4
      step:
        id: inner
        executor:
          agent: workhorse
        prompt: "adapt {{item.name}}"
`
  try {
    loadText(doc)
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    const messages = error.violations.map((v) => `${v.path}: ${v.message}`).join('\n')
    assert.match(messages, /foreach\.step\.id/)
    assert.match(messages, /template steps take no id/)
  }
})

test('foreach template allows {{item}} but a plain step does not', () => {
  const withItem = VALID.replace('Review: {{steps.first.output}}', 'Review: {{item}}')
  try {
    loadText(withItem)
    assert.fail('expected WorkflowLoadError')
  } catch (error) {
    assert.match(error.message, /outside a foreach template/)
  }
})

test('bad format tag and version are violations', () => {
  assert.throws(() => loadText(VALID.replace('format: dsh-workflow', 'format: other')), /literal "dsh-workflow"/)
  assert.throws(() => loadText(VALID.replace('version: 1', 'version: 2')), /must be 1/)
})

test('advisory roster lint warns but does not fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-roster-'))
  try {
    writeFileSync(join(dir, 'workhorse.md'), '---\nname: workhorse\ndeep: 0\n---\nBody here.\n')
    const { warnings } = loadText(VALID, { agentsDir: dir })
    assert.equal(warnings.length, 0)
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter\n')
    const { warnings: warnings2 } = loadText(VALID.replace('agent: workhorse', 'agent: ghost'), { agentsDir: dir })
    assert.ok(warnings2.some((w) => w.includes('ghost')))
    assert.ok(warnings2.some((w) => w.includes('broken.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
