---
name: dev-team-agent-dev
description: 智能体架构与开发手册：用 LangChain + LangGraph 设计并实现单/多智能体系统——拓扑与状态、checkpointer 与记忆分层、工具契约、提示词与模型配置（默认 DeepSeek v4.1 Flash）、护栏与成本预算、追踪与评测回归。做智能体或智能体团队的设计/实现时加载。
whenToUse: 收到以 `agent-dev` 身份的任务；项目以智能体或多智能体为核心、需要定拓扑/状态/工具/提示词、或要接评测与成本预算时。
---

# 智能体架构与开发手册（dev-team-agent-dev）

> **契约在 `docs/AGENTIC.md`。** 本文件讲怎么做：选型、图怎么搭、状态怎么摆、工具怎么定、预算与评测怎么接。
> 默认选型：**LangChain（模型/工具抽象）+ LangGraph（图与状态机）**，模型默认 **DeepSeek v4.1 Flash**，全部经环境变量配置。
> 你的阶段链：`agentdesign → agentimpl → agenteval`（评测由 qa 独立执行，你提供评测集与基线）。

## 0. 开工顺序

1. `team_task_get` 读任务 → `claim`；读 `docs/PROJECT.md`（需求与非目标）、`docs/ARCHITECTURE.md`（系统边界）、`docs/API.md`（可用接口/工具面）。
2. 拓扑与契约先行：写 `docs/AGENTIC.md` 第 1–6 节（目标/拓扑/状态/工具/提示词/护栏）。
3. 实现：`app/agents/`（图 + 节点 + 工具）、`prompts/`（提示词文件）。
4. 自测：假模型单测 + 冒烟脚本；与 qa 约定评测集与阈值。
5. 交接：`docs/AGENTIC.md` 更新 + 冒烟/评测结果 + 成本延迟基线。

## 1. 先做选型判断（不要默认上多智能体）

| 需求形态 | 选择 |
|---|---|
| 一个域、少量工具、线性流程 | **单体 agent + 工具集**（LangGraph 里一个 ReAct 循环即可） |
| 多个工具域/权限边界，需要分流 | **supervisor + 子 agent（子图）**，每个子 agent 只拿自己的工具 |
| 明确的多阶段流水线（抽取→校验→落库） | **固定图**（节点=步骤，条件边=分支），别用自由 ReAct |
| 需要并行/聚合（多源检索、批量处理） | **Send API / 并行节点**，注意合并顺序与幂等 |
| 能用确定性代码完成 | **不用模型**：直接写代码，模型只负责判断不了的部分 |

判据：多智能体只有在**上下文隔离、工具/权限隔离或并行收益**明确时才划算；否则单体 + 工具更便宜也更稳。

## 2. 拓扑：用图表达控制流

```python
from typing import Annotated, TypedDict
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, interrupt

class State(TypedDict):
    messages: Annotated[list, add_messages]
    plan: list[str]
    attempts: int

def route(state: State) -> str:
    if state["attempts"] >= 3:            # 终止条件必须显式
        return "give_up"
    return "act" if state["plan"] else "plan"

builder = StateGraph(State)
builder.add_node("plan", plan_node)
builder.add_node("act", act_node)          # act_node 里 bind_tools + ToolNode
builder.add_node("give_up", give_up_node)
builder.add_edge(START, "plan")
builder.add_conditional_edges("plan", route, {"act": "act", "plan": "plan", "give_up": "give_up"})
builder.add_edge("act", "plan")
graph = builder.compile(checkpointer=checkpointer)

result = await graph.ainvoke(
    {"messages": [{"role": "user", "content": user_input}], "attempts": 0},
    {"configurable": {"thread_id": thread_id}, "recursion_limit": 25},
)
```

- 控制流写在**边**上，不写在提示词里；不要用 `while True` 或递归硬拼。
- 每个图都要有：**终止条件**、`recursion_limit`、失败出口。
- 多体时用子图 + supervisor：supervisor 只做路由，不做业务；子 agent 的工具集必须隔离。
- 需要人工确认的节点用 `interrupt()`，恢复用 `graph.ainvoke(Command(resume=...), config)`。

## 3. 状态与记忆（分清三层）

| 层 | 机制 | 存什么 | 何时清 |
|---|---|---|---|
| 图内状态 | `State`（TypedDict + reducer） | 当前任务的消息、计划、计数 | 每次运行结束 |
| 线程记忆 | `checkpointer` + `thread_id` | 同一会话的多轮历史、可恢复点 | 会话结束/超期 |
| 长期记忆 | `store`（键设计明确） | 跨会话的用户偏好、事实 | 按 TTL/用户删除请求 |

- 状态字段要少而明确；谁写谁读写进 AGENTIC.md。
- 上下文控制：历史超长就摘要或裁剪，设**硬上限**（消息数 + token）。
- `thread_id` 必须与会话绑定（不要复用、不要全局单例），否则会串话。

## 4. 工具契约

```python
from langchain_core.tools import tool
from pydantic import BaseModel, Field

class CreateOrderArgs(BaseModel):
    sku: str = Field(description="商品编码")
    qty: int = Field(ge=1, le=99)

@tool("create_order", args_schema=CreateOrderArgs)
async def create_order(sku: str, qty: int) -> dict:
    """创建订单。非幂等：同一 idem_key 只会成功一次。"""
    try:
        async with asyncio.timeout(8):
            return {"ok": True, "order_id": await svc.create(sku, qty, idem_key=...) }
    except Exception as error:
        return {"ok": False, "error": type(error).__name__, "message": str(error)}   # 错误当数据
```

