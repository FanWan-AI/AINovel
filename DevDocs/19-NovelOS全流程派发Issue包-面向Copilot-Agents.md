# NovelOS 全流程派发 Issue 包（面向 GitHub Copilot Agents）

## 1. 文档目标

本文件用于把 [17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md) 与 [18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md) 转换为可直接派发给 GitHub Copilot Agents 的标准化 Issues。

范围覆盖：设计 -> 实施 -> 联调 -> 测试 -> 验收 -> 发布门禁 -> 运行治理。

---

## 2. 17 与 18 一一对应核对结论

结论：主链路可一一对应；要实现 17 文档“全部功能”需要补齐 11 类执行型事项。当前文档已在 Issue-13~Issue-23 补齐，并可实现从设计到实施到测试到发布治理的全流程落地。

### 2.1 对应矩阵

1. 17 的“统一入口 + 对话体验 + 一键飞轮” -> 18 的 6.1/6.3/6.4 + WP-01/WP-07。
2. 17 的“计划-执行-评估-优化” -> 18 的 5.1~5.4 + WP-02~WP-06。
3. 17 的“命令面 Operator Surface” -> 18 的 7.5 + WP-12。
4. 17 的“自动驾驶等级 + 风险门禁” -> 18 的 4.3 + WP-10。
5. 17 的“Skill Registry” -> 18 的 5.6 + WP-11。
6. 17 的“任务追踪与证据链” -> 18 的 7.4 + WP-04/WP-05。
7. 17 的“持久化与可恢复” -> 18 的 7.3 + WP-08。
8. 17 的“测试与验收” -> 18 的 10.2/10.3/10.4 + WP-09。

### 2.2 缺口与补齐

1. 缺口：发布门禁与灰度上线未形成独立工程任务。
补齐：Issue-14、Issue-15。
2. 缺口：可观测看板与 SLO 运营闭环未形成独立工程任务。
补齐：Issue-13。
3. 缺口：运行手册与故障演练未形成可验收任务。
补齐：Issue-16。
4. 缺口：聊天即 CRUD 中的 Delete/Read 全链路未形成独立任务。
补齐：Issue-17。
5. 缺口：World Consistency Keeper 与 Market Memory 未形成独立任务。
补齐：Issue-18。
6. 缺口：新手模板（Prompt Shortcuts）未形成独立任务。
补齐：Issue-19。
7. 缺口：Goal-to-Book 的“新建书/蓝图/章节计划”未形成独立任务。
补齐：Issue-20。
8. 缺口：策略配置中心（自动化阈值/审批策略/预算）未形成独立 UI+配置任务。
补齐：Issue-21。
9. 缺口：模型路由与降级策略（强模型审定、弱模型草拟）未形成独立任务。
补齐：Issue-22。
10. 缺口：提示注入防护与参数隔离未形成可测试安全任务。
补齐：Issue-23。

### 2.3 覆盖率结论

1. 设计覆盖率（17 -> 19）：100%。
2. 实施覆盖率（18 -> 19）：100%。
3. 可验证覆盖率（含 Required Tests）：100%。

---

## 3. 派发规则（适用于全部 Issues）

1. 每个 Issue 单独 PR，禁止跨 Issue 混改。
2. 每个 Issue 必须提交测试结果截图或日志摘要。
3. 每个 Issue 必须更新相应文档锚点（17/18/19 至少一处）。
4. 高风险变更必须包含回滚步骤。
5. 所有 API 新增或变更需给出请求/响应示例与错误码。

---

## 4. 可直接创建的标准化 Issues

### Issue-01

title: Assistant 主入口状态机与计划确认链路（WP-01）

goal: 在 Assistant 主页面完成 plan -> confirm -> execute 的最小可用状态机，确保 UI 不再依赖模拟回复。

In Scope:
- 改造 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)。
- 新增 [packages/studio/src/components/assistant/TaskPlanCard.tsx](../packages/studio/src/components/assistant/TaskPlanCard.tsx)。
- 补充 [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts) 文案。
- 支持 draft、awaiting-confirm、running、succeeded、failed、cancelled 状态转换。

Out of Scope:
- 后端 plan/execute 实现。
- SSE 实时事件接入。

