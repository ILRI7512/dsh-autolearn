# @local/dsh-autolearn-approval（legacy / MCP 兼容）

**仅用于可选的 MCP 入口**（`mcp__autolearn__*`）。
DSH 原生工具（`learning_*` / `knowledge_*` / `system_maintenance` 等）由
`@local/dsh-autolearn` 在进程内用 `tools/pre-execute` hook 审批，不再经过本插件。

## 行为（MCP 入口）

- 监听 `tools/pre-execute`；
- 对 `mcp__autolearn__*` 中风险为 `execute` / `destructive` 的工具，或 `askTools` 显式列出的工具，返回 `{ kind: 'ask', reason }`；
- 风险清单来自引擎的 `tool_risks.json`（与 MCP 适配器同源）。

## 与原生工具的差异

| 项 | 原生工具（推荐） | 本插件（MCP 兼容） |
| --- | --- | --- |
| 审批位置 | `plugins/autolearn` 进程内 hook | 独立 Host 插件 |
| 失败策略 | 判定异常 → ask（失败关闭） | 判定异常 → ask（失败关闭） |
| 默认启用 | 是 | 仅 MCP 场景 |

## 状态

- 版本 2.1.0：仅文案/元数据更新，逻辑保持兼容；
- 若只使用 DSH 原生工具，可以从 profile 的 `dsh.profile.bundles` 中移除此插件，不影响功能；
- 不要同时启用原生工具与 MCP 入口写同一数据库（二选一）。
