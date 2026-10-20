# dsh-autolearn · DSH 自主学习插件（v2.0 / TypeScript）

把「学习目标 → 有界学习任务 → 可追溯知识库 → 证据核验 → 冲突检测 → 评估报告」
做成 DeepSeek Harness 的原生工具插件：**一个 TypeScript 引擎，两个可选入口**。

> 状态：v2.0.0。
> - 业务逻辑全部在 TypeScript（`src/`，11,126 行，46 模块），**生产运行时 0 个外部依赖**；
> - 11 个 DSH 原生工具（由 60 个 MCP 工具收敛而来）+ 1 个用户侧 CLI；
> - 保留可选 MCP 适配器（默认关闭，调用同一引擎）；
> - 数据库 schema 与 v1.2 完全兼容（v7），旧知识库可直接打开；
> - 测试：**171 项 node:test 全过**；旧 Python 实现保留为 legacy（197 项 pytest 仍可跑）。
- 审计/评测/性能基线：`reports/`（含 12 份报告与原始 JSON），可重复脚本见 `scripts/`。
>
> 详细审计、依赖地图、迁移状态与实测数据见 `docs/refactor/`。

## 架构

```
DSH Agent
   │  ctx.tools.register（原生 JSON Schema + 运行时校验）
   ▼
adapters/dsh（11 工具 + 审批 hook）   adapters/mcp（可选）   cli（用户侧）
   └──────────────┬───────────────────────┬───────────────┘
                  ▼
        application/services（唯一业务门面）
                  ▼
  Learning · Knowledge · Retrieval · Verification · Practice · Security · Storage
                  ▼
        node:sqlite（WAL/FTS 无关的自建倒排 + float32 向量索引）
```

- 0 个运行时循环依赖（脚本实测）。
- 业务逻辑不依赖 MCP 协议；原生与 MCP 入口调用同一套 `AutolearnServices`。
- 所有资源（SQLite 连接、索引文件锁、hook）在插件卸载时释放。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.6**（使用内置 `node:sqlite` 与原生 TypeScript 运行测试） |
| DSH | 支持 Cordis 插件与 `ctx.tools` 的版本（本仓库验证于 0.2.0-rc.2 契约） |
| Python | **不需要**（legacy 目录仅作参考） |
| 构建 | TypeScript 5.9（devDependency） |

## 安装与构建

```bash
# 1) 类型检查 + 构建（产出 dist/）
pnpm install            # 常规环境
pnpm run typecheck
pnpm run build

# 若仓库位于 FAT/exFAT/共享存储（不支持 symlink），pnpm 会失败：
#   npm i -g typescript && tsc -p tsconfig.build.json
```

把插件 link 进 DSH profile（路径按你的仓库位置替换）：

```bash
dsh plugin --profile web add link:/path/to/dsh-autolearn/plugins/autolearn
```

