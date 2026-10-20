# dsh-autolearn 重构审计（v1.2 → v2.0）

- 审计对象：`ILRI7512/dsh-autolearn`（本地工作区），基线提交 `9c8face`，标签 `baseline-python-v1.2`
- 审计日期：2026-10-20
- 方法：逐文件静态阅读 + 依赖扫描 + 运行现有测试 + 可运行实验（SQLite/向量索引/真实旧库对拍）
- 原则：只记录**可复现**的事实；无法验证的能力明确标注「未验证」

---

## 1. 语言分布（重构前）

| 语言 | 文件数 | 行数 | 实际用途 |
| --- | --- | --- | --- |
| Python | 85 | 20,552 | 全部业务逻辑：MCP 服务器、学习编排、存储、检索、核验、安全、练习、测试 |
| JavaScript (ESM) | 3 | 847 | Cordis Host 插件：设置卡 API、审批闸门、纯函数判定测试 |
| JSON / YAML | 14 + 2 | — | 配置、工具风险清单、locale、bundle patch |
| SQL | 内嵌于 Python | 654 行 DDL 区 | 26 处 `CREATE TABLE`（24 张唯一表）+ 29 处 `CREATE INDEX` |
| NumPy 索引 | — | 5 个 chunk 的 512 维矩阵 | `vectors.npy` + `ids.json` + `manifest.json` |

- Python 业务代码（排除 `tests/`、`__init__.py`）：**16,783 行 / 57 文件**
- Python 测试：**3,667 行 / 27 文件**
- 仓库没有任何 TypeScript 源码；`package.json` 只有 3 个自定义脚本。

### 1.1 模块代码量（重构前）

| 模块 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| `core/` | 12 | 4,483 | 数据模型、配置、编排器（1,390）、状态机、规划器、预算、嵌入器、评估、缺口 |
| `knowledge/` | 9 | 2,540 | 提取、分类、核验（654）、质量、去重、冲突、版本、图、分区 |
| `storage/` | 3 | 3,006 | SQLite 元数据（1,691）、向量索引（1,193）、分词/BM25 |
| `sources/` | 4 | 1,261 | 发现、读取/抓取、解析、来源元数据 |
| `security/` | 3 | 1,080 | 权限（614）、执行策略（348）、审计（118） |
| `tools/` | 5 | 2,285 | 60 个 MCP 工具的 schema + handler |
| `practice/` | 3 | 513 | 任务生成、代码执行、实验执行 |
| `domains/` | 2 | 263 | 领域注册表与内置领域 |
| `evaluation/` | 1 | 99 | 检索评估集 |
| 根文件 | 3 | 990 | `config.py`(468)、`main.py`(413)、`plugin.py`(109) |

---

## 2. 模块职责与真实依赖

```
plugin.py (MCP stdio)
  └─ config.load_config
  └─ core.orchestrator.build_runtime
        ├─ storage.metadata_store.MetadataStore → SQLite（schema v7）
        ├─ storage.vector_store.KnowledgeStore
        │     ├─ core.embedder.HashingEmbedder (numpy)
        │     └─ metadata.bm25_search
        ├─ security.permissions.PermissionManager → audit → SQLite
        ├─ sources.reader.SourceReader → httpx / bs4 / pypdf / docx
        ├─ knowledge.extractor → classifier
        ├─ knowledge.verifier → state_machine / quality / execution_policy
        ├─ core.planner / gap_analyzer / evaluator
        └─ practice.generator / test_runner / experiment_runner
  └─ tools.build_registry → 60 个 ToolSpec（每个都调用 handler lambda）
```

- 依赖方向总体清晰（工具层 → 运行时 → 存储/安全），但存在**横向重复**（见 §3）。
- `main.py`（CLI）与 `plugin.py`（MCP）各自装配同一套 runtime；`tools/*` 又给每个能力套一层 schema/handler。
- 循环引用通过函数内 `from ..domains import REGISTRY` 等局部导入规避，说明模块边界并不干净。

