# AI助手中枢化升级并行 Issue 包

本文档用于将 AI助手中枢化与设置中心重构拆分为可并行执行的工程任务。

主设计文档：

1. [15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

统一执行要求：

1. 每个 Issue 必须提交“变更摘要 + 风险点 + 回滚方式”。
2. 每个 Issue 必须附带对应测试结果截图或日志。
3. 若发现接口或契约歧义，先补充文档再提交代码。

统一完成定义（DoD）：

1. 代码与测试通过。
2. PR 描述覆盖 Acceptance Criteria 的逐条映射。
3. 文档引用与实际实现一致。

建议优先级：

1. P0：Issue 1、Issue 2、Issue 3、Issue 5。
2. P1：Issue 4、Issue 6、Issue 7、Issue 8、Issue 9。
3. P2：Issue 10、Issue 11。

建议依赖关系：

1. Issue 1 是所有任务前置。
2. Issue 2 依赖 Issue 1。
3. Issue 3 依赖 Issue 1。
4. Issue 4 依赖 Issue 3。
5. Issue 5 依赖 Issue 3、Issue 4。
6. Issue 6 依赖 Issue 1。
7. Issue 7 依赖 Issue 6。
8. Issue 8 依赖 Issue 6。
9. Issue 9 依赖 Issue 3、Issue 5。
10. Issue 10 依赖 Issue 3、Issue 5、Issue 9。
11. Issue 11 依赖 Issue 9、Issue 10。

---

## Issue 1

### 1.Add a title

建立 Assistant 与 Settings 顶层路由容器

### 2.Goal

新增 assistant 与 settings 两个页面级路由，并完成旧 config 与 genres 路由到 settings 子分页的重定向骨架。

### 3.In Scope

1. 新增 assistant 页面路由。
2. 新增 settings 页面路由。
3. config 到 settings?tab=provider 的重定向。
4. genres 到 settings?tab=genre 的重定向。

### 4.Out of Scope

1. AI助手业务逻辑实现。
2. 设置页内部表单迁移。

### 5.Acceptance Criteria

1. 访问 assistant 能进入空白占位页。
2. 访问 settings 能进入空白占位页。
3. 访问 config 与 genres 会自动跳转到 settings 对应分页。

### 6.Required Tests

1. App 路由单元测试。
2. 重定向行为测试。

### 7.Constraints

1. 不改动后端 API。
2. 不破坏现有 dashboard、book、runtime-center 路由。

### 8.Context / Links

1. [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)
2. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：建立 Assistant 与 Settings 顶层路由容器

目标：按 Issue 说明完成路由与重定向骨架，不实现业务细节。

交付要求：

1. 提交代码改动与路由测试。
2. 在 PR 描述中列出受影响路由与重定向映射。
3. 标注未覆盖项与后续依赖。

---

## Issue 2

### 1.Add a title

重构左侧系统栏与头部入口

### 2.Goal

将左侧系统栏收敛为 AI助手 与运行中心两个入口，并保留右上角设置入口在 AI Assistant 按钮右侧。

### 3.In Scope

1. Sidebar 系统栏入口调整为两个。
2. 右上角按钮排序调整并新增设置入口动作。
3. AI助手入口不再触发右侧 ChatPanel 展开。

### 4.Out of Scope

1. AI助手页面业务实现。
2. 设置页内部功能。

### 5.Acceptance Criteria

1. 左侧系统栏仅显示 AI助手、运行中心。
2. 右上角设置按钮位于 AI Assistant 按钮右侧。
3. 点击 AI助手进入 assistant 路由。

### 6.Required Tests

1. Sidebar 渲染与点击行为测试。
2. Header 按钮顺序与跳转测试。

### 7.Constraints

1. 不删除现有 RuntimeCenter 页面。
2. 保持主题切换与通知中心可用。

### 8.Context / Links

1. [packages/studio/src/components/Sidebar.tsx](../packages/studio/src/components/Sidebar.tsx)
2. [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)
3. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：重构左侧系统栏与头部入口

目标：完成导航收敛与入口改造，保持现有系统行为稳定。

交付要求：

1. 提交导航相关代码与截图。
2. 补齐对应前端测试。
3. PR 说明中写明保留功能与迁移行为。

---

## Issue 3

### 1.Add a title

实现 AI助手主页面框架与三段式布局

### 2.Goal

构建 assistant 页面结构：顶部上下文条、中间对话区、底部输入与快捷动作区，替代右侧 ChatPanel 的主入口地位。

### 3.In Scope

1. 新建 Assistant 页面组件与布局。
2. 对话消息列表基础组件。
3. 输入框与快捷动作按钮区。
4. 会话空态和加载态。

### 4.Out of Scope

1. 后端编排接口。
2. 复杂工具调用与任务执行。

### 5.Acceptance Criteria

1. assistant 页面具备完整三段式布局。
2. 页面可显示消息、输入、快捷动作。
3. 不依赖右侧 ChatPanel 即可使用。

### 6.Required Tests

1. 页面渲染测试。
2. 输入与快捷动作点击测试。

### 7.Constraints

1. 复用现有主题与配色体系。
2. 不引入大规模状态库重构。

### 8.Context / Links

1. [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
2. [packages/studio/src/pages](../packages/studio/src/pages)
3. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：实现 AI助手主页面框架与三段式布局

目标：先完成页面壳与交互骨架，保证后续能力可插拔。

交付要求：

1. 页面结构代码与基础交互。
2. 组件拆分说明。
3. 前端单测通过。

---

## Issue 4

### 1.Add a title

实现 AI助手书籍范围选择与参数确认卡片

### 2.Goal

在对话中支持书籍范围选择与动作参数确认，确保助手执行书籍级任务前具备明确上下文。

### 3.In Scope

1. 顶部上下文条书籍范围选择器。
2. 单本书、多本书、全部活跃书三种范围模式。
3. 对话中的参数确认卡片组件。
4. 未选书籍时的阻断提示。

### 4.Out of Scope

1. 后端任务编排逻辑。
2. 高级权限系统。

### 5.Acceptance Criteria

1. 用户可在 assistant 页面明确设置书籍范围。
2. 执行写下一章/审计等动作前出现确认卡片。
3. 未选书籍时不能直接执行书籍级动作。

### 6.Required Tests

1. 范围选择状态测试。
2. 确认卡片交互测试。

### 7.Constraints

1. 与现有 books 列表接口兼容。
2. 文案支持中英文国际化。

### 8.Context / Links

1. [packages/studio/src/pages/BookDetail.tsx](../packages/studio/src/pages/BookDetail.tsx)
2. [packages/studio/src/hooks/use-api.ts](../packages/studio/src/hooks/use-api.ts)
3. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：实现 AI助手书籍范围选择与参数确认卡片

目标：补齐书籍上下文确认能力，避免误执行。

交付要求：

1. 完成范围选择与确认卡片。
2. 提交交互测试。
3. 在 PR 中说明阻断规则。

---

## Issue 5

### 1.Add a title

实现 AI助手动作编排最小闭环

### 2.Goal

实现助手对核心动作的最小编排闭环：写下一章、审计章节、市场雷达，包含执行前确认、执行中反馈、执行后结果摘要。

### 3.In Scope

1. 用户意图到动作类型映射。
2. 动作触发对接现有 API。
3. 执行过程状态回显。
4. 成功与失败结果卡片。

### 4.Out of Scope

1. 高级多步自动链路。
2. 新后端能力研发。

### 5.Acceptance Criteria

1. 通过聊天可触发写下一章。
2. 通过聊天可触发审计指定章节。
3. 通过聊天可触发市场雷达。
4. 每个动作均有开始、进行、完成或失败反馈。

### 6.Required Tests

1. 动作映射单测。
2. API 调用与状态机测试。
3. 失败分支测试。

### 7.Constraints

1. 优先复用现有 server API。
2. 不引入破坏性 API 变更。

### 8.Context / Links

1. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
2. [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
3. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：实现 AI助手动作编排最小闭环

目标：让 AI助手在主页面完成三类核心动作的可用闭环。

交付要求：

1. 完成动作映射与调用。
2. 完成执行反馈与结果卡片。
3. 提交完整测试结果。

---

## Issue 6

### 1.Add a title

实现设置中心容器与 5 大分页骨架

### 2.Goal

构建 settings 页面容器，完成五个分页骨架并支持 tab 参数路由。

### 3.In Scope

1. settings 页面布局。
2. 五分页导航与切换。
3. query tab 参数解析。
4. 分页空态与占位说明。

### 4.Out of Scope

1. 各分页具体业务表单细节。
2. 后端设置接口新增。

### 5.Acceptance Criteria

1. settings 页面可稳定切换五分页。
2. 通过 URL 参数可直达指定分页。
3. 页面风格与现有 Studio 一致。

### 6.Required Tests

1. 设置页切换测试。
2. tab 参数解析测试。

### 7.Constraints

1. 不影响现有主题、国际化机制。
2. 分页组件可复用于后续迭代。

### 8.Context / Links

1. [packages/studio/src/pages/ConfigView.tsx](../packages/studio/src/pages/ConfigView.tsx)
2. [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)
3. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：实现设置中心容器与 5 大分页骨架

目标：先完成容器页与分页导航，确保后续迁移可并行。

交付要求：

1. 完成 settings 容器和 tab 机制。
2. 提交 UI 截图和测试。
3. 说明扩展点。

---

## Issue 7

### 1.Add a title

迁移配置与题材到设置中心

### 2.Goal

将原 ConfigView 迁入 LLM Provider 设置分页，将 GenreManager 迁入题材设置分页，并删除重复入口。

### 3.In Scope

1. ConfigView 内容迁移到 provider 分页。
2. GenreManager 内容迁移到 genre 分页。
3. 旧页面入口清理与重定向。

### 4.Out of Scope

1. 配置字段扩展。
2. 题材规则算法改造。

### 5.Acceptance Criteria

1. settings?tab=provider 可完整使用原配置能力。
2. settings?tab=genre 可完整使用原题材管理能力。
3. 旧 config、genres 路由跳转后功能不缺失。

### 6.Required Tests

1. 配置页迁移回归测试。
2. 题材页迁移回归测试。
3. 重定向回归测试。

### 7.Constraints

1. 保持现有 API 契约不变。
2. 不降低任何已有能力。

### 8.Context / Links

1. [packages/studio/src/pages/ConfigView.tsx](../packages/studio/src/pages/ConfigView.tsx)
2. [packages/studio/src/pages/GenreManager.tsx](../packages/studio/src/pages/GenreManager.tsx)
3. [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)

#### 可复制派发评论模板

标题：迁移配置与题材到设置中心

目标：按无损迁移原则，将配置与题材并入 settings。

交付要求：

1. 完成迁移并保持能力等价。
2. 提交迁移前后对照说明。
3. 回归测试全部通过。

---

## Issue 8

### 1.Add a title

实现写作偏好全局治理项与防重复约束

### 2.Goal

新增写作偏好分页的系统级治理设置，并明确与书籍页面操作不重复。

### 3.In Scope

1. 写作风格模板全局偏好。
2. 审查严格程度基线。
3. 反 AI 痕迹强度策略。
4. 与书籍页面重复项拦截规则说明。

### 4.Out of Scope

1. 章节级即时操作配置。
2. 新增复杂策略引擎。

### 5.Acceptance Criteria

1. 写作偏好页不出现与 BookDetail 重复的操作项。
2. 全局策略项可保存并回显。
3. 有清晰文案说明“系统级治理，不影响单次手动操作优先级”。

### 6.Required Tests

1. 表单保存与回显测试。
2. 重复项守卫测试。

### 7.Constraints

1. 不破坏现有书籍页面操作链路。
2. 偏好配置保留扩展空间。

### 8.Context / Links

1. [packages/studio/src/pages/BookDetail.tsx](../packages/studio/src/pages/BookDetail.tsx)
2. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

#### 可复制派发评论模板

标题：实现写作偏好全局治理项与防重复约束

目标：完成写作偏好页并确保其职责是系统治理层，不与书籍页动作重复。

交付要求：

1. 完成字段、保存与回显。
2. 提交重复项对照表。
3. 说明后续可扩展策略点。

---

## Issue 9

### 1.Add a title

建立 AI助手指标埋点与增长看板

### 2.Goal

按 15 号文档指标验收要求建立事件埋点、指标口径与基础看板，支持上线后 4 周观测与决策。

### 3.In Scope

1. 定义并实现核心事件埋点：会话创建、计划确认、动作执行、失败重试、设置页访问与离开。
2. 建立关键指标口径：首次写作成功率、会话执行转化率、失败后二次重试成功率、设置页跳出率、助手使用占比。
3. 新增埋点校验脚本或测试，确保事件字段完整。
4. 输出指标看板字段说明文档。

### 4.Out of Scope

1. 商业化收费策略。
2. 复杂 BI 系统重构。

### 5.Acceptance Criteria

1. 核心链路事件可被稳定采集且字段完整。
2. 五个核心指标可在统一看板查询。
3. 指标计算口径在文档中可追溯。

### 6.Required Tests

1. 埋点事件触发测试。
2. 事件字段完整性测试。
3. 指标聚合口径回归测试。

### 7.Constraints

1. 不影响主链路性能与交互体验。
2. 埋点命名遵循统一规范并兼容后续扩展。

### 8.Context / Links

1. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
2. [packages/studio/src/pages](../packages/studio/src/pages)
3. [packages/studio/src/hooks](../packages/studio/src/hooks)

#### 可复制派发评论模板

标题：建立 AI助手指标埋点与增长看板

目标：打通关键链路数据，支撑上线后 4 周指标验收。

交付要求：

1. 提交事件字典与埋点代码。
2. 提交指标口径文档与看板说明。
3. 提交埋点测试与聚合验证结果。

---

## Issue 10

### 1.Add a title

实现首用引导与人性化失败恢复体验

### 2.Goal

落地 15 号文档“First 5 Minutes”与失败恢复规范，提升新手完成率与高压场景下的可控感。

### 3.In Scope

1. assistant 首次进入的示例目标与快捷引导。
2. 未选书时的轻提示与阻断文案优化。
3. 失败卡片统一结构：原因、可操作按钮、预计耗时。
4. 长任务阶段进度与剩余时间预估展示。
5. 核心操作键盘可达与错误提示无障碍增强。

### 4.Out of Scope

1. 全站视觉重设计。
2. 移动端专项适配。

### 5.Acceptance Criteria

1. 新用户首次进入可见引导且可一键触发示例任务。
2. 失败卡片均包含可操作恢复入口。
3. 长任务执行中可见阶段与预估时长。
4. 键盘可完成关键路径操作。

### 6.Required Tests

1. 首次引导显示与关闭测试。
2. 失败恢复按钮行为测试。
3. 长任务进度组件测试。
4. 可访问性基础测试。

### 7.Constraints

1. 不改变核心 API 契约。
2. 文案需支持中英文国际化。

### 8.Context / Links

1. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
2. [packages/studio/src/components](../packages/studio/src/components)
3. [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)

#### 可复制派发评论模板

标题：实现首用引导与人性化失败恢复体验

目标：提升新手成功率与失败场景下可控感，减少中途流失。

交付要求：

1. 提交引导与失败恢复组件改动。
2. 提交可访问性测试结果。
3. 提交关键文案清单与中英文映射。

---

## Issue 11

### 1.Add a title

建立分阶段发布门槛与运营复盘机制

### 2.Goal

把 15 号文档中的 Go/No-Go 门槛落地到发布流程，形成可执行的灰度、回滚与复盘机制。

### 3.In Scope

1. 定义内测、小流量、全量三个阶段的准入门槛。
2. 明确阻断性缺陷、关键指标、性能阈值的放行规则。
3. 建立回滚开关与应急流程文档。
4. 建立周复盘模板：失败 Top 原因、修复计划、指标趋势。

### 4.Out of Scope

1. 基础设施重构。
2. 非助手模块发布流程改造。

### 5.Acceptance Criteria

1. 发布文档可直接用于一次完整灰度演练。
2. 每阶段放行条件明确且有数据输入来源。
3. 回滚流程责任人与触发条件清晰。

### 6.Required Tests

1. 发布演练流程检查。
2. 回滚流程演练记录。
3. 指标门槛校验脚本验证。

### 7.Constraints

1. 不增加研发主线负担到不可接受范围。
2. 流程文档需和实际分支策略一致。

### 8.Context / Links

1. [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
2. [DevDocs/09-运维部署与可观测性.md](./09-运维部署与可观测性.md)
3. [DevDocs/10-维护治理与持续迭代规范.md](./10-维护治理与持续迭代规范.md)

#### 可复制派发评论模板

标题：建立分阶段发布门槛与运营复盘机制

目标：把发布从“经验驱动”变成“指标驱动”，确保可控上线。

交付要求：

1. 提交分阶段发布清单与放行门槛。
2. 提交回滚流程与演练记录模板。
3. 提交周复盘模板并给出示例。

---

## GitHub 可直接创建 Issue 模板块

使用方式：

1. 复制对应 Issue 的“标题”。
2. 在 GitHub 新建 Issue 页面粘贴标题。
3. 复制对应“正文模板（Markdown）”完整粘贴。

### Issue 1 模板

标题：`feat(studio): 建立 Assistant 与 Settings 顶层路由容器`

正文模板（Markdown）：

```md
## Goal

新增 assistant 与 settings 两个页面级路由，并完成旧 config 与 genres 路由到 settings 子分页的重定向骨架。

## In Scope

- 新增 assistant 页面路由
- 新增 settings 页面路由
- config -> settings?tab=provider 重定向
- genres -> settings?tab=genre 重定向

## Out of Scope

- AI 助手业务逻辑实现
- 设置页内部表单迁移

## Acceptance Criteria

- [ ] 访问 assistant 能进入空白占位页
- [ ] 访问 settings 能进入空白占位页
- [ ] 访问 config 与 genres 会自动跳转到 settings 对应分页

## Required Tests

- App 路由单元测试
- 重定向行为测试

## Constraints

- 不改动后端 API
- 不破坏现有 dashboard、book、runtime-center 路由

## Context / Links

- [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 2 模板

标题：`feat(studio): 重构左侧系统栏与头部入口`

正文模板（Markdown）：

```md
## Goal

将左侧系统栏收敛为 AI助手 与运行中心两个入口，并保留右上角设置入口在 AI Assistant 按钮右侧。

## In Scope

- Sidebar 系统栏入口调整为两个
- 右上角按钮排序调整并新增设置入口动作
- AI助手入口不再触发右侧 ChatPanel 展开

## Out of Scope

- AI助手页面业务实现
- 设置页内部功能

## Acceptance Criteria

- [ ] 左侧系统栏仅显示 AI助手、运行中心
- [ ] 右上角设置按钮位于 AI Assistant 按钮右侧
- [ ] 点击 AI助手进入 assistant 路由

## Required Tests

- Sidebar 渲染与点击行为测试
- Header 按钮顺序与跳转测试

## Constraints

- 不删除现有 RuntimeCenter 页面
- 保持主题切换与通知中心可用

## Context / Links

- [packages/studio/src/components/Sidebar.tsx](../packages/studio/src/components/Sidebar.tsx)
- [packages/studio/src/App.tsx](../packages/studio/src/App.tsx)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 3 模板

标题：`feat(studio): 实现 AI助手主页面框架与三段式布局`

正文模板（Markdown）：

```md
## Goal

构建 assistant 页面结构：顶部上下文条、中间对话区、底部输入与快捷动作区，替代右侧 ChatPanel 的主入口地位。

## In Scope

- 新建 Assistant 页面组件与布局
- 对话消息列表基础组件
- 输入框与快捷动作按钮区
- 会话空态和加载态

## Out of Scope

- 后端编排接口
- 复杂工具调用与任务执行

## Acceptance Criteria

- [ ] assistant 页面具备完整三段式布局
- [ ] 页面可显示消息、输入、快捷动作
- [ ] 不依赖右侧 ChatPanel 即可使用

## Required Tests

- 页面渲染测试
- 输入与快捷动作点击测试

## Constraints

- 复用现有主题与配色体系
- 不引入大规模状态库重构

## Context / Links

- [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
- [packages/studio/src/pages](../packages/studio/src/pages)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 4 模板

标题：`feat(studio): 实现 AI助手书籍范围选择与参数确认卡片`

正文模板（Markdown）：

```md
## Goal

在对话中支持书籍范围选择与动作参数确认，确保助手执行书籍级任务前具备明确上下文。

## In Scope

- 顶部上下文条书籍范围选择器
- 单本书、多本书、全部活跃书三种范围模式
- 对话中的参数确认卡片组件
- 未选书籍时的阻断提示

## Out of Scope

- 后端任务编排逻辑
- 高级权限系统

## Acceptance Criteria

- [ ] 用户可在 assistant 页面明确设置书籍范围
- [ ] 执行写下一章/审计等动作前出现确认卡片
- [ ] 未选书籍时不能直接执行书籍级动作

## Required Tests

- 范围选择状态测试
- 确认卡片交互测试

## Constraints

- 与现有 books 列表接口兼容
- 文案支持中英文国际化

## Context / Links

- [packages/studio/src/pages/BookDetail.tsx](../packages/studio/src/pages/BookDetail.tsx)
- [packages/studio/src/hooks/use-api.ts](../packages/studio/src/hooks/use-api.ts)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 5 模板

标题：`feat(studio): 实现 AI助手动作编排最小闭环`

正文模板（Markdown）：

```md
## Goal

实现助手对核心动作的最小编排闭环：写下一章、审计章节、市场雷达，包含执行前确认、执行中反馈、执行后结果摘要。

## In Scope

- 用户意图到动作类型映射
- 动作触发对接现有 API
- 执行过程状态回显
- 成功与失败结果卡片

## Out of Scope

- 高级多步自动链路
- 新后端能力研发

## Acceptance Criteria

- [ ] 通过聊天可触发写下一章
- [ ] 通过聊天可触发审计指定章节
- [ ] 通过聊天可触发市场雷达
- [ ] 每个动作均有开始、进行、完成或失败反馈

## Required Tests

- 动作映射单测
- API 调用与状态机测试
- 失败分支测试

## Constraints

- 优先复用现有 server API
- 不引入破坏性 API 变更

## Context / Links

- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)
- [packages/studio/src/components/ChatBar.tsx](../packages/studio/src/components/ChatBar.tsx)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 6 模板

标题：`feat(studio): 实现设置中心容器与 5 大分页骨架`

正文模板（Markdown）：

```md
## Goal

构建 settings 页面容器，完成五个分页骨架并支持 tab 参数路由。

## In Scope

- settings 页面布局
- 五分页导航与切换
- query tab 参数解析
- 分页空态与占位说明

## Out of Scope

- 各分页具体业务表单细节
- 后端设置接口新增

## Acceptance Criteria

- [ ] settings 页面可稳定切换五分页
- [ ] 通过 URL 参数可直达指定分页
- [ ] 页面风格与现有 Studio 一致

## Required Tests

- 设置页切换测试
- tab 参数解析测试

## Constraints

- 不影响现有主题、国际化机制
- 分页组件可复用于后续迭代

## Context / Links

- [packages/studio/src/pages/ConfigView.tsx](../packages/studio/src/pages/ConfigView.tsx)
- [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 7 模板

标题：`refactor(studio): 迁移配置与题材到设置中心`

正文模板（Markdown）：

```md
## Goal

将原 ConfigView 迁入 LLM Provider 设置分页，将 GenreManager 迁入题材设置分页，并删除重复入口。

## In Scope

- ConfigView 内容迁移到 provider 分页
- GenreManager 内容迁移到 genre 分页
- 旧页面入口清理与重定向

## Out of Scope

- 配置字段扩展
- 题材规则算法改造

## Acceptance Criteria

- [ ] settings?tab=provider 可完整使用原配置能力
- [ ] settings?tab=genre 可完整使用原题材管理能力
- [ ] 旧 config、genres 路由跳转后功能不缺失

## Required Tests

- 配置页迁移回归测试
- 题材页迁移回归测试
- 重定向回归测试

## Constraints

- 保持现有 API 契约不变
- 不降低任何已有能力

## Context / Links

- [packages/studio/src/pages/ConfigView.tsx](../packages/studio/src/pages/ConfigView.tsx)
- [packages/studio/src/pages/GenreManager.tsx](../packages/studio/src/pages/GenreManager.tsx)
- [packages/studio/src/api/server.ts](../packages/studio/src/api/server.ts)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 8 模板

标题：`feat(studio): 实现写作偏好全局治理项与防重复约束`

正文模板（Markdown）：

```md
## Goal

新增写作偏好分页的系统级治理设置，并明确与书籍页面操作不重复。

## In Scope

- 写作风格模板全局偏好
- 审查严格程度基线
- 反 AI 痕迹强度策略
- 与书籍页面重复项拦截规则说明

## Out of Scope

- 章节级即时操作配置
- 新增复杂策略引擎

## Acceptance Criteria

- [ ] 写作偏好页不出现与 BookDetail 重复的操作项
- [ ] 全局策略项可保存并回显
- [ ] 有清晰文案说明“系统级治理，不影响单次手动操作优先级”

## Required Tests

- 表单保存与回显测试
- 重复项守卫测试

## Constraints

- 不破坏现有书籍页面操作链路
- 偏好配置保留扩展空间

## Context / Links

- [packages/studio/src/pages/BookDetail.tsx](../packages/studio/src/pages/BookDetail.tsx)
- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 9 模板

标题：`feat(studio): 建立 AI助手指标埋点与增长看板`

正文模板（Markdown）：

```md
## Goal

按 15 号文档指标验收要求建立事件埋点、指标口径与基础看板，支持上线后 4 周观测与决策。

## In Scope

- 实现核心事件埋点：会话创建、计划确认、动作执行、失败重试、设置页访问与离开
- 建立核心指标口径与统计逻辑
- 新增埋点校验测试
- 输出指标看板字段说明

## Out of Scope

- 商业化收费策略
- 复杂 BI 系统重构

## Acceptance Criteria

- [ ] 核心链路事件可稳定采集且字段完整
- [ ] 五个核心指标可在统一看板查询
- [ ] 指标计算口径在文档中可追溯

## Required Tests

- 埋点事件触发测试
- 事件字段完整性测试
- 指标聚合口径回归测试

## Constraints

- 不影响主链路性能与交互体验
- 埋点命名遵循统一规范

## Context / Links

- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
- [packages/studio/src/pages](../packages/studio/src/pages)
- [packages/studio/src/hooks](../packages/studio/src/hooks)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 10 模板

标题：`feat(studio): 实现首用引导与人性化失败恢复体验`

正文模板（Markdown）：

```md
## Goal

落地 15 号文档“First 5 Minutes”与失败恢复规范，提升新手完成率与高压场景下的可控感。

## In Scope

- assistant 首次进入的示例目标与快捷引导
- 未选书时的轻提示与阻断文案优化
- 失败卡片统一结构：原因、可操作按钮、预计耗时
- 长任务阶段进度与剩余时间预估展示
- 键盘可达与错误提示无障碍增强

## Out of Scope

- 全站视觉重设计
- 移动端专项适配

## Acceptance Criteria

- [ ] 新用户首次进入可见引导且可一键触发示例任务
- [ ] 失败卡片均包含可操作恢复入口
- [ ] 长任务执行中可见阶段与预估时长
- [ ] 键盘可完成关键路径操作

## Required Tests

- 首次引导显示与关闭测试
- 失败恢复按钮行为测试
- 长任务进度组件测试
- 可访问性基础测试

## Constraints

- 不改变核心 API 契约
- 文案需支持中英文国际化

## Context / Links

- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
- [packages/studio/src/components](../packages/studio/src/components)
- [packages/studio/src/hooks/use-i18n.ts](../packages/studio/src/hooks/use-i18n.ts)

## DoD

- [ ] 代码与测试通过
- [ ] PR 描述覆盖 Acceptance Criteria 映射
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

### Issue 11 模板

标题：`chore(process): 建立分阶段发布门槛与运营复盘机制`

正文模板（Markdown）：

```md
## Goal

把 15 号文档中的 Go/No-Go 门槛落地到发布流程，形成可执行的灰度、回滚与复盘机制。

## In Scope

- 定义内测、小流量、全量三个阶段准入门槛
- 明确缺陷、指标、性能阈值放行规则
- 建立回滚开关与应急流程文档
- 建立周复盘模板并明确输入数据来源

## Out of Scope

- 基础设施重构
- 非助手模块发布流程改造

## Acceptance Criteria

- [ ] 发布文档可直接用于一次完整灰度演练
- [ ] 每阶段放行条件明确且有数据输入来源
- [ ] 回滚流程责任人与触发条件清晰

## Required Tests

- 发布演练流程检查
- 回滚流程演练记录
- 指标门槛校验脚本验证

## Constraints

- 不增加研发主线负担到不可接受范围
- 流程文档需和实际分支策略一致

## Context / Links

- [DevDocs/15-AI助手中枢化与设置中心重构详细设计.md](./15-AI助手中枢化与设置中心重构详细设计.md)
- [DevDocs/09-运维部署与可观测性.md](./09-运维部署与可观测性.md)
- [DevDocs/10-维护治理与持续迭代规范.md](./10-维护治理与持续迭代规范.md)

## DoD

- [ ] 文档与流程评审通过
- [ ] 发布演练记录完整
- [ ] 提交变更摘要 + 风险点 + 回滚方式
```

---

## 并行执行建议

建议并行分组：

1. 组 A：Issue 1 + Issue 2。
2. 组 B：Issue 3 + Issue 4 + Issue 5。
3. 组 C：Issue 6 + Issue 7 + Issue 8。
4. 组 D：Issue 9 + Issue 10 + Issue 11。

推荐派发节奏：

1. 第一批：Issue 1、Issue 3、Issue 6。
2. 第二批：Issue 2、Issue 4、Issue 7。
3. 第三批：Issue 5、Issue 8、Issue 9。
4. 第四批：Issue 10、Issue 11。

冲突规避建议：

1. App 路由和导航相关文件由同一批次内单 Agent 修改，避免冲突。
2. settings 容器与 settings 子分页拆分到不同 Agent，但以统一 tab 契约为准。
3. assistant 页面 UI 与 assistant 编排逻辑分开实现，减少同文件并发修改。
4. 埋点与业务逻辑分层提交：先抽取埋点 hook，再在各页面接入，降低冲突。
5. 发布流程文档改动由单 Agent 汇总，避免多版本流程并存。

建议合并顺序：

1. 先合并路由与导航骨架。
2. 再合并 AI助手主页面框架与动作闭环。
3. 然后合并设置迁移与写作偏好治理。
4. 再合并指标埋点与增长看板。
5. 最后合并首用引导与发布运营机制。