并在 profile 的 `package.json` 中确认：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "@local/dsh-autolearn"] } }
}
```

重启 DSH 后，模型可见工具为 `learning_create` / `learning_run` / `knowledge_search` 等 11 个。

### 引擎目录与旧数据

默认按以下顺序解析引擎目录（`DSH_AL_HOME` 可覆盖）：

1. `DSH_AL_HOME`
2. `<repo>/config.json` 存在 → 仓库根
3. `<repo>/dsh_autonomous_learning/config.json` 存在 → **legacy 引擎目录**（v1.2 的 `data/` 在这里）
4. 仓库根

因此升级不会丢旧知识库；新目录也可以直接指向 `data/`。

| 环境变量 | 用途 | 缺省 |
| --- | --- | --- |
| `DSH_AL_HOME` | 引擎目录（config.json / data/） | 自动探测（见上） |
| `DSH_AL_DATA_DIR` | 数据目录覆盖 | `<home>/data` |
| `DSH_AL_MODE` | assisted / auto / lab | 配置文件 |
| `DSH_AL_ALLOW_NETWORK` | 是否允许外部抓取 | `false` |
| `DSH_AL_CONFIG` | 配置文件路径 | `<home>/config.json` |
| `DSH_AL_SETTINGS_FILE` | 设置卡文件覆盖 | `<home>/data/settings.json` |
| `DSH_AL_LOG_LEVEL` | DEBUG/INFO/WARNING/ERROR | `INFO` |

> 设置卡（DSH 插件设置页）修改的模式/每日预算/任务上限会在**下一轮开始时**生效（引擎重读 `settings.json`）；`dataDir` 变更需要重启。

## 11 个原生工具

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `learning_create` | 建项目 + 生成主题任务链（discover→extract→verify→practice + 缺口/评估/报告） | write |
| `learning_run` | 跑一轮有界学习（预算/时长/任务数/停滞停止；失败重试与依赖阻塞） | write |
| `learning_status` | 项目/任务/覆盖率/核验率/未达标项/最近运行/缺口 | read |
| `knowledge_search` | BM25 + 特征哈希向量 + RRF 混合检索，带核验/冲突/时效/许可警告 | read |
| `knowledge_manage` | save / update / invalidate / rollback / export / get / partitions | write（invalidate/rollback 需确认） |
| `knowledge_verify` | verify / verify_formula / list_evidence / find_duplicates / detect_conflicts | read |
| `source_manage` | discover / read / list（SSRF 防护、域名白名单、体积/超时限制） | read/external |
| `learning_evaluate` | 覆盖率/核验率/来源完整率/冲突/实践通过率/成本 + 可选报告 | read |
| `learning_review` | 失败/阻塞/耗尽重试/冲突/缺口复盘；可重置失败任务（需确认） | read/write |
| `system_diagnostics` | 数据库/外键/索引一致性、schema、权限、网络策略、最近拒绝 | read |
| `system_maintenance` | integrity / rebuild_index / backup / verify_backup / restore / delete_chunk / vacuum | **destructive（宿主审批）** |

审批：
- DSH 原生工具：`tools/pre-execute` 返回 `{kind:'ask'}`，用户拒绝则不执行；判定异常**失败关闭**。
- MCP / CLI：使用本地确认令牌（作用域 = action + target、15 分钟有效、单次消费）。

## 用户侧 CLI

```bash
node dist/cli.js pending                 # 列出待确认操作
node dist/cli.js approve <token>         # 批准（仅 user/CLI 通道）
node dist/cli.js reject <token> [note]
node dist/cli.js status [projectId]
node dist/cli.js diagnostics
node dist/cli.js search "滑点" <projectId>
```

## 可选 MCP 兼容层

```bash
node dist/adapters/mcp/server.js   # stdio JSON-RPC 2.0
```

支持 `initialize` / `tools/list` / `tools/call` / `ping`；工具与原生入口**完全同构**（同一 `buildNativeTools`），不复制业务逻辑。默认不启用，避免与原生入口同时写同一数据库。

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "autolearn": {
      "command": "node",
      "args": ["/path/to/dsh-autolearn/dist/adapters/mcp/server.js"],
      "env": { "DSH_AL_HOME": "/path/to/dsh-autolearn/dsh_autonomous_learning" }
    }
  }
}
```

## 数据与兼容性

- schema：v7（与 v1.2 相同 DDL、相同迁移链、相同唯一索引/JSON/BOOL 编码）。
- 向量：`hashing:hashed-ngram:512`，BLAKE2b-64 特征哈希；旧 `vectors.npy` / `ids.json` / `manifest.json` 可读，TS 写入的索引旧版也可读。
- 内容指纹、chunk_id、`normalizeText` 与旧版逐字节一致（跨语言去重/幂等）。
- 备份：`system_maintenance(action=backup)` 产出 SQLite 在线备份 + 索引目录 + sha256 清单；恢复前自动写 `.pre-restore.sqlite3`。
- 注意：文档正文存放在 `data/documents/`，**不在** DB 备份清单内，备份 data 目录时需整体复制。

## 安全默认值（与旧版差异处已加严）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 网络 | **关闭** | `allow_network=true` 才允许抓取；仅 http/https + 80/443/8080/8443 |
| SSRF | 默认拒绝私有/环回/链路本地/元数据/保留地址 | DNS 结果钉死到实际连接，逐跳重定向校验，防 rebinding |
| 路径 | 只允许授权根 + data 目录 | realpath 解析，符号链接逃逸与 `../` 都会被拒 |
| 密钥 | 写入知识库前扫描并拒绝 | `sk-*`/Bearer/AKIA/gh*/私钥等模式；日志脱敏 |
| 审批失败 | **失败关闭** | 判定异常 → ask，不自动放行 |
| 证据 | 无证据一律 fail | 观点/假设/未解决问题永远不能 verified；模型不能自称人工复核 |
| 检索作用域 | 无 project 作用域时只返回 `visibility='global'` | 防跨项目泄漏 |
| 代码执行 | **strict 沙盒** | 降权 nobody + `unshare -n` 网络命名空间 + Node `--permission`（仅产物目录可读写，禁 child_process/worker/addons）；能力不足时失败关闭，`process` 需显式配置 |

## 测试

```bash
npm test             # 171 tests / 42 suites（node:test）
npm run typecheck    # strict TS
python3 -m pytest dsh_autonomous_learning/tests -q   # legacy 基线：197 passed
```