Acceptance Criteria:
- 输入后可展示计划卡。
- 用户可确认或取消计划。
- 状态机在页面刷新前可稳定保持当前状态。

Required Tests:
- AssistantView 状态机单元测试。
- 计划卡交互组件测试。

Constraints:
- 不改变现有路由结构。
- 不移除已有消息流能力。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-02

title: Assistant Plan API 与意图草案生成（WP-02）

goal: 实现 /api/assistant/plan，提供可确认的任务计划草案与风险评级。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。
- 输出 taskId、intent、plan、requiresConfirmation、risk。

Out of Scope:
- 实际执行步骤调度。
- SSE 推送。

Acceptance Criteria:
- 正常请求返回结构化计划。
- 缺参数返回标准错误码。
- 不可识别意图返回 ASSISTANT_PLAN_INTENT_UNKNOWN。

Required Tests:
- Plan API 正常路径测试。
- 参数校验与错误码测试。

Constraints:
- 必须复用既有 book scope 定义。
- 错误码命名遵守 assistant 前缀。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-03

title: Assistant Execute API 与原子动作编排（WP-03）

goal: 实现 /api/assistant/execute，打通 audit -> revise -> re-audit 执行链。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。
- 构建 stepId 与 runId 关联。

Out of Scope:
- 质量评分聚合。
- 自动优化循环。

Acceptance Criteria:
- 三步链路可执行并返回 running 状态。
- 每步 runId 可追踪。
- 未审批任务会被阻断。

Required Tests:
- 执行 API 集成测试。
- step 失败中断与错误传播测试。

Constraints:
- 复用既有 write/audit/revise/rewrite/resync/radar API。
- 禁止破坏既有章节 run ledger 语义。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [packages/core/src/pipeline/runner.ts](../packages/core/src/pipeline/runner.ts)

---

### Issue-04

title: Assistant SSE 事件流与前端进度时间线（WP-04）

goal: 建立 assistant 任务实时可见能力，支持 step start/success/fail 与 done 事件。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/hooks/use-sse.ts](../packages/studio/src/hooks/use-sse.ts)。
- 修改 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)。

Out of Scope:
- 新增任务类型。
- 自动修复算法。

Acceptance Criteria:
- 事件在 UI 时间线正确展示。
- 任务完成后 loading 可靠关闭。
- 事件丢失时可回退到任务查询纠偏。

Required Tests:
- SSE 订阅与反订阅测试。
- 时间线渲染测试。

Constraints:
- 事件字段必须包含 taskId、timestamp。
- 不改变已有 runtime 事件命名空间行为。

Context / Links:
- [packages/studio/src/hooks/use-sse.ts](../packages/studio/src/hooks/use-sse.ts)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-05

title: 质量评估聚合与证据卡展示（WP-05）

goal: 实现 /api/assistant/evaluate 与前端 QualityReportCard，形成可解释结果输出。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 新增 [packages/studio/src/components/assistant/QualityReportCard.tsx](../packages/studio/src/components/assistant/QualityReportCard.tsx)。
- 修改 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)。

Out of Scope:
- 自动优化循环。
- 全书发布候选。

Acceptance Criteria:
- 返回 overallScore 与 dimensions。
- 展示 blocking issues 与 evidence。
- 支持下一步建议卡触发。

Required Tests:
- evaluate API 测试。
- 质量卡渲染与字段映射测试。

Constraints:
- evidence 至少 1 条，且可回溯来源。
- 分数字段必须稳定可序列化。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)

---

### Issue-06

title: 自动优化循环与停机条件（WP-06）

goal: 实现 /api/assistant/optimize，按目标分与迭代上限执行自动改进。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。
- 输出 iteration 状态与终止原因。

Out of Scope:
- 发布门禁。
- 灰度发布。

Acceptance Criteria:
- 达到 targetScore 自动停止。
- 达到 maxIterations 自动转人工确认。
- 失败会保留可重试上下文。

Required Tests:
- optimize 正常与终止路径测试。
- 低分连续改进测试。

Constraints:
- 禁止无界循环。
- 每轮必须更新 task 进度与日志。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-07

title: ChatBar 与 Assistant 单入口语义统一（WP-07）

