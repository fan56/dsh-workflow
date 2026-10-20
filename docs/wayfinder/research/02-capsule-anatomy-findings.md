# Findings:社区 capsule 解剖(票 02)

> Research 报告全文(2026-10-20,只读调研,素材=/tmp/wf-survey/dsh_workflow 浅克隆,插件版本 0.1.2,pin DSH 0.0.1-rc.2)。决议 gist 见 `../tickets/02-capsule-anatomy.md` 的 Resolution 段。

## 一、capsule(`dsh.workflow` v1)schema

**证据文件**:`src/types.ts`、`src/capsule.ts`、`src/source-policy.ts`、示例 `examples/review.workflow.json`

### 1. 顶层信封(capsule.ts:220-239)
- 固定三元组:`format: 'dsh.workflow'`、`version: 1`、`workflowApiVersion: 1`(capsule.ts:8-10 常量,任一不符即抛错)。
- **必选**:`minDshVersion`(非空 string)、`manifest`(对象)、`source`(非空 string,脚本源码内嵌 JSON)。
- **可选**:`intent`、`inputs`、`requires`、`provenance`。
- **未知字段即失败**:`exact()` 白名单校验(capsule.ts:21-25),顶层允许键恰为 `['format','version','workflowApiVersion','minDshVersion','manifest','source','intent','inputs','requires','provenance']`。

### 2. manifest(types.ts:38-50,capsule.ts:118-156)
- 必选:`name`(kebab-case,`/^[a-z][a-z0-9-]{0,63}$/`,capsule.ts:12)、`description`、`phases`(非空 string[])、`readOnly`(bool)、`maxAgents`、`maxConcurrency`、`patterns`(非空,必须是 6 个封闭枚举之一:classify-and-act / fan-out-and-synthesize / adversarial-verification / generate-and-filter / tournament / loop-until-done,types.ts:8-15)。
- 可选:`plannedAgents`、`tokenBudget`、`mayUseWorktree`、`inputSchema`。
- **交叉不变量**(capsule.ts:136-139):`plannedAgents <= maxAgents`、`maxConcurrency <= maxAgents`,且不得超过部署天花板(limits.maxAgents/maxConcurrency)。

### 3. inputSchema(受限 JSON Schema 子集,capsule.ts:75-116)
- type 仅限 `object|array|string|number|integer|boolean|json`;`enum` 只支持 string 且非空;`const` 只支持原始值;object 的 `required` 不得指向未声明属性;`additionalProperties` 仅 bool。未知键仍被 `exact()` 拒绝。运行时用 `validateWorkflowArgs` 对 args 做递归校验(capsule.ts:241-272,engine.ts:522 启动前调用)。

### 4. intent / inputs / requires / provenance
- `intent`(types.ts:52-58):`taskClass` 必选;可选 `patterns`/`originalRequest`/`reusableFor`/`notFor`。revise 时用 `intent.originalRequest` 作为再生成输入(service.ts:168)。
- `inputs`(types.ts:60-63):`description` 必选,`examples?` 每项须过 `validateJson`(拒绝 undefined、非有限数、`-0`、稀疏数组、循环引用、深层嵌套>200,capsule.ts:62-73)。
- `requires`(types.ts:65-72):`environment?` 仅 `'git-repo'|'worktree-capable'`;`tools?/mcp?/skills?` 是部署能力清单名字,在 preflight 逐条对照 `availableTools/availableMcp/availableSkills`,缺了直接 fail(engine.ts:505-511);`modelTiers?` 仅 fast/balanced/deep;`userInteraction?` bool(要求 userQuestions 服务存在)。
- `provenance`(types.ts:74-82):出现即要求 `createdAt/dshVersion/pluginVersion` 三个必选;`fromRunId/fromWorkflowName/revisionOf/replacesWorkflowName` 可选,构成"从 run 保存 / 修订"血缘(service.ts:212-225 saveRun 注入)。

