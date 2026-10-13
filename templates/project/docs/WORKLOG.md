# 进展与交接 — <项目名>

> 所有者：lead ｜ **追加式**：每轮工作结束追加一条，最新的放在最上面。
> 目的：跨会话、跨成员交接靠这个文件，不靠上下文记忆。

## 条目模板

```markdown
## YYYY-MM-DD <本轮目标>

- 状态：完成 / 部分完成 / 阻塞
- 做了什么：<按文件或模块列要点>
- 怎么验证的：<命令 + 结果摘要，例如 `uv run pytest -q` → 42 passed>
- 文档更新：<更新了哪些 md>
- 下一步：<下一个人该从哪里接着干，越具体越好>
- 阻塞与风险：<需要谁决策什么>
```

---

## YYYY-MM-DD <示例：初始化项目骨架>

- 状态：完成
- 做了什么：建立 app/ 分层、joist 接入、Alembic 初始化、tests 目录
- 怎么验证的：`uv run pytest -q` → 3 passed；`uv run uvicorn app.main:app` 首页 200
- 文档更新：AGENTS.md、docs/ARCHITECTURE.md、docs/PROJECT.md
- 下一步：按 docs/API.md 实现第一个接口
- 阻塞与风险：无
