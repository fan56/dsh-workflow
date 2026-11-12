# SPEC — dsh-workflow v0.1

> Status: **buildable**. Every decision below is resolved; sources are the wayfinder
> tickets (`docs/wayfinder/tickets/`, with research reports under `docs/wayfinder/research/`).
> Runtime target: `@deepseek-ai/dsh` **0.2.1-rc.2**. npm scope: `@aiwayds`.

## 1. Position

A declarative workflow plugin that turns recurring daily pipelines (release waves,
migration waves, inspections) into named, reviewable, resumable YAML workflows.

- Not competing with anything: the host's native `workflow` tool owns one-off
  orchestration; this plugin owns **durable pipelines**.
- Official bundle form, **zero core patches**, never claims `ctx.workflowEngine`
  (that seam stays free for the native tool).
- v1 acceptance target: the `dsh-plugin-wave` migration pipeline as a real workflow
  (`examples/dsh-plugin-wave.workflow.yaml`).

## 2. Architecture — four layers

```
┌─ Presentation: /workflow command family + workflow tools (tui + web via ctx.commands)
├─ Scheduling:   delegated to dsh-cron (this plugin is on-demand only in v1)
├─ Monitoring:   Run Store (files) + Session projection (host tool-workflow/* events)
└─ Execution:    self-built engine over ctx.subagents + ctx.jobs + user questions
```

### Execution (engine + dispatch)

- Plugin service registered under a **non-conflicting name** (`ctx.dshWorkflows`,
  augmentation) — never `ctx.workflows`/`ctx.workflowEngine`.
- Inject: `['subagents', 'agents', 'tools', 'commands', 'systemPrompt']`; jobs/
  userQuestions/sessionQuery are optional `ctx.get()` with fail-loud degradation.
