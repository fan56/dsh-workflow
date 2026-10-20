// Projection tests — the tool-workflow/* event pairs, per-run seq numbering,
// and the fail-once-then-disable recording policy.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createRunProjector } = await import('../lib/projection.js')

function fakeSession() {
  const appends = []
  return {
    appends,
    append(type, data) {
      appends.push({ type, data })
    },
  }
}

test('run lifecycle emits the official event family with paired agent seqs', () => {
  const session = fakeSession()
  const projector = createRunProjector(session, { runId: 'r1' })
  projector.runStarted('my-flow')
  projector.agentStarted('step-a', 'child-1')
  projector.agentEnded('completed')
  projector.agentStarted('step-b', 'child-2')
  projector.agentEnded('failed')
  projector.runFinished('error')

  assert.deepEqual(session.appends.map((a) => a.type), [
    'tool-workflow/run-start',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/run-end',
  ])
  assert.deepEqual(session.appends[0].data, { runId: 'r1', name: 'my-flow' })
  assert.deepEqual(session.appends[1].data, { runId: 'r1', seq: 1, label: 'step-a', childId: 'child-1' })
  assert.deepEqual(session.appends[2].data, { runId: 'r1', seq: 1, outcome: 'completed' })
  assert.deepEqual(session.appends[3].data, { runId: 'r1', seq: 2, label: 'step-b', childId: 'child-2' })
  assert.deepEqual(session.appends[5].data, { runId: 'r1', stopReason: 'error' })
})

test('an append failure warns once and disables all later writes', () => {
  const warnings = []
  const appends = []
  const session = {
    append(type, data) {
      if (type === 'tool-workflow/agent-start') throw new Error('log closed')
      appends.push({ type, data })
    },
  }
  const projector = createRunProjector(session, { runId: 'r2', warn: (m) => warnings.push(m) })
  projector.runStarted('flow')
  projector.agentStarted('step-a', 'child-1')
  projector.agentEnded('completed')
  projector.runFinished('completed')

  // Only the pre-failure append landed; everything after is suppressed.
  assert.deepEqual(appends.map((a) => a.type), ['tool-workflow/run-start'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /disabled durable record/)
})