goal: 将 ChatBar 降级为轻入口并统一到 Assistant 主编排。

In Scope:
- 修改 [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)。
- 修改 [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)。
- 支持带 prompt 跳转到 assistant 路由。

Out of Scope:
- 重新设计侧边栏 UI。
- 新增业务 API。

Acceptance Criteria:
- ChatBar 提交后跳转到 assistant 并保留输入。
- ChatBar 不再执行独立闭环。

Required Tests:
- 路由跳转测试。
- 输入透传测试。

Constraints:
- 不影响现有导航菜单行为。
- 与 i18n 文案兼容。

Context / Links:
- [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
- [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)

---

### Issue-08

title: 任务持久化与刷新恢复（WP-08）

goal: 建立任务持久化读取机制，支持页面刷新后恢复进行中任务。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)。
- 支持 /api/assistant/tasks/:taskId 查询恢复。

Out of Scope:
- 引入新数据库。
- 多端同步。

Acceptance Criteria:
- 刷新后 30 秒内恢复任务状态。
- 历史任务可查询摘要。

Required Tests:
- 持久化读写测试。
- 刷新恢复场景测试。

Constraints:
- 存储格式需向后兼容。
- 不阻塞主线程渲染。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-09

title: 回归测试与关键链路 E2E（WP-09）

goal: 覆盖 assistant 主链路测试，保证功能迭代不回退。

In Scope:
- 修改 [packages/studio/src/pages/assistant-view.test.ts](../packages/studio/src/pages/assistant-view.test.ts)。
- 修改 [packages/studio/src/components/chatbar-state.test.ts](../packages/studio/src/components/chatbar-state.test.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。

Out of Scope:
- 压测基建改造。
- 监控系统搭建。

Acceptance Criteria:
- 新增覆盖率达到模块 80%+。
- 关键 E2E 场景全通过。

Required Tests:
- 单元测试。
- API 集成测试。
- 端到端流程测试。

Constraints:
- 测试数据可重复、可清理。
- 不引入不稳定外部依赖。

Context / Links:
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-10

title: 策略门禁与预算守卫（WP-10）

goal: 执行前强制风险/预算/权限校验，防止失控自动化。

In Scope:
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 新增 [packages/studio/src/api/services/assistant-policy-service.ts](../packages/studio/src/api/services/assistant-policy-service.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。

Out of Scope:
- 计费系统接入。
- 企业权限中心集成。

Acceptance Criteria:
- 高风险未审批动作被阻断。
- 超预算触发 budget warning 事件。
- policy check 可返回 requiredApprovals。

Required Tests:
- policy check API 测试。
- 预算超限测试。

Constraints:
- 门禁判定必须可解释。
- 阻断不应导致任务状态机异常。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)

---

### Issue-11

title: Skills Registry 与权限模型（WP-11）

goal: 建立 builtin/project/trusted 三层技能注册能力，并支持授权校验。

In Scope:
- 新增 [packages/studio/src/api/services/assistant-skill-registry-service.ts](../packages/studio/src/api/services/assistant-skill-registry-service.ts)。
- 修改 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)。
- 修改 [packages/studio/src/api/server.test.ts](../packages/studio/src/api/server.test.ts)。

Out of Scope:
- 外部市场化插件平台。
- 第三方支付授权。

Acceptance Criteria:
- /api/assistant/skills 返回技能列表与权限。
- 未授权技能调用会被拒绝并记录原因。

Required Tests:
- skills 查询测试。
- 权限拒绝路径测试。

Constraints:
- 技能元数据字段固定且可扩展。
- 向后兼容内置动作映射。

Context / Links:
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)

---

### Issue-12

title: Operator 命令面与会话控制（WP-12）

goal: 支持 /goal /status /pause /resume /approve /rollback /trace /budget 八条命令。

In Scope:
- 新增 [packages/studio/src/api/services/assistant-command-parser.ts](../packages/studio/src/api/services/assistant-command-parser.ts)。
- 修改 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)。
- 修改 [packages/studio/src/pages/assistant-view.test.ts](../packages/studio/src/pages/assistant-view.test.ts)。

Out of Scope:
- 命令别名国际化扩展。
- 语音命令输入。

