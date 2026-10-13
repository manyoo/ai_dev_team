---
name: dev-team-react
description: React 前端手册：判定该不该引入 React（对比 HTMX）、Vite + TS 工程结构、API 客户端与鉴权封装、错误码处理、与 HTMX 页面的边界、构建与验证步骤，并维护 docs/FRONTEND.md。需要富客户端交互或独立 SPA 时加载。
whenToUse: 被点名加入团队做 React SPA、或需求出现实时编辑/复杂本地状态/图表联动/拖拽时。
---

# React 前端手册（dev-team-react）

> **默认不是 React。** 这个项目的服务端 UI 是 HTMX + pyjoist；React 只在「HTMX 做不好」时才引入。
> 你在 `frontend/` 里工作，并维护 `docs/FRONTEND.md`。契约以 `docs/API.md` 为准，缺接口找 dev（不要自己动 dev 的文件）。

## 0. 先判定：真的需要 React 吗

| 需求特征 | 选型 |
|---|---|
| 列表/表单/详情页、局部刷新、服务端渲染 | **HTMX + pyjoist**（不要引入 React） |
| 实时协同编辑、复杂拖拽、图表联动、大量本地状态 | React SPA |
| 需要在同一页面混合两者 | 只在「富交互孤岛」挂 React，其余保持 HTMX；孤岛要有明确边界与容器元素 |
| 只是想「更现代」 | ❌ 不是理由 |

判定结果写进 `docs/FRONTEND.md` 与 `docs/DECISIONS.md`（由 lead 记录决策）。

## 1. 工程结构（`frontend/`）

```
frontend/
├── package.json          # pnpm；脚本 dev/build/preview/lint/test
├── vite.config.ts        # dev server 代理 /api → 后端
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx           # 路由与布局
    ├── api/              # client.ts（fetch 封装）、types.ts（与 API.md 对齐）、errors.ts
    ├── features/<域>/     # 每个业务域：组件 + hooks + 类型
    ├── components/       # 通用展示组件
    └── lib/              # 工具（格式化、日期、存储）
```

- 包管理器统一 pnpm；命令写进 `docs/FRONTEND.md`。
- TypeScript 严格模式；不要 `any` 满天飞，接口类型从 `api/types.ts` 出。
- 测试用 Vitest（组件）+ 关键交互的手工步骤（写进 FRONTEND.md）。

## 2. API 客户端封装（统一入口，禁止散落 fetch）

```ts
// src/api/client.ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",                       // 会话 Cookie 方案；Bearer 方案改为 Authorization
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? "unknown", body?.error?.message ?? res.statusText, body?.error?.detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
```

- 错误码映射集中在 `errors.ts`（例如 `409 duplicate` → 提示「请勿重复提交」），**不要在每个组件里重写业务规则**。
- 401 统一跳登录；403 提示无权限；5xx 展示可重试的错误态。
- 请求要有超时（`AbortController`）与取消（组件卸载时 abort）。

## 3. 状态与数据获取（从简）

- 组件本地状态：`useState` / `useReducer`。
- 服务端数据：优先「一个小 hook + fetch」；确需缓存/重试再引库，且必须在 `docs/DECISIONS.md` 说明理由并等 lead 确认。
- 不引全局状态库除非有明确的多页面共享状态需求（同上要走决策）。
- 表单：受控组件 + 简单校验；错误信息与后端错误码对齐，不重复实现业务规则。

## 4. 与后端 / HTMX 的边界

- React 走 JSON 接口（`/api/...`）；HTMX 走 HTML 片段。**同一个数据不要两套实现**（一个 JSON 接口 + 一个片段接口是允许的，但业务规则只能有一份，都在 service 层）。
- 需要新接口或字段改动：`send_message` 给 dev，写清用途、请求、响应、错误码；由 dev 更新 `docs/API.md` 并实现。
- 鉴权方案与后端一致（Cookie 会话或 Bearer），跨域时把 CORS 与凭据要求写进 `docs/FRONTEND.md`。
- 深链接与 SEO 敏感页面仍交服务端渲染，不要整站 SPA 化。

## 5. 验证（交付前自跑）

```bash
pnpm install
pnpm build          # 必须通过（TS 类型错误 = 失败）
pnpm test           # 有测试的话
pnpm dev            # 手工验证关键路径
```

手工验证清单（写进 `docs/FRONTEND.md`）：登录 → 主列表加载 → 分页/筛选 → 关键操作提交 → 错误态展示 → 刷新后状态正确。

## 6. 自检

- [ ] 只在 `frontend/` 与 `docs/FRONTEND.md` 里改动
- [ ] `pnpm build` 通过
- [ ] 用到的接口都在 `docs/FRONTEND.md` 列出，并与 `docs/API.md` 一致
- [ ] 错误码处理集中，不重复业务规则
- [ ] 没有把 React 塞进 HTMX 页面（或明确划出了孤岛边界）
- [ ] 关键交互有测试或明确的手工验证步骤

汇报模板：`[交付] 任务 <id>：改动=frontend/...；验证=pnpm build → 通过 + 手工路径；契约=<用到的接口>；阻塞=<无/具体>`
