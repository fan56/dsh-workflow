---
status: open
type: task
blocked-by: [01-host-primitives.md, 02-capsule-anatomy.md, 03-registry-agent-ref.md, 04-yaml-schema-prototype.md, 05-run-model-governance.md]
claimed-by: null
---

# spec 综合成文:开工级 SPEC.md + CONTEXT.md 定稿

## Question

把全部已决票汇总成**开工级 spec**:四层接口契约、YAML schema v1、Run Store 格式、命令族词表、里程碑切分。

- 产出 `docs/SPEC.md`(v0.1)+ CONTEXT.md 定稿
- 覆盖:执行层(引擎/run 模型/续跑)、监控层(事件词表/成本埋点/Run Store)、展示层(命令族+工具面)、调度层(dsh-cron 委托约定)、YAML schema、registry 引用契约
- closed 即到站:任何会话照 spec 直接开工写代码

用户过目拍板后关票(HITL 收尾)。
