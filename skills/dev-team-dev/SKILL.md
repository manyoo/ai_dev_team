---
name: dev-team-dev
description: 后端/全栈开发手册：Python 3.13 + FastAPI + asyncio + SQLAlchemy 2.x(async) + Alembic + Redis + HTMX/pyjoist 的落地动作——契约怎么写、async 与事务怎么摆、迁移怎么做、pyjoist 组件与 builder 怎么写、HTMX 片段怎么返回、测试怎么配。接到实现类任务、要动 app/ 或 templates/ 时加载。
whenToUse: 收到以 `dev` 身份的实现任务、需要写接口/迁移/组件/测试时。
---

# 后端/全栈开发手册（dev-team-dev）

> **契约在你任务里、`docs/API.md`、`docs/DATA.md`。** 本文件只讲动作：每一层怎么写、怎么验。
> 冲突时以任务描述与 `docs/` 契约为准；契约要改，先改文档再改代码。

## 0. 本轮等级与门禁

任务描述里会写「本轮风险等级：T<id>；本轮门禁：…」。对你的影响：

- **T1**：没有契约阶段，改动限于单模块、不改接口与表结构；发现自己要动表结构或公共响应 → 立即 `send_message` 建议升级为 T2/T3。
- **T2**：`contract` 阶段先冻结 `API.md`/`DATA.md`；此后改契约要走变更（发 `[契约]` 消息给 lead，等确认再改），并重跑验证。
- **T3**：多出 `design`（architect 定的边界与 NFR 是你的实现基准）、`review`/`security`/`release` 门；发布相关必须留下回滚方案。
- 交付的**证据等级**：普通改动 L2（命令 + 结果摘要），迁移/鉴权等高风险用 L3（原始输出 + 复现步骤）。改动后旧证据作废，必须重跑。

## 0. 开工顺序（不要跳）

1. `team_task_get` 读任务 → `team_task_update` `claim` 认领。
2. 读 `docs/API.md`、`docs/DATA.md`（契约）、`AGENTS.md`（项目约束）、`docs/ARCHITECTURE.md`（分层）。
3. 确认写入范围：只动自己 `writeScopes` 里的文件。
4. 顺序：**迁移 → models → service（事务/业务）→ router（HTTP）→ components+builders → templates → 测试**。
5. 跑 `uv run pytest -q` 与 `uv run ruff check .`，更新文档，再 `complete` 并向 lead 汇报。

## 1. 分层与依赖方向

```
routers/     HTTP：解析、鉴权、调 service、build + 渲染。不写 SQL、不带业务规则
services/    业务规则 + 事务边界（async）。不碰 HTTP/模板
models/      SQLAlchemy 模型（表结构）
components/  pyjoist 组件：纯数据契约 + template_path
builders/    组件组合（build_* 函数）。不查库、不碰 HTTP
templates/   Jinja2：只插值与循环
```

依赖只能自上而下。**router 里出现 `select(`、模板里出现业务判断，都算违规。**

## 2. async 底线

- 请求路径里禁止同步阻塞：`requests`、`time.sleep`、同步 `Session`、大文件同步读写、`subprocess.run` 长任务。
- 必须阻塞时：`await asyncio.to_thread(fn, ...)`；必须限时：`async with asyncio.timeout(3):`。
- 外部调用（HTTP/Redis/PG）都要考虑超时与重试；重试只对幂等操作。
- 长任务别卡请求：交给后台任务或队列，接口立刻返回状态。

## 3. 数据库（SQLAlchemy 2.x async）

```python
# app/db.py
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False)

# app/deps.py
async def get_session():
    async with Session() as session:
        yield session
```

