# NovelOS 23 个 Issue 派发评论模板（给 GitHub Copilot Agents）

## 使用说明

1. 复制对应 Issue 的评论模板到 GitHub Issue 评论区。
2. 将其中的 `{{assignee}}`、`{{branch}}`、`{{due_date}}` 替换为实际值。
3. 要求 Agent 严格按 Issue 的 In Scope / Out of Scope 执行。
4. 每个模板都要求返回统一回执，方便你审查与追责。

统一上下文文档：
- [DevDocs/17-顶级小说创作智能体设计与实现方案.md](./17-顶级小说创作智能体设计与实现方案.md)
- [DevDocs/18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md)
- [DevDocs/19-NovelOS全流程派发Issue包-面向Copilot-Agents.md](./19-NovelOS全流程派发Issue包-面向Copilot-Agents.md)

统一回执格式（要求 Agent 原样返回）：

```md
[Implementation Receipt]
- Issue: Issue-XX
- Branch: <branch-name>
- Scope Completed: yes/no
- Files Changed: <list>
- Tests Run: <commands>
- Test Result: pass/fail
- Risks / Trade-offs: <list>
- Follow-ups Needed: <list or none>
```

---

## Issue-01 派发评论模板

```md
@{{assignee}} 请实现 Issue-01：Assistant 主入口状态机与计划确认链路（WP-01）。

执行要求：
1. 严格遵循 19 文档中 Issue-01 的 In Scope / Out of Scope。
2. 仅在 Assistant 主入口范围内改动，不提前做后端执行逻辑。
3. 保持现有路由与消息流兼容。

交付要求：
1. 提交可运行代码与测试。
2. 在 PR 描述中附状态机流转图（draft -> awaiting-confirm -> running...）。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-02 派发评论模板

```md
@{{assignee}} 请实现 Issue-02：Assistant Plan API 与意图草案生成（WP-02）。

执行要求：
1. 按 19 文档定义返回 taskId、intent、plan、risk。
2. 补齐错误码与参数校验。
3. 不实现执行调度与 SSE。

交付要求：
1. server.ts 与 server.test.ts 同步提交。
2. 提供 3 组请求/响应示例（成功、缺参数、未知意图）。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-03 派发评论模板

```md
@{{assignee}} 请实现 Issue-03：Assistant Execute API 与原子动作编排（WP-03）。

执行要求：
1. 打通 audit -> revise -> re-audit 三步链。
2. 建立 stepId <-> runId 关联。
3. 严格复用现有原子 API，不破坏 run ledger。

交付要求：
1. 失败分支必须可观测并可重试。
2. 增加执行链路集成测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-04 派发评论模板

```md
@{{assignee}} 请实现 Issue-04：Assistant SSE 事件流与前端进度时间线（WP-04）。

执行要求：
1. 接入 step start/success/fail/done 事件。
2. UI 可实时展示并在完成后稳定收敛。
3. 事件丢失时支持任务查询纠偏。

交付要求：
1. 提供事件序列截图或日志。
2. 提交 use-sse 相关测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-05 派发评论模板

```md
@{{assignee}} 请实现 Issue-05：质量评估聚合与证据卡展示（WP-05）。

执行要求：
1. 实现 evaluate 聚合接口与质量卡展示。
2. 强制 evidence 至少 1 条且来源可追溯。
3. 输出维度分与阻断问题。

交付要求：
1. 提供 API 示例与页面截图。
2. 覆盖分数映射与 evidence 渲染测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-06 派发评论模板

```md
@{{assignee}} 请实现 Issue-06：自动优化循环与停机条件（WP-06）。

执行要求：
1. 支持 targetScore 与 maxIterations 双停机条件。
2. 禁止无界循环。
3. 失败时保留可重试上下文。

交付要求：
1. 提交 optimize 正常与边界测试。
2. 在 PR 说明停机策略与异常策略。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-07 派发评论模板

```md
@{{assignee}} 请实现 Issue-07：ChatBar 与 Assistant 单入口语义统一（WP-07）。

执行要求：
1. ChatBar 仅作为轻入口并跳转 assistant。
2. 保留 prompt 透传。
3. 禁止保留独立闭环逻辑。

交付要求：
1. 提供跳转与透传测试结果。
2. 标注兼容性影响范围。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-08 派发评论模板

```md
@{{assignee}} 请实现 Issue-08：任务持久化与刷新恢复（WP-08）。

执行要求：
1. 支持刷新恢复进行中任务。
2. 支持历史任务摘要查询。
3. 保证存储向后兼容。

交付要求：
1. 提供恢复场景演示步骤。
2. 提交持久化读写测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-09 派发评论模板

```md
@{{assignee}} 请实现 Issue-09：回归测试与关键链路 E2E（WP-09）。

执行要求：
1. 覆盖 assistant 主链路关键场景。
2. 覆盖率达到 issue 定义目标。
3. 测试数据可重复可清理。

交付要求：
1. 提供测试命令与结果摘要。
2. 列出新增测试文件与覆盖范围。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-10 派发评论模板

```md
@{{assignee}} 请实现 Issue-10：策略门禁与预算守卫（WP-10）。

执行要求：
1. 执行前校验风险/预算/权限。
2. 未审批高风险动作必须阻断。
3. 超预算必须发 warning 事件。

交付要求：
1. 提供 policy check 结果示例。
2. 提交预算超限与阻断测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-11 派发评论模板

```md
@{{assignee}} 请实现 Issue-11：Skills Registry 与权限模型（WP-11）。

执行要求：
1. 实现 builtin/project/trusted 三层技能。
2. 实现 /api/assistant/skills。
3. 拒绝未授权技能调用并记录原因。

交付要求：
1. 提供 skills 返回示例。
2. 提交权限拒绝路径测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-12 派发评论模板

```md
@{{assignee}} 请实现 Issue-12：Operator 命令面与会话控制（WP-12）。

