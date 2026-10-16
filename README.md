# AI 开发团队（DSH agent preset + bundle）

把「一支开发团队」做成 DSH 的可选会话模式：在新建会话里选 **开发团队**，Lead 先给需求定**风险等级**，
再按等级把**流水线阶段建成带依赖的看板任务**、拉起对应角色，最后自己验收交付。

默认栈：**Python 3.13 + FastAPI + asyncio + PostgreSQL + SQLAlchemy(async) + Alembic + Redis + HTMX**，
服务端 UI 用本机自研的 **pyjoist**（`import joist`）做组件化。

- preset id：`devteam`（模式名册 order 6）｜ 包名：`@local/dsh-ai-dev-team`
- 依赖：profile 需已启用 `@deepseek-ai/dsh-experimental-agent-team-profile`
- **运营模型（必读）**：[docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) —— 风险分级、三条车道、六道门、交接协议、证据等级、WIP 与度量、事故通道
- 角色与协作总览：[docs/TEAM.md](docs/TEAM.md) ｜ 项目文档协议：[docs/DOCS.md](docs/DOCS.md)
- 机器可读的唯一真源：[cordis.patch.yml](cordis.patch.yml) 的 `dev-team` 行（`roles` / `riskTiers` / `pipeline` / `projectDocs`）

## 目录

```
.
├── cordis.patch.yml            # preset 声明 + 常规插件行 + dev-team 配置（角色/等级/流水线/栈/文档清单）
├── lib/plugin.js               # host 半：配置校验、蓝图段落、dev_team_start（DAG 规划）、dev_docs_init
├── skills/dev-team-*/SKILL.md  # 角色手册 ×11（lead / pm / dev / qa / reviewer / architect / security / release / agent-dev / react / miniprogram）
├── templates/project/          # 项目 md 骨架 ×13（含 AGENTS.md）；dev_docs_init 复制到项目
├── docs/OPERATING-MODEL.md     # 运营模型（本次设计的核心）
├── docs/TEAM.md                # 角色、RACI、交接、质量门总览
├── docs/DOCS.md                # 项目文档协议
├── tools/preset-diag/          # 排障：把预设名册（含 broken 原因）导出到 report.json
└── test/dev-team.test.mjs      # 集成测试 ×21（真写盘脚手架、DAG 规划、容量边界、蓝图字面量模板回归、GitHub 安装可用性）
```

## 安装 / 更新

**从 GitHub 装（推荐，任何机器都能装）**：

```python
plugin_manager  action: install_bundle  target: github:manyoo/ai_dev_team
# 想钉住某个提交/标签：target: github:manyoo/ai_dev_team#<tag 或 commit>
```

**从本机目录装（改代码的开发流程）**：

```python
plugin_manager  action: install_bundle  target: /path/to/ai_dev_team

# 更新（改了 cordis.patch.yml / lib / templates 之后）
plugin_manager  action: remove_bundle   target: @local/dsh-ai-dev-team
plugin_manager  action: install_bundle  target: <上面任一种 target>
```

- 仓库是**私有**的：git 安装走你本机的 git 凭据（`git credential` / `gh auth`），DSH 那边不会另存一份。
- patch 里**不写任何绝对路径**，所以两种装法共用一份 `cordis.patch.yml`：
  - `skills` 目录用 `!!js` 表达式按 `baseUrl` 定位本包（与内置 cordis 预设同一套写法）；
  - `operatingModel` / `templatesDir` 是包内相对路径，由 `lib/plugin.js` 按包根解析成绝对路径。
  从 GitHub 装完，角色手册、项目 md 骨架、运营模型都自动指向安装位置里的那份，不需要手改配置。
- 对已安装 bundle 重复 `install_bundle` 返回 `ambiguous-install`（幂等提示，状态不变）；要带上改动必须走「移除-安装」。
- 改 **skill 正文**不用重装（目录被监视）；改 **skill 名字、手册目录、根路径、preset 配置**要重装。
- 已有会话保留启动时的 preset 版本；验证改动要开新会话。

