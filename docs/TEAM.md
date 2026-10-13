# 团队协作设计

> 这份文件回答一个问题：**这支团队按什么规则开工、交接、验证、收尾。**
> **详细设计在 [`OPERATING-MODEL.md`](OPERATING-MODEL.md)**：风险分级、三条车道（快/标准/高风险）+ 事故通道、
> 12 个主阶段 + 3 个智能体阶段（A1–A3）的产物与完成判定、六道质量门、DoR/DoD、所有权矩阵、交接协议、证据等级、WIP 与度量。
> 机器可读的那份在 [`cordis.patch.yml`](../cordis.patch.yml) 的 `dev-team` 行（`roles` / `riskTiers` / `pipeline` / `projectDocs`）。
> 三处要保持一致：改配置时同步改这两份文档，改文档时同步改配置。

## 0. 设计原则

1. **契约先行**：接口与数据模型写进 `docs/API.md`、`docs/DATA.md` 之后才写业务实现。没契约就开工，等于必然返工。
2. **文档先行**：重要信息必须落 md。上下文会丢、会话会换人，只有仓库里的文件能交接。
3. **独立验证**：写代码的人不批准自己的代码。qa 独立复跑，Lead 亲自验收。
4. **写入范围隔离**：共享同一个工作目录，没有 worktree、没有文件锁，所以靠「一个角色一套写入范围」避免互相覆盖。
5. **Lead 亲验**：成员的结论是线索不是证据；关键结论（测试通过、Bug 已修）必须由 Lead 在当前工作区复现。

## 1. 角色与职责

| 角色 | 默认是否建 | 输入 | 输出（交付物） | 写入范围 | 主要交接对象 |
|---|---|---|---|---|---|
| `pm` 产品经理 | 是 | 用户目标、现有 `docs/PROJECT.md` | 需求条目 + 逐条验收标准、非目标、边界清单 | `docs/PROJECT.md`、`docs/DECISIONS.md` | → lead（锁定范围）、dev（业务规则） |
| `dev` 后端/全栈 | 是 | 需求与验收标准 | 契约（API/DATA）、实现、Alembic 迁移、单元测试、架构更新 | `app/`、`templates/`、`migrations/`、`tests/unit/`、`pyproject.toml`、`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/DATA.md` | → qa（可验证的增量）、lead（阻塞与决策） |
| `qa` 测试/验证 | 是 | dev 的增量 + 验收标准 | 集成/回归用例、独立验证报告（命令 + 结果）、缺陷复现 | `tests/integration/`、`docs/TESTING.md` | → lead（结论）、dev（缺陷） |
| `reviewer` 代码评审 | 否（T3/点名） | 验证后的增量 + 契约 | 按 文件:行 的阻断/建议清单 | `docs/REVIEWS.md` | → lead（是否放行） |
| `architect` 架构设计 | 否（T3） | 需求 + 现状架构 | 模块边界、依赖方向、NFR、选型与迁移兼容策略 | `docs/ARCHITECTURE.md`、`docs/DECISIONS.md` | → dev（实现基准）、reviewer（评审基准） |
| `security` 安全合规 | 否（T3/点名） | 契约 + 实现 + 信任边界 | 威胁面逐项结论与依据、高危项清零 | `docs/SECURITY.md` | → lead（是否放行）、release（发布前提） |
| `release` 发布运维 | 否（T3/点名） | 全部产出 + 安全结论 | 发布顺序、回滚、开关、冒烟、告警、事故复盘 | `docs/RUNBOOK.md`、CI/部署文件 | → lead（发布结论） |
| `agent-dev` 智能体架构与开发 | 智能体项目 | 需求 + 系统边界 | 拓扑与状态、工具契约、提示词与模型配置、护栏与预算、评测集与基线 | `app/agents/`、`app/evals/`、`prompts/`、`docs/AGENTIC.md` | → qa（评测）、dev（接口）、security（工具权限）、release（上线） |
| `react-dev` React 前端 | 否（点名） | 需要富交互或独立 SPA 的需求 | `frontend/` SPA、构建脚本、对接说明 | `frontend/`、`docs/FRONTEND.md` | → dev（契约缺口）、qa（验证步骤） |
| `miniprogram-dev` 小程序 | 否（点名） | 要交付微信小程序的需求 | `miniprogram/` 工程、预览与真机步骤 | `miniprogram/`、`docs/FRONTEND.md` | → dev（契约缺口）、qa（验证步骤） |