- **Dispatch = registry-less roster execution** (ticket 03, route A):
  - Parser: self-contained copy of the dsh-subagent-registry agent-markdown parser
    (~80 lines; precedent: dsh-tui-pi). Keys: `name/deep/display_name/description/
    model/thinking/background/maxRounds`. Unknown frontmatter keys ignored (host parity).
  - Step → child: `ctx.subagents.startActivation({ provider: 'spawn', label,
    prompt, parent, agentOptions?, outputSchema?, maxDepth?, signal,
    delivery: 'caller' })` — 0.2.2-rc.2 flattened the `SubagentActivationSpec`
    (the start-request fields ride the spec itself; the host reads
    `spec.parent.id`/`spec.prompt` directly). Pre-rc.2 hosts read the nested
    `request: { … }` block; the dispatch feature-detects the line via the
    `waitForTreeWork` surface (present from rc.2) and keeps both shapes alive.
  - `parent` = `invocation.agent` (must be the exact live Agent; else `UNAUTHORIZED`).
  - **Label namespace**: `[wf] <runId>/<stepId>` — never a bare agent name (the
    registry's auto-resume claims bare-labeled one-shot children).
  - **maxDepth always explicit**: `resolveChildDepth(parent) + deep` (default deep 1;
    never rely on the host default of 1).
  - **0.2.1 persona surgery**: the activation request carries no `persona`/`toolFilter`
    on this host line; replicate the registry's out-of-band composition — keep a
    `Map<childId, composition>`, and on the `subagent/start` edge install
    `ctx.systemPrompt.section({ name: 'deployment:persona-prefix', … })` +
    `ctx.tools.restrict(...)` on the child scope. ~60 lines, public API only.
    Cleanup on `agent/disposed` and parent session dispose.
  - `deep: 0` leaf → `toolFilter.deny` list ∩ `ctx.tools.view().restrictableNames`.
- Engine rules:
  - DAG via `needs`; `foreach` fans out with `max-concurrency` (default 4) and
    **queues at the workflow layer** (never bet on host overflow behavior).
  - Failure matrix: parse/meta/引用解析失败 → run fails before any child starts;
    step-level executor errors honor `on-error: fail | skip | continue`;
    roster file missing/broken at dispatch time → step **fail-fast, no retry**;
    `retry` (max/backoff-ms) applies to ordinary child failure
    (`SubagentResult.stopReason ≠ completed`); `ACTIVATION_LIMIT_REJECTED` is
    retryable-with-queueing, never a crash.
  - Teardown: always `run.dispose()`-equivalent per activation (rc.2 disposal
    addresses exactly that activation — it no longer sweeps owned descendants);
    parent wrap-up must call `ctx.subagents.waitForTreeWork(parent)` + idle
    recheck before completing (`waitForChildren` was removed in 0.2.2).
  - `output: <json-schema>` → validated object in `SubagentResult.structured`;
    missing `structured` ≠ failure (host semantics) — acceptance must handle both.

### Monitoring (Run Store + Session projection)

- Run Store per run (ticket 02 layout, cwd-relative `.dsh/workflow-runs/<runId>/`):
  - `run.json` — rewritten snapshot (status, step states, cost summary); write
    throttled, never per-emit synchronous full rewrite.
  - `events.jsonl` — append-only `{seq,time,type,data}`; closed event vocabulary
    (adapted from 147⭐'s 17-event set, minus script/nesting events, plus
    `step-skipped`/`confirm-requested`).
  - `workflow.yaml` — immutable definition snapshot for this run.
  - `results/` — per-step outputs (`<stepId>.json`), resume checkpoints.
  - `artifacts/` — named evidence, sanitized names + short hash, exclusive-create.
- **Cost accounting is self-built** (ticket 01): usage lives only in the child's own
  Session log. After each child settles, open `ctx.sessions.get(childId)` and fold
  `assistant/message.usage` (+ `request/header` for provider/model); duration from
  the `subagentTiming` projection (`settledMs`). Sum into `run.json` cost summary.
- Session projection: write the **host `tool-workflow/*` event family**
  (`run-start` with **`turn: null`** session domain so background runs survive their
  starting step; `agent-start`/`agent-end` paired by seq; `run-end` after quiescence)
  via `SessionEventMap` augmentation + `session.append` — the official
  `dsh-client-ui-workflow-run` node renders them for free in tui/web.
  Recorder failures warn-and-degrade (never affect execution), same as the official tool.
- Terminal run produces a cost report (wall clock, per-agent tokens/model/duration)
  and an outcome summary.

### Presentation

- **One canonical tool surface + thin command aliases** (anti-lesson from 147⭐'s
  double surface):
  - Tools: `workflow_run` (name | source, args, wait), `workflow_manage`
    (action enum: runs/show/stop/rerun/resume/prune/save).
  - Command: `/workflow` single registration (`ctx.commands.register`, global scope,
    tui+web consume the same registry); subcommands split `rawInput`:
    `list/runs/show/run/stop/rerun/resume/prune/save/help`.
- Registration: `ctx.commands.register({ name: 'workflow', handler })`; events
  `command/run`+`command/done` are automatic.
- One-shot confirmations from command context use `ctx.userQuestions.ask`
  (no open-turn requirement); `ctx.approval.request` only inside live tool turns.

### Scheduling

- v1: on-demand only. dsh-cron composes by prompt ("run workflow X with args Y").
- The cron→workflow convention (exact prompt contract) lives in the fog section;
  no trigger code ships in v1.

## 3. YAML schema v1

Normative example: `examples/dsh-plugin-wave.workflow.yaml`. Grammar:

```yaml
format: dsh-workflow        # required, literal
version: 1                  # required
name: <kebab-case>          # required; must equal the file stem (load-time interlock)
description: <string>       # required
inputs:                     # optional list of { id, type, required?, default?, description? }
steps:
  - id: <step-id>           # required, unique; stable identity for checkpoints
    executor:               # required
      agent: <roster-name>  #   required: file identity name from ~/.dsh/agents/<name>.md
      model?: <route>       #   optional runtime override (never writes back)
      thinking?: <level>    #   optional
    prompt: <string>        # required (templated)
    needs: [step-id]        # optional DAG edges
    foreach:                # optional fan-out (exclusive with plain prompt steps'
      over: <ref>           #   foreach is itself a step)
      as: <name>
      max-concurrency: 4
      step: {…}             #   template step; {{item}} / {{item.path}} available
    retry: { max: 2, backoff-ms: 30000 }
    on-error: fail          # fail | skip | continue
    cache: on-failure       # always | on-failure | never
    confirm: false          # true → one-shot human confirmation before dispatch
    output: {…}             # optional object-root JSON Schema subset
    acceptance:             # optional postconditions
      - output-matches: <regex>
      - output-contains: <substring>
    action: <js-body>       # optional PURE input-shaping function:
                            # (input) => json, merged into prompt context as
                            # {{<step-id>.action-output}}; no I/O, no shared state
```

References: `{{inputs.x}}`, `{{steps.<id>.output[.path]}}`, `{{item}}`, `{{<id>.action-output}}`.

Hard rules (fail-loud, ticket 02 discipline):

1. Unknown top-level or step keys are **errors**, never ignored; schema evolution =
   version bump. `name` must equal file stem; cross-field invariants enforced
   (e.g. `foreach.max-concurrency` ≤ governance cap).
2. **Dual-track boundary**: YAML declares structure; JS appears only inside a single
   step's `action`; steps never share script state — all inter-step data flows
   through declared references as JSON.
3. Load-time validation: schema + reference resolution + roster existence lint
   (roster-aware error messages listing available agents). Load lint is advisory;
   run-time re-read is authoritative (ticket 03 two-layer resolution).

## 4. Governance (defaults)

| Knob | Default | Rationale |
|---|---|---|
| Run mode | background (job), `wait` opt-in | pipelines are long; official/147⭐ parity |
| Resume | step-level checkpoint by stable step id | beats call-sequence effect cache |
| Per-step cache | `on-failure`; side-effect steps `never` | no fake idempotency for publish/tag |
| Approval | `side-effects` (`always`/`none` optional); `confirm: true` steps ask | one-shot via userQuestions |
| Concurrency | 4 (workflow-layer queueing) | headroom under host `maxActiveSubagents` 8 |
| Retention | `maxRetainedRuns` 100, auto-prune terminal runs | single-user tool |
| Identity ambiguity | fail-closed | no silent run picking |
| Child sessions | kept after run ends | catalog behavior is keep-by-default; cost fold reads them |

## 5. Milestones

- **M1 — skeleton**: package + bundle patch (`insert` self, unique entry ids,
  `dsh.bundle.patch` field) + YAML loader (fail-loud validation) + serial engine
  running a hello workflow end-to-end through real dispatch.
- **M2 — dispatch depth**: roster parser copy, persona surgery, label namespace,
  maxDepth policy, leaf deny; Run Store + cost fold + `tool-workflow/*` projection.
- **M3 — product surface**: `/workflow` + tools, jobs background path, confirm/
  approval, retry/cache/resume, prune.
- **M4 — acceptance**: `dsh-plugin-wave` runs as a real workflow (dryRun first);
  `install-profile.mjs`-style installer (timestamped backups, entry-id conflict
  guard, `- insert` rows, `--check` via `dsh --dump-config`).

## 6. Open items / risks (implementation-time, non-blocking)

1. Host overflow behavior for active `maxActiveSubagents` (type layer only defines
   the cold-resume path) — verify with a 9-child fan-out test; our queueing makes
   this safe either way.
2. Third-party `session.append` events and `ignorable` marking across format
   migrations — recorder degrades on failure; revisit if upstream documents a
   third-party event channel.
3. `presentAs` preset-scoping bug state on 0.2.1-rc.2 (proven broken on 0.2.0-rc.2):
   contract avoids presets entirely; `SubagentStartRequest.agentPreset` stays
   out of v1.
4. Upstream follow-ups to file when convenient: registry export of roster readers
   (route B), `displayName` vs `display_name` typo in dsh-ptc-subagent's agent file,
   `xhigh` missing from AGENT-FORMAT.md.

## 7. References

- Wayfinder map: `docs/wayfinder/MAP.md`; tickets `docs/wayfinder/tickets/01–06`;
  research reports `docs/wayfinder/research/`.
- Glossary: `CONTEXT.md`. Example: `examples/dsh-plugin-wave.workflow.yaml`.
