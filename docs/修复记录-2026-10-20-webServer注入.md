# 修复记录：`@local/dsh-autolearn` entry 激活失败（webServer 未注入）

- 日期：2026-10-20
- 组件：`plugins/autolearn/index.js`（Host 半边，插件入口）
- 修复提交：`42fc9d0 fix(plugin): inject webServer instead of reading ctx.webServer`

## 1. 现象

启用本插件后，DSH 启动时 stderr 出现：

```
autolearn (@local/dsh-autolearn): Error: cannot get property "webServer" without inject
    at new apply (file:///…/plugins/autolearn/index.js:257:24)
dsh: warning: 2 entries did not activate
```

虽然 `apply()` 开头先打印了 `[dsh-autolearn] 原生工具已注册: 11 个（…）`，
但 `apply` 随后抛错，整个 entry 判定为未激活，工具注册随 fiber 一并失效 —— **11 个原生工具和设置卡全部不可用**。

## 2. 根因

Cordis 对**未在 `inject` 中声明**的服务做属性取值会抛 `cannot get property "x" without inject`。

原代码：

```js
const webServer = ctx?.webServer ?? ctx?.get?.('webServer')
```

第一个操作数 `ctx.webServer` 先抛错，`??` 右边的 `ctx.get(...)` 根本没机会执行。
而插件顶层的声明是 `export const inject = ['tools']` —— `webServer` 不在其中。

为什么不能简单地把 `webServer` 加进顶层 `inject`：headless / CLI profile 没有 web server，
entry 会永久 `pending`，11 个原生工具跟着一起失效，等于用一个 bug 换另一个 bug。

## 3. 修复

把「挂设置卡路由」这一件事放进**子注入上下文**，由 Cordis 等服务就绪后再执行；
主插件仍然只硬依赖 `tools`：

```js
const mountSettingsRoute = (wctx) => {
  let webServer
  try { webServer = wctx?.webServer ?? wctx?.get?.('webServer') } catch { webServer = undefined }
  if (!webServer || typeof webServer.register !== 'function') return
  wctx.effect(() => webServer.register(settingsRoute(env)), 'dsh-autolearn: settings route')
}

if (typeof ctx?.inject === 'function') {
  ctx.inject(['webServer'], (wctx) => mountSettingsRoute(wctx))
} else {
  mountSettingsRoute(ctx)   // 旧版 cordis 兜底
}
```

与 DSH 官方 `dsh-mcp-connector` 的 `injectWebRoutes` 同一策略：服务可用才挂路由，不可用不阻塞插件本体。
`try/catch` 仍然保留，保证旧版宿主（没有 `inject`、或取值语义不同）也不会把 entry 拖死。

## 4. 验证

用假 ctx 直接跑 `apply()`（不启动 DSH）：

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| headless：`webServer` 访问器抛错、无 `inject` 解析 | 不抛异常，11 个工具注册 | PASS（11 tools） |
| web：`inject(['webServer'])` 回调被调用 | 注册 `/dsh-autolearn/api/settings` | PASS |

修复前，第一种场景会抛 `cannot get property "webServer" without inject`。

## 5. 说明

- 该插件当前在 desktop profile 的 `dsh.desktopNextDeselectedBundles` 中被取消勾选，
  因此本次没有在真实 desktop boot 中复验；上面的控制器测试覆盖了修复涉及的完整代码路径，
  重新勾选后应出现 `[dsh-autolearn] settings API ready: <settingsPath>`。
- 同类缺陷（`ctx.webServer` 未 inject）在 `@local/art-uiux` 中同样存在，
  其完整故障分析见该仓库 `docs/FIX-2026-10-20-desktop-profile-web-boot.md`。
