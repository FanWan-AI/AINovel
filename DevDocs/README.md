# InkOS Studio 文档总览（Agent-First 跨端小说创作平台）

本目录用于指导 InkOS Studio 从当前版本迭代为“Agent-First + 跨端上架”的 AI 小说创作平台。

目标：
- 新手与进阶用户：通过简单/高级模式完成中英文小说创作。
- 跨设备使用：iOS、Android、Windows、macOS 多端一致体验。
- 渠道上线：满足 Apple App Store 与其他应用商店上架要求。
- 开发范式：主要开发对象是 Agent（例如 GPT-5.3-Codex），人类工程师负责约束、评审与运维。

## 文档结构

1. [01-PRD-双模式创作平台.md](./01-PRD-%E5%8F%8C%E6%A8%A1%E5%BC%8F%E5%88%9B%E4%BD%9C%E5%B9%B3%E5%8F%B0.md)  
产品目标、用户分层、范围边界、关键指标、验收标准。

2. [02-信息架构与用户旅程.md](./02-%E4%BF%A1%E6%81%AF%E6%9E%B6%E6%9E%84%E4%B8%8E%E7%94%A8%E6%88%B7%E6%97%85%E7%A8%8B.md)  
简单模式与高级模式的页面、模块、关键交互和流程图。

3. [03-系统架构设计.md](./03-%E7%B3%BB%E7%BB%9F%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1.md)  
当前架构盘点、目标架构、服务边界、模块职责、扩展策略。

4. [04-后端详细设计.md](./04-%E5%90%8E%E7%AB%AF%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1.md)  
API、服务层、异步任务、错误模型、状态流、兼容策略。

5. [05-前端详细设计.md](./05-%E5%89%8D%E7%AB%AF%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1.md)  
页面分层、状态管理、组件拆分、交互细则、埋点方案。

6. [06-数据模型与契约规范.md](./06-%E6%95%B0%E6%8D%AE%E6%A8%A1%E5%9E%8B%E4%B8%8E%E5%A5%91%E7%BA%A6%E8%A7%84%E8%8C%83.md)  
`book/brief/foundation/chapter` 数据结构与前后端契约规范。

7. [07-开发计划与Roadmap.md](./07-%E5%BC%80%E5%8F%91%E8%AE%A1%E5%88%92%E4%B8%8ERoadmap.md)  
阶段计划、任务拆解、优先级、里程碑、资源建议。

8. [08-测试策略与验收标准.md](./08-%E6%B5%8B%E8%AF%95%E7%AD%96%E7%95%A5%E4%B8%8E%E9%AA%8C%E6%94%B6%E6%A0%87%E5%87%86.md)  
单元/集成/E2E/回归策略与验收清单。

9. [09-运维部署与可观测性.md](./09-%E8%BF%90%E7%BB%B4%E9%83%A8%E7%BD%B2%E4%B8%8E%E5%8F%AF%E8%A7%82%E6%B5%8B%E6%80%A7.md)  
本地与云部署、日志、监控、故障响应、容量策略。

10. [10-维护治理与持续迭代规范.md](./10-%E7%BB%B4%E6%8A%A4%E6%B2%BB%E7%90%86%E4%B8%8E%E6%8C%81%E7%BB%AD%E8%BF%AD%E4%BB%A3%E8%A7%84%E8%8C%83.md)  
分支规范、版本规范、需求流程、变更管理、文档维护机制。

11. [11-风险与安全方案.md](./11-%E9%A3%8E%E9%99%A9%E4%B8%8E%E5%AE%89%E5%85%A8%E6%96%B9%E6%A1%88.md)  
API Key、路径安全、内容风险、模型风控与应急预案。

12. [12-跨端应用与上架方案.md](./12-%E8%B7%A8%E7%AB%AF%E5%BA%94%E7%94%A8%E4%B8%8E%E4%B8%8A%E6%9E%B6%E6%96%B9%E6%A1%88.md)  
iOS/Android/Windows/macOS 架构、分发、账号同步与商店上架流程。

13. [13-Agent-First开发规范.md](./13-Agent-First%E5%BC%80%E5%8F%91%E8%A7%84%E8%8C%83.md)  
面向 Agent 的任务拆分、接口契约、自动化流水线与人工守门机制。

