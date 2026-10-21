// Overlay state-machine tests — tree assembly, phase segments, keyboard
// model. Pure logic: fixtures are a temp run directory (workflow.yaml + run.json).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildOverlay, hasOverlaySnapshot } = await import('../lib/tui-overlay.js')

const WORKFLOW = `format: dsh-workflow
version: 1
name: wave
description: d
phases: [intel, adapt, verify]
steps:
  - id: intel
    executor: { agent: w }
    prompt: p
    phase: intel
  - id: audit
    needs: [intel]
    executor: { agent: w }
    prompt: p
    phase: adapt
  - id: adapt
    needs: [audit]
    foreach:
      over: "[1,2,3]"
      as: item
      step:
        executor: { agent: w }
        prompt: p
        on-error: continue
    phase: adapt
  - id: verify
    needs: [adapt]
    executor: { agent: w }
    prompt: p
    confirm: true
    phase: verify
`

function fixture(stepsMeta, status = 'running') {
  const dir = mkdtempSync(join(tmpdir(), 'wf-ov-'))
  writeFileSync(join(dir, 'workflow.yaml'), WORKFLOW)
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ status, steps: stepsMeta }, null, 2))
  return dir
}

test('tree assembly: primary-parent hanging, foreach children, phase segments', () => {
  const dir = fixture({
    intel: { status: 'completed', usage: { totalTokens: 1200 } },
    audit: { status: 'completed', usage: { totalTokens: 980 } },
    'adapt#0': { status: 'completed', usage: { totalTokens: 811 } },
    'adapt#1': { status: 'failed', error: 'boom' },
    adapt: { status: 'running' },
  })
  const overlay = buildOverlay(dir, 'en')
  assert.ok(overlay !== undefined)

  // Segments: declared order, arrows pointing right, symbol-only state.
  const row = overlay.segmentsRow()
  assert.match(row, /intel ✅/)
  assert.match(row, /adapt ▶/)
  assert.ok(!row.includes('◀'))

  // The overlay lands on the ACTIVE segment (adapt: it has the running node).
  let lines = []
  const grab = () => {
    lines = []
    for (let i = 0; i < overlay.lineCount(200); i++) lines.push(overlay.renderLine(i, 200))
    return lines.join('\n')
  }
  let text = grab()
  assert.match(text, /✅ audit/)
  assert.match(text, /▶ adapt\s+▦ 1\/2/)
  assert.match(text, /✅ adapt#0/)
  assert.match(text, /✗ adapt#1  ✗ boom/)

  // Switch to the intel segment: only its member, full subtree.
  overlay.onKey('shift+tab')
  text = grab()
  assert.match(text, /✅ intel  1200 tok/)

  // The verify segment: pending step with the confirm marker.
  overlay.onKey('tab')
  overlay.onKey('tab')
  text = grab()
  assert.match(text, /○ verify\s+\?/)
})

test('keyboard model: scroll, collapse, segment switch, follow toggle, quit passes through', () => {
  const dir = fixture({
    intel: { status: 'completed' },
    audit: { status: 'completed' },
    'adapt#0': { status: 'completed' },
    'adapt#1': { status: 'failed', error: 'x' },
    adapt: { status: 'running' },
  })
  const overlay = buildOverlay(dir, 'en')
  assert.equal(overlay.onKey('q'), 'passthrough')
  assert.equal(overlay.onKey('escape'), 'passthrough')
  assert.equal(overlay.onKey('down'), 'handled')
  assert.equal(overlay.onKey('f'), 'handled')
  assert.equal(overlay.onKey('tab'), 'handled')
  assert.equal(overlay.onKey('shift+tab'), 'handled')

  // Collapse the running node's subtree, check, then expand it again.
  assert.equal(overlay.onKey('left'), 'handled')
  let lines = []
  for (let i = 0; i < overlay.lineCount(200); i++) lines.push(overlay.renderLine(i, 200))
  assert.ok(!lines.some((l) => l.includes('#0')), 'collapsed foreach children hidden')
  assert.ok(lines.some((l) => l.includes('hidden')), 'the fold shows a hidden-count row')

  assert.equal(overlay.onKey('right'), 'handled')
  lines = []
  for (let i = 0; i < overlay.lineCount(200); i++) lines.push(overlay.renderLine(i, 200))
  assert.ok(lines.some((l) => l.includes('#0')), 'expanded again')
})

test('locale zh renders the workflow label in Chinese; missing snapshot returns null', () => {
  const dir = fixture({ intel: { status: 'completed' } })
  const overlay = buildOverlay(dir, 'zh')
  assert.match(overlay.title(), /工作流: wave/)

  assert.equal(buildOverlay(join(tmpdir(), 'wf-missing-ov'), 'en'), undefined ?? null)
  assert.equal(hasOverlaySnapshot(dir), true)
  assert.equal(hasOverlaySnapshot(join(tmpdir(), 'wf-missing-ov')), false)
})
