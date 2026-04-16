# AI助手 NovelOS 实施级详细设计与 Agent 执行蓝图

## 1. 文档定位

本文档是 17 号设计的实施版，目标是：

1. 可直接拆分给多个工程 Agent 并行开发。
2. 每个任务都能独立交付、可验证、可合并。
3. 以“真实打通功能”为导向，不停留在概念层。

上游文档：

1. [17-顶级小说创作智能体设计与实现方案.md](./17-%E9%A1%B6%E7%BA%A7%E5%B0%8F%E8%AF%B4%E5%88%9B%E4%BD%9C%E6%99%BA%E8%83%BD%E4%BD%93%E8%AE%BE%E8%AE%A1%E4%B8%8E%E5%AE%9E%E7%8E%B0%E6%96%B9%E6%A1%88.md)
2. [16-AI助手中枢化升级-并行Issue包.md](./16-AI%E5%8A%A9%E6%89%8B%E4%B8%AD%E6%9E%A2%E5%8C%96%E5%8D%87%E7%BA%A7-%E5%B9%B6%E8%A1%8CIssue%E5%8C%85.md)

---

## 2. 目标与完成标准

### 2.1 功能总目标

用户通过 AI 助手页面，仅通过聊天完成：

1. 小说增删改查（书/章/run 级）。
2. 章节与全书质量审核。
3. 自动改进或按用户意见改进。
4. 过程可解释、可审批、可回滚。

### 2.2 最小可用闭环（MVP-Plus）

闭环链路必须一次性打通：

1. 用户输入目标 -> 识别意图 -> 生成计划 -> 参数确认。
2. 执行 write-next / audit / revise / rewrite / radar。
3. 质量评分卡返回 + 下一步建议卡。
4. 用户可一键继续、修改参数重跑、或审批候选修订。

### 2.3 上线门槛（Go/No-Go）

1. 关键 E2E 场景 100% 通过。
2. `@actalk/inkos-studio` 测试全绿。
3. 阻断级缺陷 0 个。
4. assistant 关键路径平均响应：
5. 计划生成 <= 3 秒。
6. 首个进度事件 <= 2 秒。
7. 非长任务完成反馈 <= 15 秒。

---

## 3. 现有资产复用策略

### 3.1 前端复用