14. [14-VSCode-Copilot-Agent持续开发操作手册.md](./14-VSCode-Copilot-Agent%E6%8C%81%E7%BB%AD%E5%BC%80%E5%8F%91%E6%93%8D%E4%BD%9C%E6%89%8B%E5%86%8C.md)  
VS Code 中使用 Copilot Agent 连续开发的配置、节奏与故障恢复。

15. [15-AI助手中枢化与设置中心重构详细设计.md](./15-AI%E5%8A%A9%E6%89%8B%E4%B8%AD%E6%9E%A2%E5%8C%96%E4%B8%8E%E8%AE%BE%E7%BD%AE%E4%B8%AD%E5%BF%83%E9%87%8D%E6%9E%84%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1.md)  
AI助手从右侧面板升级为中间主页面智能体工作台，并完成设置中心重构方案。

16. [16-AI助手中枢化升级-并行Issue包.md](./16-AI%E5%8A%A9%E6%89%8B%E4%B8%AD%E6%9E%A2%E5%8C%96%E5%8D%87%E7%BA%A7-%E5%B9%B6%E8%A1%8CIssue%E5%8C%85.md)  
可并行派发给 Copilot Agents 的 11 个标准化 Issue，包含 GitHub 可直接创建的模板块。

17. [17-顶级小说创作智能体设计与实现方案.md](./17-%E9%A1%B6%E7%BA%A7%E5%B0%8F%E8%AF%B4%E5%88%9B%E4%BD%9C%E6%99%BA%E8%83%BD%E4%BD%93%E8%AE%BE%E8%AE%A1%E4%B8%8E%E5%AE%9E%E7%8E%B0%E6%96%B9%E6%A1%88.md)  
基于现有代码与主流 Agent 方法论的终极设计：现状能力审计、优劣分析、目标架构、实现路线与治理体系。

18. [18-AI助手NovelOS实施级详细设计与Agent执行蓝图.md](./18-AI%E5%8A%A9%E6%89%8BNovelOS%E5%AE%9E%E6%96%BD%E7%BA%A7%E8%AF%A6%E7%BB%86%E8%AE%BE%E8%AE%A1%E4%B8%8EAgent%E6%89%A7%E8%A1%8C%E8%93%9D%E5%9B%BE.md)  
面向多 Agent 并行实施的落地蓝图：接口契约、文件级改动、工作包依赖、测试脚本与验收门槛。

19. [19-NovelOS全流程派发Issue包-面向Copilot-Agents.md](./19-NovelOS%E5%85%A8%E6%B5%81%E7%A8%8B%E6%B4%BE%E5%8F%91Issue%E5%8C%85-%E9%9D%A2%E5%90%91Copilot-Agents.md)  
基于 17/18 的全流程 Issue 派发清单（23 个标准化 Issues）：覆盖设计、实施、CRUD、Goal-to-Book、策略中心、模型路由降级、安全防注入、测试、发布门禁、灰度与运行治理，可直接用于 GitHub Copilot Agents。

20. [20-NovelOS-23个Issue派发评论模板.md](./20-NovelOS-23%E4%B8%AAIssue%E6%B4%BE%E5%8F%91%E8%AF%84%E8%AE%BA%E6%A8%A1%E6%9D%BF.md)  
23 个 Issue 的逐条派发评论模板：可直接复制到 GitHub Issue 评论区，统一回执格式，便于 Agent 实施与结果追踪。

## 当前代码基线（用于对照）

- Studio 前端：`packages/studio/src`
- Studio API：`packages/studio/src/api/server.ts`
- 创建书籍页面：`packages/studio/src/pages/BookCreate.tsx`
- 创建书籍逻辑：`packages/studio/src/api/book-create.ts`
- Core 引擎：`packages/core/src/pipeline/runner.ts`
- CLI 基线：`packages/cli/src/commands/book.ts`

## 推荐阅读顺序

1. `01-PRD`  
2. `02-信息架构`  
3. `03-系统架构`  
4. `04 + 05 + 06`（研发主文档）  
5. `07 + 08 + 09 + 10 + 11`（落地与运营）
