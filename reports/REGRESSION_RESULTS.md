# 回归验证结果

分支：`audit/vnext-2026-10`（基线 `2a519939106c99ae098154f4d681c049703347d6`）
所有命令在本机实际执行；日志在会话临时目录（未提交）。

## 1. 命令与结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc -p tsconfig.json --typeRoots …` | **0 error** |
| 构建 | `tsc -p tsconfig.build.json` | 成功（`dist/` 与 src 同步） |
| 全量测试 | `npm test` | **171 tests / 42 suites / 0 fail / 31.5s** |
| legacy Python | `pytest dsh_autonomous_learning/tests -q` | **197 passed / 23.4s** |
| 检索评测 | `node scripts/retrieval-eval.ts` | `reports/retrieval-eval.json` |
| 性能基准 | `node scripts/performance-bench.ts` | `reports/performance-benchmark.json` |
| 旧库兼容 | 包含在全量测试（`tests/regression/legacy-db.test.ts`） | 3 项通过（真实 v1.2 DB/索引） |
| MCP 子进程 | 包含在 `tests/integration/adapters.test.ts` | 真实 stdio initialize/tools-list 通过 |
| CLI | 包含在 `tests/integration/cli.test.ts` | pending/approve/reject/diagnostics/search 通过 |

## 2. 基线 vs 修复后

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| TS 测试数 | 148 | **171**（+23：6 vNext + 6 HTTP + 2 注入 + 9 沙盒） |
| 失败数 | 0 | 0 |
| 新增回归缺陷 | — | 6 个闭环缺陷先失败后通过 |
| `findDuplicates` 800 条 | 4,229 ms | **309 ms** |
| hybrid MRR（固定集） | 0.848 | **0.894** |
| hybrid nDCG | 0.842 | **0.876** |
| 旧库兼容 | 通过 | 通过（未改 schema/索引格式） |
| 依赖 | 0 运行时外部包 | 0（未新增） |
| 代码执行隔离 | 仅进程级 | strict 沙盒（降权+netns+Permission Model） |

## 3. 新增测试的“先失败”证据

修复前运行 `tests/regression/vnext-fixes.test.ts`：

```
✖ JSON 列中的对象数组必须读回数组
✖ 非规范写法的 loopback/unspecified/site-local/mapped 必须判为非公网
✖ 没有 tools/pre-execute hook 时，destructive 不能交给宿主放行
✖ 同一说法的第二条独立来源应被自动收集，事实类可升级
✖ 只改标题也必须刷新向量索引
5 failed / 0 passed
```

修复后同一文件 6/6 通过（新增时效排序用例）。

沙盒用例首次运行即 9/9 通过；另有 process 模式测试证明显式降级确实无沙盒（可读 `/etc/passwd`），避免“配置写了但没生效”。

## 4. 回归范围说明

- 数据库 schema / 迁移链未修改；旧库、旧索引文件读取测试仍通过。
- 公共工具接口（11 个工具名/参数）未变更；新增的只是内部方法与错误语义。
- 安全行为有收紧：
  - 无 hook 时 destructive 由“放行”改为“需要确认”；
  - 检索默认按最终分排序；
  - 时效只影响排序，不隐藏结果。
- 没有删除任何测试、没有弱化断言。

## 5. 环境依赖与可能波动

- 本地 HTTP 测试固定使用 8443（8080 在本机被占用；80/443 无权限）。若目标环境 8443 被占用，需要调整测试端口或改为可配置，但生产端口白名单不应放宽。
- 性能与评测是单次测量；测试套件本身没有时间断言，不受设备负载影响。
- 没有执行：真实外网抓取、真实模型、10+ 进程并发、磁盘满、长时间泄漏。

## 6. 复现命令

```bash
cd /path/to/dsh-autolearn
git switch audit/vnext-2026-10
pnpm install                 # 或 npm i -g typescript（不支持 symlink 的存储）
pnpm run typecheck
pnpm run build
npm test
python3 -m pytest dsh_autonomous_learning/tests -q
node scripts/retrieval-eval.ts
node scripts/performance-bench.ts
```