1. 助手页骨架：[packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)
2. 侧栏聊天能力：[packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
3. 路由与导航：[packages/studio/src/App.tsx](../packages/studio/src/App.tsx)
4. i18n 字典：[packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)

### 3.2 后端复用

1. 原子动作 API：[packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. 章节运行记录 ledger（diff/approve/delete）：[packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
3. 运行事件中心与 SSE：[/api/events + runtime/events]

### 3.3 Core 复用

1. Pipeline 主干：[packages/core/src/pipeline/runner.ts](../packages/core/src/pipeline/runner.ts)
2. Agent 能力：planner/composer/writer/reviser/continuity/radar

原则：先编排层改造，尽量不重写 core 原子能力。

---

## 4. 目标技术架构（实施版）

### 4.1 组件图（逻辑）

1. Assistant UI（消息流、确认卡、结果卡、质量卡）
2. Assistant Frontend Runtime（Intent Router + Task Session Store）
3. Assistant Orchestrator API（计划、执行、评估、优化）
4. Existing Atomic APIs（write-next/audit/revise/rewrite/resync/radar）
5. Quality Engine（评分聚合 + 改进建议）
6. Memory Layer（会话记忆 + 书籍事实引用）

### 4.2 关键约束

1. 所有执行必须产生 taskId + runId 关联。
2. 所有高风险动作必须过确认卡。
3. 所有失败必须有重试分支与降级策略。
4. 所有结果必须包含 evidence（最少 1 条引用依据）。

### 4.3 自动驾驶等级与策略门禁

1. L0 手动：只出建议，禁止自动执行。
2. L1 辅助：每步确认执行。
3. L2 半自动：低风险自动、高风险确认。
4. L3 全自动：在预算与风险门禁下全链路自动。

策略门禁输入：

1. `riskLevel`。
2. `budgetRemaining`。
3. `userRole`。
4. `bookLockState`（是否被人工编辑锁定）。

---

## 5. 接口契约（可直接开发）

统一响应外壳（全部 assistant API）：

```json
{
  "ok": true,
  "requestId": "req_xxx",
  "timestamp": "2026-04-16T12:00:00.000Z",
  "data": {}
}
```

统一错误外壳：

```json
{
  "ok": false,
  "requestId": "req_xxx",
  "timestamp": "2026-04-16T12:00:00.000Z",
  "error": {
    "code": "ASSISTANT_EXECUTE_STEP_FAILED",
    "message": "step s2 failed",
    "retryable": true
  }
}
```

## 5.1 POST /api/assistant/plan

用途：把自然语言请求转成可执行任务草案。

请求：

```json
{
  "sessionId": "asst_s_001",
  "input": "审计第14章并自动修复主要问题",
  "scope": {
    "mode": "single",
    "bookIds": ["book_abc"]
  },
  "preferences": {
    "autoFix": true,
    "riskTolerance": "medium"
  }
}
```

响应：

```json
{
  "taskId": "asst_t_1001",
  "intent": "audit_and_optimize",
  "confidence": 0.93,
  "requiresConfirmation": true,
  "missingParams": [],
  "plan": [
    { "stepId": "s1", "action": "audit", "chapter": 14 },
    { "stepId": "s2", "action": "revise", "mode": "spot-fix" },
    { "stepId": "s3", "action": "re-audit" }
  ],
  "risk": {
    "level": "medium",
    "reasons": ["涉及章节内容改写"]
  }
}
```

失败码：

1. `ASSISTANT_PLAN_VALIDATION_FAILED`
2. `ASSISTANT_PLAN_SCOPE_REQUIRED`
3. `ASSISTANT_PLAN_INTENT_UNKNOWN`

## 5.2 POST /api/assistant/execute

用途：执行计划或单步动作。

请求：

```json
{
  "taskId": "asst_t_1001",
  "sessionId": "asst_s_001",
  "approved": true,
  "executionMode": "semi-auto",
  "plan": [
    { "stepId": "s1", "action": "audit", "bookId": "book_abc", "chapter": 14 },
    { "stepId": "s2", "action": "revise", "bookId": "book_abc", "chapter": 14, "mode": "spot-fix" },
    { "stepId": "s3", "action": "audit", "bookId": "book_abc", "chapter": 14 }
  ]
}
```

响应：

```json
{
  "taskId": "asst_t_1001",
  "status": "running",
  "eventStream": "/api/events",
  "runRefs": [
    { "stepId": "s1", "runId": "run_01" },
    { "stepId": "s2", "runId": "run_02" }
  ]
}
```

失败码：

1. `ASSISTANT_EXECUTE_TASK_NOT_FOUND`
2. `ASSISTANT_EXECUTE_NOT_APPROVED`
3. `ASSISTANT_EXECUTE_STEP_FAILED`

补充执行策略字段：

1. `autopilotLevel`：`L0|L1|L2|L3`
2. `policyProfile`：`safe|balanced|aggressive`
3. `budgetLimit`：本任务最大 token / 成本

## 5.3 POST /api/assistant/evaluate

用途：聚合章节/全书质量评分。

请求：

```json
{
  "taskId": "asst_t_1001",
  "scope": { "type": "chapter", "bookId": "book_abc", "chapter": 14 },
  "runIds": ["run_01", "run_02"]
}
```

响应：

```json
{
  "taskId": "asst_t_1001",
  "report": {
    "overallScore": 78,
    "dimensions": {
      "continuity": 81,
      "readability": 76,
      "styleConsistency": 74,
      "aiTraceRisk": 69
    },
    "blockingIssues": [
      "动机承接偏弱"
    ],
    "evidence": [
      {
        "source": "chapter:14",
        "excerpt": "...",
        "reason": "冲突目标与行动结果不一致"
      }
    ]
  },
  "suggestedNextActions": [
    "spot-fix",
    "re-audit"
  ]
}
```

## 5.4 POST /api/assistant/optimize

用途：按评分和策略自动修复。

请求：

```json
{
  "taskId": "asst_t_1001",
  "strategy": {
    "maxIterations": 2,
    "targetScore": 82,
    "allowedModes": ["spot-fix", "polish"]
  }
}
```

响应：

```json
{
  "taskId": "asst_t_1001",
  "status": "running",
  "iteration": 1
}
```

## 5.5 GET /api/assistant/tasks/:taskId

响应字段：

1. `status`: draft | awaiting-confirm | running | succeeded | failed | cancelled
2. `progress`: 0-100
3. `steps`: 每步状态
4. `runRefs`: stepId -> runId
5. `latestReport`: 最近一次质量报告摘要

## 5.6 GET /api/assistant/skills

用途：返回可用技能与权限。

响应字段：

1. `skills[]`：`name/version/riskLevel/allowedScopes/enabled`
2. `source`：`builtin|project|trusted`
3. `requiresApproval`：是否默认审批

## 5.7 POST /api/assistant/policy/check

用途：执行前门禁校验（风险/预算/权限）。

响应字段：

1. `allow`：true/false
2. `reasons[]`
3. `requiredApprovals[]`

---

## 6. 前端实施细节

## 6.1 页面职责重构

1. AssistantView：唯一主助手工作台，承载完整编排。
2. ChatBar：降级为快捷入口，点击后跳转 assistant 路由并透传 prompt。

## 6.2 AssistantView 新增状态模型

在 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx) 新增：

```ts
interface AssistantTaskState {
  taskId: string;
  status: "draft" | "awaiting-confirm" | "running" | "succeeded" | "failed" | "cancelled";
  plan: Array<{ stepId: string; action: string; status: string }>;
  runRefs: Array<{ stepId: string; runId: string }>;
  report?: AssistantQualityReport;
  error?: string;
}
```

## 6.3 新组件拆分

1. `assistant/TaskPlanCard.tsx`
2. `assistant/TaskProgressTimeline.tsx`
3. `assistant/QualityReportCard.tsx`
4. `assistant/NextActionCard.tsx`
5. `assistant/EvidenceDrawer.tsx`

建议目录：

1. [packages/studio/src/components/assistant](../packages/studio/src/components/assistant)

## 6.4 交互规则

1. 输入后先调用 `/api/assistant/plan`。
2. 若 `requiresConfirmation=true`，展示确认卡。
3. 确认后调用 `/api/assistant/execute`。
4. 监听 SSE 更新任务步骤状态。
5. 执行完成自动调用 `/api/assistant/evaluate`。
6. 若低于阈值且用户允许自动改进，调用 `/api/assistant/optimize`。

---

## 7. 后端实施细节

## 7.1 server.ts 增加 Assistant Orchestrator 路由

目标文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)

新增函数：

1. `buildAssistantPlan(input, scope, preferences)`
2. `executeAssistantPlan(plan, context)`
3. `evaluateAssistantTask(taskId, runRefs)`
4. `optimizeAssistantTask(taskId, strategy)`

## 7.2 原子动作映射表

1. `write-next` -> `/api/books/:id/write-next`
2. `audit` -> `/api/books/:id/audit/:chapter`
3. `revise` -> `/api/books/:id/revise/:chapter`
4. `rewrite` -> `/api/books/:id/rewrite/:chapter`
5. `resync` -> `/api/books/:id/resync/:chapter`
6. `radar` -> `/api/radar/scan`

## 7.3 任务持久化

新增轻量存储（可先文件/内存，二期升级 DB）：

1. `assistant/tasks/<taskId>.json`
2. `assistant/sessions/<sessionId>.json`

最小字段：

1. request
2. plan
3. state
4. step results
5. linked runIds
6. quality reports

## 7.4 SSE 事件规范

事件命名：

1. `assistant:plan:ready`
2. `assistant:step:start`
3. `assistant:step:success`
4. `assistant:step:fail`
5. `assistant:evaluate:complete`
6. `assistant:optimize:start`
7. `assistant:task:done`
8. `assistant:policy:blocked`
9. `assistant:budget:warning`

字段统一：

1. `taskId`
2. `sessionId`
3. `stepId`（可选）
4. `runId`（可选）
5. `message`
6. `timestamp`
7. `traceId`
8. `severity`（info|warn|error）

## 7.5 命令面协议（Operator Commands）

命令解析优先级高于自然语言路由：

1. `/goal <text>`
2. `/status`
3. `/pause`
4. `/resume`
5. `/approve <stepId|taskId>`
6. `/rollback <runId>`
7. `/trace on|off`
8. `/budget`

建议新增解析器文件：

1. `packages/studio/src/api/services/assistant-command-parser.ts`

---

## 8. Core 协同改造

## 8.1 最小改造原则

1. 不重写 `PipelineRunner`。
2. 在编排层实现 action 调度和结果聚合。
3. 评分模型先基于现有 audit + ai-tells + run diff，后续再引入学习型权重。

## 8.2 新增服务（studio/api/services）

1. `assistant-plan-service.ts`
2. `assistant-execution-service.ts`
3. `assistant-evaluation-service.ts`
4. `assistant-optimization-service.ts`
5. `assistant-policy-service.ts`
6. `assistant-skill-registry-service.ts`
7. `assistant-command-parser.ts`

---

## 9. Agent 可执行工作包（可直接派发）

## WP-01：前端任务状态机与计划卡

目标：完成 plan -> confirm -> execute UI 主链路。

改动文件：

1. [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)
2. [packages/studio/src/components/assistant/TaskPlanCard.tsx](../packages/studio/src/components/assistant/TaskPlanCard.tsx)
3. [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)

验收：

1. 输入后出现计划卡。
2. 可确认/取消。
3. 状态机可从 `draft` 到 `awaiting-confirm`。

## WP-02：Assistant Plan API

目标：实现 `/api/assistant/plan`。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. 能返回 taskId 与 plan。
2. 缺参数返回标准错误码。

## WP-03：Assistant Execute API + 原子动作调度

目标：实现 `/api/assistant/execute` 与步骤执行。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. 至少打通 audit->revise->re-audit 三步。
2. runId 正确关联。

## WP-04：SSE 任务事件流

目标：让 assistant 任务状态可实时展示。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/hooks/use-sse.ts](../packages/studio/src/hooks/use-sse.ts)
3. [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)

