# 前端客户端 — <项目名>

> 所有者：react-dev / miniprogram-dev（按需）｜ 最近更新：YYYY-MM-DD
> 只有引入 React SPA 或微信小程序时才需要维护本文件。服务端 HTMX 部分的说明放 ARCHITECTURE.md。

## 1. 何时引入客户端工程

- React：需要富客户端交互（实时编辑、复杂本地状态、图表联动、拖拽），或要交付独立 SPA
- 小程序：要交付微信小程序形态的产品入口
- 两者都不需要时，本文件保持空白即可——默认走 HTMX

## 2. React SPA（frontend/）

- 包管理器与命令：`pnpm install` / `pnpm dev` / `pnpm build`
- 目录结构：
- 路由与页面：
- 状态管理（保持从简；引库必须在 DECISIONS.md 说明）：
- 接口调用与鉴权（token 放哪、刷新策略）：
- 与后端契约：见 `docs/API.md` 的「前端使用清单」
- 验证步骤（构建 + 关键路径）：

## 3. 微信小程序（miniprogram/）

- 开发者工具导入路径与 AppID 来源：
- 目录结构（pages/ components/ utils/）：
- 分包与包体积策略：
- 登录（code2session）与鉴权流程：
- 支付/订阅消息等能力的申请与配置：
- 真机验证步骤：

## 4. 与后端的接口变更流程

1. 客户端需要的接口 → `send_message` 给 dev，写清请求/响应与使用场景
2. dev 更新 `docs/API.md` 并实现
3. 客户端按新契约改代码，并在本文件记录用到的接口

## 变更记录

| 日期 | 变更 | 客户端 | 作者 |
|---|---|---|---|
|  |  |  |  |
