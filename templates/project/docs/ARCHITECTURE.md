# 架构说明 — <项目名>

> 所有者：dev ｜ 最近更新：YYYY-MM-DD

## 1. 运行形态

<本地怎么跑、生产怎么部署（容器/进程/定时任务）、依赖哪些外部服务。>

## 2. 目录结构

```
app/
  main.py            FastAPI 应用与 joist 初始化
  routers/           HTTP 层：解析请求、鉴权、调 service、build + 渲染
  services/          业务逻辑与事务边界（async）
  models/            SQLAlchemy 模型
  components/        pyjoist 组件（数据契约）
  builders/          组件组合（builder 函数）
templates/           组件模板与整页模板
migrations/          Alembic
tests/unit/          单元测试      tests/integration/  集成与回归测试
```

## 3. 请求链路

```
浏览器/HTMX 请求 → router（鉴权 + 参数校验）
                 → service（业务规则 + 事务 + 缓存）
                 → builder（组件树）
                 → joist.fragment_or_page（HTMX 返回片段 / 直接访问返回整页）
```

## 4. 模块边界与依赖方向

| 模块 | 可以依赖 | 不允许依赖 |
|---|---|---|
| routers | services, builders, components | 直接连数据库、写 SQL |
| services | models, redis, 其他 service | 模板、HTTP 细节 |
| builders | components | 数据库、HTTP |
| components | 无（纯数据契约 + 模板名） | 数据库、service |

## 5. 横切关注点

- 配置与环境变量： 
- 日志与可观测性（请求 id、慢查询、错误聚合）： 
- 鉴权与权限： 
- 限流与幂等： 

## 6. 关键取舍

<链到 DECISIONS.md 的对应条目。>

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
|  |  |  |