---

## 3. 重复实现与过度抽象（可删除/合并的具体项）

| # | 重复点 | 证据 | 影响 |
| --- | --- | --- | --- |
| D-01 | 两套 BM25 | `storage/tokenizer.py:66` 纯 Python 版 + `storage/metadata_store.py:1175` SQL 候选版 | 公式需人工保持同步，已有测试分别覆盖 |
| D-02 | 两套 URL 归一化 | `sources/discovery.py:66` 与 `sources/metadata.py:214` 的跟踪参数清单不同（9 vs 11） | 去重键不一致，可能重复抓取 |
| D-03 | 三层存储职责 | `metadata_store`（CRUD+BM25）、`vector_store`（业务写入+索引+备份）、`tokenizer` | 写路径跨越两层，事务边界难以一眼看清 |
| D-04 | 60 个工具各自做参数校验/权限/审计包装 | `tools/*.py` 合计 2,285 行，多为 `ToolSpec(handler=lambda …)` | 同一业务能力有内部方法与工具两份入口 |
| D-05 | 配置默认值两处 | `config.py` dataclass + `config.json` | 已出现漂移风险（文件缺字段靠默认值补齐） |
| D-06 | 审批风险清单三处 | `tool_risks.json` + `plugins/approval/index.js` 判定 + `security/permissions.py` 风险矩阵 | 改一处要同步三处 |
| D-07 | 两个练习执行器 | `practice/test_runner.py` 与 `practice/experiment_runner.py` 都做「受限目录+超时+截断」 | 安全参数重复实现 |
| D-08 | 设置文件两个读者 | Host JS 与 Python 引擎各读 `data/settings.json` | 解析/校验逻辑重复（本次已收敛到 TS 一处） |
| D-09 | 过度抽象 | `_PartitionSpecView` 每次访问重建分区视图；`ToolSpec` 包一层只为注册；`Chunk.to_row()` / `chunk_from_dict` 双向往返 | 增加理解成本，未带来隔离收益 |

**结论**：语言不统一之外，真正的问题是「同一职责多个入口 + 同一规则多处维护」。瘦身目标应是**单一业务服务层**，而不是删功能。

---

## 4. MCP 工具审计（60 个）

### 4.1 统计

- 总数：**60**
- 风险分布：read 38、write 17、execute 2、destructive 3（`tool_risks.json`）
- 参数 schema 全部为手写 JSON Schema；返回均为 `{"ok": ...}` 或业务对象
- 审批：3 个 destructive + 2 个 execute 需要确认；Host 侧对 `mcp__autolearn__*` 做 `tools/pre-execute` ask

### 4.2 逐工具去向

