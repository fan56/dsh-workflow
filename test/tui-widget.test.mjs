// Tui-widget tests — the pure frame renderer and the capability detection.
// No pi-tui anywhere: the seam speaks plain line arrays.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { renderMini, installTuiWidget } = await import('../lib/tui-widget.js')
const { widgetRunStarted, widgetStepUpdate, widgetRunSettled, snapshotWidgetRuns, resetWidgetRuns } =
  await import('../lib/run-state.js')

test('no active runs renders nothing (the dock hides the widget)', () => {
  resetWidgetRuns()
  assert.deepEqual(renderMini(80), [])
})

test('a running run renders name, progress, current step, and tokens', () => {
  resetWidgetRuns()
  widgetRunStarted('r1', 'fan')
  widgetStepUpdate('r1', 'seed', 'completed', 14793)
  widgetStepUpdate('r1', 'adapt#0', 'completed', 47)
  widgetStepUpdate('r1', 'adapt#1', 'running')
  const lines = renderMini(200)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /▸ workflow: fan/)
  assert.match(lines[0], /2\/3/)
  assert.match(lines[0], /▸ adapt#1/)
  assert.match(lines[0], /14\.8k tok/)
})

test('a settled run shows its terminal state, then ages out after the grace window', () => {
  resetWidgetRuns()
  widgetRunStarted('r2', 'wave')
  widgetStepUpdate('r2', 'solo', 'completed', 100)
  widgetRunSettled('r2', 'completed')
  const now = Date.now()
  assert.match(renderMini(200, now)[0], /✅ 1\/1/)
  // 61s later the grace window has passed: hidden again, and GC'd.
  const later = now + 61_000
  assert.deepEqual(renderMini(200, later), [])
  assert.equal(snapshotWidgetRuns(later).length, 0)
})

test('failed runs render the ✗ marker and failed-step count', () => {
  resetWidgetRuns()
  widgetRunStarted('r3', 'broken')
  widgetStepUpdate('r3', 'a', 'failed')
  widgetStepUpdate('r3', 'b', 'running')
  const lines = renderMini(200)
  assert.match(lines[0], /✗/)
  assert.match(lines[0], /✗1/)
})

test('wide CJK names are clipped to the terminal width, never wrapped', () => {
  resetWidgetRuns()
  const longName = '工作流'.repeat(30)
  widgetRunStarted('r4', longName)
  widgetStepUpdate('r4', 's', 'completed', 1)
  const lines = renderMini(40)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].length < 60, `line too long: ${lines[0].length}`)
})

test('installTuiWidget registers into a present seam and silences on an absent one', () => {
  resetWidgetRuns()
  const registered = []
  const seam = { register: (w) => registered.push(w) }
  installTuiWidget({ tuiWidgets: seam })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-workflow')
  // The registered renderer is live: feed a run, read it back through the seam.
  widgetRunStarted('r5', 'seamcheck')
  assert.match(registered[0].render(120)[0], /seamcheck/)

  // Absent seam: a silent no-op (no throw, nothing registered).
  assert.doesNotThrow(() => installTuiWidget(undefined))
  assert.doesNotThrow(() => installTuiWidget({}))
  resetWidgetRuns()
})