覆盖：类型检查、单元、数据库集成、知识与全文检索、向量/索引一致性、版本回滚、任务恢复、预算、权限、审批拒绝、SSRF（含 IPv6）、路径穿越、跨项目隔离、并发写、备份恢复、DSH 工具注册/卸载、MCP 真实子进程、CLI 审批、旧库兼容、本地 HTTP 抓取策略、Prompt Injection、代码执行沙盒逃逸/超时/配额。

## 故障恢复

| 症状 | 处理 |
| --- | --- |
| 索引与元数据不一致 | `system_maintenance(action=integrity)` 查看；`rebuild_index` 重建 |
| 误删/误改知识 | `knowledge_manage(action=rollback, version=N)`；或从备份 `restore` |
| 备份恢复被拒 | `verify_backup` 查看 issues（校验和/版本/清单）；校验失败时不会动原库 |
| 任务卡在 running | 下一轮 `learning_run` 自动 `recover()`；也可等超时后重试 |
| 插件加载失败 | 确认已 `pnpm build`（`dist/` 存在）、Node ≥22.6、`@local/dsh-autolearn` 在 bundles |
| 需要回滚到 v1.2 | `git checkout baseline-python-v1.2`；数据库 v7 双向可读 |

### 2026-10-20 · 插件 entry 激活失败（`webServer` 未注入）

**现象**：启动日志出现 `cannot get property "webServer" without inject`，紧随
`autolearn (@local/dsh-autolearn): Error: …` 与 `dsh: warning: N entries did not activate`。
`apply()` 虽然先打印了 `[dsh-autolearn] 原生工具已注册: 11 个`，但 entry 整体激活失败，
注册随 fiber 一并回滚——**11 个原生工具和设置卡全部不可用**。

**根因**：Cordis 对**未在 `inject` 中声明**的服务做属性取值会抛错。原实现写的是
`ctx?.webServer ?? ctx?.get?.('webServer')`，第一个操作数就抛错，`??` 右边没有机会执行；
而顶层声明只有 `export const inject = ['tools']`。

**修复**：把「挂设置卡路由」放进子注入上下文 `ctx.inject(['webServer'], …)`，
主插件仍然只硬依赖 `tools`。不能简单把 `webServer` 写进顶层 inject——headless/CLI profile
没有 web server，entry 会永久 `pending`，工具同样失效。修好后的 web profile 会打印
`[dsh-autolearn] settings API ready: <settingsPath>`。

细节（含 headless / web 两场景验证表）见 [docs/修复记录-2026-10-20-webServer注入.md](docs/修复记录-2026-10-20-webServer注入.md)。

## 已知限制（不假装完成）

1. **PDF/DOCX 解析未迁移**：会明确报错并建议转换为 Markdown/TXT；HTML 用正则清洗（非 DOM）。
2. **模型辅助（规划/抽取提议）未迁移**：`use_model=true` 会返回明确警告，只走规则链路。
3. **代码执行只支持 JavaScript**，仅 lab 模式；默认 strict 沙盒（权限 + 命名空间 + Permission Model），但**不是 seccomp/LSM 内核沙箱**；`security.exec_sandbox=process` 是显式降级。Python 代码执行已移除。
4. **调度 tick / 实验运行器 / 知识图谱查询 / 检索评测集**未迁移（表结构保留）。
5. 哈希向量是**词汇级**召回，不是语义模型；未做检索质量评测，不宣称提升。
6. 真实 DSH profile 启动验证被缺失模型凭据阻塞；插件注册由契约级测试 + MCP 子进程验证覆盖。
7. `docs/refactor/audit.md` 记录了旧版 8 项安全缺陷与修复状态。

## 目录结构

```
src/
  index.ts                  # 引擎装配（唯一 DI 点）
  cli.ts                    # 用户侧 CLI（审批/诊断/检索）
  core/                     # 类型、错误、配置、校验、ID
  security/                 # 权限、审批、路径、网络、预算、审计、密钥
  infrastructure/
    database/               # schema(v7)/迁移/连接/事务/备份
    retrieval/              # 分词器 + BM25
    embeddings/             # BLAKE2b / 特征哈希 / npy / 向量索引
    sources/                # 发现 / 读取 / 解析 / 元数据
  domain/
    knowledge/              # 存储、提取、质量、领域/分区
    learning/               # 状态机、规划、缺口、评估、编排、报告、仓储
    practice/               # 练习生成、公式求值、受限执行
  application/services.ts   # 11 个业务接口
  adapters/dsh|mcp/         # 入口适配
tests/{unit,integration,security,regression}/
docs/refactor/              # 审计 / 依赖地图 / 迁移计划 / 阶段报告
dsh_autonomous_learning/    # legacy v1.2（保留，非默认运行时；迁移完成后再删除）
plugins/autolearn/          # Cordis 插件：设置卡 + 原生工具注册
plugins/approval/           # legacy MCP 审批闸门（原生工具不再依赖它）
```

## 许可

MIT