| # | MCP 工具 | 风险 | 重构后去向 |
| --- | --- | --- | --- |
| 1 | `analyze_knowledge_gaps` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 2 | `audit_knowledge_base` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 3 | `backup_knowledge_base` | write | system_maintenance / system_diagnostics |
| 4 | `cancel_learning_project` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 5 | `check_index_integrity` | read | system_maintenance / system_diagnostics |
| 6 | `check_source_freshness` | read | knowledge_verify（按 action） |
| 7 | `check_source_license` | read | knowledge_verify（按 action） |
| 8 | `classify_knowledge` | read | knowledge_search（filters/action 参数） |
| 9 | `compare_sources` | read | knowledge_verify（按 action） |
| 10 | `create_learning_project` | write | learning_create / learning_run 内部 |
| 11 | `create_practice_task` | write | learning_create / learning_run 内部 |
| 12 | `decompose_learning_goal` | read | learning_create / learning_run 内部 |
| 13 | `detect_conflicts` | write | knowledge_verify（按 action） |
| 14 | `discover_sources` | read | source_manage（discover/read） |
| 15 | `evaluate_learning` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 16 | `evaluate_practice_result` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 17 | `export_knowledge` | write | knowledge_manage / learning_status |
| 18 | `extract_code_examples` | read | knowledge_verify（按 action） |
| 19 | `extract_concepts` | read | knowledge_verify（按 action） |
| 20 | `extract_formulas` | read | knowledge_verify（按 action） |
| 21 | `extract_knowledge` | write | learning_run(extract) 内部 |
| 22 | `find_duplicate_knowledge` | write | knowledge_verify（按 action） |
| 23 | `generate_learning_report` | write | learning_create / learning_run 内部 |
| 24 | `generate_learning_tasks` | write | learning_create / learning_run 内部 |
| 25 | `get_knowledge_details` | read | knowledge_search（filters/action 参数） |
| 26 | `get_knowledge_relations` | read | knowledge_search（filters/action 参数） |
| 27 | `get_knowledge_sources` | read | knowledge_search（filters/action 参数） |
| 28 | `get_learning_metrics` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 29 | `get_learning_progress` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 30 | `get_learning_project` | read | knowledge_manage / learning_status |
| 31 | `get_runtime_info` | read | system_maintenance / system_diagnostics |
| 32 | `get_source_metadata` | read | knowledge_verify（按 action） |
| 33 | `identify_assumptions` | read | knowledge_verify（按 action） |
| 34 | `identify_uncertainties` | read | knowledge_verify（按 action） |
| 35 | `invalidate_knowledge` | destructive | knowledge_manage(action=invalidate) |
| 36 | `list_knowledge_partitions` | read | knowledge_search（filters/action 参数） |
| 37 | `list_learning_projects` | read | knowledge_manage / learning_status |
| 38 | `list_learning_tools` | read | system_diagnostics |
| 39 | `list_scheduled_tasks` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 40 | `parse_document` | read | source_manage（discover/read） |
| 41 | `pause_learning_project` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 42 | `plan_learning_path` | write | learning_create / learning_run 内部 |
| 43 | `prioritize_learning_tasks` | read | learning_create / learning_run 内部 |
| 44 | `read_source` | read | source_manage（discover/read） |
| 45 | `rebuild_vector_index` | write | system_maintenance / system_diagnostics |
| 46 | `recommend_next_tasks` | read | learning_run / learning_status / learning_review / learning_evaluate |
| 47 | `record_experiment_result` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 48 | `restore_knowledge_base` | destructive | system_maintenance / system_diagnostics |
| 49 | `resume_learning_project` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 50 | `retry_failed_task` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 51 | `run_code_test` | execute | learning_run(practice) + system_maintenance（宿主审批） |
| 52 | `run_learning_experiment` | execute | learning_run(practice) + system_maintenance（宿主审批） |
| 53 | `run_learning_round` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 54 | `run_scheduler_tick` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 55 | `save_knowledge` | write | knowledge_manage / learning_status |
| 56 | `schedule_learning_task` | write | learning_run / learning_status / learning_review / learning_evaluate |
| 57 | `search_knowledge` | read | knowledge_search（filters/action 参数） |
| 58 | `search_knowledge_by_keyword` | read | knowledge_search（filters/action 参数） |
| 59 | `search_sources` | read | knowledge_search（filters/action 参数） |
| 60 | `summarize_knowledge` | read | knowledge_search（filters/action 参数） |
| 61 | `update_knowledge` | write | knowledge_manage / learning_status |
| 62 | `verify_formula` | read | knowledge_verify（按 action） |
| 63 | `verify_knowledge` | read | knowledge_verify（按 action） |


**决策原则**：
1. 模型可见工具从 60 → **11**，减少选择成本与误调用面；
2. 只读分析类（`extract_concepts`/`identify_assumptions` 等）保留为**内部函数**，由提取/核验流程调用，不再单独暴露；
3. 危险动作（删除/恢复/重建索引）独立为 `system_maintenance`，不与 `knowledge_manage` 混在一起；
4. 所有入口（原生 Tools / MCP）调用**同一** `AutolearnServices`。

---

## 5. DSH 原生 Tools 接入方式（实测契约）

