---
status: open
type: research
blocked-by: []
claimed-by: null
---

# registry agent 引用:步骤→roster 执行契约

## Question

workflow Step 怎么**指名 dsh-subagent-registry roster 里的 agent 定义**并让它执行?产出执行契约草案(引用语法、解析路径、失败语义)。

1. registry 的 preset/agent 定义数据形状与程序化消费路径(记忆线索:程序化读 preset 走 sessionQuery projection,别从 persistence.list() 裁剪 header 读)
2. spawn 接线:把 registry agent 变成 subagent 请求时,preset 层 presentAs 在 rc.2 只有部署级生效的雷( dsh-ptc-subagent 的关键实证)对本插件意味着什么
3. 引用解析时机:workflow load 时校验存在性 vs run 时解析,失败语义各是什么

## 素材

- ~/repo/dsh-subagent-registry(本仓,v0.14.1,前台标签前缀 [fg] 等接线惯例)
- ~/repo/dsh-ptc-subagent 的 preset 层与 agents/ptc-subagent.md 派发定义

## 产出

执行契约草案 → 喂给 YAML schema 草稿票(引用字段设计)和 spec 综合票。
