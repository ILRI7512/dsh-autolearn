# 架构评审（vNext）

## 1. 实际架构（代码事实）

```
plugins/autolearn/index.js  ──import──> dist/adapters/dsh/plugin.js
        │                                      │ ctx.tools.register / ctx.on(pre-execute)
        └── 设置卡 API（data/settings.json）     ▼
                                     adapters/dsh/tools.ts（11 个 JSON Schema 工具）
                                                   │
外部 MCP 客户端 ──stdio JSON-RPC──> adapters/mcp/server.ts ──┐
用户 ──CLI──> src/cli.ts ────────────────────────────────────┤
                                                            ▼
                                              application/services.ts（唯一业务门面）
                                                            │
        ┌──────────────────┬──────────────────┬─────────────┴───────────┐
        ▼                  ▼                  ▼                         ▼
 domain/learning      domain/knowledge   domain/practice          security/*
 (repo/planner/        (store/extractor/    (generator/runner/     (permissions/approval/
  verifier/orchestr/    quality/domains)     formula)               paths/network/budget/
  gaps/evaluator/                                                   audit/secrets)
  report/state-machine)
        └──────────────────┴──────────────────┴─────────────┬───────────┘
                                                            ▼
                         infrastructure/{database,retrieval,embeddings,sources}
                                                            ▼
                                     node:sqlite + 文件系统 + HTTP (受策略约束)
```

- 运行时循环依赖：**0**（脚本扫描 46 模块）。
- `application/services.ts` 是唯一业务编排门面；适配层只做参数校验/截断。
- `index.ts` 是唯一依赖装配点；domain 层不 import index（仅一处类型依赖已移除）。
- 资源生命周期：插件 `ctx.effect` 返回 cleanup → 注销 hook/工具 → `engine.close()`。

## 2. 模块规模与职责

| 模块 | 行数 | 职责 | 评价 |
| --- | --- | --- | --- |
| `application/services.ts` | 665 | 11 个业务接口 + 冲突检测实现 | 偏大：冲突检测（~120 行）内嵌在门面里，属于 domain 逻辑 |
| `domain/learning/orchestrator.ts` | ~700 | run_round 闭环、任务分派、恢复 | 复杂度集中但内聚；每个任务 kind 一个私有方法 |
| `domain/knowledge/store.ts` | ~740 | 知识写入/检索/去重/备份 | 存储边界清晰；检索与存储同文件可接受（共享 SQL/事务） |
| `domain/learning/verifier.ts` | ~490 | 证据规则 | 单一职责，规则集中 |
| `infrastructure/security/network.ts` | ~430 | SSRF/DNS/HTTP | 安全逻辑集中，可单测 |
| `infrastructure/database/database.ts` | ~390 | 连接/事务/编解码/备份 | 通用层，无业务 |

## 3. 评审结论

### A. 职责混乱
- **未发现**插件反向依赖核心内部实现：插件只调用公开 `apply`/服务。
- **未发现**跨模块直接改内部状态：状态写入集中在 store/repo；`forceVerificationState` 是唯一受控的核验写入口。
- **存在**门面内嵌领域逻辑：冲突检测在 `services.ts`（P3，未拆）。
- 循环依赖：无。

### B. 抽象过度
- 没有为每个功能建工厂/接口；工具定义是数据 + 函数。
- `services.ts` 的 `define` helper 只做参数校验/截断/错误转换，有实际价值。
- 唯一明显的“转发层”是 `engine.assertPartitionAllowed` / `engine.bm25` 这类便利方法，使用频率低；未删除（影响面小，P3）。

### C. 抽象不足
- **已修复**：JSON 列形状靠字符串猜测 → 统一 JSON 解析（数据层契约）。
- **已修复**：向量索引文本字段变更未刷新 → 统一条件。
- **已修复**：交叉来源查询依赖每个 chunk 单独搜索 → 统一 `similarPairs`。
- 仍存在：`document.topic` 与 chunk.topic 的所有权规则不明确（见 LEARNING_PIPELINE_REVIEW）。
- 仍存在：搜索输出预算按结果逐条扣减，没有全局精确上限（P3）。

### D. 插件化
- 插件可独立测试：`tests/integration/adapters.test.ts` 用真实 ctx 形状验证注册/审批/卸载。
- 插件失败隔离：适配器抛错被 `describeError` 转结构化结果，不会让宿主进程崩溃；启动失败只禁用工具并记录。
- 插件配置校验：`loadConfig` 未知键报错；工具参数 JSON Schema + 运行时校验双重。
- 注册冲突：工具名固定 11 个；没有重复注册测试（宿主会报重复名）。
- 插件依赖未公开内部接口：否，只用 `ctx.tools/on/effect`。

## 4. 本轮架构决策（不做的重构）

| 候选 | 决策 | 理由 |
| --- | --- | --- |
| 把服务层拆成 11 个类 | 不做 | 当前 665 行、单一门面，拆分类会增加跨文件跳转，无证据表明是瓶颈 |
| 引入 DI 容器 | 不做 | 构造器注入已足够，新增框架增加依赖与启动成本 |
| 把检索拆出 store | 不做 | 检索与 SQL/事务/索引共享上下文，拆开会产生循环依赖 |
| 把冲突检测移到 domain | 记录为 P3 | 有边界价值，但本轮优先修复数据/安全问题；改动会动公开服务内部 |
| 引入语义 embedding | **不做** | 固定集显示关键词通道已很强，语义收益未被证明；新增模型会带来依赖/部署/离线问题 |
| SQL 拆成分层 repository | 不做 | 当前 SQL 集中在 store/repo，测试覆盖充分，拆分无收益 |