Acceptance Criteria:
- 八条命令可识别并执行。
- 普通自然语言不会被误识别为命令。

Required Tests:
- 命令解析单元测试。
- 命令执行 UI 回显测试。

Constraints:
- 命令解析优先级高于意图路由。
- 命令失败必须返回可读错误信息。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-13

title: 可观测看板与 SLO 指标闭环（补齐全流程缺口）

goal: 建立任务级观测与产品级指标看板，支撑运营和迭代决策。

In Scope:
- 为 assistant 全链路增加关键埋点（plan/execute/evaluate/optimize）。
- 建立成功率、人工介入率、平均分提升、预算消耗等聚合指标。
- 输出基础看板数据接口或导出任务统计 JSON。

Out of Scope:
- 商业 BI 平台接入。
- A/B 平台建设。

Acceptance Criteria:
- 指标可按日聚合。
- 可按 taskId 回放关键事件。
- 至少支持 7 个核心指标查询。

Required Tests:
- 指标聚合逻辑测试。
- 埋点完整性测试。

Constraints:
- 埋点不影响关键路径性能。
- 字段命名与事件 schema 一致。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-14

title: 发布候选门禁与质量阈值执行器（补齐全流程缺口）

goal: 将质量门槛与风险门槛工程化为发布前门禁，避免低质量结果进入发布候选。

In Scope:
- 实现质量阈值检查器（章节分、全书一致性、阻断问题）。
- 增加发布候选判定接口或状态字段。
- 提供门禁失败原因与整改建议。

Out of Scope:
- 真正发布到外部平台。
- 人工审核平台建设。

Acceptance Criteria:
- 未达门槛任务不能进入 release candidate。
- 门禁结果可追踪并可复核。

Required Tests:
- 门禁通过与拦截测试。
- 阈值边界测试。

Constraints:
- 门禁规则可配置但默认安全。
- 规则变更必须可审计。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)

---

### Issue-15

title: 灰度发布与回滚策略（补齐全流程缺口）

goal: 建立 assistant 新能力分阶段灰度发布与一键回滚机制。

In Scope:
- 支持按用户组或 feature flag 开启 L2/L3 自动化能力。
- 配置失败自动降级策略（降到 L1 或禁用 optimize）。
- 输出回滚 runbook 草案。

Out of Scope:
- 全量发布自动化平台。
- 跨产品线统一开关中心。

Acceptance Criteria:
- 可对指定用户组开启或关闭新能力。
- 发生异常可在短时间回滚并恢复服务。

Required Tests:
- feature flag 行为测试。
- 回滚路径演练测试。

Constraints:
- 默认关闭高风险自动化。
- 灰度策略变更需记录审计日志。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)

---

### Issue-16

title: 运行手册、故障演练与值班化交付（补齐全流程缺口）

goal: 把 assistant 运维操作沉淀为可执行 runbook，完成故障演练闭环。

In Scope:
- 编写常见故障处置流程（SSE 异常、预算超限、任务卡死、策略误拦截）。
- 制定演练脚本与验收记录模板。
- 形成值班检查清单。

Out of Scope:
- 24x7 实时值班体系建设。
- 组织流程改造。

Acceptance Criteria:
- 至少完成 3 类故障演练并留档。
- 运维手册可在 10 分钟内指导完成一次恢复。

Required Tests:
- 故障注入演练记录。
- 恢复步骤可复现性检查。

Constraints:
- 文档必须与当前实现版本一致。
- 每次重大变更后需更新 runbook。

Context / Links:
- [DevDocs/14-VSCode-Copilot-Agent持续开发操作手册.md](./14-VSCode-Copilot-Agent持续开发操作手册.md)
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)

---

### Issue-17

title: 聊天即 CRUD 的 Read/Delete 全链路实现（补齐 17 号能力模型）

goal: 把 17 文档中的“查（Read）+删（Delete）”做成可直接在 Assistant 对话中调用的端到端能力，并具备证据引用与软删除恢复。

In Scope:
- 在 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts) 增加 assistant 可调用的 read/delete 路由或编排映射。
- 在 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx) 增加 Read/Delete 结果卡与恢复入口。
- 复用章节 run ledger 与 delete/approve 基础能力，打通“删除前影响预览 -> 执行 -> 可恢复”。

