# CONTEXT — Domain Glossary

Draft glossary for the dsh-workflow plugin. Terms only; no implementation detail.
Status: charting phase — decisions live in the [wayfinder map](../../issues) until the spec lands.

## Terms

- **Workflow** — A named pipeline that turns a recurring piece of daily work into a runnable, reviewable asset. The thing being 固化 (made durable) by this plugin.
- **Step** — One unit of a Workflow. Declares its executor, inputs, retry policy, and acceptance check. Completion of a Step must be objectively judgeable.
- **Action** — A JavaScript snippet allowed *only inside* a single Step. The only place imperative code may appear in a Workflow.
- **YAML** — The structural source of truth for a Workflow: step graph, dependencies, retries, acceptance. Imperative logic never lives here. Import/export is copying the file.
- **Registry Agent Ref** — A Step executor that names an agent definition from [dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) instead of carrying a raw prompt.
- **Run** — One execution of a Workflow. Has a stable id, a lifecycle state, and a durable record that survives restarts.
- **Run Store** — The on-disk record of Runs: state, events, and per-agent cost. The single source a Monitor projects from.
- **Monitor** — The layer that projects run/step/agent lifecycle plus per-agent cost into the Run Store.
- **Command Family** — The `/workflow` command set (list / runs / show / stop / …) registered by the plugin; works in tui and web alike.

## Hard rules (decided)

1. YAML declares structure; Actions live only inside Steps; Steps never share script state with each other.
2. The plugin is an official bundle form with zero core patches. It composes host primitives (`ctx.subagents`, `ctx.jobs`, `ctx.approval`, `ctx.userQuestions`, Session events); it does **not** claim `ctx.workflowEngine`.
3. The host's own `workflow` tool stays untouched: one-off orchestration belongs to it; durable pipelines belong to this plugin.
4. Scheduling is delegated to dsh-cron; this plugin is on-demand only in v1.
