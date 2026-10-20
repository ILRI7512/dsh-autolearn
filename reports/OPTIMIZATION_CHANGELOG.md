# 优化变更记录

每个修复：问题 → 先写的复现测试 → 最小改动 → 验证 → 回滚方式。
所有改动在 `audit/vnext-2026-10` 分支，未推送 main。

---

## 1. JSON 列形状（SEC-11）

- 文件：`src/infrastructure/database/database.ts`
- 改动：`decode` 改为 `JSON.parse` 后按实际类型返回；坏 JSON/null 才按列语义退化（数组列→`[]`，对象列→`{}`）。新增 `ARRAY_JSON_COLUMNS` 清单。
- 测试：`tests/regression/vnext-fixes.test.ts`「JSON 列中的对象数组必须读回数组」。
- 修复前：`Array.isArray === false`，值 `{}`。
- 修复后：数组原样返回；tags 等数组列不受 `{` 影响。
- 回归：knowledge/database/diagnostics 全过。
- 回滚：git revert 该文件改动；数据未被迁移，只是读取逻辑。

## 2. IPv6 SSRF（SEC-09）

- 文件：`src/security/network.ts`
- 改动：新增 `parseIPv6`（支持 `::`、IPv4 尾部、zone）与 `isPublicIPv6`；覆盖 ULA、链路本地、站点本地、多播、文档、Teredo、6to4、IPv4-mapped/compatible、NAT64；IPv4 判定复用。
- 测试：`tests/regression/vnext-fixes.test.ts`「非规范写法…」。
- 修复前：loopback/unspecified/site-local/mapped 判为公网。
- 修复后：全部拒绝；公网 IPv6 仍允许。
- 回归：network-approval、http-guard 全过。
- 回滚：git revert；没有数据变更。

## 3. 宿主审批时序（SEC-10）

- 文件：`src/adapters/dsh/plugin.ts`、`src/security/permissions.ts`、`src/index.ts`
- 改动：引擎先 `hostApproval=false`；hook 成功注册后 `engine.enableHostApproval()`；hook 注册异常保持本地确认；判定异常仍返回 ask。
- 测试：`tests/regression/vnext-fixes.test.ts`「没有 hook 时 destructive 不能放行」。
- 修复前：无 `ctx.on` 时删除成功。
- 修复后：返回 `APPROVAL_REQUIRED`，chunk 仍存在。
- 回归：adapters/network-approval/cli 全过。
- 回滚：git revert；不影响数据库。

## 4. 交叉来源证据（LEARN-01）

- 文件：`src/domain/knowledge/store.ts`、`src/domain/learning/verifier.ts`、`src/infrastructure/embeddings/vector-index.ts`
- 改动：
  - 新增 `VectorIndex.similarPairs(allowedIds, threshold, maxPairs, onlyIds)`；
  - `findDuplicates` 在作用域 id 集合内做批量相似 + 一次 SQL 指纹分组；
  - `chunkId` 模式返回与该片段相关的对；
  - verifier 取“另一侧”作为交叉来源。
- 测试：`tests/regression/vnext-fixes.test.ts`「同一说法的第二条独立来源」。
- 修复前：independence=1，fact 无法 verified。
- 修复后：independence≥2，满足门槛后 verified。
- 回滚：git revert；数据格式不变。

## 5. 标题变更刷新向量（RET-01）

- 文件：`src/domain/knowledge/store.ts`
- 改动：`updateChunk` 在 `title`/`summary` 变化时也刷新向量（索引文本包含 title×2）。
- 测试：`tests/regression/vnext-fixes.test.ts`「只改标题也必须刷新向量」。
- 修复前：vector 命中 0；修复后：命中 1。
- 回滚：git revert；旧索引仍可读。

## 6. 时效/最终分排序（RET-02）

- 文件：`src/domain/knowledge/store.ts`
- 改动：`formatResult` 增加时效因子（fresh 1.0 / aging 0.97 / unknown 0.95 / stale 0.7 / expired 0.4），只做排序微调；`search` 返回前按最终 `score` 降序。
- 测试：`tests/regression/vnext-fixes.test.ts`「current 必须排在 stale 之前」。
- 指标：评测 q10 rank 2→1；hybrid MRR 0.848→0.894，nDCG 0.842→0.876。
- 回滚：git revert；只影响排序，不影响存储。

## 7. 重复检测性能（PERF-01）

- 文件：`src/domain/knowledge/store.ts`、`src/infrastructure/embeddings/vector-index.ts`
- 改动：见 #4 的 `similarPairs`；精确重复从读整行改为 SQL 只取 `chunk_id/project_id/content_hash`。
- 指标（相同脚本/数据/阈值）：200 866.5→51.5 ms，500 2356.9→154.5 ms，800 4229.1→309.1 ms（13.7–16.8×）。
- 测试：knowledge 近似重复、vnext 交叉来源；结果集合一致。
- 回滚：git revert；索引格式不变。

## 8. HTTP 连接与总超时（NET-01）

- 文件：`src/security/network.ts`
- 改动：抓取使用 `keepAlive:false` 的 HTTP/HTTPS Agent；`requestOnce` 增加总 deadline（覆盖“响应头已到、body 不结束”），settle 后清理定时器；错误统一为 `AutolearnError`。
- 测试：`tests/security/http-guard.test.ts` 6 条（重定向、循环、体积、content-type、超时、DNS 钉死）。
- 修复前：连续本地服务用例出现 `socket hang up`。
- 修复后：全部通过；超时返回“请求超时”。
- 回滚：git revert；无数据变更。

## 9. 文档更新

- `README.md`：测试数量 148 → 162；说明本轮新增 reports/ 与脚本入口（保持简短）。
- 新增：`reports/` 12 份报告；`scripts/retrieval-eval.ts`、`scripts/performance-bench.ts`；3 个测试文件。
- 历史文档（`docs/refactor/phase-report.md`）中的 148 是当时快照，保留不篡改。

---

## 本轮变更文件（src/tests/scripts/docs）

- src：`security/network.ts`、`security/permissions.ts`、`adapters/dsh/plugin.ts`、`infrastructure/database/database.ts`、`infrastructure/embeddings/vector-index.ts`、`domain/knowledge/store.ts`、`domain/learning/verifier.ts`、`index.ts`
- tests：`tests/regression/vnext-fixes.test.ts`、`tests/security/http-guard.test.ts`、`tests/security/prompt-injection.test.ts`
- scripts：`scripts/retrieval-eval.ts`、`scripts/performance-bench.ts`
- docs/reports：本目录 12 份
- dist：重新构建（与 src 同步）

## 未包含的改动

- 未改数据库 schema、未迁移已有知识数据、未删除 legacy Python、未引入新运行时依赖、未推送远端。