### 5. source 校验(source-policy.ts)
- 形状:必须匹配 `async function run(wf, args)`(source-policy.ts:81-83)。
- 静态拒绝表(先剥字符串/注释字面量再正则,source-policy.ts:13-26、28-77):import/require/process/fs/child_process/shell(exec/spawn)/fetch/WebSocket/XHR/Deno/Bun/timer/`globalThis[`/`__dsh*`内部桥/`eval|Function|constructor|__proto__`。
- 质量 lint(source-policy.ts:101-113):`NO_AGENT_WORK`、`UNBOUNDED_LOOP`(唯一硬失败)、`UNOBSERVED_TASK`、`UNAWAITED_AGENT`。
- 加载侧锁(catalog.ts:91-93):`manifest.name` 必须与文件名一致;文件 ≤ `maxCapsuleBytes`(默认 512KB,index.ts:82)。

## 二、run store

**证据文件**:`src/store.ts`、`src/service.ts`、`src/engine.ts`

### 1. 目录结构(store.ts:87-133,README.md:126-133)
- 根目录默认 `.dsh/workflow-runs`(index.ts:78);绝对路径配置时按 `sha256(canonical cwd)` 分区(service.ts:51-53、302-312),并写 `.project.json` 所有者标记,跨项目复用直接拒绝(store.ts:69-81)。
- 每个 run 目录:
  - `run.json`——整个 `WorkflowRunSnapshot`,**每次 emit 都重写**(engine.ts:727-730 persist);
  - `events.jsonl`——append-only,单行 `{seq,time,type,data}`(store.ts:98-102);
  - `workflow.workflow.json` + `script.js` + `manifest.json`——生成型 run 的不可变脚本快照(store.ts:110-114);
  - `results/`——effect cache,文件名 `<sha256(input)[0:32]>-<occurrence>.json`(store.ts:94、116-119);
  - `artifacts/`——名字清洗 + sha256 前 16 位后缀,`wx` 独占写、同名拒绝(store.ts:34-38、103-109)。
- 防逃逸:`SAFE_ID`/`contained()` 校验 runId 与路径不越根(store.ts:11-24)。

### 2. events.jsonl 事件词表(types.ts:267-271)
`workflow-started | workflow-log | workflow-completed | workflow-failed | workflow-stopped | phase-started | phase-completed | agent-started | agent-completed | agent-message | synthesis-started | synthesis-completed | nested-started | nested-completed | artifact-written | workflow-paused | workflow-resumed | cache-hit`,共 17 个,封闭枚举。

### 3. 状态机(types.ts:22-23,engine.ts:604-714)
- run 状态:`running → paused/completed/failed/denied/stopped`;`TERMINAL = {completed, failed, denied, stopped}`(store.ts:12)。
- 转移规则:
  - `pause` 仅从 running,`resume` 仅从 paused(engine.ts:604-620);暂停是协作式闸门——新 task 启动前与信号量放行后两次 `waitAdmission`(engine.ts:848-853、1067-1072),已在跑的子 Agent 不冻结。
  - `stop` → `stopped` + abort controller + 取消所有 running 子 Agent(engine.ts:622-636)。
  - 审批拒绝 → `denied`(engine.ts:645-651)。
  - 异常:若已 abort 则 `stopped`,否则 `failed`(engine.ts:679-684)。
- task 状态多一个 `completed_unverified`(验证有 warning 时降级,engine.ts:1335)。
- 身份解析:runId 精确命中,否则按 `displayName` 别名匹配,多个则报 ambiguous(store.ts:164-173);rerun 时 run 与 saved name 重名也报 ambiguous(service.ts:191-192)。
- 保留策略:finish 时按 `maxRetainedRuns`(默认 500)自动 prune(engine.ts:705);`delete` 拒绝非终态(force 仅限重启后的僵尸记录),活动 run 即使 force 也不能删(service.ts:182-185)。
- 终态产出两份投影:`WorkflowCostReport`(墙钟/agents/cacheHits/tokenUsage/peakConcurrency,engine.ts:688-698)与 `WorkflowOutcome`(status: completed|partial|failed|interrupted + coverage/unresolved/errors,engine.ts:807-846)。

## 三、effect cache 续跑

**证据文件**:`src/engine.ts:1001-1056、1342`、`src/store.ts:116-131`、`src/service.ts:188-210`

