// L1 repair tests — a fake persistence serves child logs; covers the
// completed-child reconciliation, the non-completed pass-through, the
// missing-childId pass-through, and the absent-persistence no-op.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { reconcileInterruptedSteps } = await import('../lib/repair.js')

function fakeHost(children) {
  return {
    get(name) {
      return name === 'sessionPersistence'
        ? {
            open: async (id) => {
              const events = children[id]
              if (events === undefined) throw new Error('no such session')
              return { read: async () => ({ events }), close: async () => {} }
            },
          }
        : undefined
    },
  }
}

const COMPLETED_CHILD = [
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DRYRUN adaptation finished cleanly' }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]
const ABORTED_CHILD = [
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'half done' }] } } },
  { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
]

test('an interrupted step whose child actually completed is repaired from the log', async () => {
  const host = fakeHost({ 'child-1': COMPLETED_CHILD })
  const steps = {
    broken: { id: 'broken', status: 'running', attempts: 1, childId: 'child-1' },
  }
  const result = await reconcileInterruptedSteps(host, steps)
  assert.deepEqual(result.repaired, ['broken'])
  assert.equal(steps.broken.status, 'completed')
  assert.equal(steps.broken.output, 'DRYRUN adaptation finished cleanly')
  assert.equal(steps.broken.replayed, true)
  assert.equal(steps.broken.error, undefined)
})

test('a child that ended non-completed is left for L3 (full re-run)', async () => {
  const host = fakeHost({ 'child-2': ABORTED_CHILD })
  const steps = { aborted: { id: 'aborted', status: 'running', attempts: 1, childId: 'child-2' } }
  const result = await reconcileInterruptedSteps(host, steps)
  assert.deepEqual(result.repaired, [])
  assert.equal(steps.aborted.status, 'running')
})

test('completed and skipped steps are not touched; steps without childId pass through', async () => {
  const host = fakeHost({ 'child-3': COMPLETED_CHILD })
  const steps = {
    done: { id: 'done', status: 'completed', attempts: 1, childId: 'child-3' },
    skipped: { id: 'skipped', status: 'skipped', attempts: 0, childId: 'child-3' },
    nochild: { id: 'nochild', status: 'running', attempts: 1 },
  }
  const result = await reconcileInterruptedSteps(host, steps)
  assert.deepEqual(result.repaired, [])
  assert.equal(result.inspected.length, 0)
  assert.equal(steps.done.status, 'completed')
  assert.equal(steps.nochild.status, 'running')
})

test('missing persistence degrades to a no-op', async () => {
  const steps = { x: { id: 'x', status: 'running', attempts: 1, childId: 'c' } }
  const result = await reconcileInterruptedSteps({}, steps)
  assert.deepEqual(result.repaired, [])
  assert.equal(steps.x.status, 'running')
})
