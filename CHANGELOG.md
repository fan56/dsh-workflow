# Changelog

## 0.1.0 - 2026-11-04

Initial release: the declarative workflow plugin for dsh — recurring daily pipelines (release waves, migration waves, inspections) as named, reviewable, resumable YAML workflows running on the host's own subagent/jobs/approval primitives, zero core patches.

### Added

- YAML workflow loader with reference checking (`loader`, `refs`) — named, reviewable workflow files (`examples/` ships hello/fan/dsh-plugin-wave samples).
- Execution engine: durable, resumable runs over `ctx.subagents`/`ctx.jobs`/`ctx.approval` (`engine`, `dispatch`, `composition`, `repair`, `roster`).
- Monitoring: a durable Run Store with lifecycle events and per-agent cost accounting (`run-store`, `cost`).
- Presentation: the `/workflow` command family with a TUI widget — horizontal stage chain, per-step stats (rounds, tool calls, elapsed, token subtotal), needs graph drawn as a real tree (`commands`, `projection`, `tui-overlay`).
- Scheduling delegated to dsh-cron; config surface documented via the bundled `dsh-workflow-config` skill.

Licensed Apache-2.0 (appendix `Copyright 2026 fan56`); sole author, no NOTICE file needed.
