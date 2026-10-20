# 分阶段执行报告（实测记录）

所有结果均为本机实际运行输出；未测量的项明确标注。

---

## 阶段 A：审计与基线

**命令**

```bash
git tag -a baseline-python-v1.2 -m "审计基线"
python3 -m pytest dsh_autonomous_learning/tests -q
```

**结果**：`197 passed in 21.79s`（复跑 28.11s，波动来自设备负载）。
**产出**：`docs/refactor/audit.md`、`dependency-map.md`、`migration-plan.md`。
**已知问题**：审计阶段的真实模型效果、PDF/DOCX 解析质量未验证（无密钥；依赖为可选）。

---

## 阶段 B：TypeScript 基础架构

**改动**

| 文件 | 原因 |
| --- | --- |
| `package.json` / `tsconfig*.json` | 建立 strict TS 工程；ESM + 原生 TS 运行；构建输出 `dist/` |
| `src/core/{errors,types,ids,json,validation,config}.ts` | 错误模型、领域类型、指纹、运行时校验、配置 |
| `src/adapters/dsh/{tools,plugin}.ts` | 11 个原生工具定义 + 插件生命周期/审批 |

**命令与结果**

```bash
node .../tsc -p tsconfig.json        # PASS（strict，0 error）
node .../tsc -p tsconfig.build.json  # PASS，dist/ 46 个模块
```

**设计取舍**
- 不引入 zod：参数契约本来就是 JSON Schema，自写子集避免 profile link 后的依赖解析问题（测试覆盖 oneOf/嵌套/边界）。
- 不 import `@deepseek-ai/dsh-tools`：`ctx.tools.register` 接受原生 JSON Schema，去掉对宿主包的硬依赖。

---

## 阶段 C：基础模块迁移

**改动**：`infrastructure/database/*`、`domain/learning/repository.ts`、`security/{budget,audit,approval,permissions,paths,secrets}.ts`、`domain/learning/state-machine.ts`、`domain/knowledge/store.ts`（版本部分）。

**测试**

```bash
node --test tests/integration/database.test.ts tests/unit/budget.test.ts
```

**结果**：schema v0→v7、重复迁移幂等、JSON/BOOL 编解码、事务回滚、只读门禁、并发写、备份恢复、预算 6 类检查点全部通过。

**修复的旧缺陷**
- 嵌套事务会提前提交 → TS 用深度计数，内层不 commit。
- 预算耗尽后任务留在 `running` → TS 置回 `retrying`，下一轮可恢复。

---

## 阶段 D：核心功能迁移

**改动**：`infrastructure/{retrieval,embeddings,sources}/*`、`domain/knowledge/{extractor,quality,domains}.ts`、`domain/learning/{verifier,planner,gaps,evaluator,orchestrator,report}.ts`、`domain/practice/*`。

**测试**

```bash
node --test tests/integration/knowledge.test.ts tests/integration/learning.test.ts tests/security/verification.test.ts
```

**结果**
- 知识写入/读取/更新/版本回滚/删除/失效/去重/索引落盘：通过；
- 学习闭环 discover→extract→verify、去重导入、maxTasks、暂停项目拒绝运行、中断恢复、失败阻塞依赖：通过；
- 证据规则：无证据 fail、单来源不达标、公式正向 verified、观点不可 verified、模型不能自称人工复核：通过。

**关键兼容性证据**
- `tests/regression/legacy-db.test.ts`：真实 v1.2 数据库 + 索引可直接打开；`embedding_cache` 与 TS 向量逐分量误差 < 1e-6；manifest embedder_id 一致。

---

## 阶段 E：兼容层

**改动**：`application/services.ts`（11 个业务接口）、`adapters/dsh/*`、`adapters/mcp/server.ts`、`src/cli.ts`、`plugins/autolearn/{index.js,cordis.patch.yml}`。

**测试**

```bash
node --test tests/integration/adapters.test.ts tests/integration/cli.test.ts
```

**结果**
- 11 个工具注册/执行/参数失败结构化/危险工具 ask/卸载清理：通过；
- MCP：initialize、tools/list、tools/call、未知方法错误码；**真实子进程** stdio 往返：通过；
- CLI：pending→approve→单次消费、reject、diagnostics、search：通过。

