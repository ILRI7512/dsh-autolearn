# @local/dsh-autolearn

DSH 自主学习插件（v2.1）：**TypeScript 引擎 + 11 个 DSH 原生工具**。
默认不注册 MCP 子进程；`tools/pre-execute` 审批与工具注册都在本插件内完成。

## 安装后的形态

| 项 | 值 |
| --- | --- |
| 插件名 | `@local/dsh-autolearn` |
| 工具 | 11 个原生工具（`learning_*` / `knowledge_*` / `source_manage` / `system_*`） |
| 引擎 | 仓库 `dist/`（Node ≥22.6，`node:sqlite`） |
| 数据 | `<engine home>/data`（默认兼容 `dsh_autonomous_learning/data`） |
| 审批 | 插件内 `tools/pre-execute` hook；危险操作独立 ask，异常失败关闭 |
| MCP | **可选**，见 `dist/adapters/mcp/server.js`；默认不启用 |

## 设置卡

「设置 → 插件 → 自主学习」显示：

- 运行模式（assisted / auto / lab）
- 数据目录（留空为默认；修改需重启 DSH）
- 每日预算（USD）
- 每轮任务上限（1–200）
- **运行与安全（只读）**：网络访问、私有网络、代码执行沙盒、执行限制、审计日志、密钥扫描

前四项写入 `<engine home>/data/settings.json`，下一轮学习开始时生效；
安全边界来自 `<engine home>/config.json` 的 `security` 段，卡片只读展示，修改后需重启 DSH。

## 安装

```bash
pnpm build
dsh plugin --profile web add link:/path/to/dsh-autolearn/plugins/autolearn
# profile package.json 的 dsh.profile.bundles 需包含 @local/dsh-autolearn
```

插件包内的 `cordis.patch.yml` 为空（不向 profile 树插入 MCP 条目）。

## 与旧版的关系

- v1.2 的 Python MCP 服务器保留为 legacy，但默认不再启动；
- 旧审批插件 `@local/dsh-autolearn-approval` 仅用于可选 MCP 入口，原生工具不使用它；
- 数据库 schema v7 与旧版兼容，旧知识库可直接打开。