## 生效规则（很重要）

| 改了什么 | 怎么生效 |
|---|---|
| `skills/**/SKILL.md` 正文 | 目录被监视，下一次会话/目录刷新即生效，不用重装 |
| `templates/**` | 下一次 `dev_docs_init` / `dev_team_start` 生效，不用重装 |
| `cordis.patch.yml`（团队配置） | `remove_bundle` → `install_bundle`；patch 本身是 live reload，但两步最稳 |
| **`lib/*.js`（插件代码）** | **必须重启 dsh**：替换已安装的包无法换掉进程里已 import 的模块代际 |

只重装、不重启会得到「新配置 + 旧代码」的组合，典型症状是**预设名册显示「加载失败」**（原因文案通常是
「配置里有未知字段：…」），而此时 `list_plugins` / `list_bundles` 一切正常——那两者只反映行与状态，
不反映模块代际。

### 排障：模式显示「加载失败」

1. `plugin_manager install_bundle target=<ai_dev_team 目录>/tools/preset-diag`
2. 等约 10 秒，读 `tools/preset-diag/report.json`：每个预设的 `broken` 字段就是 UI 上显示的失败原因
   （名册与组合清单两份）
3. 用完 `plugin_manager remove_bundle target=@local/dsh-preset-diag`，并删掉 `report.json`

### 排障：会话里报 `malformed prompt variable reference`

症状：模式能选、会话能开，但一发消息就报（段落名固定是 `dev-team:blueprint`）：

```
malformed prompt variable reference "{{ child }}" in section "dev-team:blueprint"
  (variable names match /^[a-z][a-z0-9_]*$/)
```

原因：提示词注册表默认把常驻段落当**模板**做 `{{变量}}` 插值（变量名只允许小写字母/数字/下划线），
而蓝图正文来自 `cordis.patch.yml` 的团队配置——`stackRules` 里的 pyjoist/Jinja 示例 `{{ child }}` 是文档，
不是提示词变量。修复：蓝图段落以 `interpolate: false` 注册（见 `lib/plugin.js` 的 `apply()`），
配置里的模板示例原样进提示词。这条改的是 `lib/*.js`，按上表**必须重启 dsh**；回归用例见
`test/dev-team.test.mjs`（用真实 `dsh-system-prompt` 的 `renderPrompt` 断言）。

## 怎么用

1. 新开会话，模式选 **开发团队**；把项目根目录告诉 Lead。
2. Lead 定级并建队：

```python
dev_team_start(
  goal="给订单列表加按状态筛选 + 分页，HTMX 局部刷新，带测试",   # 必须自足
  project="myapp",        # 项目根（自动补齐 13 份项目 md）
  risk="T2",              # 不传用默认等级
  roles=["reviewer"],     # 可选：点名额外角色（连带其阶段与依赖）
)
```

3. 工具返回 `riskTier`（含门禁）、`stages`（阶段 → taskId → blockedBy）、`members`（每人认领的 taskId）、`failures`；
   随后 Lead 用 `send_message` 派活/纠偏、`wait_agent` 等进展、`interrupt_agent` 止损，最后**亲自验收**。

| 工具 | 谁可调用 | 作用 |
|---|---|---|
| `dev_team_start(goal, project?, risk?, roles?)` | 仅 Lead | 定级 → 补文档 → 按等级把流水线建成**带依赖的看板任务** → 创建成员（每个成员拿到自己的全部阶段任务） |
| `dev_docs_init(project, docs?)` | 任何成员 | 按 `templates/project/**` 创建缺失的 13 份项目 md；**只创建缺失文件，绝不覆盖** |

## 风险分级与三条车道

