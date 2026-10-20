# 自主学习闭环评审

## 1. 闭环逐段核对

| 阶段 | 实现 | 输入 → 输出 | 失败/超时 | 幂等/重复 | 恢复 | 证据保留 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 目标 | `learning_create` | goal/domain/depth → project | 空目标拒绝 | project_id 唯一 | 持久化 | — | verified |
| 规划 | `planner.createPlan` | project → 4×主题任务 + gap/evaluate/report | 已有任务返回现状 | 幂等键唯一索引 | 任务持久化 | acceptance 字段 | verified |
| 发现 | `taskDiscover` + discovery | topic/地址 → sources/documents | 网络/读取失败记 failures | 内容 hash 去重 | 失败来源落库 | source 行 + metadata | verified |
| 获取 | reader | 地址 → 文本 + 元数据 | 体积/超时/SSRF 明确失败 | 304 跳过；hash 相同 unchanged | document 行持久化 | 来源 URL/许可/时效 | fixed（本轮补 HTTP 测试） |
| 解析 | parser + chunkText | 文本 → sections/chunks | 空文本/未知格式明确报错 | 短块过滤 | 文档正文落文件 | source_excerpt | partial（PDF/DOCX 无） |
| 抽取 | extractor（规则） | 文档 → drafts（pending_verification） | 零产出告警 | 同文档 hash 去重；chunk_id 幂等 | 文档 stages 落库 | metadata 证据包 | verified |
| 核验 | verifier + state-machine | chunk → 结果/记录/状态 | 无证据 fail；观点 unverifiable | 每次核验写记录 | 失败转 disputed | verification_records | fixed（交叉来源） |
| 入库 | store.addChunks | drafts → chunks/tokens/vectors | 事务回滚 | 内容唯一索引 + chunk_id | — | source 字段 | verified |
| 质量 | quality.ts | chunk+records → score/components | 缺字段降级 | 每次核验刷新 | — | basis 可解释 | verified |
| 评估 | evaluator + gaps | project → 指标/缺口 | 空库明确未达标 | 可重复 | — | gaps 表 | verified |
| 报告 | report.ts | project → md/json | 写入失败抛错 | 文件名带时间戳 | — | 引用来源/缺口 | verified |
| 复用 | knowledge_search/verify | 查询 → 结果 + warnings | 空结果 gap | — | — | 来源/版本 | verified |

## 2. 本轮修复的闭环缺陷

### 2.1 交叉来源证据链断裂（P1）
- 位置：`domain/learning/verifier.ts::enrichEvidence` + `store.findDuplicates`。
- 现象：同说法、不同来源的两条知识，`source_check` 只收集 1 条来源；`fact` 要求 2 条独立来源，永远无法升级。
- 原因：`findDuplicates({chunkId})` 只把自身作为允许集合，向量邻居永远不会返回其他片段。
- 修复：`VectorIndex.similarPairs` 在作用域 id 集合内计算；`findDuplicates(chunkId)` 取同项目/主题候选并只返回与该片段相关的对；verifier 正确选择“另一侧”。
- 证据：`tests/regression/vnext-fixes.test.ts`（修复前 independence=1，修复后 ≥2 且 verified）。

### 2.2 时效排序从未生效（P2）
- 位置：`store.formatResult` + `store.search`。
- 现象：stale 版本排在 current 之前（评测 q10 rank=2）。
- 原因：分数里乘了时效/置信度，但返回顺序仍按融合排序。
- 修复：最终结果按 `score` 降序；时效只做排序微调，结果仍返回并带 warning。
- 证据：q10 修复后 rank=1；hybrid MRR 0.848→0.894。

### 2.3 标题变更后向量陈旧（P2）
- 位置：`store.updateChunk`。
- 现象：只改标题，keyword 能命中新标题，vector 命中 0。
- 原因：只有 content/metadata/tags 变化才刷新向量；索引文本含 title（重复 2 次）。
- 修复：title/summary 变化也刷新向量；回归测试覆盖。

## 3. 仍存在的闭环限制（未修复，明确记录）

1. **多主题共享未标记文档**：`taskExtract` 只处理 `parse_status='parsed'` 的文档；第一个主题的 extract 会把文档置为 `extracted`，其他主题看到 `documents_processed=0`。实测：5 个主题 + 1 篇未标记文档 → 只有首个主题产出 2 条知识，其余 extract 任务 `reason="没有属于主题…的待提取文档"`。
   - 影响：覆盖率偏低，但系统会在 gaps 中暴露缺口；不会伪造知识。
   - 可能方向：按内容分类分配主题 / 允许每主题独立处理但避免覆盖 topic。属于数据模型决策，未在本轮擅自改动。
2. **公式练习不可自动判分**：生成器在不知道变量的情况下写入 `expected: null`，practice 阶段必然跳过（`缺少期望值，无法重算`）。实测生成 spec 确认。
   - 影响：formula 类知识难以自动进入 L4/L5；不伪造通过，属于诚实降级。
3. **概念/流程类练习**：`self_check` 只生成问题，不自动判分（设计如此），所以 L4/L5 需要人工或代码执行证据。
4. **重试没有退避**：retrying 任务在同一轮内立即重试，直到 attempts 用尽；会消耗任务预算。未发现数据错误，但成本可优化（P3）。
5. **模型辅助缺失**：`use_model=true` 明确返回 warning，不做任何模型调用，因此“模型抽取/规划质量”无法评估。
6. **训练/评测泄漏**：没有模型训练，不适用；检索固定集是人工构造的，不参与抽取流程。

## 4. 学习质量判断（只依据可测项）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 是否只是搜索并保存文章？ | 否 | 有切块、规则抽取、分类、证据包、核验、状态机 |
| 是否区分事实/推断/建议？ | 部分 | 分类器区分 fact/hypothesis/opinion；观点永不 verified |
| 是否检查时效？ | 是（记录 + 排序微调） | freshness_status + 本轮排序修复 |
| 是否保留来源与版本？ | 是 | source_id/url/title/version/versions 表 |
| 是否处理冲突？ | 部分 | 数值/极性/否定检测，登记 conflicts；未自动裁定 |
| 是否区分已学习/已验证/已掌握？ | 是 | status(L1-L5) 由证据推导；`goal_met` 明确不等于掌握 |
| 能否在新场景应用？ | **未验证** | 没有独立迁移测试集；练习只做重算/执行 |
| 是否模型自评循环？ | 否 | 无模型调用；核验靠证据门槛与确定性公式 |
| 能否识别缺口并生成任务？ | 是 | gaps + evaluate 生成补充任务（有幂等键） |
| 重复知识？ | 部分 | 内容指纹 + 唯一索引；近似重复只登记不合并 |

## 5. 结论

闭环是真实实现而不是“搜索+保存”：抽取、核验、状态机、缺口、评估都在执行。但“掌握”仍受限于练习覆盖（公式 expected 缺失、概念自评不能自动判分）与主题分配策略。本轮修复了证据链和排序两个直接影响学习结果的问题；其余限制保持诚实暴露，不包装为已完成能力。
