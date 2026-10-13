# AI 开发团队（DSH agent preset + bundle）

把「一支开发团队」做成 DSH 的可选会话模式：在新建会话里选 **开发团队**，Lead 就带着预先定义好的角色、
技术栈、工作流和文档纪律开工。默认栈是 **Python 3.13 + FastAPI + asyncio + PostgreSQL + SQLAlchemy(async)
+ Alembic + Redis + HTMX**，服务端 UI 用本机自研的 **pyjoist**（`import joist`）做组件化。

- preset id：`devteam`（模式名册 order 6）
- 包名：`@local/dsh-ai-dev-team`
- 依赖：profile 需已启用 `@deepseek-ai/dsh-experimental-agent-team-profile`（提供 Team 工具与任务看板）
- 设计文档：[`docs/TEAM.md`](docs/TEAM.md)（协作规则）｜[`docs/DOCS.md`](docs/DOCS.md)（项目 md 文档协议）
- 机器可读的团队配置：[`cordis.patch.yml`](cordis.patch.yml) 的 `dev-team` 行

## 目录

```
.
├── cordis.patch.yml        # preset 声明 + 常规插件行 + dev-team 配置（角色/栈/工作流/文档清单）
├── lib/index.js            # host 半：配置校验、蓝图段落、dev_team_start、dev_docs_init
├── templates/project/      # 每个新项目的 md 文档骨架（10 个文件，含 AGENTS.md）
├── docs/TEAM.md            # 团队协作设计：角色、交接、质量门、任务板、沟通协议、扩编
├── docs/DOCS.md            # 项目文档协议：文件清单、所有者、更新时机、写作规则
├── test/dev-team.test.mjs  # 集成测试（含真写盘的脚手架测试）
└── README.md
```

## 安装 / 更新

```python
# 安装
plugin_manager  action: install_bundle  target: /home/eric/programming/ai_dev_team

# 更新（改了 cordis.patch.yml / lib / templates 之后）
plugin_manager  action: remove_bundle   target: @local/dsh-ai-dev-team
plugin_manager  action: install_bundle  target: /home/eric/programming/ai_dev_team
```

- 对已安装的 bundle 重复 `install_bundle` 会返回 `ambiguous-install` 且 `changed: false`（幂等提示，状态不变），要带上改动必须走「移除-安装」两步。
- 已有会话保留启动时的 preset 版本；验证改动要开新会话。
- 安装会在 Host 进程执行插件代码，需要授权。

## 怎么用

1. 新开会话，模式选 **开发团队**。
2. 提需求，例如「给订单列表加按状态筛选 + 分页，HTMX 局部刷新，带测试」，并说明项目根目录。
3. Lead 会：`todo_write` 拆阶段 → `dev_docs_init` / `dev_team_start` 建队（自动补齐项目 md）→ `send_message` 派活 → 自己复核 diff 并重跑验收 → 按「做了什么 / 怎么验证 / 遗留与风险」汇报。

两个工具：

| 工具 | 谁可调用 | 作用 |
|---|---|---|
| `dev_docs_init(project, docs?)` | 任何成员 | 按 `templates/project/**` 在项目里创建缺失的 md 文档（含 `AGENTS.md`）；**只创建缺失文件，绝不覆盖**；项目目录不存在会报错 |
| `dev_team_start(goal, project?, roles?)` | 仅 Lead | 补齐缺失文档 → 为每个角色建看板任务（含交付物、写入范围、文档职责、完成判定）→ 按角色手册创建 teammate。一个目标调一次 |

## 团队一览

| 角色 | 默认建 | 写入范围 |
|---|---|---|
| `pm` 产品经理 | ✅ | `docs/PROJECT.md`、`docs/DECISIONS.md` |
| `dev` 后端/全栈 | ✅ | `app/`、`templates/`、`migrations/`、`tests/unit/`、`pyproject.toml`、`docs/{ARCHITECTURE,API,DATA}.md` |
| `qa` 测试/验证 | ✅ | `tests/integration/`、`docs/TESTING.md` |
| `reviewer` 代码评审 | 点名 | `docs/REVIEWS.md` |
| `react-dev` React 前端 | 点名 | `frontend/`、`docs/FRONTEND.md` |
| `miniprogram-dev` 微信小程序 | 点名 | `miniprogram/`、`docs/FRONTEND.md` |

