---
status: closed
type: prototype
blocked-by: [02-capsule-anatomy.md]
claimed-by: null
---

# YAML schema v1 草稿:dsh-plugin-wave 真流程表达

## Question

双轨 YAML(结构声明 + 单步 Action)长什么样?能否**无损表达 dsh-plugin-wave 迁移流水线**?

1. 拿 dsh-plugin-wave 真流程(官方发新 RC → 全仓波次适配 → 发版收尾)写一份 `.workflow.yaml` 草稿:步骤图/依赖/重试/验收/registry agent 引用/1-2 处单步 Action
2. 字段命名与 147⭐ capsule 对照:借鉴不照抄
3. 顺带钉出 schema 必选/可选边界与校验规则草案

## 素材

- capsule 解剖票的产出(对照物)
- dsh-plugin-wave 流程:ZCode 侧 saved workflow 已固化(定稿保护/时长预算门控/wait-what 直白度等),但本票只取其**步骤骨架**做表达力测试,不迁移其领域逻辑

## 产出

示例 YAML + schema 草案 → 给用户过目拍板(HITL)。这是 YAML 双轨铁律的第一次实战检验。

## Resolution(2026-10-20,closed)

产物:[examples/dsh-plugin-wave.workflow.yaml](../../examples/dsh-plugin-wave.workflow.yaml)(用户已委托拍板,细节不逐项确认)。要点:

1. **表达力结论:dsh-plugin-wave 五步流水线可无损表达**——情报/审计/fan-out 适配/汇总/验证/发版,全程无一处需要步骤间脚本状态。
2. **schema v1 字段面钉死**:必选 `format/version/name/steps[]`;步必选 `id/executor.agent/prompt`,可选 `needs/foreach/retry{max,backoff-ms}/on-error(fail|skip|continue)/cache(always|on-failure|never)/confirm/output(json-schema 子集)/acceptance(output-contains|output-matches)/action`。
3. **fan-out 用 `foreach`**(over/as/max-concurrency/内嵌 step 模板)——拒绝 147⭐ 的六 pattern 封闭枚举进 schema(02 票教训:分类学负担)。
4. **`action` 的最小语义**:纯函数输入整形——入参=声明引用快照,返回 JSON 并入该步 prompt 上下文;不做后置处理(后置归 acceptance 谓词)。
5. 引用模板 `{{inputs.x}}` / `{{steps.<id>.output[.path]}}` / `{{item}}`;`action-output` 同为可引用产物。
6. YAML schema 校验纪律(承 02 票):未知字段报错(fail-loud 白名单)、name/文件名互锁、交叉不变量(foreach.max-concurrency ≤ 治理上限)。

表达力遗留(进雾,不阻塞 spec):条件边(`if`)、foreach 嵌套、跨 workflow 引用。

## M4 Acceptance(2026-10-21,v1 验收基准通过)

dsh-plugin-wave 形状的流水线(wave-smoke:intel→audit→foreach adapt→wrap,
3 phases+4 inputs)在真宿主全链路验收:

1. **首轮后台跑**(真模型真子代理):audit 真判断了 4 个候选仓,foreach 派发
   4 个子代理——中途 /quit 真实打断(进程死,run 冻结在 running)
2. **resume 断点续跑**:新 run 从 checkpoint 起跑,全 8 步 completed 至 wrap
   (期间抓到并修复:resume 快照加载误触 name/stem 互锁——真机发现)
3. 附带实证:后台 job 存活跨 script 会话脱离;token 账全程落盘
   (累计 ~165k tok 可审计)

schema v1.1(phases+step.phase)随本轮进入——v3 overlay 的段 tab 数据源就绪。
