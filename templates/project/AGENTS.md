# AGENTS.md — <项目名> 的 Agent 常驻约束

> 所有者：lead ｜ 最近更新：YYYY-MM-DD
> 这个文件在每次会话开始被自动读取。只写「不知道就会做错」的稳定约束，进展写 docs/WORKLOG.md。

## 技术栈

- Python 3.13 + FastAPI + asyncio（全链路 async，请求路径里禁止同步阻塞调用）
- PostgreSQL + SQLAlchemy 2.x(async) + Alembic（schema 改动一律走迁移）
- Redis（只做缓存/限流/队列，key 带统一前缀与 TTL）
- HTMX + **pyjoist**（`import joist`，PyPI 名 `pyjoist`）做服务端组件化
- 需要富客户端交互时才用 React（`frontend/`）；需要小程序时才用 `miniprogram/`

## 命令

```bash
uv sync
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

## 目录

- `app/` 应用代码（`routers/` `services/` `models/` `components/` `builders/`）
- `templates/` Jinja2 模板（组件模板 + 整页模板）
- `migrations/` Alembic 迁移
- `tests/unit/` dev 的单元测试；`tests/integration/` qa 的集成与回归测试
- `frontend/` React SPA（按需）；`miniprogram/` 微信小程序（按需）
- `docs/` 项目文档（见下方协议）

## pyjoist 组件规范

- 组件 = `@dataclass(kw_only=True)` 的 `Component` 子类 + `template_path: ClassVar`；计算放 `get_props()`
- 组合 = builder 函数（`build_*`）组装组件树
- 路由只做 load → build → `joist.fragment_or_page(request, title, page)`
- 局部片段用 `Fragment(template_path=..., **props)`；响应头用 `joist.htmx.HX`
- 一个片段只有一个组件 + 一个模板，整页与片段共用同一条渲染路径
- 模板只做插值与循环，子组件直接 `{{ child }}`（不加 `|safe`）
- 接入：`joist = setup_fastapi(app, template_dirs=["templates"])`

## 文档协议（重要信息必须落 md，对话里的结论不算记录）

| 文件 | 所有者 | 什么时候更新 |
|---|---|---|
| `docs/PROJECT.md` | pm | 需求、范围、非目标、验收标准变化时 |
| `docs/ARCHITECTURE.md` | dev | 模块边界、目录、依赖、运行方式变化时 |
| `docs/API.md` | dev | 任何接口/错误码/片段约定变化时（先改这里再写实现） |
| `docs/DATA.md` | dev | 表结构、索引、迁移、Redis key 变化时 |
| `docs/DECISIONS.md` | lead | 每做一次技术或产品决策（追加） |
| `docs/WORKLOG.md` | lead | 每轮工作结束（追加：做了什么/怎么验的/下一步） |
| `docs/TESTING.md` | qa | 每次独立验证后 |
| `docs/REVIEWS.md` | reviewer | 每次评审（追加，按 文件:行 记录） |
| `docs/FRONTEND.md` | react-dev / miniprogram-dev | 客户端工程或对接方式变化时 |

## 红线

- 不擅自加依赖；不动自己任务范围外的文件；不手改数据库
- 密钥、令牌、连接串不进仓库（只写环境变量说明）
- 交付必须带命令与结果，不接受只写「已完成」