- DSH 工具注册：`ctx.tools.register(definition)`，`definition` 需要 `{ name, description, parameters(JSON Schema), output:{schema,render}, execute }`。
- 官方 `defineTool`（`@deepseek-ai/dsh-tools`）只是把「spec 形式参数」转成 JSON Schema 并加参数校验；**`ctx.tools.register` 接受原生 JSON Schema**。
- 本项目实现选择：**不依赖 `@deepseek-ai/dsh-tools` 的 import**（避免插件被 link 进 profile 后解析不到包），直接注册原生定义；参数 Schema 同时用于工具契约与运行时校验（`src/core/validation.ts`）。
- 审批：`ctx.on('tools/pre-execute', (exec, next) => …)`，返回 `{kind:'ask', reason}` 触发宿主审批；本插件对判定异常**失败关闭**（返回 ask）。
- 生命周期：`ctx.effect(() => { register…; return () => engine.close() })`，卸载时关闭 SQLite 连接、注销工具与 hook。

> 验证：`tests/integration/adapters.test.ts` 用真实 `ctx` 形状（`tools.register` / `on` / `effect`）验证 11 个工具注册、ask 判定与卸载清理；MCP 适配器由**真实子进程**完成 initialize/tools-list（见 §9）。真实 DSH profile 启动因模型凭据缺失被阻塞（§10）。

---

## 6. SQLite 结构与迁移

### 6.1 表（24）

| 表 | 用途 | 关键列/索引 |
| --- | --- | --- |
| `meta` | schema 版本等 KV | `key` |
| `projects` | 学习项目 | `status`、`partitions`(JSON)、`budget`(JSON) |
| `tasks` | 任务 DAG | `idx_tasks_project(project_id,status)`、`idx_tasks_idem(project_id,idempotency_key) WHERE <>''` |
| `runs` | 每轮运行 | `idx_runs_project(project_id,started_at)` |
| `sources` | 来源 | `idx_sources_project`、`idx_sources_hash`、`idx_sources_location` |
| `documents` | 文档（正文落文件） | `content_hash`、`stages`(JSON) |
| `chunks` | 知识（55 列） | `idx_chunks_project/status/hash/content_proj/document/domain/partition`、`uq_chunks_live_content(project_id,content_hash) WHERE invalidated_at=''` |
| `embedding_cache` | 向量缓存 | `(cache_key)`、`embedder_id` 索引 |
| `chunk_versions` | 版本快照 | `idx_versions_chunk` |
| `verification_records` | 核验记录 | `idx_verify_chunk` |
| `conflicts` / `duplicates` / `edges` / `gaps` | 冲突/重复/关系/缺口 | 按项目+状态索引 |
| `practice_tasks` / `practice_results` / `experiments` | 练习与实验 | `idx_practice_results` |
| `metrics` / `audit_log` / `llm_calls` | 指标/审计/成本 | 时间与项目索引 |
| `schedules` / `confirmations` | 调度/待确认 | `idx_confirmations_status(status,expires_at)` |
| `tokens` / `chunk_lex` | BM25 倒排与词长 | `idx_tokens_token`、主键 `(chunk_id, token)` |

### 6.2 迁移

- `SCHEMA_VERSION = 7`；迁移按**数值升序**执行（源码字典字面序为 2,3,4,7,6,5，是陷阱）。
- 关键迁移：v3 先收敛重复内容行（保留 verified/高 version），再建唯一索引；v4 documents.stages；v5 chunks 8 列；v6 embedding_cache；v7 quality 两列。
- 事务：单连接 + `BEGIN IMMEDIATE`；旧版 Python 是 `RLock` 可重入但**无保存点**（内层 commit 会提前提交外层）。
- PRAGMA：`WAL`、`foreign_keys=ON`、`synchronous=NORMAL`；`timeout=30s`（TS 用 `busy_timeout=30000` 等价）。

### 6.3 数据关系要点

