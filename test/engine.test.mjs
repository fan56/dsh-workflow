// Engine tests — a scripted fake dispatch. Covers topological order, retry
// with backoff, on-error fail/skip/continue, confirm gating, acceptance
// postconditions, action shaping, and the foreach not-implemented fence.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createEngine, topoOrder } = await import('../lib/engine.js')
const { loadWorkflow } = await import('../lib/loader.js')
const { WorkflowRunError } = await import('../lib/errors.js')

/** Fake dispatch: scripted per-call outcomes, records every request. */
function fakeDispatch(scripts) {
  const calls = []
  let i = 0
  const fn = async (request) => {
    calls.push(request)
    const script = scripts[i]
    i += 1
    if (script === undefined) throw new Error('unexpected extra dispatch call')
    if (typeof script === 'string') return { text: script, stopReason: 'completed' }
    if (script instanceof Error) throw script
    return { text: script.text ?? '', stopReason: script.stopReason ?? 'completed', ...(script.structured !== undefined ? { structured: script.structured } : {}) }
  }
  fn.calls = calls
  return fn
}

const noSleep = async () => {}

function runYaml(yaml, scripts, runOptions = {}) {
  const { workflow } = loadWorkflow(yaml)
  const dispatch = fakeDispatch(scripts)
  const engine = createEngine({ dispatch, sleep: noSleep })
  return { promise: engine.run(workflow, runOptions), calls: dispatch.calls }
}

test('topoOrder respects needs and rejects cycles', () => {
  const steps = [
    { id: 'c', executor: { agent: 'a' }, prompt: 'x', needs: ['b'] },
    { id: 'a', executor: { agent: 'a' }, prompt: 'x' },
    { id: 'b', executor: { agent: 'a' }, prompt: 'x', needs: ['a'] },
  ]
  assert.deepEqual(topoOrder(steps), ['a', 'b', 'c'])
  const cyclic = [...steps, { id: 'a', executor: { agent: 'a' }, prompt: 'x', needs: ['c'] }]
  assert.throws(() => topoOrder(cyclic), WorkflowRunError)
})

test('two-step chain passes references downstream', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: chain
description: d
inputs:
  - id: thing
    type: string
steps:
  - id: one
    executor: { agent: worker }
    prompt: "do {{inputs.thing}}"
  - id: two
    needs: [one]
    executor: { agent: worker }
    prompt: "review {{steps.one.output}}"
`
  const { promise, calls } = runYaml(yaml, ['first done', 'second done'], { inputs: { thing: 'it' } })
  const outcome = await promise
  assert.equal(outcome.status, 'completed')
  assert.equal(calls[0].prompt, 'do it')
  assert.equal(calls[1].prompt, 'review first done')
})

test('retry re-dispatches then succeeds; attempts recorded', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: flaky
description: d
steps:
  - id: flaky
    executor: { agent: worker }
    prompt: p
    retry: { max: 2, backoff-ms: 0 }
`
  const dispatch = fakeDispatch([new Error('boom'), 'recovered'])
  const engine = createEngine({ dispatch, sleep: noSleep })
  const { workflow } = loadWorkflow(yaml)
  const outcome = await engine.run(workflow)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.steps.flaky.attempts, 2)
  assert.equal(dispatch.calls.length, 2)
})

test('on-error: fail stops the run; skip marks downstream skipped', async () => {
  const base = `format: dsh-workflow
version: 1
name: errs
description: d
steps:
  - id: boom
    executor: { agent: worker }
    prompt: p
    on-error: MODE
  - id: after
    needs: [boom]
    executor: { agent: worker }
    prompt: p
`
  const outcomeFail = await runYaml(base.replace('MODE', 'fail'), [new Error('boom')]).promise
  assert.equal(outcomeFail.status, 'failed')
  assert.equal(outcomeFail.steps.boom.status, 'failed')
  assert.equal(outcomeFail.steps.after, undefined)

  const skipped = await runYaml(base.replace('MODE', 'skip'), [new Error('x')]).promise
  assert.equal(skipped.steps.boom.status, 'skipped')
  assert.equal(skipped.steps.after.status, 'skipped')

  const continued = await runYaml(base.replace('MODE', 'continue'), [new Error('x'), 'ok']).promise
  assert.equal(continued.steps.boom.status, 'failed')
  assert.equal(continued.steps.after.status, 'completed')
})

test('acceptance: output-matches with (?i) and output-contains', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: acc
description: d
steps:
  - id: a
    executor: { agent: worker }
    prompt: p
    acceptance:
      - output-matches: "(?i)workflow hello ok"
      - output-contains: "hello"
`
  const ok = await runYaml(yaml, ['all good: workflow hello ok and more']).promise
  assert.equal(ok.status, 'completed')
  const bad = await runYaml(yaml, ['nope']).promise
  assert.equal(bad.status, 'failed')
  assert.match(bad.steps.a.error, /acceptance/)
})

test('action output joins the prompt context as {{<id>.action-output}}', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: act
description: d
steps:
  - id: shape
    executor: { agent: worker }
    action: |
      return { doubled: input.inputs.n * 2 }
    prompt: "value: {{steps.shape.action-output.doubled}}"
`
  const { promise, calls } = runYaml(yaml, ['done'], { inputs: { n: 21 } })
  const outcome = await promise
  assert.equal(outcome.status, 'completed')
  assert.equal(calls[0].prompt, 'value: 42')
})

test('confirm gating: declined step is skipped, downstream sees it', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: conf
description: d
steps:
  - id: dangerous
    executor: { agent: worker }
    prompt: p
    confirm: true
  - id: after
    needs: [dangerous]
    executor: { agent: worker }
    prompt: p
`
  const declined = await runYaml(yaml, [], { confirm: async () => false }).promise
  assert.equal(declined.steps.dangerous.status, 'skipped')
  assert.equal(declined.steps.after.status, 'skipped')
  const granted = await runYaml(yaml, ['ok', 'ok2'], { confirm: async () => true }).promise
  assert.equal(granted.status, 'completed')
})

test('foreach loads but refuses to execute until M3', async () => {
  const yaml = `format: dsh-workflow
version: 1
name: fan
description: d
steps:
  - id: seed
    executor: { agent: worker }
    prompt: p
    output:
      type: object
  - id: spread
    needs: [seed]
    foreach:
      over: steps.seed.output.items
      as: item
      step:
        executor: { agent: worker }
        prompt: "{{item}}"
`
  const outcome = await runYaml(yaml, ['[]']).promise
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.steps.spread.error ?? '', /foreach(\.over unusable| execution is not implemented)/)
})
