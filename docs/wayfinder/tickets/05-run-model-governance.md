---
status: closed
type: grilling
blocked-by: [01-host-primitives.md]
claimed-by: null
---

# run 模型与治理决策:前台后台/续跑/审批分级/保留

## Question

Run 的执行语义和治理参数怎么定?产出治理决策集,进 spec。

1. **前台/后台默认**:run_workflow 立即返回 jobId?`--wait` 语义与官方 tool 对齐到什么程度
2. **断点续跑**:step-level checkpoint(每步完成即落盘,重跑跳过已完成)vs effect cache——流水线场景选哪个?失败步骤的重试边界在哪(整步重跑 vs 步内幂等键)
3. **审批分级**:哪些 Step 类别要 `ctx.approval` 确认(外向动作:publish/tag/评论)、哪些免(本地只读/构建)
4. **run 保留策略**:maxRetainedRuns / prune 形态

## 素材

- 宿主原语实测票的产出(决策站在真实契约上)
- 147⭐ capsule 解剖票的产出(它的审批分级 approvalMode: never/generated-and-local/always 与 effect cache 作对照)

## 产出

治理决策集(HITL 拍板)→ spec 综合票。

## Resolution(2026-10-20,closed)

用户已委托拍板("这些不用我来选择")。治理决策集:

1. **前台/后台默认**:模型工具 `run_workflow` 与斜杠 `/workflow run` 都默认**后台**(立即返回 `{runId, jobId?}`),`wait: true`/`--wait` 才阻塞——固化流水线必然长,与官方 tool-workflow/147⭐ 语义一致。后台注册 `ctx.jobs`(kind `workflow`),依赖 profile 里 `dsh-jobs-local + dsh-tool-jobs` 成对挂载(01 票)。
2. **续跑 = step-level checkpoint**:每步终态即写 run store;resume 时 `completed` 步直接跳过。键=**稳定 step id**(foreach 展开体=step id + item 序号派生键)。per-step `cache`: `always | on-failure | never`,默认 `on-failure`;副作用步(publish/tag)用 `never + confirm`,不靠缓存假幂等。中断在步中间的工作不保留,整步重跑。
3. **审批分级**:`approval: side-effects(默认) | always | none`。步标 `confirm: true`(外向动作)执行前走 `ctx.userQuestions.ask` 一次性确认(命令/空闲场景,无 open-turn 约束);`ctx.approval.request` 只用于 turn 内工具审批语境(01 票定界)。
4. **并发**:`foreach.max-concurrency` 与全局默认 **4**(低于宿主 `maxActiveSubagents` 8 留余量),**workflow 层自行排队**——不赌宿主活跃路径超限行为(类型层语义不明,列为实现期实测项)。
5. **保留策略**:`maxRetainedRuns` 默认 100;终态 run 自动 prune;`/workflow prune` 手动清理;身份解析歧义 fail-closed(承 147⭐ 的 ambiguous 上报)。
6. **child persistence**:run 结束后 child Session **保留**(continuable 进父 catalog 是宿主既有行为,删除才是额外动作;成本 fold 也依赖它可读)。
7. **编排结束条件**:父收尾必须 `ctx.subagents.waitForChildren(parent)` + idle recheck(01 票),漏写会提前 teardown——写进 spec 执行层硬规则。
