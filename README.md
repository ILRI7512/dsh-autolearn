# dsh-autolearn · DSH 自主学习插件

把「学习目标 → 有界学习任务 → 可追溯知识库 → 证据核验 → 冲突检测 → 评估报告」
做成 DeepSeek Harness 可用的插件：一个 Python 引擎 + 两个 Cordis 插件包。

> 状态：v1.1.0（本地开发）。Python 侧 **96 项 pytest 全过**；
> MCP 侧 63 个工具；assisted 高风险操作接 DSH 原生审批弹窗；插件页带设置卡。

## 仓库结构

```
engine/                     # Python 引擎（可独立运行，也可作为 MCP stdio 服务器）
  core/                     # 编排、规划、缺口、评估、状态机、预算、模型/向量适配
  sources/ knowledge/ storage/ practice/ security/ tools/
  tests/                    # 96 项 pytest
  examples/                 # 端到端演示 + MCP 握手
  docs/                     # 交付报告、演示与测试输出
  plugin.py main.py config.py
plugins/autolearn/          # DSH 插件 1：注册 MCP 服务器 + 设置卡（bundle）
plugins/approval/           # DSH 插件 2：高风险调用审批闸门（Host 插件）
scripts/relocate.ps1        # 把 patch/index.js 里的绝对路径改成本机路径
```

## 能力（对应设计文档 P1–P6）

| 阶段 | 内容 |
| --- | --- |
| P1 | 项目/计划、SQLite 元数据、向量库（SQLite + numpy + BM25）、解析提取、检索、报告 |
| P2 | 缺口分析、来源发现、证据核验、冲突检测、评估、补充任务、断点续跑、预算 |
| P3 | 练习任务、公式重算（AST 白名单）、受限代码执行、实验记录 |
| P4 | 定时任务、失败重试、恢复、时效管理、定期报告、停止条件 |
| P5 | 领域扩展接口（分区/模板/验证方法表），未实现具体领域插件 |
| P6 | 持久化任务队列、状态机、依赖、恢复、预算、调度 |

核心纪律：**未核验的内容不会当成事实**。`verified` 需要方法匹配 + pass + 证据，
且满足证据条数/独立来源/来源质量门槛；观点与假设永远不能升级为已验证事实。

## pnpm 工作区

仓库根是 pnpm workspace（`pnpm-workspace.yaml` 收 `plugins/*`），两个插件作为工作区包
`@local/dsh-autolearn` 与 `@local/dsh-autolearn-approval` 管理：

```bash
pnpm install      # 生成/更新 pnpm-lock.yaml，链接两个工作区包
pnpm test         # node 语法检查 + 审批判定 / 设置读写 / 设置路由 三个自测
pnpm py:test      # 96 项 pytest（需先 pip install -r engine/requirements.txt）
```

发布到 npm 前需要把 `@local/*` 改成你的 scope（例如 `@yourname/dsh-autolearn`），
并去掉 `private: true`；DSH 安装时仍用 `plugin_manager install_bundle <目录>`。

## 快速开始（只用引擎）

```bash
pip install -r engine/requirements.txt
python -m engine.main --help          # 需要把仓库根加入 PYTHONPATH
```

实际上包名是 `dsh_autonomous_learning`，因此：

```powershell
$env:PYTHONPATH = "<repo>/engine/.."   # 让 dsh_autonomous_learning 可导入
python -m dsh_autonomous_learning.main --home <repo>/engine project-create `
  --goal "学习外汇量化交易基础" --domain quant --plan
python -m dsh_autonomous_learning.main --home <repo>/engine run --project prj_xxx
python -m dsh_autonomous_learning.main --home <repo>/engine search --query "滑点"
```

> 注意：仓库里目录叫 `engine/`，但 Python 包名是 `dsh_autonomous_learning`。
> 若直接 `python -m engine.main` 会找不到包；请在仓库根执行并设置 `PYTHONPATH`，
> 或把 `engine/` 重命名为 `dsh_autonomous_learning/`。

## 作为 DSH 插件安装

1. 克隆仓库到本机，例如 `D:/dsh-autolearn`；
2. 改路径（二选一）：
   - 运行 `pwsh scripts/relocate.ps1 -Root D:/dsh-autolearn`；
   - 手改两个 patch：Python 可执行文件、`cwd`、`DSH_AL_HOME`、`PYTHONPATH`、`manifestPath`；
3. 在 DSH 里安装两个 bundle：
   - `plugin_manager install_bundle target=D:/dsh-autolearn/plugins/autolearn`
   - `plugin_manager install_bundle target=D:/dsh-autolearn/plugins/approval`
4. 重启 DSH（新模块代际），Agent 工具列表出现 `mcp__autolearn__*`（63 个）。

安装后：

- **工具**：`mcp__autolearn__create_learning_project`、`run_learning_round`、`search_knowledge` …
- **设置卡**：设置 → 插件 → 自主学习 → 运行模式 / 数据目录 / 每日预算；
  写入 `engine/data/settings.json`，引擎每轮开始前重读（模式与预算即时生效）。
- **审批**：`execute` / `destructive`（以及 `update_knowledge` 等）调用弹 DSH 原生审批框；
  审批是 user-only，智能体没有自我授权工具。

## 测试

```powershell
cd <repo>
$env:PYTHONPATH = (Resolve-Path .).Path
python -m pytest engine/tests
```

期望输出：`96 passed`。插件侧自测：

```powershell
node plugins/approval/decision_test.mjs   # 审批判定 8 条
node plugins/autolearn/settings_test.mjs  # 设置读写与校验
node plugins/autolearn/route_test.mjs     # 设置卡 HTTP 路由（GET/POST/400/405）
```

## 安全边界（如实）

- 代码执行是**进程级隔离**（独立目录、`-I`、环境变量白名单、超时、输出上限），
  **不是安全沙箱**；默认禁止执行不可信代码。
- 网络默认关闭；不绕过登录/付费墙；不下载未知可执行文件。
- 审批闸门 fail-closed：profile bundle 缺失、patch 里 `disabled: true`、或代际心跳过期时，
  引擎退回本地 `confirmations approve` 流程。
- 不做 OCR、不做回测引擎；扫描版 PDF 与量化策略回测会明确报告"不支持/需外部工具"。

## 已知限制

- 语义向量默认是特征哈希（离线、确定性），同义改写召回有限；接入 embedding 服务后
  需 `rebuild_vector_index`。
- 真实 LLM 调用默认 mock，未在本仓库验证具体 provider。
- 审批弹窗的实际点击验收未包含在自动测试中。
- 设置卡模式/预算热生效；数据目录变更需重连 MCP 连接。

## 许可

未附许可证文件。若要公开发布，请先选择许可证（例如 MIT / Apache-2.0）后再公开仓库。
