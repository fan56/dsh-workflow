# Findings:宿主原语实测(票 01)

> Research 报告全文(2026-10-20,只读调研)。证据方法:第一证据=本机 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下各包 `.d.ts` 类型签名【类型】+ 编译产物 `lib/*.js` 交叉验证【实现】;官方 GitHub 文档为旁证【文档】。宿主 0.2.1-rc.2。决议 gist 见 `../tickets/01-host-primitives.md` 的 Resolution 段。

## 面 1:ctx.subagents — 程序化发起 child

**服务定义**:`ctx.subagents: SubagentRuntime`(cordis `Context` 接口扩充),包 `@deepseek-ai/dsh-subagent`。路径:`dsh-subagent/lib/types/index.d.ts`【类型】

### 1.1 核心 API:`startActivation(spec: SubagentActivationSpec)`

```ts
interface SubagentActivationSpec {
  provider: string;                       // 注册名,如 'spawn' / 'fork'
  label: string;                          // 进入 catalog 的短标签
  childId?: SessionId;                    // 可选保留身份(本地 child)
  request: Omit<SubagentStartRequest, 'label' | 'signal'>;
  signal: AbortSignal;                    // 规范取消通道(启动前后都有效)
  delivery: 'parent' | 'caller';          // parent=通知父模型; caller=只把结果还给调用方
}
```

返回 `SubagentActivation`:

```ts
{ childId: SessionId; messageId?: MessageId;
  result: Promise<SubagentResult>;        // child 失败不 reject,以 stopReason 表达
  dispose(): Promise<void>; }             // 停止并释放该 activation 及其后代
```

`SubagentResult`:`{ output: readonly ContentBlock[]; structured?: unknown; diagnostic?: string; stopReason }`,stopReason 词表 `completed | aborted | error | max-tokens | refusal`(provider 可 merge 扩展)。**final text 从 `result.output`(最后一条非空 assistant 消息)取;structured 结果配 `request.outputSchema` 取。** 路径:`dsh-subagent/lib/types/types.d.ts`【类型】

`SubagentStartRequest` 关键字段:`cwd?`、`agentPreset?`(需 `capabilities.agentPreset`)、`prompt: ContentBlock[]`、`parent: Agent`(spawn 方;其 cwd 为默认目录)、`agentOptions?`(`{ provider?, model?, reasoningEffort?, maxTokens?... }`,模型/preset 覆盖通道)、`outputSchema?`(对象根 JSON Schema,成功时结果进 `structured`)、`maxDepth?`。【类型】

**实测调用范本**(官方 workflow 引擎 `dsh-workflow-ptc/lib/index.js` `startChild()`,【实现】):

```js
const run = await ctx.subagents.startActivation({
  provider, label: `${meta.name} child ${n}`, delivery: "caller",
  signal, request: { cwd, prompt: [{ type: "text", text }], parent,
    ...(schema ? { outputSchema: schema } : {}),
    ...(provider||model ? { agentOptions: { provider?, model? } } : {}) } });
const result = await run.result;  // { output, stopReason, structured? }
await run.dispose();
```

`dsh-tool-subagent`(模型工具版)同构,只是 `delivery: "parent"`、`agentPreset`、`maxDepth` 也走 `resolveMaxDepth()`(`dsh-tool-subagent/lib/index.js:475`)。【实现】

**前置校验(实测)**:`startActivation` 要求 `request.parent` 是 `ctx.agents.get(parent.id)` 返回的**精确存活 Agent**,否则 `UNAUTHORIZED`(`dsh-subagent/lib/index.js` 编译实现)。插件从 command handler 的 `invocation.agent` 拿到的就是活的 Agent,满足此约束。【实现】

### 1.2 continuable catalog 语义(钉死)

