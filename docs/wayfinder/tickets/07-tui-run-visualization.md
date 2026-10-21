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

## Amendment(2026-10-21,架构反转——用户拍板)

Widget 所有权归 **dsh-workflow 插件**,不在 tui-pi 硬编码。dsh-workflow 启动时
检测用户是否装了 tui-pi(检测方式=tui-pi 暴露的通用 widget 缝服务是否存在),
装了就注册 widget,没装就静默(命令族照用)。功能跟着能力走,tui-pi 保持通用。

**tui-pi 侧(通用缝,零 workflow 知识)**:新服务 `tuiWidgets`(cordis augmentation):
`register({ id, mini(): string[]|null, overlay?: { title, render(w,h): string[], onKey, close } })`;
todosDoc 渲染循环改遍历注册表(现有三面板成为注册表头三目);overlay 行数组协议
→ dsh-workflow 零 pi-tui 依赖。

**dsh-workflow 侧(widget 全量)**:`src/tui-widget.ts`——检测服务→注册
mini(单行)+graph overlay(分层 DAG 文本图+漫游+步详情)。数据全自持:
自家 Run Store 的 workflow.yaml(loadWorkflow 直调,不再跨包 import)+
自家事件订阅+自家 run.json 成本。
**时序**:bundles 树序 tui-pi 在前;保险=服务未就绪挂 added 类事件等一步(registry provider-added 先例)。

**分工**:tui-pi 开缝(小,通用资产)→ dsh-workflow 写 widget(大,本仓所有权)。

## Implementation(2026-10-21,mini widget 已上线真机验收;graph overlay 二期)

**通道反转(cordis 服务缝 → 文件缝,真机实证)**:cordis 的 provide 是**作用域私有**
——tui-pi 在自己插件 scope provide 的 `tuiWidgets`,兄弟插件(dsh-workflow)的
`ctx.get` 返回 undefined(三次真机实证,读/写守卫之外第三道墙)。缝改为**文件协议**:

- dsh-workflow 写 `$DSH_HOME/tui-widgets/dsh-workflow.lines`(run/step 每次状态
  变化即写;内容=mini 行;settled 后 60s 定时清文件,unref 定时器)
- tui-pi 渲染该目录下所有 `*.lines`(`ExternalWidgetFile`,mtime 变化重读,
  `#` 行为元数据跳过;零 workflow 知识,纯行渲染器)

**真机验收**:fan 流水线跑通,TUI 输入框上方渲染
`▸ workflow: fan ▶ 0/1 ▶1 ▸ seed` → 实时变 `✗ 0/1`(状态实时);widget 文件
与 run store 双落盘。所有权拍板不变:内容与时机 100% 在 dsh-workflow。

**二期(Graph overlay)未做**:分层 DAG 文本图+漫游+步详情——设计已定
(本票 Resolution),待 mini 用出体感后开工。

cordis 作用域三墙(踩雷账补全):读守卫(inject)、写守卫(provide)、
**兄弟 scope 隔离**(provide 的服务跨插件不可见)。
