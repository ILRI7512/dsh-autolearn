"""P2 学习流程真实化回归测试（对应审计报告 H-01 / H-02 / K-13 / T-02 / T-04）。

v1.1.0 的问题：
- ``_task_extract`` 取文档不按主题过滤，第一个 EXTRACT 吃光项目里所有 parsed 文档，
  其余主题的提取任务空转却记 completed（"按主题学习"是空壳）；
- 短文档被 ``min_chunk_chars`` 全跳过时没有任何 warning，文档仍标 extracted；
- 依赖任务永久失败后，下游任务永远停在 pending，项目静默停滞；
- ``run_round(max_tasks=...)`` 不设上限。
"""

from __future__ import annotations

import pytest

from dsh_autonomous_learning.core.models import TaskKind

from .conftest import ensure_project, runtime  # noqa: F401


def _write_doc(home, name: str, body: str):
    path = home / "p2docs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def _ingest(orchestrator, project_id: str, path, topic: str):
    read = orchestrator.rt.reader.read(str(path), project_id=project_id)
    assert read.ok, read.error
    return orchestrator.ingest_document(project_id, read, topic=topic)


def test_extract_is_scoped_to_task_topic(orchestrator, runtime, home):
    """每个主题的 EXTRACT 只处理属于该主题的文档。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "学习滑点与回测"})
    a = _write_doc(home, "a.md", "# 滑点\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则策略收益会被系统性高估。\n")
    b = _write_doc(home, "b.md", "# 回测\n回测必须在样本外数据上验证，否则过拟合会让历史收益完全失去参考价值，实盘表现会显著低于回测。\n")
    _ingest(orchestrator, "prj_test", a, "滑点")
    _ingest(orchestrator, "prj_test", b, "回测")

    first = orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    assert first["documents_processed"] == 1, first

    second = orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "回测"}}, use_model=False)
    assert second["documents_processed"] == 1, second

    titles = {row["title"] for row in runtime.metadata.query("SELECT title FROM chunks")}
    assert titles, "两个主题都应该产出知识"


def test_zero_yield_is_reported_not_silent(orchestrator, runtime, home):
    """提取 0 条必须是告警 + no_knowledge，而不是"完成任务"。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "短文档"})
    short = _write_doc(home, "short.md", "# 滑点\n滑点很重要。\n")
    _ingest(orchestrator, "prj_test", short, "滑点")

    result = orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    assert result["chunks_added"] == 0
    assert result["warnings"], "零产出必须带告警"
    assert result.get("reason"), "零产出必须说明原因"
    status = runtime.metadata.scalar("SELECT parse_status FROM documents")
    assert status == "no_knowledge"


def test_document_records_stage_progress(orchestrator, runtime, home):
    """文档要记录真实阶段（登记/获取/解析/提取）。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "阶段"})
    path = _write_doc(
        home,
        "s.md",
        "# 滑点\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则策略收益会被系统性高估。\n",
    )
    _ingest(orchestrator, "prj_test", path, "滑点")
    doc_id = runtime.metadata.scalar("SELECT document_id FROM documents")
    doc = runtime.metadata.get("documents", doc_id)
    stages = doc.get("stages") or {}
    assert stages.get("parsed") is True
    assert stages.get("fetched") is True

    orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    doc = runtime.metadata.get("documents", doc_id)
    stages = doc.get("stages") or {}
    assert stages.get("extracted") is True
    assert stages.get("indexed") is True


def test_failed_task_blocks_dependents(orchestrator, runtime):
    """依赖永久失败时，下游任务要被标 blocked 并写明原因。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "阻塞传播"})
    parent = orchestrator.metadata.create_task(
        {
            "task_id": "t_parent",
            "project_id": "prj_test",
            "kind": TaskKind.DISCOVER.value,
            "title": "父任务",
            "status": "pending",
            "max_retries": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )
    child = orchestrator.metadata.create_task(
        {
            "task_id": "t_child",
            "project_id": "prj_test",
            "kind": TaskKind.EXTRACT.value,
            "title": "子任务",
            "status": "pending",
            "depends_on": [parent["task_id"]],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
    )
    orchestrator._handle_task_failure(parent, RuntimeError("永远失败"))

    assert orchestrator.metadata.get_task("t_parent")["status"] == "failed"
    blocked = orchestrator.metadata.get_task(child["task_id"])
    assert blocked["status"] == "blocked", blocked
    assert "t_parent" in (blocked.get("error") or "")


def test_run_round_clamps_max_tasks(orchestrator, runtime):
    """max_tasks 不能突破配置上限。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "上限"})
    runtime.config.learning.max_tasks_per_run = 2
    result = orchestrator.run_round("prj_test", max_tasks=999)
    assert len(result["tasks_executed"]) <= 2


def test_task_kind_enum_has_no_dead_read_kind():
    """TaskKind.READ 是死枚举（编排器没有分支），已移除。"""

    assert not hasattr(TaskKind, "READ")


def test_task_timeout_stops_long_extract(orchestrator, runtime, home, monkeypatch):
    """timeout_s 必须在执行期生效：超时后不再处理剩余文档。"""

    import time as _time

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "超时"})
    for i in range(3):
        path = _write_doc(
            home,
            f"d{i}.md",
            f"# 主题{i}\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则收益会被高估（第{i}份）。\n",
        )
        _ingest(orchestrator, "prj_test", path, "滑点")

    real_extract = orchestrator.rt.extractor.extract

    def slow_extract(*args, **kwargs):
        _time.sleep(1.05)
        return real_extract(*args, **kwargs)

    monkeypatch.setattr(orchestrator.rt.extractor, "extract", slow_extract)
    result = orchestrator._task_extract(
        {"project_id": "prj_test", "inputs": {"topic": "滑点"}, "timeout_s": 1},
        use_model=False,
    )
    assert result["documents_processed"] < 3, result
    assert any("timeout_s" in w for w in result["warnings"]), result