验收：

1. step start/success/fail 事件可视化。
2. 任务完成态可稳定结束 loading。

## WP-05：质量报告聚合与展示

目标：实现 `/api/assistant/evaluate` + 前端质量卡。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/components/assistant/QualityReportCard.tsx](../packages/studio/src/components/assistant/QualityReportCard.tsx)
3. [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)

验收：

1. 返回整体分与维度分。
2. 显示 blocking issues 与 evidence。

## WP-06：自动优化循环

目标：实现 `/api/assistant/optimize`。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. 达到目标分自动停止。
2. 超过迭代上限转人工。

## WP-07：ChatBar 与 AssistantView 语义统一

目标：避免双入口逻辑割裂。

改动文件：

1. [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
2. [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)

验收：

1. ChatBar 提交可跳转 assistant 并带 prompt。
2. ChatBar 不再执行独立编排闭环。

## WP-08：任务持久化与恢复

目标：支持刷新恢复进行中的任务。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)

验收：

1. 刷新页面可恢复任务状态。
2. 历史 task 可查询。

## WP-09：测试与回归保障

目标：补齐单元、集成、E2E。

改动文件：

1. [packages/studio/src/pages/assistant-view.test.ts](../packages/studio/src/pages/assistant-view.test.ts)
2. [packages/studio/src/components/chatbar-state.test.ts](../packages/studio/src/components/chatbar-state.test.ts)
3. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. 新增测试覆盖率达到模块 80%+。
2. 关键链路 E2E 全通过。

