# VS Code + Copilot Agent 持续开发操作手册

## 1. 目标

让你在 VS Code 中使用 Copilot Agent 持续开发（例如连续 1 天），并保持可控质量。

## 2. 前置条件

- GitHub Copilot 会员可用
- 仓库推送权限可用
- 本地已安装：
  - VS Code 最新版
  - Git
  - Node 20+
  - pnpm 9+

## 3. VS Code 最小设置

1. 安装扩展：
- GitHub Copilot
- GitHub Pull Requests and Issues

2. 登录 GitHub 账号并启用 Copilot。

3. 打开 VS Code 设置并确认：
- 可在 Chat 中委派任务给 Agent
- 可查看 Agent 会话与执行日志

## 4. 仓库工作流（已配好）

你仓库已新增：
- Agent Issue 模板：`.github/ISSUE_TEMPLATE/agent_task.yml`
- Agent PR 模板：`.github/pull_request_template.md`（已加强）
- Agent PR 门禁：`.github/workflows/agent-pr-gate.yml`

作用：
- 任务结构化，防止 Agent 漂移。
- PR 必须包含验收映射、风险、回滚、证据。
- 自动跑 typecheck/test，失败不放行。

## 5. 一天不间断运行建议（实操）

### 5.1 任务切片规则

- 每个 Issue 控制在 30-90 分钟内可完成。
- 每个 Issue 最多改 3-5 个相关文件。
- 每个 Issue 必须有 3 条以内可测验收标准。

### 5.2 并行度

- 同时运行 2-4 个 Agent 任务最稳。
- 严禁并行改同一核心文件（如 `server.ts`）过多任务。

### 5.3 节奏

1. 先创建 10-20 个 `Agent Task` Issue。
2. 按优先级批量指派给 Agent。
3. 每 1-2 小时集中审一次 PR：
   - 看 AC 是否完成
   - 看风险与回滚
   - 看 CI 是否全绿
4. 合并后继续派发下一批任务。

## 6. 推荐任务分配顺序（你这个项目）

1. `create-flow v2` API 与 schema
2. 快速模式前端页
3. 专业模式前端页
4. 摘要确认与补问
5. 章节驾驶舱基础版
6. 中英文链路补齐
7. 同步接口与会话管理
8. 移动端壳接入

## 7. 故障恢复

场景 A：Agent 输出跑偏
- 关闭该 PR
- 复用同 issue，缩小 scope 重派

场景 B：CI 持续失败
- 先派一个“修 CI 专项 issue”
- 暂停新功能任务，恢复主干健康

场景 C：任务堆积太多
- 只保留“可合并前 5 个”
- 其余 issue 转 backlog

## 8. 质量守门（必须）

合并前人工只看 4 件事：
1. AC 是否全部勾选且真实完成
2. 是否有清晰回滚方案
3. CI 是否通过
4. 是否动了高风险文件（鉴权/同步/删除）

## 9. 注意事项

- “连续开发”本质是任务流水，不是单个长会话。
- 真正稳定的方法是：小任务 + 强模板 + 自动门禁 + 人工抽检。
- 不要追求一次派太多大任务，返工成本会爆炸。

## 10. 你今天可直接执行的启动步骤

1. 拉取当前仓库最新代码。
2. 在 GitHub 用 `Agent Task` 模板建 8-12 个 issue。
3. 先派 2 个任务（一个前端、一个后端）试运行。
4. 看 `Agent PR Gate` 是否正常拦截与放行。
5. 扩展到 4 个并行任务进入全天节奏。

