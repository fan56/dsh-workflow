---
status: open
type: research
blocked-by: []
claimed-by: fan56
---

# 社区 capsule 解剖:147⭐ 插件的五面做法

## Question

omdsh-dev/dsh_workflow(147⭐,npm `@dsh-external/workflow`)在五个面上的具体做法是什么?产出**借鉴/避开清单**。

1. **capsule**(`dsh.workflow` v1)schema 全貌:manifest/source/intent/inputs/requires/provenance 的字段与校验
2. **run store**:目录结构与 events.jsonl 事件词表
3. **effect cache 续跑**:键(调用序号+task input)怎么算、命中后怎么跳过、对流水线场景够不够
4. **命令族与三工具**:/workflow 命令 + workflow_list/run_workflow/workflow_manage 的注册方式与授权模型(一次性显式授权那套)
5. **Session 投影**:它怎么把 run 投影进 Session 事件/官方 UI 可观察性;QuickJS VM 的 capability RPC 面

注意:它 compatibility 锁 0.0.1-rc.2(2026-08-13 测),与 0.2.1-rc.2 的 API 差异只标注、不深挖(宿主原语实测票负责现版本事实)。

## 素材

- 本地浅克隆:/tmp/wf-survey/dsh_workflow(约 5435 行 TS,src/ 12 文件,README + docs/KODAX_PARITY.md + docs/CONFIGURATION.md)
- 若 /tmp 已清,重新浅克隆 github.com/omdsh-dev/dsh_workflow

## 产出

五面事实 + 借鉴/避开清单 → 喂给 YAML schema 草稿票(对照物)和 spec 综合票。
