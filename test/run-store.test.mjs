// Run Store tests — directory layout, closed event vocabulary, per-step
// result files, terminal snapshot, safe-id enforcement, and warn-degrade on
// write failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRunStore } = await import('../lib/run-store.js')
const { loadWorkflow } = await import('../lib/loader.js')

const WORKFLOW = loadWorkflow(`format: dsh-workflow
version: 1
name: storetest
description: d
steps:
  - id: solo
    executor: { agent: w }
    prompt: p
`).workflow

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-store-'))
}

test('begin/stepSettled/finish produce the documented layout', () => {
  const root = freshRoot()
  try {
    const store = createRunStore({ runId: 'abc123', root })
    store.begin(WORKFLOW, 'format: dsh-workflow\n...')
    store.stepStarted('solo')
    store.stepSettled('solo', { id: 'solo', status: 'completed', attempts: 2, output: 'done' })
    store.finish({ status: 'completed', steps: {} })

    const runDir = join(root, '.dsh', 'workflow-runs', 'abc123')
    const entries = readdirSync(runDir).sort()
    assert.deepEqual(entries, ['events.jsonl', 'results', 'run.json', 'workflow.yaml'])

    // Immutable definition snapshot (the raw text, not a re-serialization).
    assert.equal(readFileSync(join(runDir, 'workflow.yaml'), 'utf8'), 'format: dsh-workflow\n...')

    // Closed event vocabulary, append-only order.
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(events.map((e) => e.type), ['run-started', 'step-started', 'step-completed', 'run-completed'])
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3])

    // Per-step result file.
    const result = JSON.parse(readFileSync(join(runDir, 'results', 'solo.json'), 'utf8'))
    assert.equal(result.status, 'completed')
    assert.equal(result.attempts, 2)
    assert.equal(result.output, 'done')

    // Terminal snapshot has finishedAt and the final status.
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    assert.equal(run.status, 'completed')
    assert.ok(run.finishedAt !== undefined)
    assert.equal(run.steps.solo.attempts, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed and skipped steps map to their own event types and error capture', () => {
  const root = freshRoot()
  try {
    const store = createRunStore({ runId: 'failrun', root })
    store.begin(WORKFLOW)
    store.stepSettled('solo', { id: 'solo', status: 'failed', attempts: 1, error: 'child stop reason error' })
    store.finish({ status: 'failed', steps: {} })
    const events = readFileSync(join(root, '.dsh', 'workflow-runs', 'failrun', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(events.map((e) => e.type), ['run-started', 'step-failed', 'run-failed'])
    const run = JSON.parse(readFileSync(join(root, '.dsh', 'workflow-runs', 'failrun', 'run.json'), 'utf8'))
    assert.match(run.steps.solo.error, /child stop reason/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsafe run/step ids are rejected (path escape guard)', () => {
  const root = freshRoot()
  try {
    assert.throws(() => createRunStore({ runId: '../escape', root }), /unsafe run id/)
    const store = createRunStore({ runId: 'ok-id2', root })
    store.begin(WORKFLOW)
    // A bad step id is dropped silently, never written.
    store.stepStarted('../evil')
    assert.equal(readdirSync(join(root, '.dsh', 'workflow-runs', 'ok-id2', 'results')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('write failures warn and degrade — the store never throws into the run', () => {
  const root = freshRoot()
  const warnings = []
  try {
    const store = createRunStore({ runId: 'degrade', root, warn: (m) => warnings.push(m) })
    store.begin(WORKFLOW)
    // Replace the events file with a directory → every append fails.
    const runDir = join(root, '.dsh', 'workflow-runs', 'degrade')
    rmSync(join(runDir, 'events.jsonl'), { force: true })
    mkdirSync(join(runDir, 'events.jsonl'))
    store.stepStarted('solo')
    assert.ok(warnings.some((w) => w.includes('event append')))
    store.finish({ status: 'completed', steps: {} })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
