---
name: dsh-workflow-config
description: dsh-workflow 插件使用与配置指南。凡涉及创建/修改/删除/运行 workflow、.workflow.yaml 文件的写法(schema/字段/示例)、阶段 phase 与 foreach 扇出、断点续跑 resume、token 成本账、run 记录查询、roster agent 引用、插件安装(install-profile),先读本指南。触发词:workflow、工作流、流水线、dsh-workflow、run、resume、增删改查 workflow。
---

# dsh-workflow 使用指南

dsh-workflow 把可重复的工作(发版波/迁移波/巡检/情报搜集)固化成
**声明式 YAML 文件**:一个文件一个 workflow,可进 git、可审、可断点续跑。

## 心智模型(先读)

- **一个 Workflow = 一个 `.workflow.yaml` 文件**:步骤图 + 依赖 + 重试 + 验收
- **一个 Step = 一次子代理派发**:执行者是用户 roster 里的 agent
  (`~/.dsh/agents/<name>.md` 的 `name`,如 workhorse)
- **执行是 needs 有向图,展示是树**;foreach 步对上游数组扇出
- **每步终态即落盘**(`.dsh/workflow-runs/<runId>/`):中断后 resume,
  已完成步零成本重放
- **硬规则**:YAML 只声明结构;JS 只允许出现在单步 `action` 内;
  未知键报错;`name` 必须等于文件名

## 增(创建)

用户说"建一个 workflow 做 X"时:**写到个人库 `$DSH_HOME/workflows/`**
(缺省 `~/.dsh/workflows/`;目录不存在就 `mkdir -p`;文件名 kebab-case,
名=文件名),写完跑 `/wf list` 确认新条目出现,再告诉用户
`/workflow run <文件>`。仅项目专属的 workflow 才放启动目录(cwd)——
个人通用的进个人库,`/wf` 在任何目录启动都能看到它。

最小骨架:

```yaml
format: dsh-workflow
version: 1
name: my-first
description: 一句话说明
steps:
  - id: main
    executor:
      agent: workhorse        # ~/.dsh/agents/ 里必须存在
    prompt: |
      具体任务指令,可用 {{inputs.x}} 引用输入
```

常用进阶字段(都有,按需):`inputs[]`(声明参数)、`needs: [步id]`(依赖)、
`foreach:`(over 上游数组/as 别名/max-concurrency/step 模板)、
`retry: {max, backoff-ms}`、`on-error: fail|skip|continue`、
`cache: always|on-failure|never`(副作用步用 never)、`confirm: true`
(外向动作先确认)、`phase: <阶段名>`(配合顶层 phases 出分段视图)、
`output`(object JSON-schema,结果结构化)、`acceptance`
(`output-contains`/`output-matches`)、`action`(单步内纯函数,唯一可写 JS 处)。

完整对照样张:仓库 `examples/dsh-plugin-wave.workflow.yaml`
(3 阶段 + foreach 扇出 + 确认门)。

写完自检三条:①所有 `executor.agent` 在 roster 里存在;②`required` 里的
字段都在 `properties` 里声明;③引用 `{{steps.<id>.output...}}` 的上游步存在。

## 查(运行记录)

- `/workflow runs [N]` — 列最近 run(状态/名字/时间)
- `/workflow show <runId>` — 单 run 详情:每步状态/token 账/错误
- 记录在磁盘 `<工作区>/.dsh/workflow-runs/<runId>/`(run.json/events.jsonl/results/)

## 改 / 删

- **改**:直接编辑 `.workflow.yaml`(name 保持等于文件名);已完成的 run
  不受影响(rerun 用当前版本,resume 用当时的不可变快照)
- **删**:直接删文件;历史 run 用 `/workflow prune --keep N` 清理

## 运行 / 续跑 / 停止

- `/workflow run <file> [json参数]` — 默认后台(返回 run+job id);
  加 `--wait` 阻塞看结果
- `/workflow resume <runId>` — 断点续跑:completed 步重放,
  cache: never 步真重跑;被打断的步会先查子代理会话日志
  (结局为 completed 则直接捞回产出,零重跑)
- `/workflow stop <runId>` — 停止后台 run
- 外向动作(发布/tag)给步标 `confirm: true`——后台模式会跳过并提示,
  前台 --wait 会弹确认

## 配置

插件经 profile 的 bundle 挂载(entry id `dsh-workflow`,包
`@aiwayds/dsh-workflow`)。安装/升级用仓库
`scripts/install-profile.mjs --profile <名>`(--check 验证;--uninstall 卸载)。
治理参数当前为内置默认(并发 4、保留 100 runs);引擎通过
`ctx.subagents` 派发,子代理工具面与主会话一致。

## 常见错误速查

| 现象 | 原因 |
|---|---|
| `unknown key "x"` | YAML 写了 schema 外字段(白名单校验) |
| `unknown agent "x" — available agents: …` | roster 里没有该名字(检查 ~/.dsh/agents/) |
| `required names "x" which is not in properties` | output schema 的 required 未在 properties 声明 |
| `name "x" must equal the file stem` | 文件名与 name 不一致 |
| `reference {{…}} points at an undeclared input` | 引用了未声明的 inputs |
