# dsh-autolearn · DSH 自主学习插件

把「学习目标 → 有界学习任务 → 可追溯知识库 → 证据核验 → 冲突检测 → 评估报告」
做成 DeepSeek Harness 可用的插件：一个 Python 引擎 + 两个 Cordis 插件包。

> 状态：v1.1.0。Python 侧 **96 项 pytest 全过**；MCP 侧 63 个工具；
> assisted 高风险操作接 DSH 原生审批弹窗；插件页带设置卡。
> 仓库内不含任何机器专属绝对路径。

## 仓库结构

```
dsh_autonomous_learning/    # Python 引擎（可独立运行，也可作为 MCP stdio 服务器）
  core/ sources/ knowledge/ storage/ practice/ security/ tools/
  tests/                    # 96 项 pytest
  examples/                 # 端到端演示 + MCP 握手
  docs/                     # 交付报告、演示与测试输出
  plugin.py main.py config.py
plugins/autolearn/          # DSH 插件 1：注册 MCP 服务器 + 设置卡（bundle）
plugins/approval/           # DSH 插件 2：高风险调用审批闸门（Host 插件）
scripts/check-env.ps1       # 环境自检 + 安装提示（只打印，不写路径）
```

## 路径约定（没有硬编码路径）

运行期需要知道的“路径”全部来自环境变量或从插件自身位置推导：

| 变量 | 用途 | 缺省行为 |
| --- | --- | --- |
| `DSH_AL_WORKDIR` | 仓库根（MCP 行的 cwd / PYTHONPATH） | `process.cwd()` |
| `DSH_AL_HOME` | 引擎目录（data/ 所在） | 插件从自身位置向上查找 `dsh_autonomous_learning/` |
| `DSH_AL_PYTHON` | Python 解释器 | `python`（Windows）/ `python3`（其它） |
| `DSH_AL_SETTINGS_FILE` | 设置卡文件覆盖 | `<engine>/data/settings.json` |
| `DSH_AL_HOST_APPROVAL` | 是否把审批交给宿主 | MCP 行里固定为 `1` |

## pnpm 工作区

```bash
pnpm install      # 链接两个 plugins/* 工作区包，生成 pnpm-lock.yaml
pnpm test         # node 语法检查 + 审批判定 / 设置读写 / 设置路由 三个自测
pnpm py:test      # 96 项 pytest（需先 pnpm py:install）
```

两个插件是工作区包 `@local/dsh-autolearn`、`@local/dsh-autolearn-approval`。
发布 npm 前改 scope 并去掉 `private: true`。

## 快速开始（只用引擎）

```bash
python -m pip install -r dsh_autonomous_learning/requirements.txt
PYTHONPATH=. python -m dsh_autonomous_learning.main --home dsh_autonomous_learning project-create \
  --goal "学习外汇量化交易基础" --domain quant --plan
PYTHONPATH=. python -m dsh_autonomous_learning.main --home dsh_autonomous_learning run --project prj_xxx
PYTHONPATH=. python -m dsh_autonomous_learning.main --home dsh_autonomous_learning search --query "滑点"
```

Windows PowerShell 用 `$env:PYTHONPATH = (Resolve-Path .).Path` 代替 `PYTHONPATH=.`。

## 作为 DSH 插件安装

1. 克隆仓库到任意位置（不需要改任何源文件）；
2. 运行 `pwsh scripts/check-env.ps1` 自检（会打印安装命令）；
3. 在 DSH 里安装两个 bundle：
   - `plugin_manager install_bundle target=<repo>/plugins/autolearn`
   - `plugin_manager install_bundle target=<repo>/plugins/approval`
4. 重启 DSH（新模块代际），Agent 工具列表出现 `mcp__autolearn__*`（63 个）。

插件行通过 `!!js` 读取环境变量组装 MCP 配置；两个 Host 插件也会从自身位置
向上查找引擎目录。因此**仓库放哪都能跑**，只要保持 `plugins/*` 与
`dsh_autonomous_learning/` 的相对位置（或显式设置 `DSH_AL_HOME`）。

安装后：

- **工具**：`mcp__autolearn__create_learning_project`、`run_learning_round`、`search_knowledge` …
- **设置卡**：设置 → 插件 → 自主学习 → 运行模式 / 数据目录 / 每日预算；
  写入 `<engine>/data/settings.json`，引擎每轮开始前重读。
- **审批**：`execute` / `destructive`（以及 `update_knowledge` 等）弹 DSH 原生审批框；
  审批是 user-only，智能体没有自我授权工具。

## 测试

```bash
pnpm test                                   # 插件侧
python -m pytest dsh_autonomous_learning/tests   # 引擎侧（PYTHONPATH=仓库根）
```

期望：Node 三个自测全过；Python `96 passed`。

## 安全边界（如实）

- 代码执行是**进程级隔离**（独立目录、`-I`、环境变量白名单、超时、输出上限），
  **不是安全沙箱**；默认禁止执行不可信代码。
- 网络默认关闭；不绕过登录/付费墙；不下载未知可执行文件。
- 审批闸门 fail-closed：bundle 缺失、patch `disabled: true`、或代际心跳过期时，
  引擎退回本地 `confirmations approve` 流程。
- 不做 OCR、不做回测引擎；扫描版 PDF 与量化策略回测会明确报告“不支持/需外部工具”。

## 已知限制

- 语义向量默认是特征哈希（离线、确定性），同义改写召回有限；
  接入 embedding 服务后需 `rebuild_vector_index`。
- 真实 LLM 调用默认 mock，未在此仓库验证具体 provider。
- 审批弹窗的实际点击验收未包含在自动测试中。
- 设置卡模式/预算热生效；数据目录变更需重连 MCP 连接。

## 许可

未附许可证文件。若要公开发布，请先选择许可证（例如 MIT / Apache-2.0）后再公开仓库。