- **provider 有 `prepareContinuable` 方法 → `manager.startLocal`(本地 Session-backed child);没有 → `manager.startExternal`(外部叶子)**。本机 `spawn` 与 `fork` 两个 provider **都实现了 `prepareContinuable`**,所以走 startActivation 的都是本地 child。【实现:`dsh-subagent-spawn-in-process/lib/index.js:31`、`dsh-subagent-fork-in-process/lib/index.js:45`】
- `manager.startLocal` **无条件写 `mode: "continuable"` descriptor**(child 自己日志里的 `subagent/descriptor` 事件,version 3),并通过 `establishCatalogChild(parent.session, ...)` **写入父 catalog(父日志 `subagent/catalog` 事件)**——即 **workflow 式 spawn 的 child 一定进父 catalog,且是 continuable(可续聊)**,与 delivery 取值无关;`delivery: 'caller'` 只是不通知父模型、persistence 变为可选。【实现:`dsh-subagent/lib/index.js` `startLocal()`;类型:`dsh-subagent/lib/types/descriptor.d.ts`、`catalog.d.ts`】
- 续聊通道:`sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options): Promise<MessageId>`(相邻 parent↔child;缺席 child 会冷恢复);宿主协议投递走 symbol-keyed `[deliverSubagentPrompt]`。`interrupt(targetSessionId, authority)` 打断。catalog 读取:`listChildren(parentSessionId)` / `listDescendants(rootSessionId)`。【类型:index.d.ts】
- 容量:`maxActiveSubagents` 默认 8、`maxDepth` 默认 1(SubagentRuntime.Config,volatile)。超容冷恢复报 `subagent/delivery-unavailable`。【类型】
- **回答票 03 遗留①**:`delivery:'caller'` 的 child 依然是本地 continuable child、进父 catalog;`ctx.sessions.get(childId)` 可读其 Session——child 会话事后可打开,persistence 可选意味着**若要 child 会话持久可查,run store 侧要保证 persistence 前提升**(取舍留给治理票)。

### 1.3 usage(token/模型/时长)从哪读

- **`startActivation` 的 result 不带 usage**;`subagent/end` 事件的 `SubagentRunEndInfo` 也只有 `stopReason` + `lastAssistantMessage`。usage 在 **child 自己的 Session 日志**里:`assistant/message` 事件携带 `usage?: TokenUsage`(`inputTokens/outputTokens/totalTokens?/cacheRead?/cacheWrite?/reasoningTokens?`,`dsh-llm/lib/types/types.d.ts:160`),模型路由(provider/model)在 `request/header` 事件。【类型】
- **时长**:`subagentTiming` projection(`settledMs` + `active:{since,through}` + `lastTurnCompleted`),由 `dsh-subagent/projection-types.d.ts` 声明进 `SessionProjectionMap`。【类型】
- **汇总口径**:`dsh-session-stats` 的 `sessionStats` projection(`turns/steps/llmMs/toolMs/ttftMs/decodeMs/decodeTokens` 等,`dsh-session-stats/lib/types/types.d.ts`);注意它**没有总 token 字段**,总 token 需要自己 fold `assistant/message.usage`。
- 存活 child Session 可直接 `ctx.sessions.get(childId)`(`SessionStore.get`,`dsh-session/lib/types/index.d.ts:491`)。【类型】

### 1.4 provider 注册点

`ctx.subagents.registerProvider(provider: SubagentProvider): () => void`(返回 effect disposer,HMR 安全);`SubagentProvider = { name, capabilities:{agentOptions,agentPreset,outputSchema,depthLimit}, inheritsParentContext, agentRouteDefaults?, start?, prepareContinuable? }`。本机两个 provider 是普通 cordis 插件(`export const name/inject/apply`),`apply` 里就一行 `ctx.subagents.registerProvider(...)`;config 只有 `providerName`(默认 `spawn`/`fork`)。spawn:`inheritsParentContext=false`、四能力全开;fork:`inheritsParentContext=true`、`agentPreset=false`。配套事件:`subagent/provider-added/removed`、`subagent/start`、`subagent/end`(scoped)。【类型+实现】

**结论:插件不必注册新 provider,直接用 'spawn'(或 'fork');编排上下文靠 `parent: invocation.agent` + `agentOptions` 控制。**

## 面 2:ctx.jobs — owned job / output ring / kill

**服务定义**:`ctx.jobs: JobRegistry`(抽象类),包 `@deepseek-ai/dsh-jobs`;进程内实现在 `@deepseek-ai/dsh-jobs-local`。路径:`dsh-jobs/lib/types/index.d.ts`、`types.d.ts`【类型】

### 最小用法(与官方 tool-workflow 逐字段同款,`dsh-tool-workflow/lib/index.js` `startBackgroundRun()`,【实现】)

```ts
const jobId = ctx.jobs.start({
  kind: 'workflow',            // JobKindMap augmentation,同时是 id 前缀 <kind>-<short-uuid>
  label: name,
  owner: parent.id,            // SessionId;不填=unowned
  toolCall,                    // 可选 {callId, rootCallId}
  run(job: JobHandle) {        // 同步 starter;throw 则什么都不注册
    // 启动实际工作
    return {
      cancel(reason?: string) { /* 同步、幂等、最终要 settle done */ },
      done: promise,           // Promise<JobOutcome>;resolve 于资源释放后;不 reject
    };
  }
});
```

