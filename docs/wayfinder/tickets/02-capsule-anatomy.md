---
status: closed
type: research
blocked-by: []
claimed-by: fan56
---

# 社区 capsule 解剖:147⭐ 插件的五面做法

## Question

omdsh-dev/dsh_workflow(147⭐,npm `@dsh-external/workflow`)在五个面上的具体做法是什么?产出**借鉴/避开清单**。

1. **capsule**(`dsh.workflow` v1)schema 全貌:manifest/source/intent/inputs/requires/provenance 的字段与校验
2. **run store**:目录结构与 events.jsonl 事件词表
3. **effect cache 续跑**:键(调用序号+task input)怎么算、命中后怎么跳过、对流水线场景够不够
4. **命令族与三工具**:/workflow 命令 + workflow_list/run_workflow/workflow_manage 的注册方式与授权模型(一次性显式授权那套)
5. **Session 投影**:它怎么把 run 投影进 Session 事件/官方 UI 可观察性;QuickJS VM 的 capability RPC 面

注意:它 compatibility 锁 0.0.1-rc.2(2026-08-13 测),与 0.2.1-rc.2 的 API 差异只标注、不深挖(宿主原语实测票负责现版本事实)。

## 素材

- 本地浅克隆:/tmp/wf-survey/dsh_workflow(约 5435 行 TS,src/ 12 文件,README + docs/KODAX_PARITY.md + docs/CONFIGURATION.md)
- 若 /tmp 已清,重新浅克隆 github.com/omdsh-dev/dsh_workflow

## 产出

五面事实 + 借鉴/避开清单 → 喂给 YAML schema 草稿票(对照物)和 spec 综合票。

## Resolution(2026-10-20,closed)

完整报告:[../research/02-capsule-anatomy-findings.md](../research/02-capsule-anatomy-findings.md)。决议(借鉴 vs 避开):

**照抄**:
- capsule 侧三纪律:未知字段 fail-loud 白名单(`exact()`)、跨字段不变量、name/文件名互锁——我们的 YAML schema 同款。
- run store 布局:`run.json`(可重写快照)+ `events.jsonl`(append-only)+ 不可变定义快照 + `results/` + `artifacts/`;17 事件封闭词表思路;`denied` 单列状态;prune/retention;ambiguous 身份上报。
- 缓存写入门槛:completed+验证干净才入缓存、`origin: executed|replayed` 可审计、跨 run 继承二次质量过滤。
- 复用官方 `tool-workflow/*` Session 事件 + **`turn: null` Session 域**(后台 run 活过启动 step,防 UI 误标中断)+ start/end 成对不变量。
- 授权:模型工具走 `ctx.approval`、斜杠命令走 `ctx.userQuestions.ask` 的分工;三级 approvalMode 分层;能力缺失 fail-loud 绝不静默降级。
- 保存/替换原子发布 + `.archive` 血缘;注册名用不冲突的独立 service 名(同款"加装不占位")。

**避开**:
- QuickJS WASM + 静态策略整层(占其代码 ~1/5)——YAML 双轨无脚本执行面,整体省去;effect cache 的"整段脚本重放+调用序号"模型——改用**稳定 step id 为键 + 显式 per-step cache policy**(always/if-failed/never),它的模型改一行脚本全废、分支漂移即错位。
- capsule 单体 JSON 塞 JS 源码(可读性/diff 双差);封闭 pattern 枚举与 model-hint 三档进 schema(分类学负担);scout-then-author 生成管线与 handoff 授权状态机(我们声明式路线不需要)。
- 它的实现债引以为戒:emit 全量重投影 O(n²)(我们要增量投影+快照节流)、双份同义命令面(工具为规范入口,斜杠命令只做薄别名)、宿主版本特化补丁散落(收敛到薄 adapter)、per-host workaround 随升级腐烂。
