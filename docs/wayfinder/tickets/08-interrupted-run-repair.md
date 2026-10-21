---
status: open
type: grilling
blocked-by: []
claimed-by: null
---

# 被打断的 Run 如何借宿主能力修复(L1 结局修补 + L2 步内续聊)

## Question

Workflow 中途被打断(进程重启/崩溃/手动中断)后,如何借用 dsh 的天然能力
把 run 修复到可继续,而不是从头重跑?

**三层修复模型**(用户讨论定调,2026-10-21):

- **L0 崩溃安全(已有)**:步终态即 checkpoint(results/<stepId>.json),
  resume 重放 completed 步
- **L1 结局修补(待建)**:resume 时对无终态记录的步,用 label
  `[wf] <runId>/<stepId>` 反查 child 会话,读其 `turn/end` reason——
  completed → 修补 run.json(该步其实完成了,产出从 child 日志捞回,零重跑);
  aborted/error → 交 L2 决策。宿主能力:subagent catalog/sessions.get/
  readStoredEvents + turn/end→stopReason 映射(registry 已验证)
- **L2 步内续聊(待建)**:中断步不重跑,向同一个 continuable child
  sendMessage 继续(子代理带原上下文接着干)。可选字段 `resume-mode: continue`
  (缺省 L3 整步重跑)。宿主能力:continuable child + ctx.agents.resume/
  sendMessage + 冷恢复
- **L3 整步重跑(已有)**:cache: never / 兜底

## 素材

- 票 01:child 无条件 continuable+进父 catalog;ctx.sessions.get(childId)
- 票 03:label 命名空间 `[wf] <runId>/<stepId>`(寻址已具备);registry
  resume.ts 的 readStoredEvents/turn/end 映射(findResumableRun 先例)
- 宿主:ctx.subagents.listChildren / ctx.agents.resume / sendMessage

## 产出

L1/L2 的执行契约(resume 命令的决策树、child 反查 API 链、修补写回格式)
→ 实现进 resume 路径。