Out of Scope:
- 永久物理删除。
- 跨项目检索。

Acceptance Criteria:
- 支持按书/卷/章/角色/伏笔查询并返回 evidence。
- 支持删除章节或候选 run，且可在窗口期恢复。
- 删除动作默认二次确认并展示影响范围。

Required Tests:
- Read API 查询维度测试（书/卷/章/角色/伏笔）。
- Delete/恢复流程测试。
- Assistant 对话触发 Read/Delete 的集成测试。

Constraints:
- 删除默认软删除且可审计。
- evidence 必须包含来源定位信息。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)

---

### Issue-18

title: 世界观一致性守门与市场记忆融合（补齐 World Consistency + Market Memory）

goal: 实现 World Consistency Keeper 与 Market Memory 的任务化能力，支持一致性巡检、冲突修复建议与题材趋势联动建议。

In Scope:
- 在 [packages/core/src/pipeline/runner.ts](../packages/core/src/pipeline/runner.ts) 或相邻服务增加一致性巡检编排入口。
- 在 [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts) 增加世界观一致性报告与市场信号查询聚合接口。
- 在 Assistant 中提供“全书一致性报告 + 市场策略建议”卡片。

Out of Scope:
- 外部商业数据采购。
- 自动改写全书正文。

Acceptance Criteria:
- 可生成人物/设定/伏笔一致性报告并标记阻断问题。
- 可输出题材趋势建议并标注信号来源。
- 一致性问题可转化为可执行修复任务。

Required Tests:
- 一致性报告生成测试。
- 市场信号聚合测试。
- 报告转任务的端到端测试。

Constraints:
- 市场信号必须标注时间戳与来源。
- 一致性报告需可复算且可追踪。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/core/src/pipeline/runner.ts](../packages/core/src/pipeline/runner.ts)

---

### Issue-19

title: 新手模板与一键飞轮模板化执行（补齐 Prompt Shortcuts）

goal: 把 17 文档的 Prompt Shortcuts 变成可点击模板能力，并统一接入计划确认与风险门禁。

In Scope:
- 在 [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx) 实现模板区与模板触发。
- 模板至少包含：结构生成、写下一章并自审、最近三章审计修复、本周更新计划。
- 模板执行后自动产出下一步建议卡并可一键继续。

Out of Scope:
- 模板市场。
- 多语言模板体系。

Acceptance Criteria:
- 新用户可在 10 分钟内完成一次模板驱动的写作+审计流程。
- 高风险模板默认 L1 并要求确认。
- 模板执行记录可追踪到 taskId。

Required Tests:
- 模板触发与参数注入测试。
- 模板风险分级与门禁测试。
- 模板执行后飞轮建议卡测试。

Constraints:
- 模板必须走统一 plan/execute/evaluate 流程。
- 模板文案与 i18n 兼容。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/studio/src/pages/AssistantView.tsx](../packages/studio/src/pages/AssistantView.tsx)

---

### Issue-20

title: Goal-to-Book 开书蓝图与章节计划端到端（补齐 Create 核心能力）

goal: 实现“从一句目标到新建书、生成蓝图、生成章节计划”的端到端流程，使 Goal-to-Book 能独立成立。

In Scope:
- 在 assistant 编排中增加 `create-book` 与 `generate-blueprint` 任务类型。
- 复用或扩展 [packages/studio/src/api/book-create.ts](../packages/studio/src/api/book-create.ts) 与相关路由，打通新建书。
- 在 Assistant 页面支持“创建成功后自动进入首章计划”流程。

Out of Scope:
- 封面生成与美术资源。
- 外部发布平台同步。

Acceptance Criteria:
- 用户输入目标后，可完成新建书并生成卷章计划。
- 计划可被确认、编辑并进入执行链。
- 产物能在书籍列表与详情页正确出现。

Required Tests:
- 开书 API 集成测试。
- 蓝图生成与章节计划测试。
- Goal-to-Book 端到端测试。

Constraints:
- 必须兼容现有书籍创建流程。
- 创建失败需提供可恢复提示。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/studio/src/api/book-create.ts](../packages/studio/src/api/book-create.ts)

---

### Issue-21

