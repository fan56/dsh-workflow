// Reference-template tests: scope roots, path traversal, stringification,
// and the fail-loud missing-reference rule.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { resolveTemplate, extractRefs, resolveOverArray } = await import('../lib/refs.js')
const { WorkflowRunError } = await import('../lib/errors.js')

const SCOPE = {
  inputs: { target: 'repo-x', count: 3, flag: true },
  steps: {
    audit: { output: { repos: ['a', 'b'], note: 'done' }, 'action-output': { ok: 1 } },
  },
  item: { name: 'repo-x', why: 'matched' },
}

test('extractRefs finds and dedupes dotted paths, whitespace-tolerant', () => {
  assert.deepEqual(
    extractRefs('A {{inputs.target}} B {{ steps.audit.output.note }} C {{inputs.target}}'),
    ['inputs.target', 'steps.audit.output.note'],
  )
})

test('resolveTemplate substitutes strings, stringifies non-strings', () => {
  const text = 't={{inputs.target}} n={{inputs.count}} f={{inputs.flag}} j={{steps.audit.action-output}}'
  assert.equal(
    resolveTemplate(text, SCOPE),
    't=repo-x n=3 f=true j={"ok":1}',
  )
})

test('deep item paths and bare item both resolve', () => {
  assert.equal(resolveTemplate('{{item.name}}:{{item.why}}', SCOPE), 'repo-x:matched')
  assert.equal(resolveTemplate('{{item}}', { item: 'solo' }), 'solo')
})

test('a missing reference throws (never silently emits the literal)', () => {
  assert.throws(() => resolveTemplate('{{inputs.ghost}}', SCOPE), WorkflowRunError)
  assert.throws(() => resolveTemplate('{{steps.ghost.output}}', SCOPE), WorkflowRunError)
  assert.throws(() => resolveTemplate('{{unknown.root}}', SCOPE), WorkflowRunError)
})

test('resolveOverArray: ok, not-array, and missing cases', () => {
  assert.deepEqual(resolveOverArray('steps.audit.output.repos', SCOPE), { ok: true, items: ['a', 'b'] })
  assert.equal(resolveOverArray('steps.audit.output.note', SCOPE).ok, false)
  assert.equal(resolveOverArray('inputs.ghost', SCOPE).ok, false)
})