### 1. 缓存键
`cacheKey = sha256(JSON.stringify(cacheIdentity)).slice(0,32) + '-' + occurrence`(store.ts:116-119)。`cacheIdentity`(engine.ts:1019-1025)包含:
- `version: 2`;
- `workflow: {manifest, source}`——**整个工作流声明+脚本源码**;
- `runtime: {pluginVersion, dshVersion, verificationAdapter.cacheIdentity}`;
- `routing: {defaultProvider, modelTiers, readOnlyPolicy}`——含解析后的只读工具过滤;
- `input`——该次 spawn 的完整 task input。

"相同调用序号"= `cacheOccurrences` Map 对同一 identity 基串的第 N 次调用计数(engine.ts:1026-1029),序号拼进键尾。即:同一脚本里第 2 个完全相同的调用与第 1 个不共享缓存。

### 2. 命中怎么跳过
- 仅当 `resumeFromRunId` 非空才查缓存(engine.ts:1030;入口是 `workflow_manage` 的 `resume-run` / `rerun(..., resume=true)`,service.ts:206-209)。
- 查找顺序:本 run 的 `results/` → 前序 run 的 `results/`(store.ts:120-130)。**跨 run 继承有质量门槛**:只有 `status === 'completed'` 且 `verificationWarnings` 为空才允许继承,并复制进本 run 目录(store.ts:127-128)。
- 命中后 task 直接以 `origin: 'replayed-from-cache'` 落位,不派发子 Agent,发 `cache-hit` 事件(engine.ts:1031-1041);ProcessSnapshot 的 `progress.replayedAgents` 统计重放数(engine.ts:802)。

### 3. 失败步骤怎么处理
- **只有"completed 且零 verification warning"的结果写缓存**(engine.ts:1342)。failed / stopped / `completed_unverified` 一律不缓存 → resume 时真实重跑。
- 续跑本质是**整个脚本从头重新执行**:靠 VM 确定性(Math.random/Date.now 禁用)+ 调用序号对齐,让已完成步骤变 cache-hit、未完成步骤真实执行。`runAgent` 对普通失败返回 `null` 让脚本降级(engine.ts:903-912),handle 式 `wait` 保留完整失败结果。
- 中断在步骤中间的工作(子 Agent 被 dispose)不保留,只能整步重来。

### 4. 对发版流水线场景的评估
**够用的部分**:幂等重放有明确门槛(completed+验证干净才缓存)、有 origin 标记可审计、键里含运行时与只读策略版本(换环境不会误命中)。
**不够的部分**:
- 键含整个 source+manifest,**改一行脚本即全量失效**;
- 序号对齐要求重放时调用序列完全一致,脚本里任何非确定分支(含读取外部状态导致的分支漂移)会让缓存错位——无"稳定 step id"概念;
- 对有真实外部副作用的步骤(发布/部署),缓存只是唯一幂等保障,**没有向子步骤下发幂等键/事务语义**;一个"已执行但结果未落缓存"的副作用步骤(如写缓存前崩溃)会重复执行;
- 没有 per-step 的 cache policy(强制重跑/永不缓存)开关。

## 四、命令族与三工具

**证据文件**:`src/index.ts`、`src/service.ts`、`src/engine.ts:645-653、709-714`、`src/catalog.ts:178`

### 1. /workflow 命令族
- 注册:`ctx.inject(['commands'], child => child.commands.register({ name: 'workflow', ... }))`(index.ts:674-680),handler 走 `command()` 分发(index.ts:459-579)。
- 子命令(HELP,index.ts:439-457):`help / list / create <request> / review [base|sha <hash>] [--lean] [--risk] [--requirement] [--test-evidence] [--wait] [-- <focus>] / <name> [JSON args] / runs [--all|--limit N] / show [--full] / pause|resume|stop / rerun|resume-run [--wait] / save / rename-run / rename-saved / revise [--replace] / delete-run / delete-saved / delete [--run|--saved] / rename / prune [--dry-run|--keep|--older-than]`——约 20 个词位。
- 未知名词或 `create` 走 handoff 模式(index.ts:199-225):把 authoring contract 作为 plugin context 注入、用户原话作为真正的 user message `steer` 回当前 Agent,并在 `WeakMap<Agent, messageId>` 记一次性授权;`--wait` 明确拒绝(authoring 归当前 turn)。

