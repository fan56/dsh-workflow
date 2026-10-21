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