## WP-10：策略门禁与预算守卫

目标：实现执行前策略检查和预算控制。

改动文件：

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. `packages/studio/src/api/services/assistant-policy-service.ts`
3. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. 高风险未审批动作被阻断。
2. 超预算任务自动暂停并发出 warning 事件。

## WP-11：技能注册与权限模型

目标：建立 assistant skills registry（builtin/project/trusted）。

改动文件：

1. `packages/studio/src/api/services/assistant-skill-registry-service.ts`
2. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
3. [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)

验收：

1. `/api/assistant/skills` 返回技能列表与权限。
2. 禁止调用未授权技能。

## WP-12：命令面与会话控制

目标：实现 `/goal /status /pause /resume /approve /rollback /trace /budget`。

改动文件：

1. `packages/studio/src/api/services/assistant-command-parser.ts`
2. [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)
3. [packages/studio/src/pages/assistant-view.test.ts](../packages/studio/src/pages/assistant-view.test.ts)

验收：

1. 命令解析稳定且不误触发普通对话。
2. 命令执行结果可在消息流回显。

---

## 10. 联调脚本与验收命令

## 10.1 本地联调脚本

```bash
INKOS_PROJECT_ROOT=/Users/fanwan/Documents/Playground/inkos-novel pnpm --filter @actalk/inkos-studio dev
```

