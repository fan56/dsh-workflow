---
status: open
type: prototype
blocked-by: [02-capsule-anatomy.md]
claimed-by: null
---

# YAML schema v1 草稿:dsh-plugin-wave 真流程表达

## Question

双轨 YAML(结构声明 + 单步 Action)长什么样?能否**无损表达 dsh-plugin-wave 迁移流水线**?

1. 拿 dsh-plugin-wave 真流程(官方发新 RC → 全仓波次适配 → 发版收尾)写一份 `.workflow.yaml` 草稿:步骤图/依赖/重试/验收/registry agent 引用/1-2 处单步 Action
2. 字段命名与 147⭐ capsule 对照:借鉴不照抄
3. 顺带钉出 schema 必选/可选边界与校验规则草案

## 素材

- capsule 解剖票的产出(对照物)
- dsh-plugin-wave 流程:ZCode 侧 saved workflow 已固化(定稿保护/时长预算门控/wait-what 直白度等),但本票只取其**步骤骨架**做表达力测试,不迁移其领域逻辑

## 产出

示例 YAML + schema 草案 → 给用户过目拍板(HITL)。这是 YAML 双轨铁律的第一次实战检验。