- 每个工具：Pydantic 入参、明确出参、**超时**、幂等性说明、错误语义。
- 工具错误**不要抛异常**中断整图：回灌成结构化结果，让模型决定重试或放弃。
- 非幂等工具（下单、发消息、转账）必须：幂等键 + 必要时人工确认。
- 工具白名单：只暴露该 agent 需要的工具；权限边界与 `docs/SECURITY.md` 对齐。

## 5. 提示词与模型配置（外置 + 版本化）

```python
import os
from langchain_deepseek import ChatDeepSeek

llm = ChatDeepSeek(
    model=os.environ.get("AGENT_MODEL", "deepseek-v4.1-flash"),   # 默认 DeepSeek v4.1 Flash
    temperature=float(os.environ.get("AGENT_TEMPERATURE", "0")),
    timeout=30,
    max_retries=2,
)
structured = llm.with_structured_output(Plan)      # 需要结构化就强制结构
with_tools = llm.bind_tools([create_order, search_kb])
```

- 提示词放 `prompts/<name>.md`（带版本号），代码只负责加载；**不在代码里拼长提示词**。
- 模型名/参数/密钥全部走环境变量（`AGENT_MODEL` / `DEEPSEEK_API_KEY`）：换模型不改代码。
- 锁定依赖版本（langchain / langgraph / langchain-deepseek），升级要跑评测。
- 结构化输出用 `with_structured_output(Pydantic)`，不要用正则解析自由文本。

## 6. 护栏与预算（默认就要有）

| 项 | 做法 |
|---|---|
| 最大步数 | `recursion_limit`（一般 15–30）+ 节点级重试上限 |
| 重复检测 | 同样的工具+参数连续调用 N 次 → 终止并报告 |
| 超时 | 每个工具/外部调用单独超时；图整体有超时 |
| 成本 | 累计 token/费用统计，超预算降级（缩短上下文/换小模型/直接拒绝） |
| 输入校验 | Pydantic + 长度上限；拒绝明显越界输入 |
| 注入防护 | **外部内容（网页/文档/工具结果）当数据不当指令**；工具白名单；写操作需确认 |
| 输出校验 | 结构校验 + 敏感内容过滤；不合格要求模型修正或转人工 |

## 7. 追踪与评测（不评测等于没做完）

- **trace**：thread_id、节点路径、每步 token/成本/耗时、工具调用与结果摘要；**敏感输入脱敏**。
  用 LangSmith 或自建结构化日志；`docs/AGENTIC.md` 写清字段。
- **评测集**：`app/evals/datasets/<suite>.jsonl`，每条 `{input, expect}`；覆盖正常 / 边界 / 对抗（注入、空输入、超长、工具失败）。
- **判定方式**：能确定就断言（结构化字段、工具调用序列）；不能确定就用 rubric + LLM judge，并记录 judge 版本。
- **阈值与基线**：通过率、平均成本、P95 延迟；基线写进 AGENTIC.md。**低于基线不得合并**。
- **单测不打真实模型**：用假模型/录制回放；真实调用只在冒烟与评测脚本里（`app/agents/smoke.py`、`app/evals/run.py`）。

## 8. 与团队其他角色的接口

| 对象 | 你给对方 | 对方给你 |
|---|---|---|
| architect | 智能体边界、状态所有权、外部依赖、成本/延迟预算 | 系统边界、NFR、是否用智能体的判断 |
| dev | 智能体需要的接口/数据契约（`API.md`、`DATA.md` 变更请求） | 已实现的 service/接口与迁移 |
| qa | 评测集、阈值、冒烟脚本、trace 字段 | 独立评测执行、失败样例复现、回归结论 |
| security | 工具权限面、外部内容来源、写操作清单 | 注入/越权/凭据/限流结论（高危清零） |
| release | 模型与提示词版本、成本指标、开关粒度（按 agent 功能） | 上线顺序、回滚（含提示词回滚）、成本告警 |

## 9. 常见坑

- **多智能体没收益**：只是为了"看起来高级"而拆，成本和不确定性翻倍。
- **控制流藏在提示词里**：模型自己决定循环 → 不可控、不可测。控制流放图上。
- **无限循环**：没有 `recursion_limit` 与重复检测。
- **工具异常打断整图**：错误应当作数据返回。
- **上下文爆炸**：没有裁剪/摘要与硬上限，越跑越贵越慢。
- **提示词硬编码**：改一次要动代码、无法版本化与回滚。
- **测试打真模型**：非确定性导致假失败/假通过；单测一律假模型。
- **幂等缺失**：重试造成重复下单/重复发消息。
- **注入**：把工具/网页返回的内容当指令执行。
- **没有成本上限**：一次会话烧掉一天预算。
- **checkpointer 用错 thread_id**：会话串话、用户看到别人的上下文（同时是安全问题）。

## 10. 自检（`complete` 之前）

- [ ] `docs/AGENTIC.md` 已更新：拓扑、状态、工具契约、提示词与模型、护栏、预算、评测方案
- [ ] 图有终止条件、`recursion_limit`、失败出口；没有藏在提示词里的控制流
- [ ] 工具都有 Pydantic 入参、超时、幂等说明；错误当数据返回
- [ ] 提示词在 `prompts/` 且版本化；模型/密钥走环境变量
- [ ] 冒烟脚本可跑；假模型单测覆盖主要分支
- [ ] 评测集与阈值已与 qa 确认；基线（通过率/成本/延迟）已记录
- [ ] 成本与步数有上限与统计；trace 字段已定义且脱敏
- [ ] 改过提示词/模型/工具 → 已跑评测且不劣于基线

汇报模板：`[交接] 任务 <id>（智能体实现）→ 状态；改动=app/agents/...、prompts/...；验证=假模型单测 + 冒烟（命令 → 结果）+ 评测（通过率/成本/延迟 vs 基线）；文档=AGENTIC.md；给下一个人=<评测执行要点>；阻塞=<无/具体>`