- 外键 `ON DELETE CASCADE`：projects → tasks/runs/sources/documents/chunks/…；chunks → tokens/chunk_lex/versions/verification_records。
- `sources.location` 用归一化地址（去跟踪参数、去尾斜杠）。
- `chunks.visibility` ∈ {project, global}，项目内检索 = `project_id=? OR visibility='global'`。
- 备份是「SQLite 在线备份 + 索引目录 + 清单（含 sha256）」，恢复前写 `.pre-restore` 安全副本。

---

## 7. 向量索引与检索

### 7.1 真实算法（不是语义模型）

- 实现：`core/embedder.py::HashingEmbedder`，**特征哈希**，非神经网络。
- 过程：分词（拉丁词 + 中文 bigram）→ 每个 token 做 `blake2b(token, digest_size=8)` → 小端 uint64 → `index = value % dim`、`sign = bit63` → 权重 `1+ln(tf)` → L2 归一化。
- 维度默认 512；`embedder_id = hashing:hashed-ngram:512`。
- 索引文件：`vectors.npy`（float32 行归一化矩阵）、`ids.json`（chunk_id 顺序）、`manifest.json`（embedder_id/dim/count/updated_at）。
- 检索：余弦点积 → 与 BM25 候选做加权 RRF（`k=60`、vector 0.65 / keyword 0.35）→ 按 `score*(0.85+0.15*confidence)` 微调。

### 7.2 兼容性实测（TS 与 Python 逐字节一致）

- TS 重写了 `BLAKE2b`（Node 内置只有 blake2b512，无法复用 8 字节输出），与 `hashlib.blake2b(digest_size=8)` **对拍一致**（6 组向量）。
- 旧库 `embedding_cache` 中的 BLOB 与 TS 现算向量**逐分量误差 < 1e-6**（`tests/regression/legacy-db.test.ts`，真实旧库）。
- 旧 `manifest.json` 的 `embedder_id`/`dim` 与 TS 一致，索引可直接读取。

### 7.3 已知限制

- 哈希向量只有词汇级召回，**不能宣称语义检索质量提升**；本次未做离线评测集对比。
- 旧索引若含已删除 chunk 会报孤儿向量（一致性检查可见），需 `rebuild_index`。
- TS 的 `blake2b` 使用 BigInt 实现，批量写入时向量化比 numpy 慢（见 §9 性能）。

---

## 8. 测试、可用性与「只是接口」的部分

### 8.1 基线测试结果（重构前，实测）

```
python3 -m pytest dsh_autonomous_learning/tests -q
197 passed in 21.79s
```

覆盖：配置、状态机、存储、检索、SSRF、审批、预算、指纹、P1-P7 系列、工具 CLI、学习流。

### 8.2 功能真实性核对

| 能力 | 状态 | 证据/说明 |
| --- | --- | --- |
| SQLite 元数据、任务 DAG、幂等键 | **真实可用** | 197 测试 + 本次 TS 复刻并新增测试 |
| BM25（中文 bigram） | **真实可用** | 分词/检索测试；`tokens`/`chunk_lex` 与行同事务维护 |
| 特征哈希向量检索 | **真实可用（非语义）** | 与旧索引对拍；质量未评测 |
| 来源抓取（HTTP + SSRF） | **真实可用（受限）** | 端口 80/443/8080/8443、私有网段拦截、逐跳重定向检查 |
| 本地文档解析 | **部分** | `pypdf`/`python-docx`/`bs4` 为可选依赖；缺失时明确报错。TS 版只支持文本/Markdown/正则 HTML |
| 知识核验（证据门槛） | **真实可用** | 65 条状态机/核验测试；无证据 fail、观点不可 verified |
| 模型辅助（规划/抽取） | **模拟/未验证** | 默认 `provider=mock`；仓库内没有真实模型效果评测 |
| Web 搜索来源发现 | **接口存在、实现注入式** | 需要外部注入 search 通道；默认不联网 |
| 定时调度 | **代码存在、默认关闭** | `scheduler.enabled=false`；无后台常驻保证 |
| 代码/实验执行 | **真实但非沙箱** | 进程级隔离；Python 版仅 lab 模式；TS 版只支持 JavaScript |
| 向量「语义」质量 | **未验证/不成立** | 特征哈希 + 无评测，不能宣称语义 |
| 学习「掌握」判定 | **真实规则，非认知结论** | `goal_met` 只是量化指标；报告明确「不等于掌握」 |

