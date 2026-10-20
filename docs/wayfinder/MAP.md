# Wayfinder Map:dsh-workflow 插件开工级 spec

> 本地图承载于本地 markdown(用户拍板,GitHub issues 已作废关闭)。
> 约定:票在 `tickets/` 下,frontier = `status: open` 且所有 `blocked-by` 已 `status: closed`;
> claim = 把票文件头的 `claimed-by` 改成自己再动手;决议写进票文件尾部「## Resolution」段并置 `status: closed`。

## Destination

一份 dsh-workflow 插件的**开工级 spec**:CONTEXT.md 域词汇定稿、四层(执行/监控/展示/调度)架构与接口契约、YAML schema v1、命令族词表全部落定在本仓内——任何会话照 spec 直接开工写代码,无需再做决策。

## Notes

**立场**:不与任何社区/官方实现竞争。官方 `workflow` 工具管一次性编排,本插件管固化流程;官方 bundle 形态、零核心 patch、不占 `ctx.workflowEngine` 缝。

**已拍板(开图会话,2026-10-20)**:
- 目的地 = 开工级 spec(不带到发版)
- v1 验收对象 = 结构化流水线,首发固化 `dsh-plugin-wave` 迁移流水线
- 执行层 = 自建编排 bundle:组 `ctx.subagents` + `ctx.jobs` + `ctx.approval` 原语,自己的命令族与工具面
- YAML = 双轨:结构声明(步骤图/依赖/重试/验收)为真源,Action 只许在单步内部,步骤间禁共享脚本状态
- 监控层 = 生命周期 + 每 agent 成本埋点;子代理中间输出不进监控流
- 展示层 = 命令族先行(tui/web 通吃),常驻面板进雾
- 调度层 = 委托 dsh-cron,v1 仅 on-demand
- 生态接线 = 仅 registry agent 引用(dsh-subagent-registry);approval 走官方 `ctx.approval` 不特判;feishu 留缝不实现
- 仓 = fan56/dsh-workflow(private,发 v0.1 时拍板转 public),npm `@aiwayds/dsh-workflow`
- 宿主基线 = 0.2.1-rc.2;仓产物(commit/README/注释)英文,本图与票中文

**tracker 约定**:本地 markdown(见文首);grilling 票同时挂 grilling + domain-modeling 技能。

## Decisions so far

<!-- 每关一张票在此加一行: [票名](tickets/xx.md): 一句话答案 -->

## Not yet specified

- tui 常驻面板:run graph 实时显示(activity panel 同款套路)——等命令族落地后看真实痛点再立
- 调度层细则:cron→workflow 的调用约定形态、触发器语义(委托 dsh-cron 已定,约定未定)
- feishu 通知缝:run 终态推送的事件口最终形态
- workflow 版本化与 revise:保存后的 workflow 怎么修订、旧 run 引用哪个版本
- 多 workflow 组合/嵌套:一个 workflow 引用另一个
- 全局 token budget:跨 run 的预算词汇
- web 端展示形态
- 固化 workflow 的分享/分发:要不要可发布(发包/导出给别人)
- 宿主升级兼容策略:0.2.1-rc.2 → 正式版的 API 漂移跟法

## Out of scope

- 与社区插件(147⭐ @dsh-external/workflow、dsh-workflow-lite、dsh-workflow-isolate)的功能对标竞争——只借鉴不赛跑
- 替换或修改官方 workflow 工具/引擎/seam 契约
- 宿主核心 patch(坚持官方 bundle 形态)
- 多租户/团队治理(这是单人工具,治理面只到审批分级为止)