## 10.2 测试命令

```bash
pnpm --filter @actalk/inkos-studio test
```

## 10.3 关键手工场景

1. 输入“写下一章” -> 计划卡 -> 确认 -> 运行 -> 质量卡 -> 下一步卡。
2. 输入“审计第14章并修复” -> 三步执行 -> 自动复审。
3. 执行失败 -> 一键重试/改参数。
4. 刷新页面 -> 任务恢复。

## 10.4 体验验收矩阵（易用性 + 智能性）

1. UX-01 首次使用：新用户通过模板在 10 分钟内完成一次“写作 + 审计”。
2. UX-02 可解释性：每个结果卡都展示至少 1 条 evidence 与风险级别。
3. UX-03 可控性：高风险步骤必须出现审批入口，且可拒绝。
4. UX-04 可恢复性：异常中断后 30 秒内可恢复任务状态。
5. IQ-01 智能改进：开启 optimize 后，质量分平均提升 >= 8 分。
6. IQ-02 成本控制：触发预算守卫后，系统在 2 秒内发出 warning 事件。

---

## 11. 依赖顺序与并行建议

### 11.1 强依赖顺序

1. WP-02 -> WP-03 -> WP-04 -> WP-05 -> WP-06
2. WP-01 与 WP-02 可并行
3. WP-07 需在 WP-01 稳定后
4. WP-08 在 WP-03 完成后
5. WP-10 依赖 WP-03
6. WP-11 可与 WP-10 并行
7. WP-12 依赖 WP-01 与 WP-03
8. WP-09 贯穿全程

### 11.2 并行分组

1. 组 A：WP-01、WP-02
2. 组 B：WP-03、WP-04
3. 组 C：WP-05、WP-06
4. 组 D：WP-07、WP-08、WP-09
5. 组 E：WP-10、WP-11、WP-12

---

## 12. 风险清单与降级策略

1. 风险：计划误判导致错误执行。
降级：必须确认卡 + 高风险默认禁止自动执行。

2. 风险：SSE 丢事件造成前端状态错乱。
降级：轮询 `/api/assistant/tasks/:taskId` 做状态纠偏。

3. 风险：自动优化循环成本过高。
降级：设置 `maxIterations` 与 token budget 硬阈值。

4. 风险：跨入口语义不一致。
降级：保留 ChatBar 但只做轻入口，不做独立编排。

---

## 13. 交付物清单（Definition of Done）

每个工作包必须提交：

1. 代码改动。
2. 测试用例与结果。
3. API 示例请求/响应。
4. 风险点与回滚方案。
5. 与 17 号文档的映射说明。
6. 事件流截图或日志（至少一条成功、一条失败）。
7. 策略门禁验证记录（审批/预算/权限）。

项目总 DoD：

1. MVP-Plus 三大场景打通。
2. 回归测试全绿。
3. 指标埋点可观测。
4. 文档与实现一致。
5. 命令面八条指令全部可用。
6. 自动驾驶 L1/L2 可稳定运行。

---

## 14. 建议下一步

1. 把本文件拆成 GitHub Issue 批量模板（WP-01 ~ WP-12）。
2. 按依赖顺序派发给多 Agent 并行执行。
3. 每两天做一次集成回归，防止接口漂移。
