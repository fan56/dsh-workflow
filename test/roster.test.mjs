// Roster parser tests — registry-parity behaviors: name/stem interlock,
// thinking whitelist fail-loud, deep/background/maxRounds validation, loose
// parsing (quotes/CRLF/unknown keys), and roster-aware unknown-agent errors.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parseAgentMarkdown, loadRoster, resolveAgent, defaultAgentsDir } = await import('../lib/roster.js')
const { WorkflowRunError } = await import('../lib/errors.js')

function makeAgent(overrides = {}, body = 'Persona body.\n') {
  const keys = { name: 'worker', deep: '1', display_name: 'Worker', description: 'does things', model: 'prov/model', thinking: 'high', background: 'false', maxRounds: '8', ...overrides }
  const fm = Object.entries(keys).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${fm}\n---\n${body}`
}

test('full frontmatter parses to typed meta; body kept verbatim', () => {
  const result = parseAgentMarkdown(makeAgent(), '/x/worker.md', 'worker')
  assert.ok(result.ok)
  assert.equal(result.agent.meta.name, 'worker')
  assert.equal(result.agent.meta.displayName, 'Worker')
  assert.equal(result.agent.meta.model, 'prov/model')
  assert.equal(result.agent.meta.thinking, 'high')
  assert.equal(result.agent.meta.deep, 1)
  assert.equal(result.agent.meta.maxRounds, 8)
  assert.equal(result.agent.body, 'Persona body.\n')
})

test('name must equal the file stem', () => {
  const result = parseAgentMarkdown(makeAgent({ name: 'other' }), '/x/worker.md', 'worker')
  assert.ok(!result.ok)
  assert.match(result.error, /does not match file stem/)
})

test('thinking outside the whitelist breaks the file (fail-loud)', () => {
  const result = parseAgentMarkdown(makeAgent({ thinking: 'ultra' }), '/x/worker.md', 'worker')
  assert.ok(!result.ok)
  assert.match(result.error, /thinking/)
})

test('deep rejects negatives and non-integers; 0 is a legal leaf', () => {
  assert.ok(!parseAgentMarkdown(makeAgent({ name: 'w', deep: '-1' }), '/x/w.md', 'w').ok)
  assert.ok(!parseAgentMarkdown(makeAgent({ name: 'w', deep: '1.5' }), '/x/w.md', 'w').ok)
  const leaf = parseAgentMarkdown(makeAgent({ name: 'w', deep: '0' }), '/x/w.md', 'w')
  assert.ok(leaf.ok && leaf.agent.meta.deep === 0)
})

test('background must be exactly true/false; quotes tolerated; CRLF tolerated', () => {
  assert.ok(!parseAgentMarkdown(makeAgent({ name: 'w', background: 'yes' }), '/x/w.md', 'w').ok)
  const quoted = parseAgentMarkdown(makeAgent({ name: '"w"', background: "'true'" }).replaceAll('\n', '\r\n'), '/x/w.md', 'w')
  assert.ok(quoted.ok)
  assert.equal(quoted.agent.meta.name, 'w')
  assert.equal(quoted.agent.meta.background, true)
})

test('unknown keys are ignored (the displayName camelCase trap is a no-op)', () => {
  const result = parseAgentMarkdown(makeAgent({ displayName: 'Camel Trap' }), '/x/worker.md', 'worker')
  assert.ok(result.ok)
  assert.equal(result.agent.meta.displayName, 'Worker')
})

test('loadRoster reports broken files without dying; resolveAgent is roster-aware', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-roster2-'))
  try {
    writeFileSync(join(dir, 'good.md'), makeAgent({ name: 'good' }))
    writeFileSync(join(dir, 'bad.md'), 'plain text, no fence\n')
    const { agents, broken } = loadRoster(dir)
    assert.equal(agents.size, 1)
    assert.equal(broken.length, 1)
    assert.match(broken[0].error, /missing frontmatter/)

    assert.equal(resolveAgent(dir, 'good').meta.name, 'good')
    try {
      resolveAgent(dir, 'ghost')
      assert.fail('expected WorkflowRunError')
    } catch (error) {
      assert.ok(error instanceof WorkflowRunError)
      assert.match(error.message, /available agents: good/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultAgentsDir resolves $DSH_HOME first', () => {
  const old = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/custom-dsh'
    assert.equal(defaultAgentsDir(), join('/tmp/custom-dsh', 'agents'))
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

test('missing agents dir yields an empty roster', () => {
  mkdirSync(join(tmpdir(), `wf-empty-${Date.now()}`), { recursive: true })
  const { agents, broken } = loadRoster(join(tmpdir(), `wf-missing-${Date.now()}`))
  assert.equal(agents.size, 0)
  assert.equal(broken.length, 0)
})
