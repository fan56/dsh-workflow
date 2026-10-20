# Findings:registry agent 引用执行契约(票 03)

> Research 报告全文(2026-10-20,只读调研)。决议 gist 见 `../tickets/03-registry-agent-ref.md` 的 Resolution 段。

## 一、registry agent 定义的形状

### 1.1 文件位置与解析器

- 一个 agent = `<agentsDir>/<name>.md`。`agentsDir` 默认 `$DSH_HOME/agents`(即 `~/.dsh/agents`,`$DSH_HOME` 优先);配置字面量 `'~/.dsh/agents'` 才走 dsh-home 解析,自定义路径仅做 `~` 展开原样使用(`src/index.ts:162`)。
- 解析器:`~/repo/dsh-subagent-registry/src/agents-dir.ts` — `parseAgentMarkdown`(L153)、`listAgentFiles`(L214)。是 dsh-tui-pi agent-manager 解析逻辑的**自包含副本**,零包依赖(先例:一个第三方插件自带副本是生态既定做法)。格式权威文档:`docs/AGENT-FORMAT.md`。

### 1.2 frontmatter 字段清单(AgentMeta,agents-dir.ts L49-74)

| 键 | 类型 | 缺省 | 失败语义 |
|---|---|---|---|
| `name` | string | 必填 | 缺失/空 → 整文件丢弃 `missing required frontmatter key 'name'`;**必须等于文件名(去 .md)**,否则 broken |
| `deep` | 非负整数 | `1` | 非法 → 丢文件。`0`=leaf(禁 spawn),`≥1`=相对深度预算 |
| `display_name` | string | 缺省 | 可选 UI 标签;子代理 label 写 `display_name ?? name`。**注意是下划线形式** |
| `description` | string | 缺省 | roster 副标题,进 `use_agent` 工具描述 |
| `model` | `provider/model` 路由 | 缺省=继承 | 第一个 `/` 切分;无 `/` = 仅 provider(`splitModel`,tool-run-agent.ts L205) |
| `thinking` | `off/low/medium/high/xhigh/max` | 缺省=继承 | 白名单外 → **丢文件**(fail-loud)。注意:源码 `THINKING_LEVELS` 含 `xhigh`(agents-dir.ts L43),AGENT-FORMAT.md 文字漏列——以实现为准 |
| `background` | 严格 `true`/`false` | 缺省=前台 | 其他值 → 丢文件 |
| `maxRounds` | 正整数 | 缺省=全局 | 非法 → 丢文件。官方 subagent 缝不消费,宿主 TUI hard-stop ladder 消费(label→cap 查 `readAgentMaxRounds`,agent-caps.ts L36:精确 name 优先、唯一 display_name 次之、歧义 fail-closed) |

- **body = persona(system prompt),逐字使用**,无模板替换。
- **未知键静默忽略**:`tools`、`system_prompt`、`extensions`(fun-agent 约定)、`color` 全部不生效。
- 松散解析:`key: value`、可选引号、CRLF 兼容;空值不对称(`name`/`deep` 空值丢文件,其余键空值视同缺省)。
- 内置 roster 播种:`seedBundledAgents`(seed-defaults.ts)仅在目录为空时一次性写入 workhorse/oldfox/rubber-duck,**三个全是 `deep: 0` leaf**,且已存在文件永不覆盖(目录视为 user-owned)。

### 1.3 实测踩到的一个现行不一致

`~/repo/dsh-ptc-subagent/agents/ptc-subagent.md` L3 写的是**驼峰 `displayName: PTC Subagent`** — 解析器只认 `display_name`,该键被静默忽略,实际 roster 标签是 `ptc-subagent`。dsh-workflow 的引用语法与示例必须锁定**下划线 `display_name`**,且引用名一律用 `name`(file identity),不用 display_name。

### 1.4 两个 "preset" 必须先分清

| 概念 | 存储面 | 程序化消费面 |
|---|---|---|
| **roster agent 定义**(本票主角) | `~/.dsh/agents/*.md` 纯文件 | call-time 重读文件(无缓存;"roster is user-owned and editable at runtime" 是既定惯例) |
| **会话级 agent preset**(对话组合层) | `agent-preset/selected` session 事件 | `ctx.sessionQuery` projection(见下) |

