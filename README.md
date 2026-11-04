# dsh-workflow

Declarative workflow plugin for DeepSeek Harness: turns recurring daily pipelines
(release waves, migration waves, inspections) into named, reviewable, resumable
YAML workflows that run on host primitives.

- Status: **early implementation** — spec and the wayfinder map live in `docs/SPEC.md` and Issues.
- Runtime target: `@deepseek-ai/dsh` 0.2.1-rc.2, official bundle form, zero core patches.
- Layering: execution (self-built orchestration over `ctx.subagents`/`ctx.jobs`/`ctx.approval`),
  monitoring (lifecycle + per-agent cost into a durable Run Store),
  presentation (`/workflow` command family, tui + web), scheduling (delegated to dsh-cron).
- v1 acceptance target: the `dsh-plugin-wave` migration pipeline as a real workflow.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