| 等级 | 判定 | 成员 | 门禁 | 阶段（自动建成看板任务） |
|---|---|---|---|---|
| **T0** | 只改文档/注释/文案 | 不建队（Lead 自己做） | — | — |
| **T1** | 单模块行为修正，不改接口与表结构 | dev + qa | 测试门、验收门 | `impl → unit → verify → accept` |
| **T2**（默认） | 新接口/改响应/加字段/跨模块 | pm + dev + qa | 契约门、测试门、验收门 | `req → contract →（testplan ∥ schema → impl → unit）→ verify → accept` |
| **T3** | 鉴权/支付/资金/个人数据/迁移/架构/发布 | + architect、reviewer、security、release（7 人） | 六道门全过 | T2 前加 `design`，后加 `review → security → release` |

- **契约冻结（contract 完成）是并行起跑线**：dev 实现、qa 集成用例同时开工（`testplan` 只依赖契约，不依赖实现）。
- **点名角色会带进它的阶段与依赖链**：`roles:["security"]` 会连 `review` + `reviewer` 一起进来；`roles:["react-dev"]` 会带进 `fe` 与它需要的 `contract`。
- 看板上的 `blockedBy` 就是「谁在等谁」；前置未完成的任务是 not-ready。

## 智能体系统（以 agent 为核心的项目，默认形态）

这类项目默认用 **LangChain + LangGraph** 实现，模型默认 **DeepSeek v4.1 Flash**（`AGENT_MODEL` 环境变量配置）。
建队时加 `roles: ["agent-dev"]`，会自动带进智能体工作流并与主流水线连起来：

```
agentdesign(agent-dev) → agentimpl(agent-dev) → agenteval(qa) ⇢ verify(qa) → accept(lead)
```

- `agenteval` **归 qa**：评测是独立验证的一部分，不接受 agent-dev 自评；`verify` 用**软依赖**等它
  （智能体在场才等评测，普通项目不会凭空多一个前置）。
- 硬约束（见 `stackRules`）：控制流写在 LangGraph 图上而不是提示词里；工具契约用 Pydantic + 超时 + 幂等 + 错误当数据；
  提示词外置并版本化；模型/密钥走环境变量；有最大步数与成本预算；**改提示词/模型/工具必须跑评测回归**；
  单测不打真实模型（假模型/回放）。
- 契约落在 `docs/AGENTIC.md`（拓扑、状态与记忆、工具契约、提示词与模型、护栏与预算、追踪与评测、基线）；
  上线由 release 保证三件套可单独回滚（模型版本 / 提示词版本 / 代码版本）与成本告警。

## 团队一览（11 份角色手册）

| 角色 | 默认 | 手册 | 写入范围 |
|---|---|---|---|
| Lead（编排） | 会话本身 | `dev-team-lead` | `docs/WORKLOG.md`、`docs/DECISIONS.md` 汇总 |
| `pm` 产品经理 | T2/T3 | `dev-team-pm` | `docs/PROJECT.md`、`docs/DECISIONS.md` |
| `dev` 后端/全栈 | T1/T2/T3 | `dev-team-dev` | `app/`、`templates/`、`migrations/`、`tests/unit/`、`pyproject.toml`、`docs/{API,DATA}.md` |
| `qa` 测试/验证 | T1/T2/T3 | `dev-team-qa` | `tests/integration/`、`docs/TESTING.md` |
| `reviewer` 代码评审 | T3/点名 | `dev-team-reviewer` | `docs/REVIEWS.md` |
| `architect` 架构设计 | T3 | `dev-team-architect` | `docs/ARCHITECTURE.md`、`docs/DECISIONS.md` |
| `security` 安全合规 | T3/点名 | `dev-team-security` | `docs/SECURITY.md` |
| `release` 发布运维 | T3/点名 | `dev-team-release` | `docs/RUNBOOK.md`、`.github/workflows/`、`Dockerfile`、`deploy/` |
| `react-dev` React 前端 | 点名 | `dev-team-react` | `frontend/`、`docs/FRONTEND.md` |
| `agent-dev` 智能体架构与开发 | 智能体项目 | `dev-team-agent-dev` | `app/agents/`、`app/evals/`、`prompts/`、`docs/AGENTIC.md` |
| `miniprogram-dev` 小程序 | 点名 | `dev-team-miniprogram` | `miniprogram/`、`docs/FRONTEND.md` |

