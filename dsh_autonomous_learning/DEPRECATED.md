# ⚠️ Legacy：v1.2 Python 实现（非默认运行时）

本目录是 **v1.2 的 Python 引擎**，在 v2.0 中已不再是默认运行时：

- DSH 原生工具由 `src/`（TypeScript）提供，通过 `plugins/autolearn/index.js` 注册；
- `plugins/autolearn/cordis.patch.yml` 不再启动 Python MCP 子进程；
- 本目录保留的原因：PDF/DOCX 解析、模型辅助、调度等能力尚未迁移（见
  `docs/refactor/migration-plan.md`），需要时可作为对照与回退参考。

## 仍然可用

```bash
python3 -m pytest dsh_autonomous_learning/tests -q     # 197 passed（基线）
DSH_AL_HOME=$PWD/dsh_autonomous_learning python3 -m dsh_autonomous_learning.main --help
```

数据库 schema 与 v2.0 相同（v7），两个实现可以先后打开同一份 `data/metadata.sqlite3`；
**不要让两者同时执行学习任务**（虽然 SQLite 事务安全，但任务/审批语义各自独立）。

## 删除条件

满足 `docs/refactor/migration-plan.md` 的「删除 Python 的准入条件」后再整体删除本目录；
在此之前保留是**有意为之**，不是遗漏。