按需扩编：`dev_team_start(goal=..., project=..., roles=["dev", "react-dev"])`。要加全新角色，就在 `cordis.patch.yml`
的 `roles` 里加一条（`duties` / `deliverables` / `acceptance` / `docs` / `writeScopes`），再走「移除-安装」。

## 配置即数据

`cordis.patch.yml` 里 `dev-team` 行的 `config` 是唯一真源，改这里而不是改 prompt：

| 字段 | 含义 |
|---|---|
| `teamName` | 团队名 |
| `context` / `freshProvider` / `forkProvider` | 成员上下文（`fresh` 推荐）与创建提供方 |
| `stackSummary` / `stackRules` | 一句话技术栈 + 逐条工程约定（async、事务、迁移、Redis、pyjoist 组件规范） |
| `commands` | 常用命令（默认 uv + pytest + ruff + alembic + uvicorn） |
| `projectDocs` | 每个项目必须有的 md 清单：`path` / `title` / `purpose` / `owner` |
| `templatesDir` | 文档骨架目录，默认 `templates/project` |
| `workflow` | 八阶段工作流（立项 → 契约 → 拆分 → 实现 → 验证 → 评审 → 验收 → 收尾） |
| `rules` | 团队硬约束（文档必落盘、先契约后实现、写入范围、交付带验证……） |
| `roles[]` | 角色表：`name` / `title` / `description` / `phase` / `duties` / `deliverables` / `acceptance` / `docs` / `writeScopes` / `create` |

配置错误在激活时报出（未知字段、非 kebab-case 角色名、角色名重复、`docs` 引用了未声明的文档、`projectDocs`
路径重复或写成绝对路径），不会静默跑歪。

## 项目文档协议（要点）

每个项目根目录必须有这 10 个文件，各有所有者；重要信息一律落 md，对话里的结论不算记录：

`AGENTS.md`（lead）｜`docs/PROJECT.md`（pm）｜`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/DATA.md`（dev）｜
`docs/DECISIONS.md`、`docs/WORKLOG.md`（lead）｜`docs/TESTING.md`（qa）｜`docs/REVIEWS.md`（reviewer）｜
`docs/FRONTEND.md`（react-dev / miniprogram-dev）

规则、更新时机与反模式见 [`docs/DOCS.md`](docs/DOCS.md)；骨架就是 [`templates/project/`](templates/project)。

## 验证状态

已验证：

| 项 | 证据 |
|---|---|
| 插件代码行为 | `node --test test/` 8 个用例全过：配置校验、蓝图渲染、**真写盘脚手架（10 个文件、幂等、不覆盖）**、路径越界拒绝、`project` 前缀范围、角色提示词内容、Lead 权限、重名与单点失败 |
| 模板完整性 | `templates/project/**` 与 `projectDocs` 一一对应（10/10），测试断言无 `missingTemplates` |
| 安装与激活 | `install_bundle` → `application: applied`；`Config.listConfigs` 有 `include:preset-devteam`；`list_plugins` 显示 `enabled: true, fiberPhase: "active"`（preset registry 会先审计子行的导入/激活/泄漏，失败即抛错） |

未验证（需要真实会话，本会话无法代做）：用 `devteam` 预设新开会话后模型侧的蓝图与工具可见性、真跑一次建队。

验收方式：新开会话选 **开发团队** → 发一个开发需求（附项目根目录）→ 预期看到一次 `dev_docs_init` 或
`dev_team_start`、看板出现 pm/dev/qa 三条任务、成员列表出现三个 teammate、项目里出现 10 个 md 文件。

## 限制

- teammate 与 Lead **同模型**；成员继承 Lead 的 preset，角色差异只来自各自任务提示词。
- 共享工作目录，**没有 worktree 隔离、没有文件锁**；`writeScopes` 是约定，范围重叠只会在看板警告。
- 文档脚手架只创建缺失文件（不覆盖），也只在工作目录或用户主目录内创建。
- 团队上限 8 人；成员名永久保留，同一会话不能重建同名成员。
- 服务端 UI 组件规范依赖 pyjoist 本机包 `/home/eric/programming/joist`（`import joist`）；要改 pyjoist 本身请去那个仓库，别在业务项目里改。