**配置放契约，手册放方法**：`roles[].duties/deliverables/acceptance` 是任务契约（进看板与提示词，必须短）；
做法、代码模式、检查清单在 `skills/dev-team-*/SKILL.md`，成员开工时用 `skill(name="dev-team-dev")` 按需加载。

## 配置即数据（`cordis.patch.yml` 的 `dev-team` 行）

| 字段 | 含义 |
|---|---|
| `teamName` / `context` / `freshProvider` / `forkProvider` | 团队名与成员上下文（`fresh` 推荐） |
| `stackSummary` / `stackRules` / `commands` | 技术栈、逐条工程约定（async/事务/迁移/Redis/pyjoist）、常用命令（uv + pytest + ruff + alembic + uvicorn） |
| `riskTiers[]` | 风险等级：`id` / `title` / `when` / `roles` / `gates` / `solo` / `default` |
| `pipeline[]` | 流水线阶段：`id` / `title` / `owner` / `dependsOn` / `tiers` / `deliverables` |
| `projectDocs[]` | 每个项目必须有的 md：`path` / `title` / `purpose` / `owner`（13 份） |
| `templatesDir` / `operatingModel` | 文档骨架目录、运营模型路径（写进蓝图） |
| `maxMembers` | 团队人数上限（默认 8，必须与 agent-team 组合包一致；测试会比对防漂移） |
| `workflow` / `rules` | 车道说明与团队硬约束（定级、契约变更、证据、WIP、回滚、单一写入者） |
| `roles[]` | 角色契约：`name` / `title` / `description` / `phase` / `skill` / `duties` / `deliverables` / `acceptance` / `docs` / `writeScopes` / `create` |

另：`skill-filesystem` 行的 `customSkillDirs` 决定角色手册发现目录（项目自己的 `<项目根>/.dsh/skills` 仍有效）。

蓝图正文按**字面量**注入提示词（`interpolate: false`），所以配置里写 `{{ child }}` 这类模板示例是安全的——
它们不会被当成提示词变量解析（否则会话每轮装配都会报 `malformed prompt variable reference`）。

配置错误在**激活时**报出：未知字段、非 kebab-case 名、角色/tier/阶段 id 重复、`docs` 引用未声明文档、
`projectDocs` 绝对路径或重复、tier 引用未定义角色、多个 `default` tier、非 solo tier 无 roles、阶段 owner 未定义、
阶段依赖不存在、**循环依赖**、以及某个等级选不到任何阶段。

## 项目文档协议（13 份）

`AGENTS.md`（lead）｜`docs/PROJECT.md`（pm）｜`docs/ARCHITECTURE.md`（architect）｜`docs/API.md`、`docs/DATA.md`（dev）｜
`docs/DECISIONS.md`（architect/lead 追加）｜`docs/WORKLOG.md`（lead）｜`docs/TESTING.md`（qa）｜`docs/REVIEWS.md`（reviewer）｜
`docs/SECURITY.md`（security）｜`docs/RUNBOOK.md`（release）｜`docs/AGENTIC.md`（agent-dev）｜`docs/FRONTEND.md`（客户端角色）

规则、更新时机与反模式见 [docs/DOCS.md](docs/DOCS.md)；骨架即 [templates/project/](templates/project)。

## 验证状态