```python
# app/services/orders.py —— 查询与事务
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

async def list_orders(session, user_id: int, status: str | None, page: int, size: int = 20):
    stmt = select(Order).where(Order.user_id == user_id)
    if status:
        stmt = stmt.where(Order.status == status)
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await session.scalars(
        stmt.options(selectinload(Order.items))          # 防 N+1
            .order_by(Order.created_at.desc())
            .offset((page - 1) * size).limit(size)
    )).all()
    return rows, total or 0

async def create_order(session, user_id: int, payload) -> Order:
    async with session.begin():                          # 事务边界在 service
        order = Order(user_id=user_id, status="pending")
        session.add(order)
        await session.flush()                             # 拿到 id
        session.add_all([OrderItem(order_id=order.id, **i) for i in payload.items])
    return order
```

- 列表接口**必须分页**，`count` 用同一条件；禁止全表 `select(Model)` 后 Python 过滤。
- 唯一约束兜底并发：捕获 `IntegrityError` 转成业务错误（409），不要靠「先查再插」。
- 需要串行更新的行用 `with_for_update()`；或用版本列做乐观锁。
- 事务里不要做外部 IO（发消息、调第三方）；要么放到提交后，要么用 outbox。

## 4. Alembic 迁移

```bash
uv run alembic revision --autogenerate -m "add captcha fields"   # 生成后必须人工审
uv run alembic upgrade head
```

- autogenerate 只当草稿：检查字段类型、默认值、索引名、`server_default`。
- **给已有数据的表加非空列**：三步——加可空列 → 数据回填（`op.execute`）→ 改非空。
- 迁移要能在**空库**从零 `upgrade head`；写清 `downgrade` 或明确「不可回滚」及理由。
- 迁移文件与 `docs/DATA.md` 的迁移历史表同步更新。

## 5. Redis

```python
from redis.asyncio import Redis
r = Redis.from_url(settings.redis_url, decode_responses=True)

await r.set(f"app:captcha:{sid}", code, ex=300)               # 缓存：必带 TTL
ok = await r.set(f"app:idem:{key}", "1", nx=True, ex=60)      # 幂等/防重复提交
```

- key 统一前缀（`app:<domain>:<id>`），每个 key 必须有 TTL；key 与 TTL 写进 `docs/DATA.md`。
- 缓存失效：写库后**失效**（简单可靠）优先于更新缓存；缓存穿透用空值短 TTL。
- Redis 不是唯一数据源：丢了不能导致业务错误。

## 6. pyjoist 组件化（重点）

三层分工：**组件 = 数据契约；builder = 组合；模板 = 纯 markup。路由只做 load → build → render。**

```python
# app/components/order_table.py
from dataclasses import dataclass, field
from typing import ClassVar
from joist import Component, Fragment, Page

@dataclass(kw_only=True)
class OrderRow(Component):
    template_path: ClassVar = "orders/_row.html"
    order_id: int = 0
    status: str = ""
    amount: str = ""

    def get_props(self):
        return {"status_label": {"pending": "待付", "paid": "已付"}.get(self.status, self.status)}

@dataclass(kw_only=True)
class OrderTable(Component):
    template_path: ClassVar = "orders/table.html"
    rows: list = field(default_factory=list)
    page: int = 1

    @property
    def has_any(self) -> bool:          # 空态由组件自己声明
        return bool(self.rows)
```

```python
# app/builders/orders.py —— 组合只在这里发生
from joist import Page
from app.components.order_table import OrderRow, OrderTable

def build_order_table(orders, page: int) -> OrderTable:
    return OrderTable(page=page, rows=[OrderRow(order_id=o.id, status=o.status, amount=f"{o.amount:.2f}") for o in orders])

def build_orders_page(orders, page: int) -> Page:
    return Page(page_title="订单", content=build_order_table(orders, page))
```

```python
# app/routers/orders.py —— 路由只有三件事
from fastapi import APIRouter, Depends, Request
from app.builders.orders import build_order_table
from app.services.orders import list_orders

router = APIRouter()

@router.get("/orders")
async def orders_page(request: Request, page: int = 1, session=Depends(get_session)):
    orders, _ = await list_orders(session, user_id=1, status=None, page=page)
    table = build_order_table(orders, page)
    return joist.fragment_or_page(request, "订单", table)     # HTMX → 片段；直接访问 → 整页
```

