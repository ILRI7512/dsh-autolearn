# 优化优先级清单

只列有证据的问题；状态：**fixed**（本轮修复）/ **open**（记录未做）/ **partial**。

## P0 — 安全 / 数据污染

| ID | 问题 | 位置 | 证据 | 影响 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-09 | IPv6 非规范写法绕过 SSRF | `security/network.ts` | 探针：`0:0:0:0:0:0:0:1`、`::`、`fec0::1`、`::ffff:7f00:1` 判为公网 | 可访问 loopback/site-local/映射内网 | 手写 IPv6 展开 + 位掩码分类 | fixed |
| SEC-10 | 无审批 hook 仍委托宿主放行 | `adapters/dsh/plugin.ts`、`security/permissions.ts` | 探针：无 `ctx.on` 时 delete 成功 | destructive 无审批执行 | 先 false，hook 成功后才 enable；异常 fail-closed | fixed |

## P1 — 证据链 / 数据完整性

| ID | 问题 | 位置 | 证据 | 影响 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-11 | JSON 对象数组解码成 `{}` | `infrastructure/database/database.ts` | 探针：evidence 读回 `{}` | 证据/标签结构损坏，质量与核验判断失真 | 按 JSON 实际类型解码 | fixed |
| LEARN-01 | 交叉来源永不生效 | `verifier.ts` + `store.findDuplicates` | 探针：两条独立来源仍 independence=1 | fact 类无法升级，证据链断裂 | 作用域内批量相似对 + 正确选另一侧 | fixed |
| SANDBOX-01 | 代码执行仅有进程隔离 | `practice/runner.ts` | 旧实现无文件/网络限制 | 不可信代码可读写宿主文件、联网 | 降权 + netns + Node Permission Model；能力不足失败关闭 | fixed |

## P2 — 一致性 / 性能

| ID | 问题 | 位置 | 证据 | 影响 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| PERF-01 | 重复检测 O(n²) 次向量化 | `store.findDuplicates` + `vector-index.ts` | 200/500/800：867/2357/4229 ms | 大库评估/缺口分析卡顿 | `similarPairs` 矩阵点积 + SQL 分组 | fixed（13.7–16.8×） |
| RET-01 | 只改标题不刷新向量 | `store.updateChunk` | 探针：vector 命中 0，keyword 命中 1 | 检索结果与知识内容不一致 | title/summary 变化也刷新 | fixed |
| RET-02 | 时效排序算了但没用 | `store.search` | 评测 q10：stale 排 1 | 旧结论覆盖当前结论 | 按最终分降序 | fixed |
| NET-01 | 复用死连接导致 socket hang up | `security/network.ts` | 本地 HTTP 连续用例复现 | 抓取偶发失败 | keepAlive:false Agent + 总 deadline | fixed |

## P3 — 可维护性 / 体验 / 文档

| ID | 问题 | 位置 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RET-03 | 缺失知识仍返回向量邻居 | `store.search`/vector | q11 返回 4 条无关 | 增加绝对相似度阈值或 `no_answer` 提示 | open |
| RET-04 | 查询向量不走 embedding_cache | `vector-index.search` | 每次查询重新哈希 | 传入 db 走缓存（重复查询收益） | open |
| LEARN-02 | 未标记文档被首个主题取走 | `orchestrator.taskExtract` | 5 主题 1 文档 → 仅 1 主题产出 | 设计主题分配/文档多主题策略 | open |
| LEARN-03 | 公式练习必然跳过 | `practice/generator.ts` | spec `expected: null` | 引入变量/期望值来源，或明确人工判分流程 | open |
| SEC-13 | 允许根为 `/` 时前缀判断边角 | `security/paths.ts` | 代码审查 | 规范化根为 `/` 的特判 | open |
| SEC-14 | 沙盒依赖宿主工具 | `security/sandbox.ts` | 能力探测 | 缺少 unshare/setpriv 时失败关闭；无内核级隔离 | open（设计边界） |
| ARCH-01 | 冲突检测内嵌在服务门面 | `application/services.ts` | 665 行，含 ~120 行领域逻辑 | 迁到 `domain/knowledge/conflicts.ts` | open |
| TEST-01 | 无 10+ 进程并发/磁盘满/长稳测试 | tests | 未执行 | 需要独立故障注入环境 | open |
| DOC-01 | README 测试数字随修复变化 | `README.md` | 148 → 162 | 本轮已更新 | fixed |

## 不做的事（有理由）

| 候选 | 决策 | 理由 |
| --- | --- | --- |
| 引入语义 embedding / 向量库 | 不做 | 固定集关键词已 100% Recall；无收益证据；部署/依赖成本高 |
| 语言迁移（TS↔Python） | 不做 | 当前双实现已界定：TS 默认、Python legacy；没有证据表明迁移能解决本轮问题 |
| 大规模拆分服务层 | 不做 | 没有性能/维护证据；优先修缺陷 |
| 删除重复检测/冲突检测 | 不做 | 它们承担证据与质量职责，删了会降低可靠性 |
| 自动合并近似重复 | 不做 | 有错误合并风险；当前只登记，保留人工裁定 |

## 修复顺序（实际执行）

1. 先写复现测试（5 个 vNext 回归用例全部先失败）。
2. 修 SEC-11 → SEC-09 → SEC-10 → LEARN-01 → RET-01 → PERF-01/RET-02 → NET-01。
3. 每步跑目标测试，最后全量回归。
4. 评测/性能脚本复跑，记录前后数字。