## 二、程序化消费的正确姿势

### 2.1 记忆线索核实:"读 preset 走 sessionQuery projection" — 当前版本仍成立,且已核实到类型层

教训出处实证(dsh-feishu):
- `~/repo/dsh-feishu/src/binder.ts` L285-296 `presetOfSession`:`ctx.sessionQuery.observeSession(SessionId(id))` → `observation.projections.values.agentPreset`;注释明言 **"NOT the meta header: agentPreset never persists there"**。
- `bot.ts` L1850-1874 `learnPreset` 同款。
- `resume-table.ts` L32:`persistence.list()` 在 dsh ≥0.1.5-rc.1 返回 `{header, revision, sizeBytes}` 快照(不是裸 header)——从它"裁剪 header 读 preset"既拿不到真值也不兼容。

类型层证据(0.2.1-rc.2 closure):
- `@deepseek-ai/dsh-agent-preset-registry/lib/types/session.d.ts`:`agentPresetProjectionDefinition`(key `'agentPreset'`),fold `agent-preset/selected` 事件;docstring:**"Reconstruction reads the `agentPreset` Session projection, never the header alone"**——header 只记创建时值,空白期可换 preset,projection 才是真相。
- `@deepseek-ai/dsh-session-query/lib/types/index.d.ts`:`SessionQueryEngine.observeSession(sessionId, {projectionMode})` → `SessionObservation.projections`(ProjectionSnapshot)。

正确 API(逐步):

```ts
const query = ctx.get('sessionQuery')                       // 缺服务 = undefined,需降级
const obs   = await query.observeSession(SessionId(id))     // live-preferred,带租约(Disposable)
const preset = obs.projections?.values?.agentPreset         // string | null
obs[Symbol.dispose]()                                       // 用完释放
```

配套服务面:`ctx.agentPresets`(`AgentPresetRegistry`):`resolve(id?)` / `list()` / `mount(ctx, id?)` / `select(agent, presetId)` / `composeFrom(ctx, parent)`(子继承父的 preset 修订)/ `composedPreset(ctx)`。

### 2.2 从 roster agent 定义到一次 child 执行:registry 的完整链路(复刻蓝本)

`use_agent` 执行路径(tool-run-agent.ts L543-714),逐步:

1. **call-time 读文件**:`loadAgent(dir, name, available)`(L460)— 文件缺失 → `unknown agent "X" — no X.md in <dir> (available agents: …)`;解析失败 → `agent "X": <parser 原因>`。**每次调用重读**,不缓存。
2. **合成运行时**:`composeAgentRuntime(name, {model, thinking})`(profile-resolution.ts L140)— 就近 `.dsh-profile` pin → `$DSH_HOME/model-profiles.json` per-agent 覆盖 ⊕ frontmatter 基线,全防御性、永不 throw。
3. **构建请求** `buildStartRequest`(L271):`label = display_name ?? name`;`prompt: [{type:'text', text}]`;`parent = exec.agent`(发起 Agent,必需);`persona = body`;`deep:0` → `toolFilter.deny = leafDenyList(...)`(默认 `[subagent, subagent_fork, workflow, ralph] + 自身 toolName`,与 `ctx.tools.view().restrictableNames` 求交,显式覆盖不求交)**且不带 maxDepth**;`deep≥1` → `maxDepth = resolveChildDepth(parent) + deep`(显式传,永不被宿主默认 1 卡住);`agentOptions = {provider, model, reasoningEffort}`。
4. **派发**(双宿主 feature-detect,失败的已接受调用**绝不**换 API 重试,CHANGELOG 0.14.0):
   - **0.2.1 线**:`ctx.subagents.startActivation({ provider, label, request, signal, delivery, childId })`。前台 `delivery:'caller'` + `foregroundLabel(label)`;后台 `delivery:'parent'` + 裸 label。request 在此线**不含 persona/toolFilter** — 先 `reserveChildComposition(childId, parentId, {persona, toolFilter})` 私有寄存,`subagent/start` 边由 listener 在子 scope 装 persona section(`deployment:persona-prefix`)+ `tools.restrict`(host-compat.ts L72-128;寄存存活至父 session dispose,每个 run 物化新 scope 都重装)。
   - **0.2.0 线**:`legacySubagents(ctx).start(...)` / `startContinuable(...)`(persona/toolFilter 内联在 request)。