模板（`templates/orders/_row.html`）：

```html
<tr id="order-{{ order_id }}">
  <td>{{ order_id }}</td>
  <td>{{ status_label }}</td>
  <td>{{ amount }}</td>
</tr>
```

约定与坑：

- 一个 UI 片段**只有一个组件 + 一个模板**；整页与 HTMX 片段走同一条渲染路径，禁止两套 markup（否则必然漂移）。
- `template_path` 放 `ClassVar`（`Component`）；一次性内联片段用 `Fragment(template_path="orders/_row.html", ...)`（实例字段）。
- 计算、格式化、映射（状态→文案）放 `get_props()` 或 builder；**模板里不写逻辑**。
- 子组件直接 `{{ child }}`（已是 `Markup`），不要加 `|safe`。
- 空态用 `has_any` 或 builder 里换成空态组件，不要让模板写 `{% if %}` 长逻辑。
- 需要局部替换时用 HTMX 目标属性 + `id`；同一个 `id` 在一页里只能出现一次。
- 接入：`joist = setup_fastapi(app, template_dirs=["templates"])`。

## 7. HTMX

- 局部刷新：`hx-get` / `hx-post` + `hx-target` / `hx-swap`；表单默认 `hx-post` 后替换目标元素。
- 服务端判断走 `fragment_or_page`（内部用 `is_hx_request`），不要自己 `if request.headers.get("HX-Request")` 拼接两套返回。
- 事件与跳转用 `joist.htmx.HX`：`HX.trigger("order:created")`、`HX.trigger("toast", {"msg": "ok"})`、`HX.retarget("#list")`、`HX.redirect("/orders")`、`HX.push_url("/orders?page=2")`。**不要手写 `HX-` 头字符串。**
- 写操作必须防 CSRF（token 放进表单或 `hx-headers`），并考虑重复提交（幂等键或 `HX-Trigger` 后禁用按钮）。
- 错误也要返回可渲染片段（错误提示组件），不要只返回纯文本 500。

## 8. 测试

```python
# tests/unit/test_order_table.py —— 组件渲染断言
from app.builders.orders import build_order_table
from app.components.order_table import OrderRow

def test_row_status_label():
    table = build_order_table([], 1)
    assert "暂无订单" in build_order_table([], 1).render()  # 空态
    assert "待付" in OrderRow(order_id=1, status="pending", amount="1.00").render()


# tests/integration/test_orders_route.py —— 两条分支都要测
import pytest
from httpx import ASGITransport, AsyncClient

@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

async def test_orders_htmx_returns_fragment(client):
    r = await client.get("/orders", headers={"HX-Request": "true"})
    assert r.status_code == 200 and "<!DOCTYPE" not in r.text

async def test_orders_direct_returns_page(client):
    r = await client.get("/orders")
    assert "<!DOCTYPE" in r.text
```

- 数据库用事务回滚的 fixture（每个用例独立），不要依赖执行顺序。
- 新接口至少覆盖：成功、参数非法、权限不足、空态。
- 组件至少断言关键结构与文案；状态映射这类逻辑要单独测。

## 9. 交付自检（发消息给 lead 之前）

```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
uv run alembic upgrade head          # 空库也要能过
```

- [ ] 只动了自己范围里的文件；共享文件改动前已报备
- [ ] `docs/API.md`、`docs/DATA.md`、`docs/ARCHITECTURE.md` 与实现一致
- [ ] async 路径里没有阻塞调用；列表接口有分页
- [ ] 迁移能在空库执行；迁移历史写进 `docs/DATA.md`
- [ ] 新组件/片段有渲染测试；HTMX 与整页两条分支都有用例

汇报模板：`[交付] 任务 <id>：状态；改动=<文件+路径>；验证=<命令> → <结果>；文档=<更新了哪些 md>；阻塞=<无/具体>`