`JobOutcome = { status: 'completed'|'killed'|'failed'; detail?: string; result?: string }` — **`result` 是"一次性交付的返回值"**(如 workflow 的渲染结果),结算后模型第一次 `read` 领走。【类型】

- **output ring**:`job.append(text, {channel?, gapBefore?})`(推进 UTF-8 字节 offset)、`job.updateProgress(line)`;或 spec 里给 `output: JobOutputSource[]`(pull 源,registry 泵)。消费:`read(id, caller?)`(模型 cursor,推进)、`readAt(id, from, caller?)`(绝对 offset 观察读)、`list(caller?)`、`get(id, caller?)`。【类型】
- **kill**:`kill(id, caller?, reason?) → 'requested'|'already-finished'`;`wait(id, timeoutMs, caller?, signal?) → Promise<JobView>`;`remove(id, caller?)`(结算后删记录);`events.subscribe(filter, listener)`(`{owner}|{owners:'all'|'scope'}`,事件 `registered/progress/stopping/removed/settled{awaited}/output{total}`)。【类型】
- **硬门槛**:`start` 拒绝 owner 无人服务的 spec —— 必须有人 `ctx.jobs.attachController(name)`。官方 `dsh-tool-jobs` 的 `apply` 第一行就是 `ctx.jobs.attachController("tool-jobs")`(`dsh-tool-jobs/lib/index.js:256`);它同时提供 `job_output/job_list/job_kill` 工具与**完成通知投递**(忙碌注入 / 空闲开 turn,`completionDelivery: 'quiet'|'wakeup'`)。**官方 bundle 形态里 `dsh-jobs-local` + `dsh-tool-jobs` 成对出现;本插件依赖这一对已挂载,自己不必 attachController。**【类型+实现】

## 面 3:ctx.approval 与 ctx.userQuestions

### ctx.approval(`@deepseek-ai/dsh-user-approval`)

```ts
const outcome = await ctx.approval.request({
  agent, toolName, callId?, reason?, displayReason?: {en, ...}, signal?
});  // → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

路径:`dsh-user-approval/lib/types/index.d.ts`【类型】

**关键约束(类型文档明示)**:"The request requires an open turn ... an idle ask rejects before appending anything" —— **目标 agent 必须有打开的 turn,空闲时直接 reject**。审批 waterfall 是 cordis 事件 `approval/request`(scoped waterfall,`next()` 委托);审计写 `approval/asked` + `approval/decided` 事件对(log-only)。会话策略 `ApprovalPolicy = 'ask' | 'never'`;本机 cordis.patch.yml 里的 `dsh-approval-policy {origins:[subagent,scheduled,cron]}` 是另一包的策略配置。

### ctx.userQuestions.ask(一次性确认推荐通道)

`ctx.userQuestions: UserQuestionService`(`@deepseek-ai/dsh-user-questions`):

```ts
await ctx.userQuestions.ask({
  questions: [{ id, question, detail?, header?, options?: [{label, description?}],
                multiSelect?, intent? }],   // intent 如 {kind:'plan-review', approve, callId?}
  agent,        // 可选;给了则要求精确存活 runtime root
  signal,       // 可选
  wait?: { callId, timed? },                  // Client 卡片键
});  // → { answers: [{id, selected: string[], custom?}] }
```

路径:`dsh-user-questions/lib/types/index.d.ts`、`types.d.ts`【类型】。错误码:`ASK_ABORTED` / `CALLER_NOT_LIVE`(agent 非精确存活实例)/ `DELEGATED_CALLER`(该 agent 被别的 agent 拥有——**owned child 永远问不到人,会 block**);另有 `askTimed(request, callId, timeoutMs)` 前台限时版。answerer waterfall 为 `user-questions/request` 事件。官方调用范本:`dsh-tool-ask-user/lib/index.js:195`【实现】。

**对比结论**:命令/插件代码里的一次性确认用 `ctx.userQuestions.ask`(无 turn 要求);`ctx.approval.request` 语义是"工具权限审批",受开 turn 约束。

## 面 4:Session 自定义事件(声明 + 写入)

**机制 = TypeScript module augmentation + `Session.append`**,与 `dsh-tool-workflow` 完全同款:

声明(官方原文,`dsh-tool-workflow/lib/types/types.d.ts:33-56`【类型】):

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool-workflow/run-start': { runId; name };
    'tool-workflow/agent-start': { runId; seq; label; phase?; childId };
    'tool-workflow/agent-end': { runId; seq; outcome };
    'tool-workflow/run-end': { runId; stopReason };
  }
}
```

