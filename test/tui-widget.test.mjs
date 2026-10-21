// Tui-widget tests — the pure frame renderer and the capability detection.
// No pi-tui anywhere: the seam speaks plain line arrays.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { renderMini, installTuiWidget } = await import('../lib/tui-widget.js')
const { widgetRunStarted, widgetStepUpdate, widgetRunSettled, snapshotWidgetRuns, resetWidgetRuns } =
  await import('../lib/run-state.js')
const { cancelWidgetClearTimer } = await import('../lib/tui-widget.js')

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

test('flushWidgetFile writes the widget lines under $DSH_HOME', async () => {
  resetWidgetRuns()
  const home = mkdtempSync(join(tmpdir(), 'wf-wdg-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { flushWidgetFile, widgetFile } = await import('../lib/tui-widget.js')
    widgetRunStarted('r9', 'fan')
    widgetStepUpdate('r9', 'seed', 'completed', 14793)
    widgetStepUpdate('r9', 'adapt#1', 'running')
    flushWidgetFile()
    const content = readFileSync(widgetFile(), 'utf8')
    assert.match(content, /▸ workflow: fan/)
    assert.match(content, /1\/2 ▶1/)
    assert.match(content, /14\.8k tok/)

    // A settled run with no other activity: one final flush after the grace
    // window clears the file (the timer is unref'd; we drive it manually).
    widgetRunSettled('r9', 'completed')
    flushWidgetFile()
    assert.ok(existsSync(widgetFile()))
    resetWidgetRuns()
    flushWidgetFile()
    assert.equal(existsSync(widgetFile()), false)
  } finally {
    cancelWidgetClearTimer()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})
