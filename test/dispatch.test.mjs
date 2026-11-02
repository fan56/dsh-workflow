// Dispatch tests — a fake host records the startActivation spec and replays
// the composition listener. Covers roster authority (fail-fast RosterError),
// persona/leaf composition parking + start-edge install, the spawn-tool deny
// intersection, child event pairing, and the usage fold.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createDispatch } = await import('../lib/dispatch.js')
const { installChildCompositionListener } = await import('../lib/composition.js')
const { RosterError } = await import('../lib/errors.js')

/** A fake parent good enough for resolveChildDepth (its exact shape only matters for spawner depths). */
const PARENT = { id: 'parent-1' }

function makeFakeHost({ usageEvents = [], childAgent } = {}) {
  const handlers = {}
  const activations = []
  const warns = []
  const host = {
    warns,
    handlers,
    // The dispatch mints its own UUID childId; the fake host resolves any id
    // to the single fake child (the real host resolves exactly).
    agents: { get: () => childAgent },
    logger: { warn: (m) => warns.push(m) },
    tools: { view: { restrictableNames: new Set(['subagent', 'subagent_fork', 'workflow', 'ralph', 'read']) } },
    on(event, handler) {
      handlers[event] = handler
      return () => delete handlers[event]
    },
    subagents: {
      startActivation: async (spec) => {
        activations.push(spec)
        return {
          result: Promise.resolve({ output: [{ type: 'text', text: 'child output' }], stopReason: 'completed' }),
          dispose: async () => { activations.at(-1).disposed = true },
        }
      },
    },
    sessionPersistence: {
      open: async () => ({ read: async () => ({ events: usageEvents }), close: async () => {} }),
    },
    get(name) {
      return name === 'sessionPersistence' ? this.sessionPersistence : undefined
    },
  }
  host.activations = activations
  return host
}

function makeRoster(dir, agents = { worker: { deep: '0', thinking: 'high' } }) {
  for (const [name, keys] of Object.entries(agents)) {
    const fm = Object.entries({ name, ...keys }).map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(join(dir, `${name}.md`), `---\n${fm}\n---\nWorker persona body.\n`)
  }
}

function fakeChild() {
  const calls = { sections: [], restricts: [] }
  return {
    id: 'child-1',
    ctx: {
      systemPrompt: {
        section: (s) => calls.sections.push(s),
        getSectionOrder: () => 42,
      },
      tools: { restrict: (f) => calls.restricts.push(f) },
    },
    calls,
  }
}

test('leaf agent (deep 0): deny list intersects host-known tools, no maxDepth, persona installs at the start edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dsp-'))
  try {
    makeRoster(dir)
    const child = fakeChild()
    const host = makeFakeHost({ childAgent: child })
    installChildCompositionListener(host)
    const dispatch = createDispatch(host, { parent: PARENT, runId: 'r9', agentsDir: dir })

    // Drive the dispatch; the composition install happens on the start edge,
    // which the real host fires during activation setup. Our fake fires it
    // right after startActivation records the spec.
    const pending = dispatch({ agentName: 'worker', prompt: 'p', label: 's1' })
    const spec = host.activations.at(-1)
    host.handlers['subagent/start']({ id: spec.childId })
    const outcome = await pending

    assert.equal(outcome.text, 'child output')
    assert.equal(outcome.stopReason, 'completed')
    // Leaf policy: no maxDepth field, deny list = SPAWN∩known (read stays usable).
    assert.equal(spec.request.maxDepth, undefined)
    assert.deepEqual(spec.request.agentOptions, { reasoningEffort: 'high' })
    assert.deepEqual(spec.request.outputSchema, undefined)
    // Composition landed on the child scope.
    assert.equal(child.calls.sections.length, 1)
    assert.equal(child.calls.sections[0].name, 'deployment:persona-prefix')
    assert.equal(child.calls.sections[0].text, 'Worker persona body.\n')
    assert.equal(child.calls.sections[0].order, 42)
    assert.deepEqual(child.calls.restricts[0].deny.sort(), ['ralph', 'subagent', 'subagent_fork', 'workflow'])
    // Child edges paired for the projection.
    assert.ok(spec.childId !== undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usage folds from the child session and lands on the outcome; frontmatter routes split', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dsp-'))
  try {
    makeRoster(dir, { worker: { deep: '0', model: 'prov-x/m-9', thinking: 'low' } })
    const host = makeFakeHost({
      usageEvents: [
        { type: 'assistant/message', data: { usage: { inputTokens: 11, outputTokens: 7 } } },
        { type: 'request/header', data: { provider: 'prov', model: 'm' } },
      ],
    })
    const dispatch = createDispatch(host, { parent: PARENT, runId: 'r9', agentsDir: dir })
    const outcome = await dispatch({ agentName: 'worker', prompt: 'p', label: 's1' })
    assert.deepEqual(outcome.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, rounds: 1, provider: 'prov', model: 'm' })
    // The frontmatter `provider/model` route is split, never passed whole.
    const spec = host.activations.at(-1)
    assert.deepEqual(spec.request.agentOptions, { provider: 'prov-x', model: 'm-9', reasoningEffort: 'low' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown roster agent throws RosterError before any activation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dsp-'))
  try {
    makeRoster(dir)
    const host = makeFakeHost()
    const dispatch = createDispatch(host, { parent: PARENT, runId: 'r9', agentsDir: dir })
    await assert.rejects(
      dispatch({ agentName: 'ghost', prompt: 'p', label: 's1' }),
      (error) => error instanceof RosterError && /available agents: worker/.test(error.message),
    )
    assert.equal(host.activations.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('child events fire paired around the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dsp-'))
  try {
    makeRoster(dir)
    const host = makeFakeHost()
    const seen = []
    const dispatch = createDispatch(host, {
      parent: PARENT, runId: 'r9', agentsDir: dir,
      events: {
        childStarted: (id, label) => seen.push(['started', label]),
        childSettled: (id, stopReason) => seen.push(['settled', stopReason]),
      },
    })
    await dispatch({ agentName: 'worker', prompt: 'p', label: 's1' })
    assert.deepEqual(seen, [['started', 's1'], ['settled', 'completed']])
    // Disposal always runs.
    assert.equal(host.activations.at(-1).disposed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
