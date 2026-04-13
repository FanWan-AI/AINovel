# Agent-First 开发规范

## 1. 目标

让 Agent（如 GPT-5.3-Codex）成为主要开发执行者，人类工程师负责验收与守门。

## 2. 基本原则

1. 任务结构化：所有任务必须可机读。
2. 变更可追溯：每次改动有明确输入、输出、测试证据。
3. 风险可控：高风险动作需人工确认。

## 3. 任务规范（Task Spec）

每个任务必须包含：
- `task_id`
- `context`
- `goal`
- `in_scope`
- `out_of_scope`
- `acceptance_criteria`
- `constraints`
- `deliverables`

## 4. Agent 执行输出模板

- `summary`
- `changed_files`
- `tests_run`
- `risks`
- `followups`

## 5. 开发流水线

1. Agent 读取任务 spec
2. Agent 生成/修改代码
3. Agent 执行测试与静态检查
4. Agent 输出变更报告
5. 人类工程师审核并合并

## 6. 质量门禁

必须通过：
- typecheck
- unit/integration tests
- 关键 E2E（若涉及主流程）
- 文档同步更新

## 7. 风险分级与审批

- Low：常规 UI 文案调整，可自动合并
- Medium：业务逻辑变更，需代码审查
- High：鉴权、支付、数据删除、同步核心逻辑，必须人工审批

## 8. 接口契约要求

- Agent 不得绕过共享契约文件。
- 新接口必须同步契约与测试。
- 错误码必须稳定且可机读。

## 9. 观测与审计

每次 Agent 执行记录：
- 输入任务版本
- 输出结果
- 测试结果
- 合并人
- 发布时间

## 10. 失败处理

若 Agent 任务失败：
1. 自动汇总失败原因
2. 回滚到最近稳定提交
3. 生成修复任务并重新执行