5. **收结果**:`SubagentResult { output, structured?, diagnostic?, stopReason }`;非 `completed` → 抛错并保留 partial output + diagnostic。
6. **续跑(仅前台,仅同父会话)**:`ctx.subagents.listChildren(parent.id)` → `SubagentCatalogEntry[] { id, createdAt, mode, label? }` → `pickLatestLabeledChild` 按 `[fg] label` 匹配 → persistence `open(id,'read')` 读事件分类上次 turn 结局 → `ctx.agents.resume` 续一轮。

### 2.3 registry 对外暴露的程序化面(能白拿的与拿不到的)

包根导出(index.ts L45-48,`exports` map 只开放 `.` 和 `./client`):
- **可用**:`agentsDir()` / `dshHome()`、`readAgentMaxRounds(label, dir)`、`foregroundLabel(label)` / `stripForegroundLabel(label)`、`composeAgentRuntime(name, base, opts)`、`readModelProfilesDoc()`、`workspaceProfileName()`、`Config` / `apply`。
- **拿不到**:`listAgentFiles` / `parseAgentMarkdown` / `loadAgent` / `buildStartRequest` / `splitModel` / `leafDenyList` 均未导出;**没有程序化 "dispatch by name" 函数** — `use_agent` 是 model-facing tool,只有工具 execute 一个入口。
- 插件 inject 面:`['tools','subagents','agents','skills','systemPrompt']`;配置六键 `agentsDir / provider('spawn') / toolName('use_agent') / askToolName('ask_agent') / leafDenyTools / resume`。provider 未就绪时挂 `subagent/provider-added` 事件等(cordis 并行激活竞态,index.ts L263-273)。
- web 侧只读面:它自己的认证 RPC `/api/subagent-presets/{list,save,remove}`(`PresetEntry { id, version: sha256, fields, source, body, error?, structured }`),是 registry 私有契约。

**结论:dsh-workflow 要么自带 ~80 行解析副本(有 dsh-tui-pi 先例),要么推 registry 上游补导出;执行发起走官方缝自建,不依赖 registry 挂载。**

### 2.4 `[fg]` 前缀接线惯例(0.14.1 现行,PR#6 接手版)

- `FOREGROUND_LABEL_PREFIX = '[fg] '`(0.14.1 从 0.14.0 的 `[use_agent foreground] ` 缩短,两式都仍识别/剥离,`resume.ts` L168-180)。
- `stripForegroundLabel` 同时剥两式;`pickLatestLabeledChild` 只认:`mode:'one-shot'` + 裸 label,或 `mode:'continuable'` + 托管前缀 label。
- **已知限制(resume.ts 文档明示)**:裸 agent 名作 label 的一次性 child 会与 registry 的 resume 匹配混淆。**workflow 的 child label 绝不能用裸 agent 名**,建议自命名空间如 `[wf] <runId>/<stepId>`。
- `ask_agent` 寻址按 `[display_name ?? name, name]` 两候选取最新;`agent` 与 `agent_id` XOR 校验。

## 三、dsh-ptc-subagent 的三个教训

### 3.1 preset 级 presentAs "两向都断"(关键实证,design doc §8 L78)

- **实证内容**(0.2.0-rc.2 真机 TUI,preset 里 `tool-presentation mode: ptc` 行进了树但会话 wire 工具面不变:41 原生工具、零 run_code;**反向**部署级 ptc 下 preset 的 `mode: native` 行也护不住。`presentAs` 没落在会话的 modeFor 链上。"preset 单独开 PTC、主面不动"做不到)。
- 机制:`@deepseek-ai/dsh-agent-tool-presentation` 的 `apply` 调 `ctx.tools.presentAs(mode)`(lib/index.js L37-45),声明作用域是"挂载 scope",官方文档承诺 preset 组合可用,rc.2 实现断裂。
- **对 workflow 的含义**:① Step 执行者的**工具面差异化不要走 preset 切换**——可靠杠杆只有 registry 的 `deep:0` leaf deny(persona + toolFilter,双宿主都有实现)与宿主 subagent volatile 配置;② 不要给契约加 `executor.preset` 字段(v1);③ in-process child 默认 `composeFrom` 父的当前 preset 修订,**继承了主会话的工具面**——这反而是 v1 想要的(子代理与主面同构)。