### 2. 三工具(index.ts:581-666)
- 注册方式:`installSurfaces()` 内三次 `ctx.tools.register(defineTool({...}))`,工具名可配置(`listToolName/runToolName/manageToolName`,默认 `workflow_list/run_workflow/workflow_manage`,index.ts:79-81)。
- `workflow_list`:无参,列 built-in/pattern/project/personal,无效条目报错但不执行。
- `run_workflow`:参数 `name|request|source` **三选一强制**(index.ts:609-610),外加 `manifest/args/wait/background(废弃)/save_scope`;三种模式=跑命名 / scout-then-author 生成 / inline source+manifest 执行。
- `workflow_manage`:`action` 枚举 14 个动作(runs/show/pause/resume/stop/rerun/resume-run/save/rename-run/rename-saved/revise/delete-run/delete-saved/prune,index.ts:638)。

### 3. 授权模型
- 三级 `approvalMode`:`never | generated-and-local | always`(默认 generated-and-local,index.ts:105)。判定(engine.ts:709-714):`requireApproval` 显式覆盖;`always` 恒批;`generated-and-local` 只对 `capability-generated` 与 `trusted-local` 批。
- 引擎审批走 `ctx.approval.request({toolName:'run_workflow', ...})`,非 `allowed-once` → run 进 `denied`(engine.ts:645-653)。斜杠命令走 `ctx.userQuestions.ask` 的 Run/Cancel 二选(service.ts:235-242)。模型工具默认立即返回 `{runId,status,jobId?}`,`wait:true` 才阻塞(index.ts:169-175)。
- **一次性显式授权**(README.md:83):handoff 授权只被"本 turn 第一个通过 pre-launch 冒烟校验(smokeWorkflowCapsule,author.ts:320-332)的 inline workflow"消费;脚本或字段无效时报精确错误且授权保留供修正重试;relay、后续用户消息、重复调用不可复用。但 `approvalMode: always` 与 trusted-local 审批不被绕过(index.ts:627)。
- trusted-local(`.ts/.mjs/.js`)每次加载都需显式确认(service.ts:123-131、catalog.ts:178),以 Node 宿主权限执行。
- 插件挂载面:`inject = ['subagents','tools']`(index.ts:36),approval/jobs/userQuestions 均为 `ctx.get()` 可选注入(index.ts:685-687),缺审批服务时该路径 fail loud;另有 systemPrompt 段(index.ts:668-673)。

## 五、Session 投影与 VM

**证据文件**:`src/engine.ts:303-316、638-642、702-703、732-805、1139-1142、1344`、`src/runtime.ts`

### 1. Session / 官方 UI 可观察性
- 复用官方 `tool-workflow/*` Session 事件族,不自造 UI:
  - `tool-workflow/run-start`,**显式 Session 域**:`turn: null` 让 run 生命周期脱离发起它的 tool step(engine.ts:303-316、638-642,注释明说防止 DSH 误推断中断);
  - 每个子 Agent 一对 `tool-workflow/agent-start`(runId/seq/label/phase/childId)与 `tool-workflow/agent-end`(outcome: completed|cancelled|failed,engine.ts:1139-1142、1344),架构不变量"每条 start 恰有一条 end"(docs/ARCHITECTURE.md);
  - 终态 `tool-workflow/run-end`(stopReason: completed|cancelled|error,engine.ts:702-703)。
- 并行产出插件自有投影:`WorkflowProcessSnapshot`(items 分 `phase|agent|step|artifact` 四类 + counts + progress 含 replayedAgents,engine.ts:732-805)与 `WorkflowOutcome`;订阅回调 `subscribe(listener)`(engine.ts:716-725);后台运行尽力注册 `ctx.jobs`(kind 'workflow',失败仅 warn,durable run 仍在,service.ts:244-263)。

