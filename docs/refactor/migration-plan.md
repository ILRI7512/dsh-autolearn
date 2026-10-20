# 迁移计划与执行状态（v1.2 → v2.0）

> 状态图例：✅ 完成并测试 · 🟡 部分迁移/受限 · ⬜ 未迁移（明确保留或后续）
> 原则：先建立行为基线，再迁移；不删除仍有调用者的实现。

---

## 阶段 A：审计与基线 ✅

| 交付 | 状态 | 证据 |
| --- | --- | --- |
| 保存 Git 基线 | ✅ | tag `baseline-python-v1.2`（`9c8face`） |
| 运行现有测试 | ✅ | `pytest`：**197 passed / 21.79s** |
| 行为盘点 | ✅ | `docs/refactor/audit.md`（60 工具、24 表、向量算法、真实/模拟清单） |
| 依赖地图 | ✅ | `docs/refactor/dependency-map.md` |
| 数据结构与旧库验证 | ✅ | `tests/regression/legacy-db.test.ts` 对真实旧库只读校验；向量逐分量对拍 < 1e-6 |
| 已知安全缺陷 | ✅ | audit §11（SEC-01..SEC-08） |

**未做**：没有对真实模型调用做效果基线（无可用密钥/不伪造）；未统计历史性能曲线（只测单次）。

---

## 阶段 B：TS 基础架构 ✅

| 交付 | 位置 |
| --- | --- |
| 严格 TypeScript（`strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`） | `tsconfig.json` / `tsconfig.build.json` |
| 统一错误模型（code/recoverable/details） | `src/core/errors.ts` |
| 运行时 Schema 校验（零依赖，JSON Schema 子集） | `src/core/validation.ts` |
| 配置（默认值/文件/环境/宿主设置卡；未知键报错） | `src/core/config.ts` |
| 领域类型（与旧库值逐字一致） | `src/core/types.ts` |
| ID/指纹（与 Python 逐字节一致） | `src/core/ids.ts` |
| 原生工具最小可运行版本 | `src/adapters/dsh/{tools,plugin}.ts` |
| DSH 注册契约验证 | `tests/integration/adapters.test.ts`（真实 ctx 形状） |

**决策**：不引入 zod。理由：工具参数本身必须是 JSON Schema；引入库会让插件在 profile link 后增加解析依赖，而手写子集已由 4 组测试覆盖（含 oneOf/嵌套/边界）。

---

## 阶段 C：基础模块迁移 ✅

| 旧模块 | 新模块 | 兼容性要点 |
| --- | --- | --- |
| `core/models.py` | `core/types.ts` + `ids.ts` | 枚举值/ID/指纹/归一化逐字一致 |
| `storage/metadata_store.py`（1,691） | `infrastructure/database/{schema,migrations,database}.ts` + `domain/learning/repository.ts` | DDL 原文、schema v7、迁移顺序、JSON/BOOL 编解码 |
| `core/budget.py` | `security/budget.ts` | 检查点与 dimension 语义一致；阈值差异已修（见 phase-report） |
| `security/audit.py` | `security/audit.ts` | 同表、脱敏、allow/deny 都记录 |
| `knowledge/version_manager.py` | `store.ts`（`chunk_versions` + rollback） | 更新即快照；回滚也计入版本 |
| `core/state_machine.py` | `domain/learning/state-machine.ts` | 迁移白名单、证据门槛、L0-L5 |
| `security/permissions.py` | `security/{permissions,approval,paths,secrets}.ts` | 风险矩阵；令牌作用域+TTL+单次；失败关闭 |

**验证**：迁移/事务/并发/备份恢复/JSON 解码（`tests/integration/database.test.ts`），预算（`tests/unit/budget.test.ts`）。

---

## 阶段 D：核心功能迁移 ✅ / 🟡

