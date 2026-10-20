---
status: closed
type: research
blocked-by: []
claimed-by: fan56
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

## Resolution(2026-10-20,closed)

完整报告:[../research/03-registry-agent-ref-findings.md](../research/03-registry-agent-ref-findings.md)。决议:

1. **路线 A:v1 自建 dispatch**——只依赖官方缝 + `~/.dsh/agents/*.md` 目录,自带 ~80 行 parser 副本(dsh-tui-pi 先例),**不依赖 registry 插件挂载**;长期(路线 B)推 registry 上游补 `listAgentFiles`/dispatch 导出后切换;否决模拟调 `use_agent`(无干净跨插件调用面)。
2. **引用语法**:`executor.agent: <name>` 引用**文件身份 name**(永不用 display_name,歧义 fail-closed);v1 契约**不设** `executor.preset`/`executor.tools`(presentAs 两向断裂的雷);可选 `model/thinking/output` 运行时覆盖。
3. **两层解析**:load 时 lint(存在性校验,roster-aware 报错,不构成 run 时保证);run 时每个 step 派发前**权威重读**(call-time 重读惯例),文件消失/broken → step fail-fast 不进 retry。
4. **避雷三条**:child label 用 `[wf] <runId>/<stepId>` 命名空间(裸 agent 名会被 use_agent auto-resume 认领);maxDepth 永远显式传 `resolveChildDepth(parent)+deep`(不吃宿主默认 1);0.2.1 线 persona 落地复刻 registry 的寄存 Map+`subagent/start` 边外科手术(公开 API 足够,~60 行)。
5. **派发口**:`ctx.subagents.startActivation({..., delivery: 'caller'})`——README 明说这是给 workflow 留的口子(await 结果、无 parent notice)。
6. **遗留给其他票**:① `delivery:'caller'` 的 child 持久化语义 → 票 01 钉;② `maxActiveSubagents` 默认 8、超限 `ACTIVATION_LIMIT_REJECTED` → 票 05 治理(上限+retry 识别);③ registry 键 `displayName` 驼峰静默失效(dsh-ptc-subagent 现行 bug)顺手修;④ `xhigh` 文档缺口提醒上游。
