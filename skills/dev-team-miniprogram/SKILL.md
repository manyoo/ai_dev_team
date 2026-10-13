---
name: dev-team-miniprogram
description: 微信小程序手册：工程结构与分包策略、请求与鉴权封装（code2session）、登录态与存储、支付/订阅消息等官方流程、真机验证步骤、包体积控制，并维护 docs/FRONTEND.md。要交付微信小程序时加载。
whenToUse: 被点名加入团队做微信小程序、或需求出现小程序端入口/支付/订阅消息时。
---

# 微信小程序手册（dev-team-miniprogram）

> 你在 `miniprogram/` 里工作，并维护 `docs/FRONTEND.md` 的小程序小节。**复用同一套后端 API**，不另开后门接口；
> 缺接口找 dev，不要自己动 dev 的文件。**任何凭据、AppSecret、商户密钥都不进仓库。**

## 0. 开工顺序

1. `team_task_get` → `claim`；读 `docs/API.md` 的鉴权与错误码，读 `docs/FRONTEND.md` 现状。
2. 建/接小程序工程 → 登录链路 → 业务页面 → 真机验证 → 更新 `docs/FRONTEND.md` → `complete` → 汇报。

## 1. 工程结构

```
miniprogram/
├── project.config.json     # 只放 projectname/appid 占位说明，不写密钥
├── app.js / app.json / app.wxss
├── pages/<域>/index.{js,json,wxml,wxss}
├── components/<组件>/
├── utils/request.js        # 统一请求封装（带上 BASE_URL、token、错误处理）
├── utils/auth.js           # 登录态、code2session 调用
└── subpackages/<域>/        # 按需分包
```

- AppID 与 `BASE_URL` 用环境区分（开发/生产），写进 `docs/FRONTEND.md`；**不要写进代码常量**。
- 页面职责单一；WXML 只做结构，逻辑放对应的 `.js`，样式放 `.wxss`。

## 2. 请求与鉴权

```js
// utils/request.js
const BASE_URL = wx.getAccountInfoSync().miniProgram.envVersion === 'release'
  ? 'https://api.example.com' : 'https://staging.example.com';

export function request(path, { method = 'GET', data, auth = true } = {}) {
  const token = auth ? wx.getStorageSync('token') : '';
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${path}`, method, data,
      header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 10000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401) { wx.removeStorageSync('token'); wx.reLaunch({ url: '/pages/login/index' }); }
        reject(Object.assign(new Error(res.data?.error?.message ?? '请求失败'), { status: res.statusCode, code: res.data?.error?.code }));
      },
      fail: (err) => reject(new Error(`网络异常：${err.errMsg}`)),
    });
  });
}
```

登录链路（标准流程）：

```
wx.login() → code → POST /api/auth/wechat { code }（后端用 AppSecret 调 code2session）
           → 返回 { token, expires_in } → wx.setStorageSync('token', ...)
```

- AppSecret 只在后端；小程序端永远拿不到，也不要试图拿。
- token 过期统一 401 → 清存储 → 回登录页；不要在每个页面重复判断。
- 错误码映射与后端一致，业务规则不要在小程序里重写。

## 3. 分包与包体积

- 主包只放：启动页、登录、tabBar 页面、公共 `utils/` 与通用组件。
- 业务域各自 `subpackages/<域>/`，按需加载（`wx.navigateTo` 到分包页面）。
- 图片走 CDN + 压缩；大图/长列表用缩略图 + 懒加载。
- 交付前看开发者工具的「代码依赖分析」：主包尽量 < 1.5 MB，总体积看清楚再报完成。

## 4. 支付与订阅消息（涉及钱与用户触达，严格按官方流程）

- 微信支付：后端下单生成支付参数 → 小程序 `wx.requestPayment` → 后端收异步回调做最终确认。**前端支付成功不代表已支付**，必须以服务端回调/主动查询为准。
- 订阅消息：先 `wx.requestSubscribeMessage` 拿到用户授权，再由后端发送；模板 ID 写进 `docs/FRONTEND.md`。
- 所有回调幂等（同一订单重复回调只处理一次），这一步在后端，但要确认契约里写了。
- 这两个能力都要 reviewer 过一遍：涉及鉴权、幂等与资金。

## 5. 验证（交付前）

1. 开发者工具导入 `miniprogram/`（写清导入路径与 AppID 来源）→ 编译无错误、无警告堆积。
2. 真机预览关键路径：启动 → 登录 → 主流程 → 关键提交 → 错误态 → 冷启动后登录态恢复。
3. 弱网与异常：断开网络看提示是否可理解；后端 5xx 是否有重试/提示。
4. 分包加载：首次进入分包页面是否正常；包体积检查。

验证步骤写进 `docs/FRONTEND.md`（下一个人要能照着做）。

## 6. 自检

- [ ] 只在 `miniprogram/` 与 `docs/FRONTEND.md` 里改动
- [ ] 没有密钥/AppSecret/商户密钥进仓库（grep 一遍）
- [ ] 用到的接口都在 `docs/FRONTEND.md` 列出，与 `docs/API.md` 一致
- [ ] 401/错误码处理统一在 `utils/request.js`
- [ ] 主包体积与分包策略已检查并记录
- [ ] 真机路径走通，验证步骤已写入文档
- [ ] 支付/订阅消息（如有）已确认后端幂等并请 reviewer 过

汇报模板：`[交付] 任务 <id>：改动=miniprogram/...；验证=开发者工具编译 + 真机路径；包体积=<主包/总>；契约=<用到的接口>；阻塞=<无/具体>`