### 3.2 preset 层挂载约定(cordis.patch.yml 实样)

- preset 行 = `- insert` 里两条 `@deepseek-ai/dsh-agent-preset` 行(config `{id, name, description, order, plugins:[…]}`,plugin 清单全量声明);registry 服务行 `agent-preset-registry`(config `default: native`)+ 官方 ptc preset 依赖的裸行 `subagent-model-selection-settings`(**缺了 preset mount 直接 failed to load**)。
- tui profile 必须 `- insert`(`- id:` 覆盖式报 entry not found);preset 选择无 CLI flag,只有 TUI `/preset <id>`(fresh 生效,rememberPreset 按工作目录记忆)。
- **bundle 主插件不会被宿主自动挂载**,必须自带 `- id: dsh-ptc-subagent, name: '@aiwayds/dsh-ptc-subagent'` 行(实测 2026-10-14,没这行 codemode 工具不进注册表)。
- 工具本身挂 **standing scope**(profile bundle),不挂 preset 内——主 agent 和派发的子代理都能看到。这正对 workflow:roster 引用的执行者是普通注册工具的消费者,preset 无关。

### 3.3 install-profile.mjs 挂载/冲突守卫思路(dsh-workflow 可直接抄)

`~/repo/dsh-ptc-subagent/scripts/install-profile.mjs`:
1. 改前时间戳 `.bak` 备份 profile 的 package.json 与 cordis.patch.yml;
2. **冲突守卫**:`SHIPPED_ROW_IDS`(本 bundle 会让 profile patch 出现的 entry id)正则扫 profile patch,命中即 abort——**跨 patch 层重复 entry id 会让 cordis loader 崩**;
3. bundle 追加进 `dsh.profile.bundles` + 依赖(`link:` dev 或 npm 版)+ `pnpm install --registry npmjs`;
4. agent 定义**复制**(非链接)到 `~/.dsh/agents/ptc-subagent.md`,存在则跳过、`--force-agent` 才覆盖、`--purge-agent` 卸载;
5. `--check` 用 `dsh --dump-config` 验静态树。

## 四、执行契约草案(供 YAML schema 票与 spec 综合票)

### 4.1 Step 引用语法(YAML)

```yaml
steps:
  - id: implement-core
    executor:
      agent: workhorse            # 必填。= ~/.dsh/agents/workhorse.md 的 frontmatter name
                                  # 校验规则:name 非空、无路径分隔符、等于某 <name>.md 的文件身份
      prompt: |                   # 可选;缺省用 step 的 task/input 模板。必须自包含(子代理看不到父会话)
        实现 {{inputs.module}} …
      # ---- 以下全部可选,缺省吃 agent 定义 ----
      # model: volc-ark-plan/deepseek-v4-flash   # 运行时覆盖;不写回 agent 文件
      # thinking: high                           # 同上
      # output: json                             # 声明后走 request.outputSchema,SubagentResult.structured 判定
    retry: { … }
    acceptance: { … }
```

- 引用名**永远用 `name`**,不用 `display_name`(可能歧义/被改名;registry 自己的 label→cap 查找对歧义 display_name 是 fail-closed 的,同一哲学)。
- v1 **不设** `executor.preset`、不设 `executor.tools`(presentAs 雷 + registry 格式无工具面;工具面差异化 = agent 定义里的 `deep: 0`,由 agent 文件作者负责)。

### 4.2 解析时机与失败语义(两层,各自明确)

