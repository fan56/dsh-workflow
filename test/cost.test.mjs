// Cost fold tests — a fake session persistence serves child events; covers
// usage accumulation, route capture, the empty-log → undefined rule, and the
// best-effort contract (missing/broken persistence never throws).

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { foldChildUsage } = await import('../lib/cost.js')

function fakePersistence(events) {
  return {
    sessionPersistence: {
      open: async () => ({
        read: async () => ({ events }),
        close: async () => {},
      }),
    },
  }
}

test('usage accumulates across turns; route comes from the last request/header', async () => {
  const usage = await foldChildUsage(fakePersistence([
    { type: 'request/header', data: { provider: 'prov-a', model: 'm-1' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheRead: 10 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 30, outputTokens: 8 } } },
    { type: 'request/header', data: { provider: 'prov-b', model: 'm-2' } },
    { type: 'turn/end', data: { reason: 'completed' } },
  ]), 'child-1')
  assert.deepEqual(usage, {
    inputTokens: 130,
    outputTokens: 28,
    totalTokens: 158,
    reasoningTokens: 5,
    cacheReadTokens: 10,
    provider: 'prov-b',
    model: 'm-2',
  })
})

test('a log with no usage and no route returns undefined', async () => {
  assert.equal(await foldChildUsage(fakePersistence([{ type: 'turn/end', data: {} }]), 'c'), undefined)
})

test('missing persistence and dead sessions degrade to undefined', async () => {
  assert.equal(await foldChildUsage({}, 'c'), undefined)
  assert.equal(await foldChildUsage({ sessionPersistence: { open: async () => { throw new Error('dead') } } }, 'c'), undefined)
  assert.equal(await foldChildUsage({ sessionPersistence: { open: async () => ({ read: async () => { throw new Error('boom') }, close: async () => {} }) } }, 'c'), undefined)
})