| 旧模块 | 新模块 | 状态 | 说明 |
| --- | --- | --- | --- |
| `storage/tokenizer.py` | `infrastructure/retrieval/tokenizer.ts` | ✅ | 停用词、bigram、`strip` 规则一致 |
| `storage/metadata_store.bm25_search` | `infrastructure/retrieval/bm25.ts` | ✅ | SQL 候选 + 内存打分，公式一致 |
| `storage/vector_store.py` | `knowledge/store.ts` + `embeddings/vector-index.ts` | 🟡 | 检索/去重/备份恢复已迁移；`merge` 去重合并未迁移 |
| `knowledge/verifier.py` | `domain/learning/verifier.ts` | ✅ | 证据规则、独立性、置信度、disputed 流转 |
| `knowledge/extractor.py` + `classifier.py` | `domain/knowledge/extractor.ts` | ✅（规则） | 模型提议未迁移 |
| `knowledge/quality.py` | `domain/knowledge/quality.ts` | ✅ | 8 分量权重一致 |
| `knowledge/partitions.py` + `domains/` | `domain/knowledge/domains.ts` | ✅ | 7 个内置领域、分区/可见性 |
| `knowledge/conflict_detector.py` | `application/services.ts`（冲突检测） | 🟡 | 数值/极性/否定规则已迁移；`scan(limit=300)` 的候选限制简化 |
| `knowledge/deduplicator.py` | `store.findDuplicates` + 服务层登记 | 🟡 | 检测/登记已迁移；merge 未迁移 |
| `sources/{discovery,reader,parser,metadata}.py` | `infrastructure/sources/*` | 🟡 | 文本/Markdown/正则 HTML；PDF/DOCX 未迁移 |
| `core/planner.py` | `domain/learning/planner.ts` | ✅ | 主题链/幂等键/优先级 |
| `core/gap_analyzer.py` | `domain/learning/gaps.ts` | ✅ | 覆盖等级与缺口规则 |
| `core/evaluator.py` | `domain/learning/evaluator.ts` | ✅ | 指标与未达标项 |
| `core/orchestrator.py`（1,390） | `domain/learning/orchestrator.ts` | 🟡 | 闭环/预算/恢复/失败阻塞已迁移；模型辅助与调度 tick 未迁移 |
| `core/reporter.py` | `domain/learning/report.ts` | 🟡 | Markdown+JSON；字段少于旧版 |
| `practice/task_generator.py` | `domain/practice/generator.ts` | ✅ | 公式/代码/自测；不可判分明确跳过 |
| `practice/test_runner.py` | `domain/practice/runner.ts` | 🟡 | 只执行 JavaScript；Python 执行明确拒绝 |
| `core/scheduler.py` | — | ⬜ | `schedules` 表保留，无自动 tick（避免后台定时器） |
| `core/model_adapter.py` | — | ⬜ | `model` 配置保留；`use_model` 返回明确警告 |
| `core/telemetry.py` | 控制台 telemetry/审计 | 🟡 | 无独立 JSONL 运行日志文件 |
| `knowledge/knowledge_graph.py` | — | ⬜ | `edges` 表保留；关系查询未暴露 |
| `practice/experiment_runner.py` | — | ⬜ | `experiments` 表保留 |
| `evaluation/retrieval_eval.py` | — | ⬜ | 评测集未迁移 |
| `main.py`（CLI） | `src/cli.ts` | 🟡 | 审批/诊断/检索/状态；项目创建等仍走工具 |

---

## 阶段 E：兼容层 ✅

| 目标 | 做法 | 验证 |
| --- | --- | --- |
| 原生 Tools 调 TS 引擎 | `adapters/dsh/tools.ts` → `AutolearnServices` | 11 工具执行/参数失败/审批 ask/卸载清理 |
| MCP 调同一引擎 | `adapters/mcp/server.ts` → 同一 `AutolearnServices` | 真实子进程 initialize/tools-list；JSON-RPC 错误码 |
| 避免双写 | 默认只注册原生工具；MCP 需显式启动 | `plugins/autolearn/cordis.patch.yml` 为空 patch |
| 避免双任务执行 | 同一 DB 事务 + 幂等键；未启用两个入口 | 文档明确「二选一」 |

**MCP 保留理由**：
1. 跨 Agent/跨语言互操作是既有用户场景（旧 profile 已接 `dsh-mcp-connector`）；
2. 协议层薄（~200 行）且不复制业务逻辑；
3. 默认关闭，不影响原生路径；
4. 何时删除：若连续两个版本没有外部 MCP 客户端使用，可按本文件「删除准则」移除。

---

## 阶段 F：验证与清理 🟡

| 项 | 状态 | 证据/说明 |
| --- | --- | --- |
| 全量测试 | ✅ | **145 tests / 0 fail**（重构后新增；旧 197 测试保留可跑） |
| 安全测试 | ✅ | SSRF/路径穿越/审批/证据/隔离 共 32 条 |
| 数据库迁移 | ✅ | v0→v7、重复迁移幂等、旧库打开 |
| 旧数据可读 | ✅ | `legacy-db.test.ts`（真实旧库） |
| 中断恢复 | ✅ | `recover()` 测试 |
| 插件加载/卸载 | 🟡 | 契约级 + 卸载释放 DB 已验证；真实 DSH profile 启动被模型凭据阻塞 |
| 删除 Python 业务代码 | ⬜ | **未删除**：PDF/DOCX、模型、调度等仍未迁移；先保留为 legacy 参考 |
| 删除旧适配层 | 🟡 | 旧 MCP 注册已从 bundle 移除；Python `plugin.py` 保留但不再被默认路径调用 |
| 依赖清理 | ✅ | 生产运行时 0 外部包；`@types/node`/`typescript` 仅开发 |
| README/文档 | ✅ | 本目录 + 根 README |

### 删除 Python 的准入条件（未满足前不删）

1. 上述 ⬜/🟡 项全部有 TS 等价实现并通过测试；
2. 至少一个真实使用周期内（建议 2 周）没有回退到 Python 的需求；
3. 旧库迁移脚本与回滚路径演练通过；
4. 用户明确确认后，按 `git rm` 删除并保留 tag 作为可恢复点。

### Python 代码当前定位

- 目录：`dsh_autonomous_learning/`（原样保留）
- 状态：**legacy / 非默认运行时**，仅供对照与未迁移能力参考
- 不再被 `plugins/autolearn` 调用；不会被 CI 默认执行
- 计划：完成剩余迁移后整体删除

---

## 回滚方案

| 场景 | 操作 |
| --- | --- |
| TS 插件异常 | 从 profile 移除 `@local/dsh-autolearn`（或改回旧 MCP patch），引擎数据格式未变，Python 可直接打开同一 DB |
| 数据库升级后回退 | schema v7 与旧版一致，未新增破坏性迁移；回退只需换回旧代码 |
| 索引损坏 | `system_maintenance(action=rebuild_index)`；旧索引文件被覆盖前可用备份恢复 |
| 恢复误操作 | `backup` 目录 + `verify_backup` + `restore`（自动 `.pre-restore` 安全副本） |
| 发布回退 | Git tag `baseline-python-v1.2` 可完整回到重构前 |