| 项 | 证据 |
|---|---|
| 插件行为 | `node --test test/` **21/21 通过**：蓝图内容、配置校验（含 tier/pipeline 全部错误分支与循环依赖）、**手册↔配置↔提示词一致性**、**13 份文档真写盘（幂等/不覆盖/越界拒绝）**、T1/T2/T3 三条车道的 DAG 与 blockedBy 精确断言、点名角色连带阶段与**软依赖（评测不产生幻影阻塞）**、T0 拒绝建队、权限与参数校验、重名跳过与单点失败隔离 |
| 蓝图不被变量插值 | 回归用例用真实 `dsh-system-prompt` 的 `renderPrompt` 跑装配：去掉 `interpolate: false` 就复现 `malformed prompt variable reference "{{ child }}"`，留着则整段原样保留 |
| 模板完整性 | `templates/project/**` 与 `projectDocs` 一一对应（12/12），测试断言无 `missingTemplates` |
| 手册完整性 | 11 份 `skills/dev-team-*/SKILL.md`：frontmatter 用真实 YAML 解析、目录名与 `name` 一致、`description`/`whenToUse` 非空、正文有实际内容 |
| 安装与激活 | `install_bundle` → `application: applied`；`Config.listConfigs` 有 `include:preset-devteam`；`list_plugins` 显示 `enabled: true, fiberPhase: "active"`（preset registry 先审计子行导入/激活/泄漏，失败即抛错） |
| GitHub 安装可用性 | 测试用 DSH 真实的 patch 方言（`js-yaml JSON_SCHEMA + !!js` 标量标签）与真实的表达式求值方式（`with (ctx) { return eval(expr) }`）跑 `customSkillDirs`：`baseUrl` 指向仓库目录（link: 安装）与指向 profile 目录（git/pnpm 安装）都解析到包内 `skills/`（11 份手册）；dump 回写后语义不变；patch 里无任何机器绝对路径 |
| 真实 GitHub 安装 | `pnpm add github:manyoo/ai_dev_team` 装进临时目录 → 用安装副本里的 patch 求值到安装位置的 `skills/`，并用该副本的 `lib/plugin.js` 跑真实提示词装配 |

**未验证**（需要真实会话，本会话无法代做）：新会话里模型的蓝图可见性、`dev_team_start` 真建 DAG 与成员、
看板依赖与 ready 状态在界面上的呈现。验收：新开会话选 **开发团队** → 发需求并给项目根 → 预期看到一次
`dev_team_start`、看板出现该等级的阶段任务链（含依赖）、成员名单与等级一致、项目里出现 13 份 md。

容量相关的三条断言（超编前置失败且零副作用、正好等于上限可行、两侧 maxMembers 一致）都在 `test/dev-team.test.mjs` 里。

## 限制

- 需要 **DSH ≥ 0.2.0-rc.1**：蓝图靠 `interpolate: false` 关闭段落插值，更早的 `dsh-system-prompt` 无条件插值
  （本机 npx 缓存里就有 0.1.5-rc.3，它会让 `{{ child }}` 重新变成报错源）。
- 需要 **DSH 的 patch 方言支持 `!!js` 标量**（内置 `standard`/`cordis` 预设都用到，0.2.0-rc.2 实测可用）：
  `skills` 目录靠它定位安装位置；不支持的旧版本会退化成「手册目录缺失」，不会静默跑歪。
- 仓库是私有的：从 GitHub 安装依赖本机 git 凭据；`github:manyoo/ai_dev_team#<tag>` 可钉版本。
- teammate 与 Lead **同模型**；成员继承 Lead 的 preset，角色差异只来自任务与角色手册。
- 共享工作目录，**无 worktree、无文件锁**：`writeScopes` 是约定，重叠只在看板警告，靠 Lead 裁决。
- 文档脚手架只创建缺失文件，且只在工作目录或用户主目录内创建。
- 团队上限 `maxMembers`（默认 8，T3 用 7 人）：**名册超编时建队会在动手前失败**（不建任务、不建成员），并给出三种选择——去掉点名角色、降级或拆两轮、或把两处 maxMembers 一起提高。静态超编的等级（等级名册本身就超上限）在激活时就报错。
- 成员名永久保留，同一会话不能重建同名成员。
- pyjoist 是本机包 `/home/eric/programming/joist`（`import joist`）；要改它请去那个仓库另开任务。