| 时机 | 动作 | 失败语义 |
|---|---|---|
| **load 时(validate/lint)** | 列 agentsDir(与 registry 同解析),校验每个 `executor.agent` 存在且未 broken | workflow 加载失败(结构错误),报错带 `available agents: …`(对齐 `loadAgent` 的 roster-aware 错误格式)。**仅是编辑期 lint,不构成 run 时保证**——agents 目录运行时可改(Web CRUD 面真实存在) |
| **run 时(resolve,权威)** | 每个 step 派发前重读 `<dir>/<name>.md`(与 `use_agent`/`readAgentMaxRounds` 的 call-time 重读惯例一致),现场取 persona/model/thinking | 文件消失/改名/broken → **step fail-fast,不进 retry**(重试不会自愈);run 记 step 级 error 事件,错误消息透传 parser 具体原因;按 step 的 on-error 策略决定 run 终止或跳过 |

- 派发后失败沿用 `SubagentResult.stopReason` 词表:`completed / aborted / error / max-tokens / refusal` + `diagnostic`(provider 提供的 ≤4096B 摘要)→ 非 completed 映射为 step 失败,partial output 落 run store。
- `output: json` 时:`structured` 缺失**不等于失败**(官方语义:schema 请求不保证 presence)——acceptance 必须双轨(structured 在则验 schema,不在则退文本判定并标注降级)。
- 续跑边界:workflow 的续跑 = run-store checkpoint + 整步重跑(治理票在决);**不复用 registry 的 auto-resume**(它绑定"同父会话 + `[fg]` label",与 run 生命周期正交)。workflow 直呼官方缝时 resume 机制本来就不介入,天然规避。

### 4.3 发起执行的推荐链路(v1)

**路线 A(推荐):自建 dispatch,只依赖官方缝 + agents 目录,不依赖 registry 插件挂载**

1. `inject: ['subagents', 'agents', 'systemPrompt', 'tools']`;provider 取 `spawn`(与 registry 同默认,含 dsh-base 的 profile 必有)。
2. 解析 agents 目录(自带 parser 副本,格式对齐 AGENT-FORMAT.md;键锁定 `name/deep/display_name/description/model/thinking/background/maxRounds`)。
3. 组 `SubagentStartRequest`:`parent` 取发起语境的 Agent(tool execute 的 `exec.agent`;脱离工具语境时 `ctx.agents.currentInitiator()`);`label = [wf] <runId>/<stepId>`(**绝不裸 agent 名**,避免被 use_agent resume 认领);`maxDepth = resolveChildDepth(parent, undefined) + deep`(deep 缺省 1;永远显式传,不吃宿主默认 1);`agentOptions` 按 model/thinking;`deep:0` → `toolFilter.deny`(默认 deny 表与 `ctx.tools.view().restrictableNames` 求交)。
4. 派发:`ctx.subagents.startActivation({ provider, label, request, signal, delivery: 'caller', childId })` — README 原话 **"delivery: 'caller' lets workflows await the result without a parent notice or initial return guidance"**,这就是给 workflow 设计的口子。
5. **0.2.1 线 persona 落地(必须自己做,公开 API 足够)**:request 在此线无 `persona`/`toolFilter` 字段;复刻 registry 手法——自维护 `Map<childId, composition>`(存活至父 session dispose,`agent/disposed` 清理),`ctx.on('subagent/start')` 边对 `ctx.agents.get(info.id)` 装 `ctx.systemPrompt.section({ name: 'deployment:persona-prefix', … })` + `ctx.tools.restrict(...)`。registry 用同一公开窗口,私有的只是寄存 Map(~60 行)。
6. 结果:`activation.result` → `SubagentResult`;`activation.dispose()` 收尾;`subagent/end` 事件喂 Monitor 投影。

**路线 B(长期):推 registry 上游加程序化导出**(如 `dispatchRegistryAgent(ctx, cfg, {agent, prompt, parent, signal, fresh})` + 导出 `listAgentFiles`)——单一实现、双宿主兼容白拿;路线 A 先行,上游落地后切。
**路线 C(否决)**:模拟调用 `use_agent` 工具——无干净跨插件调用面,`exec.agent` 语境伪造不了。

### 4.4 preset/presentAs 雷的规避(写进 spec 的硬规则)