### 2. QuickJS WASM 与 capability RPC 面
- 运行时:`quickjs-emscripten` 独立堆(runtime.ts:1、265-271),内存 64MB、栈 1MB、同步片 10s(interrupt handler)、总墙钟默认 1h;超时关闭 RPC 桥、abort 整个 run、并静默所有已接收的宿主 dispatch 后才退出(runtime.ts:449-477)。
- 桥接:注入 `__dshCall`(异步 RPC→deferred promise)与 `__dshSync`(同步 RPC)后在 guest bootstrap 里删除并锁死(runtime.ts:137-157、364-397);宿主对象零泄漏,所有过界值强制 JSON(`assertJsonValue`,runtime.ts:16-50;结果侧 guest 内再断言一次,runtime.ts:414-441)。
- **暴露给脚本的能力**(冻结的全局 `wf`,runtime.ts:218-257):
  - 异步 RPC(runtime.ts:297-313):`spawnAgent, runAgent, wait, snapshot, output, send, stop, synthesize, workflow(嵌套一层), artifact`;
  - 同步 RPC(runtime.ts:314-361):`budgetSpent, budgetRemaining, phaseBegin/End, parallelBegin/End, parallelLaneBegin/End, concurrentGroupBegin/End, log`;
  - guest 本地实现:`parallel/pipeline`(泳道并发受 `__dshParallelLimit` 限,runtime.ts:166-217)。
- 确定性守卫:`Math.random` 抛错、`Date.now` 与无参 `Date()` 抛错(要求经 args 传熵)、`Math` 冻结、console 置空(runtime.ts:243-256)。
- 脚本侧还有:budget 预留-核算(engine.ts:1082-1088、1151)、`send/stop` 走 `localAgent.steer/cancel`(engine.ts:916-928)、单层嵌套契约(engine.ts:961-987)、read-only 子 Agent 工具过滤=父 Agent 实时可见工具 ∩ 可信只读 allow-list(engine.ts:318-325)。

## 值得借鉴(自建插件该抄的设计)

1. **未知字段 fail-loud 的白名单校验**(capsule.ts:21-25 `exact()`)+ **跨字段不变量**(plannedAgents≤maxAgents 等)+ **name/文件名互锁**(catalog.ts:93)。YAML 双轨的结构声明侧应同样"多写一个键即报错",schema 演进靠版本而非容忍。
2. **run store 目录布局**:`run.json`(可重写快照)+ `events.jsonl`(append-only 事件)+ 不可变定义快照 + `results/`(缓存)+ `artifacts/`(命名证据)。纯文件、可 diff、可搬运,配合封闭事件词表(17 个)做 UI 投影就够。`denied` 单列状态、TERMINAL 集合、prune/retention、身份解析的 ambiguous 上报(store.ts:164-173)都值得原样搬。
3. **缓存写入门槛**:"completed 且验证零 warning 才入缓存" + `origin: executed|replayed-from-cache` 可审计 + 继承缓存需二次质量过滤(engine.ts:1342、store.ts:127)。step-level 路线更能落好这点——直接用稳定 step id 做键,胜过它的"调用序号"。
4. **一次性授权的"冒烟通过才消费"**(index.ts:611-628 + author.ts:320-332):无效输入报精确错误且保留授权供修正重试,同时 `always` 模式与 trusted 执行不被绕过。以及三级 `approvalMode` 分层、模型工具与斜杠命令分别走 `ctx.approval` / `ctx.userQuestions` 的分工。
5. **复用官方 Session 事件做 UI 观察**,特别是 `turn: null` 的 Session 域 run-start 让后台流程活过启动 step(engine.ts:303-316、638-642)——直接解决"后台 workflow 被 UI 误标已中断"的问题;配一对 start/end 不变量与 ProcessSnapshot(phase/agent/step/artifact 四类 item + counts + progress)投影。
6. **能力缺失 fail-loud,绝不接受即忽略**(docs/KODAX_PARITY.md 兼容规则 2/5):provider 不支持 toolFilter/outputSchema/target/effort/worktree 时在 preflight 或启动前拒绝。对"官方 bundle 形态"是一条好纪律。
7. **read-only 工具过滤 = 静态 allow-list ∩ 父 Agent 实时工具目录**(engine.ts:318-325):未来新增写工具默认不可见,不用追补丁。
8. **发布前冒烟执行**(fake 能力面 + inert 子 Agent 真跑一遍脚本,author.ts:90-332):在花审批/真实 token 前抓脚本错误,且验证输出"可展示性"。单步 Action 同样可以在 save/revise 时干跑一步。
9. **保存/替换的原子发布与血缘**(catalog.ts:281-318:同目录临时文件 + `wx` 独占 link + 替换走 `.archive` 归档可回滚;provenance 记 fromRunId/revisionOf)。
10. **加装式占位**:注册 `ctx.dynamicWorkflows` 而非占用 `ctx.workflows`/`ctx.workflowEngine`,native 一轮/前台 workflow 不动(docs/ARCHITECTURE.md"Why a separate engine")——与"不占 ctx.workflowEngine"同向,service 命名取不冲突名即可。