执行要求：
1. 支持 /goal /status /pause /resume /approve /rollback /trace /budget。
2. 命令优先级高于意图路由。
3. 普通自然语言不得误判为命令。

交付要求：
1. 提供命令行为清单与示例。
2. 提交命令解析与回显测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-13 派发评论模板

```md
@{{assignee}} 请实现 Issue-13：可观测看板与 SLO 指标闭环。

执行要求：
1. 补齐 plan/execute/evaluate/optimize 埋点。
2. 至少支持 7 个核心指标聚合。
3. 可按 taskId 回放关键事件。

交付要求：
1. 提供指标字段字典。
2. 提交聚合逻辑与埋点完整性测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-14 派发评论模板

```md
@{{assignee}} 请实现 Issue-14：发布候选门禁与质量阈值执行器。

执行要求：
1. 质量门槛不达标不得进入 release candidate。
2. 门禁失败需返回可复核原因。
3. 规则默认安全且可审计。

交付要求：
1. 提供门禁通过/拦截示例。
2. 提交阈值边界测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-15 派发评论模板

```md
@{{assignee}} 请实现 Issue-15：灰度发布与回滚策略。

执行要求：
1. 支持按用户组或 feature flag 灰度。
2. 异常时可快速回滚并恢复服务。
3. 高风险自动化默认关闭。

交付要求：
1. 提供灰度策略说明与回滚步骤。
2. 提交 feature flag 与回滚演练测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-16 派发评论模板

```md
@{{assignee}} 请实现 Issue-16：运行手册、故障演练与值班化交付。

执行要求：
1. 覆盖 SSE 异常、预算超限、任务卡死、策略误拦截。
2. 至少完成 3 类演练并留档。
3. 手册可在 10 分钟内指导恢复。

交付要求：
1. 提交 runbook 文档与演练记录。
2. 标注适用版本与更新策略。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-17 派发评论模板

```md
@{{assignee}} 请实现 Issue-17：聊天即 CRUD 的 Read/Delete 全链路。

执行要求：
1. 支持按书/卷/章/角色/伏笔查询并返回 evidence。
2. 支持删除与恢复流程，默认软删除。
3. 删除前必须影响预览与二次确认。

交付要求：
1. 提供查询与删除恢复示例。
2. 提交 Read/Delete 集成测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-18 派发评论模板

```md
@{{assignee}} 请实现 Issue-18：世界观一致性守门与市场记忆融合。

执行要求：
1. 输出人物/设定/伏笔一致性报告。
2. 输出市场信号建议并标注来源与时间。
3. 支持将一致性问题转化为可执行修复任务。

交付要求：
1. 提供一致性报告与市场建议示例。
2. 提交报告生成与转任务测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-19 派发评论模板

```md
@{{assignee}} 请实现 Issue-19：新手模板与一键飞轮模板化执行。

执行要求：
1. 上线四个模板入口（结构、写作自审、三章审计、周计划）。
2. 模板统一走 plan/execute/evaluate。
3. 高风险模板默认 L1 审批。

交付要求：
1. 提供模板触发与执行示例。
2. 提交模板风险分级与飞轮测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-20 派发评论模板

```md
@{{assignee}} 请实现 Issue-20：Goal-to-Book 开书蓝图与章节计划端到端。

执行要求：
1. 从目标输入完成新建书、蓝图、章节计划。
2. 支持计划确认与编辑后执行。
3. 保持与现有 book-create 流程兼容。

交付要求：
1. 提供 Goal-to-Book 全链路演示。
2. 提交开书 API 与端到端测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-21 派发评论模板

```md
@{{assignee}} 请实现 Issue-21：策略配置中心（阈值/审批/预算）产品化落地。

执行要求：
1. 在设置中心提供可视化策略配置。
2. 配置变更可立即影响后续任务。
3. 支持策略版本回滚。

交付要求：
1. 提供配置项清单与默认值。
2. 提交设置页、持久化与生效联动测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-22 派发评论模板

```md
@{{assignee}} 请实现 Issue-22：模型路由与降级策略执行器。

执行要求：
1. 实现草拟/审定/回退模型路由策略。
2. 主模型失败时自动降级但不绕过质量门禁。
3. 输出模型决策日志与原因。

交付要求：
1. 提供模型路由配置与日志示例。
2. 提交故障降级与联动测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

## Issue-23 派发评论模板

```md
@{{assignee}} 请实现 Issue-23：提示注入防护与工具参数隔离。

执行要求：
1. 实施参数白名单与 schema 校验。
2. 实施 prompt 安全拼装边界与敏感字段隔离。
3. 建立注入攻击回归集（越权、伪指令、参数污染）。

交付要求：
1. 提供安全规则与拦截示例。
2. 提交注入防护与越权拦截测试。
3. 按统一回执格式回复。

截止时间：{{due_date}}
分支命名：{{branch}}
```

---

## 建议派发节奏

1. 批次 1：Issue-01、Issue-02。
2. 批次 2：Issue-03、Issue-04、Issue-10。
3. 批次 3：Issue-05、Issue-06、Issue-11、Issue-12。
4. 批次 4：Issue-07、Issue-08、Issue-17。
5. 批次 5：Issue-18、Issue-19、Issue-09。
6. 批次 6：Issue-20、Issue-21。
7. 批次 7：Issue-22、Issue-23。
8. 批次 8：Issue-13、Issue-14、Issue-15、Issue-16。
