# 审计基线（vNext）

- 仓库：`dsh-autolearn`（本地 `/storage/emulated/0/A/DSHA/dsh-autolearn`）
- 基线提交：`2a519939106c99ae098154f4d681c049703347d6`（v2.0.0，main）
- 审计分支：`audit/vnext-2026-10`（从基线创建；未推送、未改 main）
- 基线记录时间：2026-10-20
- 运行环境：Node.js v24.19.0；SQLite（`node:sqlite`）3.53.3；无外部网络依赖；无模型 API 凭证

## 1. 工作区与保护措施

| 检查项 | 结果 |
| --- | --- |
| 审计开始时工作区 | 干净（`## main...origin/main`） |
| 是否创建隔离分支 | 是：`audit/vnext-2026-10` |
| 是否覆盖/删除用户文件 | 否 |
| 是否推送远端 | 否（本轮只提交本地分支） |
| 是否修改数据结构 | 否（schema 仍为 v7；无迁移） |
| 只读验证的数据 | 旧库兼容测试对仓库内 v1.2 数据做**只读**备份后校验 |

## 2. 基线测试（修改前）

| 命令 | 结果 |
| --- | --- |
| `tsc -p tsconfig.json`（strict） | 0 error |
| `npm test`（node:test） | **148 tests / 31 suites / 0 fail / 18.8s** |
| `pytest dsh_autonomous_learning/tests -q`（legacy） | **197 passed / 42.0s** |
| `tsc -p tsconfig.build.json` | 成功，`dist/` 47 个模块 |

基线日志：`/tmp/base-test.log`、`/tmp/base-tsc.log`、`/tmp/base-pytest.log`（会话内临时文件，未提交）。

## 3. 审计方法

1. **静态阅读**：`src/` 46 个模块、`tests/`、`plugins/`、`scripts/`、`dsh_autonomous_learning/`（legacy）。
2. **可执行探针**：对每个可疑行为写最小运行脚本（`/tmp/probes.ts` 等），先复现再修复。
3. **固定评测集**：`scripts/retrieval-eval.ts`（20 条知识 / 11 个问题 / 10 类场景）。
4. **性能基线**：`scripts/performance-bench.ts`（冷启动/写入/检索/去重/摄入/内存）。
5. **回归**：每个修复先加测试（`tests/regression/vnext-fixes.test.ts`、`tests/security/http-guard.test.ts`、`tests/security/prompt-injection.test.ts`），失败后再改代码。

## 4. 修复前探针结果（真实输出）

| 探针 | 修复前结果 | 判定 |
| --- | --- | --- |
| JSON 列对象数组解码 | `verification_evidence` 读回 `{}`（`typeof object`, `isArray false`） | **确认为缺陷** |
| IPv6 非规范写法 | `0:0:0:0:0:0:0:1`、`::`、`fec0::1`、`::ffff:7f00:1`、`64:ff9b::a00:1` 判为公网 | **确认为 SSRF 绕过** |
| 无审批 hook 时的插件 | `ctx.on` 不存在，`system_maintenance(delete_chunk)` 仍成功删除 | **确认为放行缺陷** |
| 交叉来源核验 | 两条同说法不同来源，`independence=1`，事实类无法升级 | **确认证据链断裂** |
| 标题变更后的向量 | 只改标题后 vector 检索命中 0（keyword 命中 1） | **确认索引不同步** |
| 时效排序 | `stale` 版本排在 `current` 之前（hybrid MRR 0.5） | **确认排序未生效** |
| 重复检测扩展性（200/500/800 条） | 866.5 / 2356.9 / 4229.1 ms | **确认 O(n²) 级瓶颈** |
| 多主题共享未标记文档 | 首个主题取走文档，其余主题 `documents_processed=0` | 确认覆盖限制（未修复，记录） |
| 公式练习 | 生成 spec `expected: null`，练习阶段必然跳过 | 确认能力限制（未修复，记录） |

## 5. 未验证 / 无法验证项

- **真实模型辅助**：当前实现没有模型调用路径，无法评估模型抽取/规划效果。
- **真实外部网络**：审计环境不保证外网可达，仅用本地 HTTP 服务器验证抓取策略。
- **PDF/DOCX**：TS 实现不支持，未做解析质量验证。
- **长期运行**：未做 24h+ 内存/句柄泄漏测试。
- **多进程并发压力**：只有 2 连接写入测试，没有 10+ 进程竞争测试。
- **检索语义质量**：固定集规模小，不能外推为通用语义能力。

## 6. 基线结论

当前实现的主体是可运行的：类型检查、171 项测试（含沙盒）、旧库兼容、MCP 子进程、CLI 均通过。但存在 2 个安全级缺陷、2 个数据/证据链缺陷、4 个一致性与性能缺陷；这些都有可复现证据，已在本轮修复（见 `OPTIMIZATION_CHANGELOG.md`）。