**默认策略**：只启用原生工具；MCP 适配器需显式启动，避免双入口并发写同一 DB。

---

## 阶段 F：验证与清理

**全量命令与结果**

```bash
node .../tsc -p tsconfig.json           # PASS
node .../tsc -p tsconfig.build.json     # PASS
npm test                                # 148 tests / 31 suites / 0 fail / 22.4s
python3 -m pytest dsh_autonomous_learning/tests -q   # 197 passed（旧实现仍在，作为对照）
```

**未完成/受限项**
1. **真实 DSH profile 启动验证被阻塞**：在隔离 home 创建 headless profile 并安装插件后，DSH 因 `MISSING_CREDENTIAL: llm-deepseek` 在工具挂载前退出；用占位密钥时 provider 在会话启动阶段鉴权失败。**没有**修改用户现有 profile 来绕过。插件注册契约由真实 ctx 形状的集成测试覆盖；MCP 由真实子进程验证。
2. PDF/DOCX 解析、Python 代码执行、模型辅助、调度 tick、知识图谱/实验/检索评测：未迁移（见 migration-plan）。
3. `data/documents/` 正文文件不包含在 DB 备份清单内，需要整体备份 data 目录（已知风险 R-07）。
4. 批量写入性能低于 Python（见下表），未做 BLAKE2b 的 32 位优化。

---

## 重构前后对比（实测 + 统计）

| 指标 | 重构前 v1.2 | 重构后 v2.0 | 说明 |
| --- | --- | --- | --- |
| Python 业务代码 | 16,783 行（57 文件） | 0（未删除，legacy 保留） | 仍可运行，但默认路径不再调用 |
| TypeScript 业务代码 | 0 | **11,126 行（46 文件，含 src/index.ts 250 行）** | `src/` 全量 |
| 测试代码 | Python 3,667 行 / 197 用例 | TS 2,083 行 / **148 用例** | 旧测试仍可跑 |
| 生产运行时依赖 | 7 个 PyPI 包 | **0 个外部包**（Node 内置） | dev 仅 typescript/@types/node |
| 模型可见工具 | 60 | **11** | 危险动作独立入口 |
| 重复模块 | 9 处（audit §3） | 主要项已消除：BM25 1 套、URL 归一化 1 套、工具门面 1 套、练习执行 1 套 | 仍有报告/实验等未迁移能力 |
| 主要模块数 | 9 个目录 / 57 业务文件 | 6 个目录 / 46 文件（含 tests） | 边界单向、0 运行时循环 |
| 测试通过率 | 197/197 | 148/148 | 0 skip |
| 冷启动 | 1,536 ms | **415 ms** | 同机单次 |
| 检索延迟（旧库 5 chunk） | p50 0.46 / p95 0.99 ms | p50 4.45 / p95 10.5 ms | TS 小语料固定成本高 |
| 检索延迟（100 chunk） | p50 7.15 / p95 15.65 ms | p50 3.56 / p95 7.04 ms | 语料变大后 TS 更快 |
| 写入 100 chunk | 72.4 ms | 438 ms | TS BLAKE2b(BigInt) + 索引落盘 |
| 读取 100 chunk | 9.2 ms | 17.1 ms | 同量级 |
| 数据库 schema | v7 | v7（同 DDL） | 双向可读 |

> 未测量：真实模型调用成本/延迟、PDF/DOCX 解析速度、长期运行内存、并发 10+ 进程写入。

---

## 下一步（按优先级）

1. 在用户已授权的 DSH profile 中做一次真实工具调用（需要可用模型凭据）；
2. 迁移 PDF/DOCX（评估纯 JS 解析库或保留“转换后导入”的明确约束）；
3. 决策：模型辅助抽取/规划是否恢复（当前明确警告未实现）；
4. 调度 tick（无后台定时器前提下，由用户/宿主触发）；
5. 去重合并（`merge`）、知识图谱查询、实验运行器；
6. 删除 Python 前完成 2 周真实使用观察与回滚演练。
