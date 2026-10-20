# 依赖地图（重构前 → 重构后）

- 基线：`9c8face`（v1.2）
- 目标：v2.0（TypeScript 引擎 + 11 个 DSH 原生工具 + 可选 MCP 适配器）

---

## 1. 重构前的入口与调用链

```
DSH profile
  ├─ plugins/autolearn/index.js      (Host: 设置卡 API，读写 data/settings.json)
  ├─ plugins/approval/index.js       (Host: tools/pre-execute → ask，读 tool_risks.json)
  └─ @deepseek-ai/dsh-mcp-client ──stdio──> python -m dsh_autonomous_learning.plugin
                                                │
                                                ├─ config.load_config
                                                ├─ core.orchestrator.build_runtime
                                                └─ tools.registry.call(name, args)
                                                      └─ 60 个 handler → runtime.*
```

- 每次模型调用 `mcp__autolearn__*` 都要跨进程 JSON-RPC。
- 设置卡（Node）与引擎（Python）通过 `data/settings.json` 共享状态。
- 审批（Node）只知道「工具名风险表」，不知道具体业务参数语义。

## 2. Python 模块依赖（目录聚合，实测扫描）

```
main → config, core, domains, plugin, tools
plugin → config, core, tools
tools → config, core, domains, knowledge, practice, registry, sources, storage
core → config, domains, knowledge, practice, security, sources, storage
knowledge → config, core, domains, security, sources, storage
storage → config, core
security → config, core, storage
sources → config, core, security
practice → config, core, security, storage
```

**问题边**：
- `core ↔ knowledge`、`core ↔ storage`、`storage ↔ core` 形成目录级双向依赖（编排器直接调 verifier/store；store 又依赖 core 的模型与指纹）。
- `security → storage`（审计写 SQLite）让安全层无法独立测试。
- `tools` 同时依赖 6 个业务域，是典型的「上帝层」。

## 3. 重构后的依赖（严格单向）

```
adapters/dsh (plugin/tools)     adapters/mcp (server)     cli
        │                            │                     │
        └──────────────┬─────────────┴─────────────────────┘
                       ▼
              application/services.ts        ← 唯一业务门面
                       │
        ┌──────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼              ▼
 domain/learning  domain/knowledge  domain/practice  security/*
        │              │               │              │
        └──────────────┴───────┬───────┴──────────────┘
                               ▼
                 infrastructure/{database,retrieval,embeddings,sources}
                               │
                               ▼
                      node:sqlite / 文件系统 / 网络
```

- **运行时循环依赖：0**（46 个模块，脚本实测）。
- `application/services.ts` 只依赖 domain 与 security，不依赖 MCP 协议。
- `adapters/dsh` 与 `adapters/mcp` 互不依赖，都调用 `AutolearnServices`。
- `index.ts` 是唯一装配点；domain 不 import index（唯一的 `import type AutolearnEngine` 已移除，避免运行期环）。
- 安全层不再依赖存储：`PermissionManager` 接收 `PathPolicy` / `ApprovalService` / `AuditLogger` 接口，测试可注入。

### 3.1 关键模块依赖表

| 模块 | 依赖 | 被谁依赖 |
| --- | --- | --- |
| `core/{errors,types,ids,json,validation}` | 无（仅标准库） | 全部 |
| `core/config` | errors/json | index、cli、adapters |
| `infrastructure/database` | schema/migrations、node:sqlite | store、repo、security、index |
| `infrastructure/retrieval` | tokenizer、sqlite | store |
| `infrastructure/embeddings` | blake2b、npy、tokenizer | store、index |
| `infrastructure/sources` | security/network、path policy | reader、orchestrator、services |
| `security/*` | core、database（仅审计/令牌持久化） | services、orchestrator |
| `domain/knowledge` | core、database、embeddings、retrieval | services、orchestrator |
| `domain/learning` | knowledge、security、practice、sources | services、adapters |
| `application/services` | 全部 domain + security | adapters、cli、index |
| `index` | 全部（装配） | adapters、cli、tests |
| `adapters/dsh` | index、services、tools schema | plugins/autolearn/index.js |
| `adapters/mcp` | index、services、dsh/tools schema | 外部 MCP 客户端 |