### 8.3 已知缺陷（重构前）

1. **审批闸门失败放行**：`plugins/approval/index.js` catch 后 `next()`（fail-open）。
2. **失效知识仍可被 BM25 召回**：`invalidate_document` 不清理 `tokens`，`_allowed_ids` 不过滤 `invalidated_at`（调用方需自行传 filters）。
3. **无项目作用域的检索返回全库**：`_allowed_ids` 在无 `project_id/project_ids` 时返回所有 chunk，跨项目泄漏风险。
4. **相对路径写入绕过检查**：`_looks_like_path('evil.json') === False`，`export_knowledge` 可直接写 cwd。
5. **DNS rebinding 窗口**：先解析校验、再由 httpx 重新解析连接，两次解析可能不同。
6. **索引/元数据可静默漂移**：向量写入失败只记日志，`check_integrity` 才能发现。
7. **迁移顺序依赖**：字典字面序与数值序不一致，维护者容易改错。
8. **gapfix 幂等键含 gap_id**：每轮 `analyze(record=True)` 生成新 gap → 补充任务会累积。

---

## 9. 性能实测（同一台设备，真实旧库/等价数据）

| 指标 | Python v1.2 | TypeScript v2.0 | 说明 |
| --- | --- | --- | --- |
| 冷启动（加载引擎+打开库+索引） | **1,536 ms** | **415 ms** | TS 无 numpy/pydantic 等导入开销 |
| 检索延迟（5 chunk 旧库，24 次） | p50 0.46 ms / p95 0.99 ms | p50 4.45 ms / p95 10.5 ms | TS 查询向量化用 BigInt BLAKE2b，小语料下固定成本占比高 |
| 检索延迟（100 chunk，50 次） | p50 7.15 ms / p95 15.65 ms | p50 3.56 ms / p95 7.04 ms | 语料变大后 TS 反超 |
| 写入 100 chunk | 72.4 ms | 438 ms | TS 逐条 BLAKE2b + 索引落盘；已合并为单事务 |
| 读取 100 chunk | 9.2 ms | 17.1 ms | 量级相同 |
| 生产运行时依赖 | 7 个 PyPI 包 | **0 个外部包**（全 Node 内置） | 部署面显著缩小 |

> 测量方式：`python3` 与 `node` 各跑独立脚本，数据为旧库拷贝/同构 100 条合成数据；未做多次预热统计，数值仅代表本机单次运行。

---

## 10. 迁移可能造成的数据丢失/行为变化

| # | 风险 | 触发 | 处置 |
| --- | --- | --- | --- |
| R-01 | 向量空间混用 | 换 embedder/dim 但复用旧索引 | manifest 校验 + 显式报错要求 rebuild；本次保持 embedder_id 不变 |
| R-02 | 旧库 schema 高于代码 | 用户先升级插件再回退 | 迁移直接拒绝降级，不写库 |
| R-03 | 坏 JSON 解码差异 | 历史行 JSON 损坏 | 旧版→`None`，TS→空容器；已在审计标注，损坏行需人工核验 |
| R-04 | 失效知识的检索可见性 | 旧调用方未传 invalidated 过滤 | TS 默认排除 `invalidated_at<>''`（更严格，属行为收紧） |
| R-05 | 无作用域检索 | 旧调用方省略 project_id | TS 默认只返回 `visibility='global'`（安全收紧） |
| R-06 | 并发写 | 两个进程同时写 | WAL + `BEGIN IMMEDIATE` + busy_timeout 30s；仍有 `SQLITE_BUSY` 可能 |
| R-07 | 文档正文只存文件 | 只备份 DB 不备份 `documents/` | 备份清单含索引，不含 documents 目录；需整体备份 data 目录 |
| R-08 | 设置热生效 | 修改 `data/settings.json` | TS 每轮重读 mode/预算；dataDir 变更需重启 |
| R-09 | Python 运行时移除 | 依赖 Python 的 LAB 代码执行/PDF 解析 | 未迁移项已列在 migration-plan，功能明确报错而不是静默失败 |
| R-10 | 双入口双写 | 原生工具与 MCP 同时启用 | 默认只启用原生；MCP 需显式配置，且共用同一 DB（仍建议二选一） |