**RACI 速查**（A=拍板，R=执行，C=被咨询，I=被告知）

| 事项 | pm | dev | qa | reviewer | lead |
|---|---|---|---|---|---|
| 需求与非目标 | R | C | C | I | **A** |
| 接口/数据契约 | C | R | C | C | **A** |
| 实现 | I | R | I | C | **A** |
| 独立验证结论 | I | C | R | C | **A**（复验后才算） |
| 放行/交付用户 | I | I | C | C | **A** |
| 项目文档完整性 | R | R | R | R | **A** |

| 架构与非功能需求 | C | C | I | C | **A**（architect 出方案） |
| 安全放行 | I | C | C | C | **A**（security 出结论，高危未清零不得发布） |
| 发布/回滚决策 | I | C | C | I | **A**（release 出方案） |

### 1.1 角色手册（skill）

**契约在配置，方法在手册。** `cordis.patch.yml` 里每个角色的 `duties` / `deliverables` / `acceptance` / `writeScopes`
是**任务契约**（会进看板任务与成员提示词，必须短而准）；每个角色怎么做、代码模式、检查清单、常见坑写在
`skills/<skill>/SKILL.md` 里，成员开工时用 `skill(name="...")` **按需加载**——不需要为每个成员付全量手册的 token。

| 角色 | 手册 | 手册里有什么 |
|---|---|---|
| Lead | `dev-team-lead` | 何时组队、怎么切任务划范围、怎么盯与纠偏、什么时候自己下场、四道门、汇报格式、收尾清单 |
| pm | `dev-team-pm` | 可判定需求写法、非目标、边界矩阵、验收标准、ADR 模板、与 dev 的交接 |
| dev | `dev-team-dev` | 分层写法、async 底线、SQLAlchemy 事务/分页、Alembic 三步加列、Redis 约定、pyjoist 组件与 builder 完整示例、HTMX、测试配方、交付自检 |
| qa | `dev-team-qa` | 复跑纪律、用例矩阵、用例示例、最小复现报告、TESTING.md 结构、升级判定 |
| reviewer | `dev-team-reviewer` | 九步评审顺序、阻断/建议分级、REVIEWS.md 格式、高频阻断清单、只读纪律 |
| architect | `dev-team-architect` | 模块边界与依赖方向、可验证 NFR、选型 ADR（含回滚）、expand/contract 迁移策略、契约复核 |
| security | `dev-team-security` | 信任边界、10 项威胁面逐项核对、结论必须落到 文件:行、高危清零与「不得发布」判定 |
| release | `dev-team-release` | 发布顺序与回滚触发阈值、迁移分批与不可回滚点、冒烟清单、可观测性与告警、事故复盘 |
| agent-dev | `dev-team-agent-dev` | LangChain/LangGraph 选型与图、状态与记忆分层、工具契约、提示词与模型配置（DeepSeek v4.1 Flash）、护栏与成本预算、追踪与评测回归 |
| react-dev | `dev-team-react` | 何时才用 React、Vite 工程结构、API 客户端封装、状态从简、与 HTMX 的边界、验证清单 |
| miniprogram-dev | `dev-team-miniprogram` | 小程序工程结构、分包与体积、登录态与 401、支付/订阅消息、真机验证、密钥红线 |

- 手册根目录：`cordis.patch.yml` 的 `skill-filesystem` 行 `customSkillDirs` → 本仓库 `skills/`；项目自己的
  `<项目根>/.dsh/skills` 仍然有效，项目专属 skill 照常放。
- **改手册正文不用重装**（目录被监视，下一次会话/目录刷新生效）；改 **skill 名字、手册目录或根路径**要重装 bundle。
- 新增角色 = `roles` 加一条（含 `skill`）+ 建 `skills/<skill>/SKILL.md`；`node --test test/` 会校验
  「配置里的 skill」与「磁盘上的 SKILL.md」一一对应、frontmatter 合法、提示词里带加载指令。
- 手册与配置/任务冲突时，**以任务描述与 `docs/` 契约**为准（手册每份开头都写了这一条）。

## 2. 工作流：三条车道

