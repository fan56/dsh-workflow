---
status: closed
type: research
blocked-by: []
claimed-by: fan56
---

# 宿主原语实测:0.2.1-rc.2 的执行层地基

## Question

在 `@deepseek-ai/dsh` **0.2.1-rc.2** 上,自建编排需要的宿主缝真实契约是什么?产出一份**接口事实清单**(带包名/类型名/文件路径),每项标注证据等级(类型签名实测 vs 文档推断)。

需要钉的面:

1. **ctx.subagents**:spawn/fork provider 的程序化调用面(插件代码怎么发起 child)、continuable catalog 语义(child 完成后进不进父 catalog、可否续聊)、usage(token/模型/时长)从哪里拿、provider 注册点
2. **ctx.jobs**:注册 owned job、output ring、job_kill/stop 控制面的最小用法
3. **ctx.approval** 与 **ctx.userQuestions.ask**:插件发起一次审批/一次性确认的正确姿势
4. **Session 事件写面**:插件自定义 Session 事件(官方 tool-workflow/run-* 同款机制)怎么声明和写入
5. **命令注册**:插件注册 /workflow 式命令族的工具面(tui/web 通吃那条路)

## 素材

- 宿主本机安装:/opt/homebrew/lib/node_modules/@deepseek-ai/dsh(node_modules/@deepseek-ai/ 下各包 .d.ts 是第一证据)
- 官方仓 master:github.com/deepseek-ai/deepseek-harness(docs/subsystems/、docs/cordis-api/)
- 相关记忆线索:rc.2 增补 userQuestions.ask/profile 系统;宿主 API 地图见 dsh 宿主插件 seams

## 产出

接口事实清单 → 直接喂给 run 模型与治理决策票和 spec 综合票。

## Resolution(2026-10-20,closed)

完整报告:[../research/01-host-primitives-findings.md](../research/01-host-primitives-findings.md)。六面全部钉死,决定性事实:

1. **派发口钉死**:`ctx.subagents.startActivation({provider, label, childId?, request:{prompt, parent, agentOptions?, outputSchema?, maxDepth?}, signal, delivery})`;官方 workflow-ptc 的 `startChild()` 就是同款范本【实现级证据】。`parent` 必须是精确存活 Agent(否则 `UNAUTHORIZED`)——command handler 的 `invocation.agent` 满足。
2. **continuable 语义钉死(回答票 03 遗留①)**:spawn/fork 都走 `startLocal`,child **无条件进父 catalog 且 continuable,与 delivery 无关**;`delivery:'caller'` 只是不通知父模型+persistence 可选。child Session 可 `ctx.sessions.get(childId)` 读——成本埋点与事后查看都有路。
3. **usage 现状(决定监控层设计)**:`SubagentResult`/`subagent/end` **都不带 token**;usage 要自己 fold child Session 的 `assistant/message.usage` + `request/header`(模型路由);时长有 `subagentTiming` projection(settledMs);`sessionStats` projection 无总 token 字段。→ 每 agent 成本埋点=纯自建 fold,写进 spec。
4. **jobs 最小用法钉死**(与 tool-workflow 逐字段同款):`ctx.jobs.start({kind:'workflow', label, owner, run(job){return {cancel, done}}})`,`JobOutcome.result` 是一次性交付返回值;硬门槛=依赖 profile 里 `dsh-jobs-local + dsh-tool-jobs` 成对挂载(controller 已由 tool-jobs attach),本插件不自 attach。
5. **审批双通道定界**:`ctx.approval.request` 要 **open turn**(命令 handler/空闲期会 reject);一次性确认走 `ctx.userQuestions.ask`(无 turn 要求,注意 `DELEGATED_CALLER`:owned child 问不到人会 block)。
6. **命令注册面钉死**:`ctx.commands.register({name:'workflow', handler(invocation)})`,宿主根 ctx 注册即全局,tui/web 通吃(实证:tui-pi 与 web client-ui-commands 都只是该 registry 的消费者)。
7. **Session 自定义事件**:module augmentation `SessionEventMap` + `session.append`;`appendPluginRecord` 第三方禁用(gate 拒绝);recorder 对 append 失败要 warn+降级(tool-workflow 同款防御)。
8. **bundle 挂载三层**:`package.json dsh.bundle.patch` + patch 里**显式 `insert` 自己**(不会被自动挂载)+ entry id 跨层唯一;层叠顺序 bundle patch→profile patch→overlay。

**遗留给治理票(05)**:① fan-out 并发容量:活跃路径的 `maxActiveSubagents`(默认 8)超限行为类型层不明(排队/拒绝),需实现期实测;② child persistence 前提升与否(run 完 child 会话留不留)要拍板;③ `waitForChildren(parent)`+idle recheck 是编排结束条件的正确写法,漏写会提前 teardown。
