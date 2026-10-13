# 团队协作设计

> 这份文件回答一个问题：**这支团队按什么规则开工、交接、验证、收尾。**
> 机器可读的那份在 [`cordis.patch.yml`](../cordis.patch.yml) 的 `dev-team` 行——角色、技术栈、命令、工作流、硬约束、项目文档清单都在那里。两者要保持一致：改配置时同步改本文，改本文时同步改配置。

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
| `reviewer` 代码评审 | 否（点名） | 提交/分支 + 契约 | 按 文件:行 的阻断/建议清单 | `docs/REVIEWS.md` | → lead（是否放行） |
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
| react-dev | `dev-team-react` | 何时才用 React、Vite 工程结构、API 客户端封装、状态从简、与 HTMX 的边界、验证清单 |
| miniprogram-dev | `dev-team-miniprogram` | 小程序工程结构、分包与体积、登录态与 401、支付/订阅消息、真机验证、密钥红线 |

- 手册根目录：`cordis.patch.yml` 的 `skill-filesystem` 行 `customSkillDirs` → 本仓库 `skills/`；项目自己的
  `<项目根>/.dsh/skills` 仍然有效，项目专属 skill 照常放。
- **改手册正文不用重装**（目录被监视，下一次会话/目录刷新生效）；改 **skill 名字、手册目录或根路径**要重装 bundle。
- 新增角色 = `roles` 加一条（含 `skill`）+ 建 `skills/<skill>/SKILL.md`；`node --test test/` 会校验
  「配置里的 skill」与「磁盘上的 SKILL.md」一一对应、frontmatter 合法、提示词里带加载指令。
- 手册与配置/任务冲突时，**以任务描述与 `docs/` 契约**为准（手册每份开头都写了这一条）。

## 2. 工作流：八个阶段与交接物

每个阶段的「完成」都由文件或命令证明，不靠口头。

| # | 阶段 | 谁做 | 输入 | 产出（落盘在哪） | 完成判定 |
|---|---|---|---|---|---|
| 1 | 立项 | lead + pm | 用户目标 | `docs/PROJECT.md`（含非目标）、文档骨架齐备 | 非目标已写；`docs/` 文件齐全 |
| 2 | 契约 | dev，pm 确认 | 需求条目 | `docs/API.md`、`docs/DATA.md` | 每个接口有请求/响应/错误码；每张表有字段与索引 |
| 3 | 拆分 | lead | 契约 | 看板任务 + 写入范围 + 依赖关系 | 范围互不重叠；依赖顺序正确；每任务有验收标准 |
| 4 | 实现 | dev | 契约 + 任务 | 代码、迁移、`tests/unit/` | `pytest`/`ruff` 通过；契约文档已更新 |
| 5 | 验证 | qa | 实现 + 验收标准 | `tests/integration/`、`docs/TESTING.md` | 报告含命令与结果；失败项有最小复现 |
| 6 | 评审 | reviewer（按需） | 提交 + 契约 | `docs/REVIEWS.md` | 每条结论可定位到 文件:行 |
| 7 | 验收 | lead | 全部产出 | 验收记录写进 `docs/WORKLOG.md` | Lead 亲自跑通验收命令与关键路径 |
| 8 | 收尾 | lead | — | `docs/WORKLOG.md`、`docs/DECISIONS.md` | 用户拿到「做了什么/怎么验证/遗留与风险」 |

## 3. 四道质量门

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