Lead 建队前先定**风险等级**，等级决定成员、阶段任务与门禁（完整阶段表与产物见
[OPERATING-MODEL.md](OPERATING-MODEL.md#4-阶段产物与完成判定)）：

| 车道 | 等级 | 阶段序列 | 成员 |
|---|---|---|---|
| 快车道 | T1 | `impl → unit → verify → accept` | dev + qa |
| 标准车道 | T2 | `req → contract →（testplan ∥ schema → impl → unit）→ verify → accept` | pm + dev + qa |
| 高风险车道 | T3 | 标准车道前加 `design`，后加 `review → security → release` | + architect、reviewer、security、release |
| 事故通道 | — | 先止血（回滚/关开关）→ 复盘 → 按 T3 回归 | lead 指挥，release 复盘 |

`dev_team_start` 会把这些阶段建成**带依赖的看板任务**：前置未完成的任务是 not-ready，谁在等谁一眼可见。
契约冻结（`contract` 完成）之后 dev 实现与 qa 集成用例同时开工。

## 3. 六道质量门（契约 / 测试 / 评审 / 安全 / 发布 / 验收）

- **契约门**：`API.md` / `DATA.md` 没写清 → 不允许 dev 写业务实现。
- **测试门**：`uv run pytest -q` 与 `uv run ruff check .` 必须全绿；qa 的独立报告必须带命令与输出摘要。
- **评审门**：出现以下任一情况必须点名 reviewer——涉及并发/事务/幂等、涉及鉴权或支付、出现数据迁移、改动超过 ~300 行或跨 3 个以上模块。
- **验收门**：Lead 在**最新代码**上亲自跑验收命令与关键用户路径，逐条对照 `docs/PROJECT.md` 的验收标准。

**Definition of Done**（每个任务收尾前逐条自检）

- [ ] 代码/内容已在任务写入范围内完成，没有顺手改范围外文件
- [ ] 契约文档与实现一致（`docs/API.md`、`docs/DATA.md`）
- [ ] 有测试或明确的验证步骤，且本人都跑过
- [ ] 迁移（如有）能在空库 `upgrade head`，并说明回滚方式
- [ ] 该角色负责的 md 已更新（见 [DOCS.md](DOCS.md)）
- [ ] 向 lead 的汇报含「命令 + 结果」，不是「已完成」

## 4. 任务板协议

- **一个角色一条任务**：`dev_team_start` 为每个角色建一条任务，subject 形如 `后端/全栈开发｜实现`。
- **依赖**：契约（dev）→ 实现（dev）→ 验证（qa）→ 评审（reviewer）；用任务的 `blocked_by` 表达，前置未完成的任务不可开始。
- **认领与完成**：成员先 `team_task_get` 读任务，`team_task_update` 用 `claim`（带当前 revision）认领，完工 `complete`。revision 过期会被拒绝——这是防覆盖，不是 bug。
- **写入范围**：任务上的 `writeScopes` 是提示性范围（不是锁）。范围重叠时板面会警告，此时由 lead 决定谁让路。
- **共享文件**：`pyproject.toml`、`uv.lock`、`migrations/versions/` 目录、`docs/DECISIONS.md`、`docs/WORKLOG.md` 任何改动前先给 lead 发消息。
- **成员名永久**：一个会话里每个名字只能建一次。第二次建队会被拒绝——后续派活一律用 `send_message`，不要重建。

## 5. 沟通协议（`send_message`）

消息要自足：对方看不到你和别人的对话。

| 类型 | 模板 |
|---|---|
| 交付汇报 | `[交付] 任务 <id>：状态=完成/部分完成；改动=<文件+路径>；验证=<命令> → <结果>；文档=<更新了哪些 md>；阻塞=<无/具体>` |
| 阻塞上报 | `[阻塞] 任务 <id>：卡在 <具体现象>；最小复现=<步骤>；已尝试=<a/b>；需要你决定=<选项>` |
| 请求决策 | `[决策] 背景=<为何需要定>；选项=<A/B>；各自代价=<...>；我的建议=<...>` |
| 评审结论 | `[评审] 范围=<分支/文件>；结论=通过/阻断(N)；问题=<文件:行 + 级别 + 建议>` |
| 契约变更 | `[契约] <接口/表> 需要变更：原因=<...>；新契约=<...>；影响=<谁要跟着改>` |

**必须写进文件（而不是只发消息）**：需求与范围、契约、数据模型、决策、验证结果、评审结论、进展交接。消息是催促与协调，文件才是记录。

**Lead 的汇报格式**（给用户）：`做了什么 / 怎么验证的 / 遗留与风险`，附关键文件路径；不粘贴成员原文。

## 6. 项目文档协议

见 [DOCS.md](DOCS.md)。要点：每个项目 10 个 md 文件、各有所有者、有明确更新时机；骨架由 `dev_docs_init`（或建队时的 `dev_team_start`）从 [`templates/project/`](../templates/project) 复制，**只创建缺失文件，绝不覆盖已有内容**。

## 7. 按需扩编

默认只建 `pm` / `dev` / `qa` 三人；另外两个角色配在册但 `create: false`：

| 触发条件 | 加谁 | 怎么加 | 注意 |
|---|---|---|---|
| T3（鉴权/支付/资金/个人数据/迁移/架构/发布） | `architect` / `reviewer` / `security` / `release` | T3 自动带上这四个：定边界与 NFR、独立评审、安全清零、发布与回滚 |
| 只想要独立评审（T2 的关键改动） | `reviewer` | `roles: ["reviewer"]` 会把 `review` 阶段一并带进本轮 |
| 要上线、要迁移、出过事故 | `release` | 上线前必须有回滚方案与冒烟清单，否则不许发布 |
| 系统以智能体/多智能体为核心 | `agent-dev` | 默认形态；带进 A1–A3（设计→实现→评测）与评测门、成本门 |
| 需要富客户端交互、复杂本地状态、图表联动、独立 SPA | `react-dev` | Lead 调 `dev_team_start` 时带 `roles: ["react-dev"]`（或直接对它 `spawn_teammate`） | 只在 `frontend/` 内建工程；不把 React 塞进 HTMX 页面 |
| 要交付微信小程序 | `miniprogram-dev` | 同上，`roles: ["miniprogram-dev"]` | 复用同一套 API；凭据不进仓库 |
| 两个客户端角色同时在场 | 两者 | 先建一个，稳定后再建第二个 | 它们共享 `docs/FRONTEND.md`，各自只追加自己的小节 |

**再加别的角色**（例如 DBA、运维、UI 设计）只需在 `cordis.patch.yml` 的 `roles` 里加一条：`name` / `title` / `description` / `phase` / `duties` / `deliverables` / `acceptance` / `docs` / `writeScopes` / `create`，然后 `remove_bundle` → `install_bundle`。

## 8. 会话、项目与仓库

- **一个项目 = 一个 git 仓库 = 一个项目根目录**。所有路径、看板范围、成员提示词都以项目根为基准。
- 一个会话通常只服务一个项目；换项目就新开会话（新会话才带得动新 preset 版本与干净上下文）。
- 团队成员与任务都持久化：崩溃、重启、换天后仍能恢复，离线的成员会收到排队消息。
- 所有写入都限制在项目目录内；不碰工作区里的其他项目。

## 9. 失败模式与对策

| 失败模式 | 现象 | 对策（已内置的约束） |
|---|---|---|
| 大上下文里的结论遗忘 | 换会话后不知道做到哪了 | 文档协议 + `WORKLOG.md` 交接条目 |
| 范围蔓延 | 顺手改了无关文件、加了依赖 | 硬约束：只写 writeScopes；加依赖先问 lead；发现范围外 bug 只报告 |
| 假验证 | 「测试应该没问题」 | 测试门：报告必须含命令与结果；Lead 复跑；qa 与 dev 的结论分开记录 |
| 并行覆盖写 | 两人改同一文件互相覆盖 | 分角色写入范围 + 共享文件先报备 + 板面重叠警告 + `FS_STALE_VERSION` 重试 |
| 契约漂移 | 实现与文档不一致 | 契约门：先改 `API.md`/`DATA.md` 再写实现，评审对照契约 |
| 成员跑偏或卡死 | 长时间无进展 | Lead `wait_agent` 观察 + `interrupt_agent` 止损 + `send_message` 纠偏 |
| 结论不可信 | 成员自称通过 | Lead 亲自复跑验收命令；关键路径人工走一遍 |

## 10. 已知限制

- 成员与 Lead **同模型**（`spawn_teammate` 没有 model 参数），角色差异只来自各自任务提示词。
- **没有 worktree 隔离、没有文件锁**：`writeScopes` 是约定，靠纪律与 Lead 复核兜底。
- 团队上限 8 人（`maxMembers`），任务板 256 条。
- 成员名永久保留，一个会话内不能重建同名成员。
- 工具只会**创建缺失**的项目文档，不会覆盖你已有的内容——所以文档内容质量靠人和纪律，不靠工具。
- 排队消息已经持久化，不要重发。
