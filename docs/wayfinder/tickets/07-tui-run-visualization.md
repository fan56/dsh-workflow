---
status: open
type: prototype
blocked-by: []
claimed-by: null
---

# tui 的 run 级可视化:workflow-run 节点或面板

## Question

tui(我们的 dsh-tui-pi,主力 UI)当前对 workflow 的可见性只有**成员级**:
`foldTracked` 消费 `tool-workflow/agent-start|end`(我们 M2 写的同款事件),
把子代理注册进 `agentViews`,在子代理面板(Ctrl+G)渲染
`[wf] <runId>/<stepId> | ✅ | 输出预览`——**已真机眼验**(冒烟 adapt#0 ✅ ACK)。

缺的是 **run 级**视图:run-start/run-end 折叠节点、fan-out 汇总
(total/completed/failed)、每 run 成本汇总。官方 web 有 workflow-run 节点
(dsh-client-ui-workflow-run),tui 没有。

怎么补?两条路:
A. **会话内 run 节点**:tui-pi 会话渲染把 run-start→run-end 之间的成员行
   折叠成一个 `workflow-run` 摘要行(官方 web 节点的 tui 版)。
B. **常驻面板**:activity panel 套路的 workflow 面板(活动 run graph)。

## 素材

- ~/repo/dsh-tui-pi/src/dsh-events.ts(事件类型与守卫已齐)
- ~/repo/dsh-tui-pi/src/session.ts `foldTracked`/`agentViews`(成员注册与配对,1633+)
- ~/repo/dsh-tui-pi/src/live-widgets.ts:336(delegation 工具行)
- 本插件写的事件:src/projection.ts(run-start/agent-start/agent-end/run-end)

## 产出

方案原型(用户反应后定 A/B)+ tui-pi 仓内的落点清单。
用户已定调:tui 是主力 UI,这一环重要。

## Resolution(2026-10-21,方案拍板——用户定:专门 widget+文本流程图)

**形态**:tui-pi 第四个常驻 widget(挂 todosDoc 槽,与 Todos/Think/Tool 并列)。
- **Mini 模式**(默认):单行,有活动 run 才出现——`▸ workflow: <name> ▶ <当前步> ▦ m/n ✓ · <tok>`
- **Graph 模式**(快捷键进 overlay):分层 DAG 文本流程图。needs 拓扑分层;状态符 ○/▶/✅/↻/✗/⏭/?;foreach 聚合双线框 `▦ m/n ✓` 可展开子行;执行点粗框+视口自动居中(f 可锁/解锁);↑↓←→ 漫游;Enter 步详情(输出/token/错误)
- **数据源零新协议**:图=cwd 下 run store 的 workflow.yaml 快照,直接 import 同 profile 的 @aiwayds/dsh-workflow `loadWorkflow`(纯函数);执行态=session fold(agentViews,已有)+run.json 尾随
- **落点**:tui-pi 仓 src/workflow-widget.ts + todosDoc 第四槽 + Ctrl+W(占位)
- **实施注意**:本插件 run-store 的 run.json 需在 begin 落 name(YAML 快照旁);foreach 子步 id 含 `#`,渲染层按 `#` 折叠