1. 契约不出现 preset 字段;Step 执行者的能力边界 = agent 定义(`deep`、`background`、`model`、`thinking`、`maxRounds`)+ Step 级 prompt/输出 schema。
2. 子代理默认 `composeFrom` 父 preset(继承主面组合与工具面)——**这是 v1 语义,写死**;不要试图给某 step 的 child 换 preset/工具面。
3. 将来要 PTC-face/异构工具面 specialist:唯一候选是 `SubagentStartRequest.agentPreset`(0.2.1 独立选择,spawn-only,`capabilities.agentPreset` 门控;独立选择会在 child log 记 `agent-preset/selected` 且 cold-resume 可恢复)——但 preset 内 presentation 行仍受 presentAs 断裂影响,**标注为未知、v1 不做**,等上游修 presentAs preset scoping 后重评。
4. 挂载面抄 install-profile.mjs:bundle 自带 mount 行、entry id 冲突守卫、`- insert` 形式、agent .md 复制不链接、`--check` 验静态树。

## 五、风险 / 未知

1. **0.2.1 persona 外科手术的私有性**:registry 的 out-of-band 组合可行已证,但寄存 Map 生存期、每 run 重装、`agent/disposed` 剪枝这些细节要逐条复刻;上游若把 `applyChildOverrides` 公开为缝应立即切换。(host-compat.ts L40-52 注释即施工图)
2. **`agentPreset` 独立 spawn 未真机验证**:类型与 README 都在,registry 未用过;presentAs 断裂是否波及独立选择未测。
3. **presentAs 修复状态未知**:实证是 0.2.0-rc.2;0.2.1-rc.2 是否修复未验证(设计文档列了上游 issue 候选①)。
4. **parser 副本漂移**:registry 公开导出缺 roster 读取函数,workflow 自带副本后,frontmatter 合同演进(如 TODO 中的 `maxTokens`)需双侧同步;建议在 dsh-workflow 里留指向 AGENT-FORMAT.md 的版本锚(当前 v0.14.1)。
5. **`xhigh` 文档缺口**:解析器白名单含 `xhigh`,AGENT-FORMAT.md 未列——schema 校验以解析器为准,文档侧提醒上游。
6. **`delivery: 'caller'` 的持久化语义**:README 说 caller delivery 可用 ephemeral local session——run store 若要 child 会话事后可打开/续聊,delivery 与持久化前提升的条件需宿主原语实测票钉死。
7. **容量**:`maxActiveSubagents` 默认 8(ActivationManager 全局,不排队,超限 `ACTIVATION_LIMIT_REJECTED`)——workflow fan-out 上限要在治理票定,retry 要能识别该错误码。
8. **registry 可配 toolName**:契约不得硬编码 `use_agent` 字符串做探测;探测 registry 是否挂载应走包名/插件清单而非工具名。
9. **`deep` 不重_arm**:`deep` 是 per-call 相对预算,不重置更深层后代——workflow 的 fan-out 子树深度要按"每层各自的 cap"理解,最外层 maxDepth 是兜底。

## 关键文件索引

- `~/repo/dsh-subagent-registry/src/{agents-dir,tool-run-agent,resume,host-compat,profile-resolution,agent-caps,preset-store,preset-contract,presets-rpc,index}.ts`、`docs/AGENT-FORMAT.md`、`templates/agents/*.md`
- `~/repo/dsh-ptc-subagent/{cordis.patch.yml,agents/ptc-subagent.md,scripts/install-profile.mjs,CHANGELOG.md}`、`~/repo/dsh-ptc-subagent-design-20261014.md`(§8 实证)
- `~/repo/dsh-feishu/src/{binder,bot,resume-table}.ts`(sessionQuery projection 教训)
- closure 类型:`…/node_modules/@deepseek-ai/dsh-subagent/lib/types/{types,catalog,list-children}.d.ts`、`@deepseek-ai/dsh-agent-preset-registry/lib/types/{session,index}.d.ts`、`@deepseek-ai/dsh-session-query/lib/types/index.d.ts`、`@deepseek-ai/dsh-agent-tool-presentation/lib/index.js`
