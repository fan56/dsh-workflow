---
status: open
type: research
blocked-by: []
claimed-by: null
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
