# Changelog

## Unreleased

### Fixed
- **Dispatch over the 0.2.2-rc.2 host**: the host flattened `SubagentActivationSpec` (`extends Omit<SubagentStartRequest, 'label' | 'signal'>` — the start-request fields ride the spec itself), and the host implementation reads `spec.parent.id` / `spec.prompt` directly. The plugin's nested `request: { … }` block therefore caused a `TypeError` on every dispatch under rc.2 — invisible to repo typecheck because `DispatchHost` self-declared the nested shape. The call now feature-detects the host line via the `waitForTreeWork` surface (shipped with rc.2, absent on pre-rc.2 lines): rc.2 hosts get the flattened spec (with a never-aborted `signal` backing the now-required field when the caller supplies none), pre-rc.2 hosts keep the nested block — matching the peer floors (`>=0.2.0-rc.2`, unchanged). `DispatchHost`'s declaration is flattened to the rc.2 shape so a future host reshape is visible to tsc again.

### Changed
- Dev closure re-pinned to `0.2.2-rc.2`: devDependencies `dsh-agent` / `dsh-session` / `dsh-subagent` move `0.2.2-rc.1` → `0.2.2-rc.2` (official registry, lockfile advanced; the postinstall linker re-links `node_modules/@deepseek-ai/*` to the closure). Peer floors untouched.
- **ci.yml's newest-of(latest,next) comparator now mirrors publish.yml**: the rc segments compare NUMERICALLY per dot segment (`rc.10` > `rc.2` — the leftover plain string prerelease compare in ci.yml would have picked the OLDER rc once an index reaches two digits; publish.yml got the numeric form in 0.2.0).

## 0.2.1 - 2026-11-09

### Fixed
- Mark the `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-subagent` peers optional in `peerDependenciesMeta` per the optional-peer contract.

## 0.2.0 - 2026-11-06

### Changed
- **Dev closure re-pinned to `0.2.2-rc.1`**: devDependencies `dsh-agent` / `dsh-session` / `dsh-subagent` move `0.2.1-rc.5` → `0.2.2-rc.1`; `@deepseek-ai/cordis` follows the closure `4.0.5` → `4.1.0` (the 0.2.2-rc.1 packages hard-peer `cordis ~4.1.0`; resolved by the "dev pin follows the host closure" precedent). A repo `.npmrc` with `legacy-peer-deps=true` joins per the same precedent, so plain `npm install` no longer auto-installs the closure peers (e.g. `dsh-agent`'s `dsh-llm` peer) from the stable tower over the linked closure. Peer floors stay `>= 4.0.4` (cordis) — untouched; the host preflight satisfies ranges with `includePrerelease`, so the floors already match the new rc. The CI host-resolution step already resolves the newest of the `latest`/`next` dist-tags with the prerelease-aware comparator; publish.yml's leftover `sort -V` pick is now switched to the same compare (see below). Verified against a scratch 0.2.2-rc.1 host closure (the CI install shape): tsc check clean, 64 pass / 0 fail, boot smoke PASS on the real host.
- **publish.yml picks the host closure with ci.yml's prerelease-aware compare** — the leftover `sort -V` decision (which ranks an rc above a same-version stable once one lands on `latest`) is replaced by the same node comparator ci.yml uses, so the release gates against exactly the closure CI installs. Review hardening on top: the rc segments compare NUMERICALLY per dot segment (`rc.10` > `rc.2` — the plain string compare would pick the OLDER rc once an index reaches two digits; latent only, `latest` has always been a stable, and the pre-existing ci.yml copies keep the string form, so the two agree in practice today).

## 0.1.0 - 2026-11-04

Initial release: the declarative workflow plugin for dsh — recurring daily pipelines (release waves, migration waves, inspections) as named, reviewable, resumable YAML workflows running on the host's own subagent/jobs/approval primitives, zero core patches.

### Added

- YAML workflow loader with reference checking (`loader`, `refs`) — named, reviewable workflow files (`examples/` ships hello/fan/dsh-plugin-wave samples).
- Execution engine: durable, resumable runs over `ctx.subagents`/`ctx.jobs`/`ctx.approval` (`engine`, `dispatch`, `composition`, `repair`, `roster`).
- Monitoring: a durable Run Store with lifecycle events and per-agent cost accounting (`run-store`, `cost`).
- Presentation: the `/workflow` command family with a TUI widget — horizontal stage chain, per-step stats (rounds, tool calls, elapsed, token subtotal), needs graph drawn as a real tree (`commands`, `projection`, `tui-overlay`).
- Scheduling delegated to dsh-cron; config surface documented via the bundled `dsh-workflow-config` skill.

Licensed Apache-2.0 (appendix `Copyright 2026 fan56`); sole author, no NOTICE file needed.
