"""P1-7 预算接线回归测试（对应审计报告 H-05 / SEC-04 / SEC-16）。

v1.1.0 的问题：``BudgetTracker.consume_llm`` 全仓没有调用者，``llm_calls`` 表
也没有任何写入方 —— 于是单轮模型调用上限、每日预算、单轮费用上限全部不生效，
``snapshot()`` 永远显示 0 次调用 0 成本，给使用者一种"很省"的错觉。
"""

from __future__ import annotations

import pytest

from dsh_autonomous_learning.core.budget import BudgetExceeded, BudgetTracker
from dsh_autonomous_learning.core.model_adapter import MockModel, ModelConfig


def _model(price_in: float = 0.0, price_out: float = 0.0) -> MockModel:
    return MockModel(
        ModelConfig(
            provider="mock",
            model="mock-1",
            price_input_per_1k=price_in,
            price_output_per_1k=price_out,
            rate_limit_per_min=600,
        )
    )


def test_model_calls_are_counted(runtime):
    """每次模型调用都要计入 tracker.state.llm_calls。"""

    tracker = BudgetTracker(runtime.config.learning, runtime.config.model, runtime.metadata, project_id="prj_test")
    model = _model()
    tracker.attach(model)
    try:
        model.complete("plan", "系统", "把目标拆成主题")
        model.complete("plan", "系统", "再拆一次")
    finally:
        tracker.detach()
    assert tracker.state.llm_calls == 2
    assert tracker.snapshot()["llm_calls"] == 2


def test_llm_calls_are_persisted(runtime):
    """调用要落 llm_calls 表，_today_spend / llm_usage 才有数据。"""

    tracker = BudgetTracker(runtime.config.learning, runtime.config.model, runtime.metadata, project_id="prj_test")
    model = _model(price_in=1.0, price_out=2.0)
    tracker.attach(model)
    try:
        model.complete("plan", "系统", "记录一次调用")
    finally:
        tracker.detach()
    rows = runtime.metadata.query("SELECT * FROM llm_calls")
    assert len(rows) == 1
    assert rows[0]["project_id"] == "prj_test"
    assert rows[0]["cost_estimate"] > 0


def test_call_limit_actually_blocks(runtime):
    """max_llm_calls_per_run 必须真的拦住第 N+1 次调用。"""

    runtime.config.learning.max_llm_calls_per_run = 2
    tracker = BudgetTracker(runtime.config.learning, runtime.config.model, runtime.metadata, project_id="prj_test")
    model = _model()
    tracker.attach(model)
    try:
        model.complete("plan", "系统", "第一次")
        model.complete("plan", "系统", "第二次")
        with pytest.raises(BudgetExceeded):
            model.complete("plan", "系统", "第三次")
    finally:
        tracker.detach()
    assert tracker.state.llm_calls == 3


def test_daily_budget_blocks(runtime):
    """每日预算耗尽后必须中断。"""

    runtime.config.learning.daily_budget_usd = 0.000001
    tracker = BudgetTracker(
        runtime.config.learning,
        runtime.config.model,
        runtime.metadata,
        project_id="prj_test",
        daily_spent=0.0,
    )
    model = _model(price_in=1.0, price_out=1.0)
    tracker.attach(model)
    try:
        with pytest.raises(BudgetExceeded):
            model.complete("plan", "系统", "这次调用会超预算")
    finally:
        tracker.detach()


def test_detach_stops_counting(runtime):
    tracker = BudgetTracker(runtime.config.learning, runtime.config.model, runtime.metadata, project_id="prj_test")
    model = _model()
    tracker.attach(model)
    model.complete("plan", "系统", "计入")
    tracker.detach()
    model.complete("plan", "系统", "不再计入")
    assert tracker.state.llm_calls == 1


def test_round_snapshot_reports_real_call_count(runtime, orchestrator):
    """run_round 的 budget.snapshot() 不再恒为 0（有模型调用时）。"""

    from dsh_autonomous_learning.tests.conftest import ensure_project

    ensure_project(runtime, "prj_test")
    runtime.metadata.update("projects", "prj_test", {"goal": "学习滑点与回测"})
    # 不预建任务：run_round 会用 use_model=True 自动规划，从而真的调用模型
    result = orchestrator.run_round("prj_test", max_tasks=1, use_model=True)
    assert result["budget"]["llm_calls"] >= 1, result["budget"]
    assert orchestrator.metadata.scalar("SELECT COUNT(*) FROM llm_calls", (), 0) >= 1


def test_search_without_project_id_only_sees_global(runtime):
    """未指定项目时，默认不得返回其他项目的私有知识。"""

    from dsh_autonomous_learning.tools import build_registry
    from dsh_autonomous_learning.tests.conftest import ensure_project, make_chunk

    ensure_project(runtime, "prj_a")
    ensure_project(runtime, "prj_b")
    make_chunk(runtime, chunk_id="priv_a", content="项目 A 的私有滑点结论。", project_id="prj_a")
    make_chunk(
        runtime,
        chunk_id="glob_b",
        content="项目 B 的公开滑点结论。",
        project_id="prj_b",
        visibility="global",
    )
    reg, _, _ = build_registry(runtime)

    scoped = reg.call("search_knowledge", {"query": "滑点", "top_k": 10})
    ids = [r["chunk_id"] for r in scoped["data"]["results"]]
    assert "priv_a" not in ids, ids
    assert "glob_b" in ids, ids

    explicit = reg.call("search_knowledge", {"query": "滑点", "top_k": 10, "include_all_projects": True})
    ids_all = [r["chunk_id"] for r in explicit["data"]["results"]]
    assert "priv_a" in ids_all and "glob_b" in ids_all, ids_all
