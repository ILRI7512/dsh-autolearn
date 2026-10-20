"""P1-4 verified 状态守卫回归测试（对应审计报告 F-04 / K-01 / K-03 / K-04）。

v1.1.0 有三条零证据捷径：
1. ``manual_review``：``_normalize_evidence`` 无条件塞入条目自身来源，导致
   ``evidence_list`` 永不为空 → 恒为 PASS，连模型自述都能升级为 verified；
2. ``static_analysis``：只要代码里没有 eval/TODO 就 PASS；
3. ``update_knowledge``：``fields`` 直通数据库，可直接写 status=verified / confidence=0.99。

修复后：三条路径都不能单独把知识推到 verified。
"""

from __future__ import annotations

import pytest

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401


def test_manual_review_without_human_evidence_does_not_verify(runtime):
    """人工复核必须真的有人工证据，条目的自身来源不算。"""

    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="m1",
        content="对比度是界面可读性的基础指标。",
        knowledge_type="concept",
        source_quality=0.9,
        source_type="official_doc",
    )
    outcome = runtime.verifier.verify("m1", method="manual_review")
    assert outcome["status_after"] != "verified", outcome
    assert outcome["result"] != "pass", outcome


def test_manual_review_with_model_claim_does_not_verify(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="m2",
        content="某个概念的正确说法。",
        knowledge_type="concept",
        source_quality=0.95,
        source_type="official_doc",
    )
    outcome = runtime.verifier.verify(
        "m2", method="manual_review", evidence=[{"kind": "model_claim", "note": "模型认为正确"}]
    )
    assert outcome["status_after"] != "verified", outcome


def test_manual_review_with_user_evidence_can_verify(runtime):
    """真正的人工复核（verifier=user + 人工证据）仍然可以升级。"""

    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="m3",
        content="对比度要求不低于 4.5:1。",
        knowledge_type="concept",
        source_quality=0.9,
        source_type="official_doc",
    )
    outcome = runtime.verifier.verify(
        "m3",
        method="manual_review",
        evidence=[{"kind": "user_review", "actor": "user", "note": "已核对 WCAG 2.2 原文"}],
        verifier="user",
    )
    assert outcome["status_after"] == "verified", outcome


def test_static_analysis_cannot_verify_alone(runtime):
    """静态检查只能给 partial，不能单独支撑 verified。"""

    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="s1",
        content="计算移动平均的示例代码。",
        knowledge_type="code_example",
        source_quality=0.9,
        metadata={"code_blocks": [{"language": "python", "code": "def ma(xs, n):\n    return sum(xs[-n:]) / n\n"}]},
    )
    outcome = runtime.verifier.verify("s1", method="static_analysis")
    assert outcome["result"] != "pass", outcome
    assert outcome["status_after"] != "verified", outcome


def test_update_knowledge_rejects_state_fields(runtime):
    """update_knowledge 不得直接写状态/置信度字段。"""

    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="u1", content="待更新的知识内容。")
    for fields in (
        {"status": "verified"},
        {"verification_status": "verified"},
        {"confidence": 0.99},
        {"level": "L5"},
    ):
        with pytest.raises((ValueError, PermissionError)):
            runtime.versions.update("u1", fields=fields)

    chunk = runtime.metadata.get_chunk("u1")
    assert chunk["status"] == "pending_verification"
    assert chunk["verification_status"] == "unverified"


def test_update_knowledge_still_updates_content(runtime):
    """白名单不能把正常的内容更新一起挡掉。"""

    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="u2", content="旧的说明文字。")
    result = runtime.versions.update("u2", content="新的说明文字，内容确实变了。")
    assert result["chunk_id"] == "u2"
    chunk = runtime.metadata.get_chunk("u2")
    assert "新的说明文字" in chunk["content"]
    assert chunk["status"] == "pending_verification"
    assert chunk["version"] == 2
