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

test('a running run renders the timeline: header summary, centered running step, hotkeys', () => {
  resetWidgetRuns()
  const stepIds = Array.from({ length: 10 }, (_, i) => `step-${i}`)
  widgetRunStarted('r1', 'fan', stepIds)
  for (let i = 0; i < 4; i++) widgetStepUpdate('r1', `step-${i}`, 'completed', 1000)
  widgetStepUpdate('r1', 'step-4', 'running', 500)
  for (let i = 5; i < 10; i++) widgetStepUpdate('r1', `step-${i}`, 'pending')
  const lines = renderMini(200)
  // 7 content rows: header + 5-step window + hotkey footer.
  assert.ok(lines.length >= 8 && lines.length <= 11, `line count ${lines.length}`)
  const joined = lines.join('\n')
  assert.match(joined, /fan/)
  assert.match(joined, /1 live/)
  assert.match(joined, /4\.5k tok/)
  // The RUNNING step is centered: window shows step-2..step-6.
  assert.match(joined, /▸ step-4/)
  assert.match(joined, /✅ step-2/)
  assert.match(joined, /○ step-5/)
  assert.match(joined, /… 2 more/)
  assert.match(joined, /Ctrl\+K tree/)
})
test('a settled run shows its terminal state, then ages out after the grace window', () => {
  resetWidgetRuns()
  widgetRunStarted('r2', 'wave', ['solo'])
  widgetStepUpdate('r2', 'solo', 'completed', 100)
  widgetRunSettled('r2', 'completed')
  const now = Date.now()
  assert.match(renderMini(200, now).join('\n'), /✅ 1\/1/)
  // 61s later the grace window has passed: hidden again, and GC'd.
  const later = now + 61_000
  assert.deepEqual(renderMini(200, later), [])
  assert.equal(snapshotWidgetRuns(later).length, 0)
})

test('failed runs render the ✗ marker and failed-step count', () => {
  resetWidgetRuns()
  widgetRunStarted('r3', 'broken', ['a'])
  widgetStepUpdate('r3', 'a', 'failed')
  widgetRunSettled('r3', 'failed')
  widgetStepUpdate('r3', 'b', 'running')
  const lines = renderMini(200)
  assert.match(lines[0], /✗/)
  assert.match(lines[0], /✗ 0\/2/)
})

test('wide CJK names are clipped to the terminal width, never wrapped', () => {
  resetWidgetRuns()
  const longName = '工作流'.repeat(30)
  widgetRunStarted('r4', longName, ['s'])
  widgetStepUpdate('r4', 's', 'completed', 1)
  const lines = renderMini(40)
  for (const line of lines) {
    assert.ok(line.length < 80, `line too long: ${line.length}`)
  }
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
    assert.match(content, /fan/)
    assert.match(content, /1 live/)
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
