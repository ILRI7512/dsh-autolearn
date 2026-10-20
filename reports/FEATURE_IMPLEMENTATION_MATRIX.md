# 功能实现矩阵

状态口径：
- **verified**：有实现 + 自动化测试/运行证据
- **fixed**：本轮修复并有回归测试
- **partial**：实现存在但能力受限（明确说明）
- **not implemented**：只有表结构/接口或完全缺失

| # | 功能 | 入口 | 核心实现 | 调用方 | 输入 → 输出 | 异常处理 | 相关测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 创建学习项目与任务链 | `learning_create` | `orchestrator.createProject` / `planner.createPlan` | 原生工具、CLI、MCP | 目标/领域/深度 → 项目 + 4×主题任务 + 3 收尾任务 | 空目标/非法深度抛 `AutolearnError` | learning.test 项目/计划 | verified |
| 2 | 有界学习轮次 | `learning_run` | `orchestrator.runRound` | 原生工具、MCP、CLI | projectId/maxTasks → run 结果 + stop_reason | 预算/超时/失败分类；`recover` | learning.test、budget.test | verified |
| 3 | 资料发现 | `source_manage(discover)` | `infrastructure/sources/discovery.ts` | orchestrator、服务层 | 主题/显式地址/语料目录 → candidates | 不存在/付费墙转 warning；网络关闭跳过 | learning.test 去重导入 | verified |
| 4 | 资料读取（本地/HTTP） | `source_manage(read)` | `sources/reader.ts` + `security/network.ts` | dispatcher、服务层 | 地址 → ReadResult（正文/来源/质量/许可） | 体积/超时/SSRF/content-type 明确失败 | http-guard.test、network-approval | fixed |
| 5 | 文档解析/切块 | `learning_run(extract)` | `sources/parser.ts` | extractor | 文本/HTML/Markdown → sections/chunks | 空文本、未知扩展名、PDF/DOCX 明确报错 | parser-formula、learning.test | partial（无 PDF/DOCX） |
| 6 | 规则知识抽取与分类 | `learning_run(extract)` | `knowledge/extractor.ts` | orchestrator | 文档 + 项目 → drafts（pending_verification） | 零产出告警；短块跳过 | extraction/learning | verified |
| 7 | 内容指纹/幂等 | 全链路 | `core/ids.ts` / `makeChunkId` | store/extractor/verifier | 文本 → sha256 指纹 / 稳定 chunk_id | 空内容允许但保存工具要求 content/summary | validation、legacy-db | verified |
| 8 | 知识写入（行+倒排+向量） | `knowledge_manage(save)` | `knowledge/store.ts` | orchestrator、服务层 | drafts → chunks/tokens/vectors | 事务回滚；向量失败转 warning | knowledge.test、database.test | verified |
| 9 | 知识版本与回滚 | `knowledge_manage(update/rollback)` | store（chunk_versions） | 服务层 | chunkId/fields → 新版本 + 核验重置 | 版本不存在 NotFound | knowledge.test | verified |
| 10 | 知识失效/替代 | `knowledge_manage(invalidate)` | store.invalidateChunk | 服务层 | chunkId/reason → superseded | 需要权限（destructive） | knowledge.test | verified |
| 11 | 关键词检索（BM25） | `knowledge_search(mode=keyword)` | `retrieval/tokenizer.ts` + `bm25.ts` | store.search | 查询 → Top-K + 分数 | 空查询/空语料返回空 | tokenizer.test、retrieval-eval | verified |
| 12 | 向量检索（特征哈希） | `knowledge_search(mode=vector)` | `embeddings/*` + `vector-index.ts` | store.search | 查询 → 余弦 Top-K | 维度/manifest 不一致明确报错 | blake2b、npy、legacy-db | verified（非语义） |
| 13 | 混合检索与最终排序 | `knowledge_search` | store.search/fuse/formatResult | 服务层 | 查询 + filter → RRF + 时效/置信度排序 | 过滤为空返回 gap | retrieval-eval、vnext-fixes | fixed |
| 14 | 来源可追溯 | 全链路 | chunks.source_* / sources 表 | 检索结果、报告 | 来源 ID/URL/标题/许可 → 随结果返回 | 缺失时 warning | knowledge.test | verified |
| 15 | 证据核验（方法/门槛） | `knowledge_verify(verify)` | `learning/verifier.ts` + `state-machine.ts` | orchestrator、服务层 | chunkId/方法 → 结果 + 记录 | 无证据 fail；观点 unverifiable | verification.test | verified |
| 16 | 交叉来源自动收集 | 同上 | verifier.enrichEvidence + store.findDuplicates | verifier | 同主题相近片段 → 第 2 条独立来源 | 无候选时保持 partial | vnext-fixes | fixed |
| 17 | 公式重算 | `knowledge_verify(verify_formula)` | `practice/formula.ts` | verifier | 表达式+变量+期望 → pass/fail | 未知变量/函数/除零明确失败 | parser-formula | verified |
| 18 | 练习任务生成 | `learning_run(practice)` | `practice/generator.ts` | orchestrator | 已核验知识 → 公式/代码/自测任务 | 不可判分类型明确跳过 | 手工探针 | partial |
| 19 | 受限代码执行 | lab 模式 practice | `practice/runner.ts` | orchestrator | JS 代码 → 退出码/输出/产物 | 超时 kill、输出截断、语言拒绝 | 无自动化（lab 需审批） | partial（仅 JS，非沙箱） |
| 20 | 缺口分析 | `learning_run(gap_analysis)` / status | `learning/gaps.ts` | orchestrator、evaluator | 项目 → 覆盖率/缺口 | 空主题 coverage=[] | learning.test 间接 | verified |
| 21 | 学习评估与报告 | `learning_evaluate` | `evaluator.ts` / `report.ts` | 服务层 | 项目 → 指标/未达标 + md/json | 空库明确未达标 | learning.test | verified |
| 22 | 失败重试/阻塞/恢复 | `learning_run` | orchestrator/repository | 内部 | 任务失败 → retrying/failed + 阻塞依赖 | 次数上限；`recover` 超时 | learning.test | verified |
| 23 | 预算（任务/来源/调用/时长/费用） | `learning_run` | `security/budget.ts` | orchestrator | 用量 → stop_reason | 超限抛 BudgetExceededError | budget.test | verified |
| 24 | 高风险审批 | 原生工具 hook / CLI | `security/{permissions,approval}.ts` + plugin | 工具层 | 工具+参数 → ask 或令牌 | 失败关闭；单次令牌 | network-approval、vnext-fixes | fixed |
| 25 | 路径策略 | 读写文件 | `security/paths.ts` | reader/store/export | 路径 → 允许/拒绝 | realpath、`..`、符号链接 | network-approval | verified |
| 26 | SSRF/网络策略 | HTTP 读取 | `security/network.ts` | reader | URL → 目标地址/正文 | 私网/端口/重定向/体积/超时 | network-approval、http-guard | fixed |
| 27 | 密钥扫描与日志脱敏 | 写库/审计 | `security/secrets.ts` | permissions/audit | 文本 → 命中/脱敏 | 拒绝写入 | network-approval、prompt-injection | verified |
| 28 | 备份/恢复/一致性 | `system_maintenance` | store + database | 服务层 | 目录/清单 → 备份/校验/恢复 | 校验失败拒绝恢复 | database.test、diagnostics | verified |
| 29 | DSH 原生工具注册 | `plugins/autolearn/index.js` | `adapters/dsh/*` | DSH | ctx → 11 工具 + hook | 注册失败 log；卸载 close | adapters.test | verified（契约级） |
| 30 | MCP 兼容层 | `node dist/adapters/mcp/server.js` | `adapters/mcp/server.ts` | 外部 MCP 客户端 | JSON-RPC → 同一服务 | 未知方法/工具错误码 | adapters.test（真实子进程） | verified |
| 31 | CLI（用户侧审批） | `dist/cli.js` | `src/cli.ts` | 用户 | approve/reject/status/search | 未知 token 非零退出 | cli.test | verified |
| 32 | 模型辅助规划/抽取 | `use_model` 参数 | 无实现 | — | — → 明确 warning | 明确返回未迁移 | 无 | not implemented |
| 33 | 定时调度 | 表 `schedules` | 无 tick 实现 | — | — | — | 无 | not implemented |
| 34 | 知识图谱关系查询 | `edges` 表 | 无查询入口 | — | — | — | 无 | not implemented |
| 35 | 检索语义能力 | — | 特征哈希 | — | — | — | retrieval-eval | partial（词汇级） |

## 文档与实现一致性检查

| README/文档声明 | 实际 | 结论 |
| --- | --- | --- |
| 148 项测试（v2.0） | 基线 148；本轮修复后 162 | 旧声明不更新会漂移，已在本轮报告中以新数字为准 |
| 11 个原生工具 | `buildNativeTools` 返回 11 个，测试断言 | 一致 |
| schema v7 兼容 | `legacy-db.test.ts` 通过 | 一致 |
| 向量是特征哈希、非语义 | `hashing-embedder.ts` 注释与实现一致 | 一致 |
| 代码执行是进程级隔离 | runner 注释与 env 白名单 | 一致（不是沙箱） |
| "审批失败关闭" | v2.0 原实现有 2 处漏洞，本轮修复 | 修复后一致 |
| Python v1.2 legacy | `DEPRECATED.md` + 197 tests | 一致 |
