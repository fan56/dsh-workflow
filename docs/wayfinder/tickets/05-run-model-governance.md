---
status: open
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