title: 策略配置中心（阈值/审批/预算）产品化落地

goal: 把策略配置中心做成可用产品能力，支持自动化阈值、审批策略、预算策略的可视化配置与持久化。

In Scope:
- 在 [packages/studio/src/pages/SettingsView.tsx](../packages/studio/src/pages/SettingsView.tsx) 增加 assistant 策略配置区。
- 提供策略读取/保存接口并接入执行门禁。
- 支持策略版本和回滚到上一个稳定版本。

Out of Scope:
- 企业级组织权限系统。
- 跨项目配置同步。

Acceptance Criteria:
- 用户可配置 targetScore、maxIterations、审批级别、预算上限。
- 配置变更可立即影响后续任务执行。
- 错误配置可一键回滚到上个版本。

Required Tests:
- 设置页交互测试。
- 配置持久化测试。
- 配置生效联动测试（与 policy check/execute）。

Constraints:
- 默认策略必须安全。
- 配置变更必须审计可追踪。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/studio/src/pages/SettingsView.tsx](../packages/studio/src/pages/SettingsView.tsx)

---

### Issue-22

title: 模型路由与降级策略执行器（强审定/弱草拟）

goal: 实现模型路由与降级策略，保障在模型波动时系统仍可稳定输出并满足质量门槛。

In Scope:
- 在编排层引入模型路由策略（草拟模型、审定模型、回退模型）。
- 增加失败自动降级与重试策略。
- 输出每步模型选择的追踪日志与决策原因。

Out of Scope:
- 新模型采购与商务接入。
- 全量 A/B 平台。

Acceptance Criteria:
- 正常场景可按策略选择模型执行。
- 主模型不可用时自动降级且任务不中断。
- 关键审定步骤默认走强模型或等效策略。

Required Tests:
- 路由策略单元测试。
- 模型故障降级测试。
- 质量守门与模型路由联动测试。

Constraints:
- 降级不应绕过质量门禁。
- 模型决策日志需可审计。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/core/src/pipeline/runner.ts](../packages/core/src/pipeline/runner.ts)

---

### Issue-23

title: 提示注入防护与工具参数隔离（安全基线任务）

goal: 工程化实现提示注入防护，做到用户输入与工具参数隔离、敏感字段不可被提示污染。

In Scope:
- 为 assistant 工具调用加入参数白名单与 schema 校验。
- 实现 prompt 拼装安全层（敏感字段屏蔽、上下文边界隔离）。
- 增加常见攻击样例回归集（prompt injection、越权调用、伪造指令）。

Out of Scope:
- 第三方 WAF 接入。
- 企业安全中心联动。

Acceptance Criteria:
- 注入样例无法突破权限边界。
- 敏感参数不进入可被模型污染的拼装区。
- 异常输入触发安全拒绝并给出可读原因。

Required Tests:
- 安全规则单元测试。
- 注入攻击回归测试。
- 端到端越权拦截测试。

Constraints:
- 安全层必须默认开启。
- 拒绝策略不得破坏正常请求路径。

Context / Links:
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)

---

## 5. 建议派发顺序

1. 第 1 批：Issue-01、Issue-02。
2. 第 2 批：Issue-03、Issue-04、Issue-10。
3. 第 3 批：Issue-05、Issue-06、Issue-11、Issue-12。
4. 第 4 批：Issue-07、Issue-08、Issue-17。
5. 第 5 批：Issue-18、Issue-19、Issue-09。
6. 第 6 批：Issue-20、Issue-21。
7. 第 7 批：Issue-22、Issue-23。
8. 第 8 批：Issue-13、Issue-14、Issue-15、Issue-16。

---

## 6. 最终说明

1. 本文档已将 17 的目标设计和 18 的实施蓝图映射为可执行 Issue 集。
2. 相比仅有 WP-01~WP-12，本文件新增了 CRUD 缺口、世界观与市场记忆、模板飞轮、Goal-to-Book、策略配置中心、模型路由降级、安全防注入、发布、运营、治理阶段任务，满足全流程要求。
3. 可直接按章节复制到 GitHub Issue，字段已与要求完全一致：title、goal、In Scope、Out of Scope、Acceptance Criteria、Required Tests、Constraints、Context / Links。