写入(官方编译实现,`dsh-tool-workflow/lib/index.js` `createWorkflowRecorder`,【实现】):

```ts
session.append('tool-workflow/run-start', { runId, name });  // 返回 SessionEvent<T>(带 seq/time)
```

- `Session.append<T>(type, data, ...opts)`:非 surface 事件(message 类)**不带** `surfaceOp/sourceEventSeqs`,纯 log-only;带 `ignorable?: true` 标记的事件是"读者可安全跳过"。自定义事件是否 ignorable 取决于已知事件目录——`dsh-session/lib/types/known-event-types.d.ts` 明说"**Downstream (out-of-repo) plugin events are outside this list by construction**",持久化的 `SessionEvent.ignorable` 标记是兼容性保障(types.d.ts:47)。**风险点见第 7 节。**
- 另有 `appendPluginRecord(session, type, data)`(`plugin:` 前缀实验记录),但 **`.d.ts` 明文:"Only production source under `packages/experimental/` may call this function; the `verify-plugin-record-callers` gate rejects any other production caller"** —— 第三方插件不可用。【类型:`dsh-session/lib/types/index.d.ts:103-117`】
- 同 session log 的既有先例:命令生命周期 `command/run`+`command/done`、审批 `approval/asked`+`approval/decided`、job `job/registered`+`job/settled`、subagent `subagent/descriptor`+`subagent/catalog` —— 全部走 SessionEventMap augmentation。【类型,各包】
- 事件读回:监听 cordis 事件 `session/event`(post-commit feed)或查 projection。

## 面 5:/workflow 命令族注册(tui/web 通吃)

**宿主侧唯一注册面:`ctx.commands: CommandRuntime`(`@deepseek-ai/dsh-commands`)。** 路径:`dsh-commands/lib/types/index.d.ts`【类型】

```ts
ctx.effect(() => ctx.commands.register({
  name: 'workflow',                 // 小写,无斜杠
  description,
  definitionId?, input?: { hint, attachments? }, recordInput?,
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>,
}));  // 返回注销 disposer
```

- `CommandInvocation = { commandId, agent: Agent, rawInput, attachments: (ImageBlock|FileBlock)[], signal }`;`CommandResult = {kind:'success', text?, sourceEventSeq?} | {kind:'error', text}`。
- 执行走 `ctx.commands.execute(agent, line, attachments, signal)`,自动写 `command/run`/`command/done` 事件对(log-only、无 turn 包裹);注册/注销广播 `commands/change` 事件供 UI 刷新。
- **作用域**:"Plain-context definitions are global; definitions registered through a command-injected child of an agent context shadow globals for that agent." —— 插件在宿主根 ctx 注册即全局。
- **tui/web 通吃的证据**:
  - TUI 侧(本机 `~/.dsh/profiles/tui/node_modules/@aiwayds/dsh-tui-pi/lib/index.js:937`):`ctx.effect(() => ctx.commands.register({ name, description, handler }))` —— TUI 就是消费 host registry 的一个 UI 适配器,autocomplete 与派发都走它【实现】;
  - Web 侧:`@deepseek-ai/dsh-client-ui-commands`(`package.json dsh.client.platform="web"`,inject 含 `dsh-client-ui-input-trigger`/`dsh-client-ui-conversation`)是 Web Client 的命令模块,同一 registry 经 typert 远程面(CommandRuntime extends TypertRemoteService)暴露【类型】;
  - 命令族(`/workflow`、`/workflow list`、`/workflow kill`…)就是多个 `register({name:'workflow…'})` 定义,handler 里自行 split `rawInput`。

## 面 6:官方 bundle 挂载形态

**三层事实源**:`dsh-package-manifest/lib/types/types.d.ts`、`dsh-app-boot/lib/types/profile.d.ts`(两处【类型】)+ 本机真实样本。

### 插件包(package.json)

```jsonc
{
  "name": "@aiwayds/dsh-workflow", "version": "...", "main": "lib/index.js",
  "dsh": {
    "manifestVersion": 1,                 // 可选
    "bundle": { "patch": "./cordis.patch.yml" },   // string 或 string[](按序)
    // "profile": { "bundles": [...] }    // 这是 profile 目录用的,不是插件包
    // "client": { platform, inject?, immediately?, external? }  // 仅 client 模块需要
  },
  "engines": { "dsh": "0.2.1-rc.2" }      // 声明式兼容
}
```

