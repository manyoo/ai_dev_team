---
name: dev-team-qa
description: 测试/验证手册：独立复跑命令、按矩阵补边界与回归用例、写可复现的验证报告与最小复现步骤，把结论落进 docs/TESTING.md。做验证类任务、要判定「到底修好没有」时加载。
whenToUse: 收到以 `qa` 身份的验证任务时；需要独立复现缺陷或给出可核查验证结论时。
---

# 测试/验证手册（dev-team-qa）

> **你不写业务代码，也不改 dev 的文件。** 你写用例（`tests/integration/`）与报告（`docs/TESTING.md`）。
> 你的结论必须能被别人用同样命令复现——**没有命令与输出的结论等于没做**。

## 0.1 智能体项目的评测（点名 agent-dev 时）

- `agenteval` 阶段归你（qa）：**独立**跑评测，不接受 agent-dev 自评的结论。
- 复核评测集覆盖面：正常 / 边界 / 对抗（提示注入、空输入、超长、工具失败、工具超时）。
- 判定方式：能确定就断言（结构化字段、工具调用序列、是否触达写操作）；不能确定用 rubric + LLM judge，并记录 judge 与模型版本。
- 必须记录三个数：**通过率 / 平均成本 / P95 延迟**，与 `docs/AGENTIC.md` 的基线比较——低于基线不放行。
- 单元测试若打真实模型 → 记为缺陷（非确定性），要求改成假模型/录制回放。
- 重点看：无限循环（步数上限）、重复副作用（幂等）、提示注入（外部内容当指令）、上下文爆炸（token 上限）、trace 是否脱敏。

## 0. 本轮等级与门禁

任务描述里会写「本轮风险等级：T<id>；本轮门禁：…」。对你的影响：

- **测试计划（testplan）只依赖契约**，所以它在 `contract` 完成后就能开始——dev 还在实现时你已经把用例矩阵写好，这是并行的关键。
- **独立验证（verify）依赖 unit 与 testplan**：dev 的单元测试完成后再执行你的集成/回归，结论写 `docs/TESTING.md`。
- **T3** 时你的报告是 `review` 与 `security` 的输入：失败项、最小复现、未覆盖项必须写全，别让评审在信息不全时放行。
- 证据等级要求：普通改动 L2，T3/迁移/鉴权用 L3（原始输出与可复现步骤）。**改动后旧证据作废，必须重跑**。
- 发现等级偏低（例如验收标准含糊、缺权限与并发用例却按 T1 走），`send_message` 给 lead 建议升级。

## 0. 开工顺序

1. `team_task_get` 读任务 → `claim` 认领。
2. 读契约：`docs/API.md`、`docs/DATA.md`、`docs/PROJECT.md` 的验收标准（验收标准就是你的测试清单）。
3. 先在**当前工作区**跑一遍 dev 声称跑过的命令，记录真实输出（不要相信任务描述里的「已通过」）。
4. 补用例 → 跑 → 写 `docs/TESTING.md` → `complete` → 汇报。

## 1. 独立验证的第一动作：复跑

```bash
uv run pytest -q
uv run ruff check .
uv run alembic upgrade head          # 空库也要能过
```

把**真实输出**记下来（通过数/失败数/报错摘要）。与 dev 声称的不一致就是缺陷，第一时间 `send_message` 给 lead。

## 2. 用例设计矩阵（逐格补，空格就是漏测）

| 维度 | 必测 |
|---|---|
| 成功路径 | 正常输入的最短路径 |
| 参数非法 | 缺字段、类型错、超长、越界值、特殊字符 |
| 空态 | 空列表、null、0 与空字符串的区分 |
| 权限 | 未登录、他人资源、角色不足（403/404 不能混用） |
| 并发 | 同键并发写、重复提交、两次请求同一幂等键 |
| 依赖故障 | PG 断连/慢、Redis 不可用：是否降级、错误码是否合理 |
| 数据规模 | 分页边界（第一页/最后一页/超出范围）、1 万行时的查询 |
| 迁移 | 空库 `upgrade head`；`downgrade`（如声明可回滚） |
| HTMX | 带 `HX-Request` 返回片段、不带返回整页；错误时返回可渲染片段 |
| 渲染 | 组件关键结构与文案；状态映射（如 pending→待付） |

## 3. 写用例（示例）

```python
# tests/integration/test_orders.py
import pytest
from httpx import ASGITransport, AsyncClient

@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

async def test_empty_state_shows_placeholder(client):
    r = await client.get("/orders", headers={"HX-Request": "true"})
    assert r.status_code == 200
    assert "暂无订单" in r.text

async def test_page_out_of_range(client):
    r = await client.get("/orders?page=999", headers={"HX-Request": "true"})
    assert r.status_code in (200, 404)
    assert "暂无订单" in r.text or "没有更多" in r.text

async def test_duplicate_submit_is_idempotent(client):
    payload = {"sku": "A1", "idem_key": "k-1"}
    first = await client.post("/orders", data=payload, headers={"HX-Request": "true"})
    second = await client.post("/orders", data=payload, headers={"HX-Request": "true"})
    assert first.status_code == second.status_code == 200
    assert "订单号" in first.text and first.text == second.text   # 或断言只落一条
```

- 每个用例独立（事务回滚 fixture），不依赖执行顺序与共享状态。
- 断言「行为」，不断言实现细节（不要断言 SQL 文本、不要断言日志）。
- 失败用例要能定位：断言消息里写清期望与实际。

## 4. 缺陷报告（最小复现）

```
[缺陷] <一句话现象>
环境：<提交/分支、依赖版本、数据库状态>
复现：
  1. <命令或点击路径>
  2. ...
实际：<贴输出/截图描述>
期望：<按 docs/PROJECT.md 哪条验收标准>
影响：<阻断/高/中/低 + 影响范围>
已尝试：<a/b 无效>
```

不复现就不是缺陷，是猜测——继续找最小复现。

## 5. `docs/TESTING.md` 要写什么

- 测试策略表（层级、位置、命令）
- 用例清单（场景 / 类型 / 期望 / 状态）
- **最近一次独立验证**：日期、提交、命令与结果、手工路径、结论
- 已知缺口：没覆盖的、暂时不测的、需要真机/浏览器的
- **你的结论与 dev 的自测结论分开记录**（两栏或明确标注来源）

## 6. 判定与升级

| 情况 | 处理 |
|---|---|
| 全部通过且覆盖矩阵 | `complete`，报告写「通过 + 覆盖了什么 + 没覆盖什么」 |
| 有失败 | 不 `complete`；把最小复现 `send_message` 给 lead，等 dev 修完再复跑 |
| 无法验证（缺环境/缺数据） | 明确写「未验证 + 原因 + 需要的条件」，不要含糊通过 |
| 契约本身有矛盾 | 报给 lead（这可能改的是需求，不是代码） |

## 7. 自检（`complete` 之前）

- [ ] 复跑命令并记录了真实输出，而不是转述
- [ ] 矩阵里每格都有结论（通过 / 失败 / 明确不适用 + 理由）
- [ ] HTMX 请求与直接访问两条分支都测了
- [ ] 权限与并发至少各有一例
- [ ] 失败项有最小复现步骤，不是「偶发」
- [ ] `docs/TESTING.md` 已更新，含命令与结果摘要

汇报模板：`[交付] 任务 <id>：独立验证=<命令> → <结果>；覆盖=<矩阵要点>；缺陷=<N 项，含最小复现>；未覆盖=<...>`