## 要避开(过度设计 / 与我们路线冲突处)

1. **QuickJS WASM + 正则静态策略这一整层**(runtime.ts 全文 + source-policy.ts 的 strip-literals 状态机):为"内嵌 JS 源码"服务的隔离与审查工程约占代码量 1/5,且正则黑名单天然可被绕(模板字符串插值、剥字面量的手写词法就有 50 行)。YAML 双轨=结构声明+单步 Action,根本没有脚本执行面,这层应整体省去;副作用控制交给 step 定义与宿主工具权限。
2. **effect cache 的"整段脚本重放 + 调用序号"模型**(engine.ts:1019-1041):source 一改缓存全废、调用序列漂移即错位、无稳定 step id、无 per-step 缓存策略、副作用步骤无幂等键。发版流水线这类有外部副作用的场景只能算"凑合"。step-level 应直接以 step id 为键 + 显式 cache policy(always/if-failed/never)。
3. **capsule 把 JS 源码整段塞进 JSON**(`source` 字段即转义代码串,examples/review.workflow.json 可见):可读性与 diff 极差,还牵出 512KB 上限、快照三件套(workflow.workflow.json/script.js/manifest.json)冗余。YAML 双轨天然分开"声明"与"动作",不要走单体 JSON。
4. **封闭 pattern 枚举 + model-hint 三档塞进 schema**(types.ts:8-15、capsule.ts:128-132):六种 pattern 是分类学负担,进 schema 意味着扩一个词就动版本;fast/balanced/deep 与 subagentProvider/provider/model 双层路由(types.ts:401-408)配置面很大。YAML 声明应只留必要字段,路由留给宿主默认。
5. **scout-then-author 生成管线 + 冒烟 + 3 次修复循环 + handoff WeakMap 授权**(author.ts:334-395、index.ts:197-248):这是"用模型写 JS"的复杂度与信任面,和"声明式 YAML、step 由人工/常规编码产出"的路线冲突;其 turn 级授权状态机(hasCurrentWorkflowHandoff 消息 id 回溯)微妙易碎。
6. **emit 时同步 IO + 全量重投影**:每次 emit 都 `writeFileSync(run.json)`,且 `projectProcess()` 每次 persist 都 `getEvents()` 重读整个 events.jsonl 再投影(engine.ts:716-730、732-805)——长 run 是 O(n²)。事件投影应增量维护,快照节流。
7. **双份同义命令面**:/workflow 约 20 个子命令与 workflow_manage 14 个 action 大量重叠(index.ts:439-457、638),认知与维护成本双份。保留一个规范入口(工具),斜杠命令只做薄别名。
8. **宿主版本特化补丁**:`rc2MissingCapture` 专门兼容 rc.2 的 structured capture 缺失形状并做"修复后改判 completed"(engine.ts:1160-1226);compatibility.json pin 死 0.0.1-rc.2。这类 per-host-shape workaround 会随宿主升级腐烂,兼容逻辑要收敛到一层薄 adapter。
9. **并发/生命周期的多重叠**:per-cwd engine+store Map、部署级 semaphore、三个 adapter 的"仅首个 run 前可注册"窗口锁(service.ts:82-101)、单层嵌套 + `WORKFLOW_INTERNAL` Symbol 内部桥(types.ts:227-239)——为对齐 KodaX 全量契约付出的结构税。step-level runner 里 parallel/嵌套是免费能力,不需要这套内部 API 面。
10. **verification 的重活**(engine.ts:1271-1334:git workspace 前后指纹、逐 required path 指纹、同 actor 最多 2 次修复、prepared-text 正则判"准备中"):有借鉴价值的只是"证据字段+warn/hard 两档+有界修复"概念;指纹/正则这些实现细节属于 Git 评审专用场景,别平移进通用 workflow 层。