- `dsh.bundle.patch`:bundle 导出的配置层文件(相对包根)。**注意术语**:插件是 "bundle",字段是 `dsh.bundle.patch`;`dsh.profile.bundles` 是 **profile 目录 package.json 里的有序 bundle 列表**(挂载谁的顺序)。
- 本机真实样本:`@aiwayds/dsh-ptc-subagent` 与 `@aiwayds/dsh-tui-pi` 均为 `{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}`。

### bundle patch 文件(cordis.patch.yml)

顶层 YAML 数组,每项为 `PatchOptions`(`cordis-plugin-include/lib/types/index.d.ts:27`【类型】):

```yaml
- insert:                       # 插入新条目(挂载自己的插件必须显式 insert!)
    - id: dsh-workflow          # 树内稳定 id;同时是 settings 命名空间
      name: '@aiwayds/dsh-workflow'   # 模块 specifier
      config: { ... }           # 传给 apply 的配置;支持 !!js 表达式
- id: some-entry                # 定向覆盖:按 id 改 config / disabled / inject…
  config: { ... }
```

`EntryOptions = { id, name, config?, group?, disabled?, inject? }`(`cordis-plugin-loader/lib/types/config/entry.d.ts`)。**关键坑(本机 ptc-subagent patch 注释实测确认):bundle 主插件不会被宿主自动挂载,必须在 patch 里 `insert` 自己;entry id 必须跨 patch 层唯一。**

### 层叠顺序(profile.d.ts 头注 + 本机 ~/.dsh/profiles/tui/cordis.patch.yml)

`空根 [] → 各 bundle 的 patch(按 profile 的 dsh.profile.bundles 顺序)→ profile 自己的 cordis.patch.yml → --patch overlays → flag 派生`。bundle 包解析:先 dsh 安装目录、再 profile 目录;profile 目录 `node_modules` 用 pnpm 装第三方插件(`dsh plugin --profile <name> add <pkg>` 即完成安装+挂 bundle)。

## 7. 风险 / 未知

1. **`Session.append` 自定义事件的旧读者兼容**:`ignorable` 标记如何随 append 设置在类型签名里不可见(append 只收 `type,data`);repo 事件目录明说第三方事件在已知列表之外,持久化侧靠 envelope 的 ignorable 标记兜底,但**第三方插件写入的事件是否自动获得 ignorable、格式版本迁移(V3→V4 风格)是否保留,类型层没有承诺**。tool-workflow 的 recorder 对 append 失败做了 warn+降级(记录失效不影响执行)——建议同款防御。
2. **`ctx.approval.request` 的开 turn 约束**:命令 handler(无 turn)里调用会 reject;插件发起的"审批"若在空闲期,只能走 `ctx.userQuestions.ask` 或先给 agent 排一个 turn。`'unavailable'` 是 fail-closed 默认(无 answerer 时)。
3. **usage 无现成聚合出口**:`SubagentResult`/`subagent/end` 都不带 token;`sessionStats` projection 没有总 token 字段。要 token/模型/时长就得自己 fold child Session 的 `assistant/message.usage` + `request/header`,或用 `subagentTiming` projection(仅时长)。这块是纯自建工作量。
4. **并发深度/容量**:spawn 每次都是全新 Agent(贵);`maxActiveSubagents` 默认 8 是"continuable 父链"容量,超容在冷恢复时报 `subagent/delivery-unavailable`——fan-out 大并发的实际容量上限行为(排队还是拒绝)类型层只写了冷恢复路径,活跃并发路径未见明确语义。
5. **文档面缺失**:官方文档只核对到 `docs/cookbook/extension-cookbook.md`(确认了 `name/inject/apply` 插件约定与 "Dynamic workflow = ctx.workflowEngine + workflow tool" 的官方特征表);`docs/subsystems/subagent.md` 未验证存在。类型证据充分,文档旁证薄。
6. **`waitForChildren` 语义**:父 agent 收尾时插件需自己调用 `ctx.subagents.waitForChildren(parent)` 并在返回 true 后复查 parent idle(类型注释要求 hosts recheck)——编排结束条件要自己写对,漏掉会提前 teardown。
7. **entry id 唯一性**:bundle patch 与用户 cordis.patch.yml、其他 bundle 之间 entry id 必须全局唯一(ptc-subagent 实测注释:重复 id 会被 loader 拒绝);`dsh-workflow` 前缀命名要贯穿。
8. **`maxDepth` 默认 1**:`SubagentRuntime.Config.maxDepth` 默认 1 只约束"无显式 limit 的工具";本插件直接传数值可绕开,但 child 里若再装 dsh-tool-subagent 会按此受限——多级编排要么显式传 `maxDepth`,要么接受默认。