---

## 11. 安全发现（重构前）与修复

| ID | 严重度 | 位置 | 触发条件 | 影响 | 复现 | 修复 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | 高 | `plugins/approval/index.js:217-221` | 审批判定抛异常 | 高风险工具被自动放行（fail-open） | 让 `decideApproval` 抛错后调用 execute 工具 | 新插件 catch 后返回 `{kind:'ask'}`（fail-closed），见 `src/adapters/dsh/plugin.ts` |
| SEC-02 | 中 | `storage/vector_store.py:494` + `metadata_store.py:534` | 知识被 invalidate 后检索 | 已失效/被替代知识仍可能被 BM25 召回 | invalidate 后 `search_knowledge` 仍命中（未传 filters） | TS 默认过滤 `invalidated_at=''`，并在 invalidate 时移除向量 |
| SEC-03 | 中 | `storage/vector_store.py:534` | 调用方省略 project 作用域 | 跨项目知识泄漏 | 不传 project_id 调 search | TS 无作用域时只返回 `visibility='global'`，并测试隔离 |
| SEC-04 | 中 | `security/permissions.py:69` + `tools` 导出 | `export_knowledge` 传相对文件名（无 `/`） | 可写当前工作目录任意相对路径 | `export_knowledge(path="evil.json")` | TS 所有写路径都过 `PathPolicy.assertWritable`（含真实路径解析） |
| SEC-05 | 中 | `sources/reader.py:343` + `httpx` | 攻击者控制域名 DNS | 校验后 DNS 换地址（rebinding）→ 访问内网 | 控制 DNS 先返回公网再返回 127.0.0.1 | TS 将 DNS 结果作为 `lookup` 钉死到实际连接 |
| SEC-06 | 低 | `metadata_store.py:863` | 内部调用 `query()` | 可执行写型 PRAGMA | `db.query("PRAGMA journal_mode=DELETE")` | TS 保留只读前缀门禁；写 PRAGMA 仅内部显式调用 |
| SEC-07 | 低 | `core/state_machine.py` + 工具层 | 无（已验证安全） | 模型不能自称人工复核 | 检查：`verify_knowledge` 无 verifier 参数 | TS 服务层强制 `verifier:'system'`，人工复核仅用户侧可发起 |
| SEC-08 | 低 | `storage/metadata_store.py:724` | 嵌套事务 | 内层 commit 提前提交外层未完成写 | 审计记录可佐证 | TS 深度计数事务：内层不提交 |

> 说明：SEC-01 属于 Host 插件，Python 侧无法修复；新架构把审批放进同一进程并用失败关闭兜底。

---

## 12. 审计结论

1. v1.2 的核心能力（任务 DAG、BM25、证据核验、预算、审计）是**真实实现**，不是空壳；197 个测试可作行为基线。
2. 主要债务是**多语言 + 多入口 + 多份规则**，以及若干边界安全缺陷（fail-open、作用域、相对路径、DNS rebinding）。
3. 迁移必须保留：证据门槛、状态机、事务边界、审计、来源追踪、任务恢复；可以删除：重复的 BM25 实现、60 个工具包装、双份 URL 归一化、双练习执行器。
4. 语音/语义能力没有被证明，重构不得把它包装成「语义检索已提升」。