## 4. 外部依赖

| 依赖 | 重构前 | 重构后 | 说明 |
| --- | --- | --- | --- |
| Python 运行时 | 必需（3.11+） | **不需要** | 业务逻辑全部在 TS |
| `mcp` / `anyio` | 必需 | 不需要 | MCP 协议用 Node 标准库实现 |
| `numpy` | 必需 | 不需要 | float32 矩阵手写实现（npy 读写） |
| `httpx` | 必需 | 不需要 | `node:http/https` + DNS 钉死 |
| `beautifulsoup4` | 可选（HTML） | 不需要 | 正则清洗（能力有取舍，见下） |
| `pypdf` / `python-docx` | 可选 | **未迁移** | TS 版明确报错，不做静默降级 |
| `pytest` | 开发 | 不需要 | `node:test` |
| `typescript` | — | devDependency（构建/类型检查） | 运行时不加载 |
| SQLite 驱动 | Python 内置 sqlite3 | `node:sqlite`（Node ≥22.5 内置） | 无原生扩展 |

> 结论：生产运行时外部包 **7 → 0**；代价是 PDF/DOCX 解析与 Python 代码执行能力暂缺（已在 migration-plan 标注）。

## 5. 数据流

### 5.1 学习一轮（run_round）

```
learning_run
  → orchestrator.runRound
      → reloadHostSettings()              读 data/settings.json（白名单键）
      → recover()                         把超时的 running 任务转 retrying/failed
      → BudgetTracker                     任务数/模型调用/来源数/时长/费用
      → repo.nextReadyTasks()             依赖全部 completed，priority DESC
      → executeTask
          discover → discovery + reader（SSRF/路径策略）→ ingestDocument
          extract  → parser + extractor（规则）→ store.addChunks（行+倒排同事务）
          verify   → verifier（证据门槛）→ forceVerificationState
          practice → generator + runner（lab）→ markPracticed
          evaluate → evaluator + gaps → 补充任务
          report   → report.ts（Markdown+JSON）
      → finishRun + metrics + audit
```

### 5.2 检索

```
knowledge_search
  → services.knowledgeSearch
      → store.listChunkIds(filter)         项目 + visibility 作用域
      → vectorIndex.search(query, allowed) BLAKE2b 查询向量 + 余弦
      → bm25Search(db, query, allowed)     SQL 候选 + 内存打分
      → RRF 融合（k=60, 0.65/0.35）
      → formatResult（核验状态/冲突/时效/许可 warnings）
```

### 5.3 审批

```
DSH 原生工具：
  model → tools/pre-execute → {kind:'ask'} → 用户批准 → execute → PermissionManager(delegateToHost)
MCP / CLI：
  execute → PermissionManager → needs_confirmation → ApprovalService 令牌
      → 用户 CLI approve（user-only）→ 单次消费（action+target 作用域）
```

## 6. 插件与运行形态

| 形态 | 入口 | 用途 | 默认 |
| --- | --- | --- | --- |
| DSH 原生 | `plugins/autolearn/index.js` → `dist/adapters/dsh/plugin.js` | 11 个原生工具 + 设置卡 | **启用** |
| MCP（可选） | `dist/adapters/mcp/server.js` | 非 DSH 客户端兼容 | 关闭 |
| CLI（用户侧） | `dist/cli.js` | 审批、诊断、检索 | 手动 |
| 引擎库 | `dist/index.js` | 测试/嵌入 | — |

> 为什么 MCP 仍保留：跨 Agent/跨语言互操作是真实但低频的需求；协议层只有 ~200 行且复用同一服务层，维护成本低。**默认不启用**，避免同一 DB 的双入口并发写。
