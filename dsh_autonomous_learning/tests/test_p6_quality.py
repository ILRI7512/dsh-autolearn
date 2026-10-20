"""P6 质量评估回归测试（对应审计 K-05 / K-11 / H-10 与第四阶段质量要求）。

v1.1.0 的问题：
- 质量只有一个 confidence，没有可解释分量；"来源可信、内容完整、时效、冲突"全靠人看；
- DomainSpec.quality_overrides 只是声明，核验器根本不读；
- practiced / evaluated（L4 / L5）是死状态：生产代码没有任何写入点。
"""

from __future__ import annotations

import pytest

from dsh_autonomous_learning.core.models import KnowledgeStatus, LearningLevel, VerificationRecord
from dsh_autonomous_learning.knowledge.verifier import chunk_from_dict
from dsh_autonomous_learning.core.orchestrator import LearningOrchestrator
from dsh_autonomous_learning.core.state_machine import compute_level, evidence_requirements
from dsh_autonomous_learning.knowledge.quality import WEIGHTS, assess_quality

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401


def test_quality_has_explainable_components(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="q1", content="滑点会侵蚀策略的期望收益，回测必须计入滑点成本。")
    row = runtime.metadata.get_chunk("q1")
    assessment = assess_quality(row, [])
    assert set(assessment.components) == set(WEIGHTS)
    assert 0.0 <= assessment.score <= 1.0
    assert assessment.basis and "最弱维度" in assessment.basis


def test_verified_chunk_scores_higher_than_unverified(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="qv", content="对比度要求不低于 4.5:1，否则低视力用户无法辨认。")
    make_chunk(runtime, chunk_id="qu", content="另一条尚未核验的说明，用于对比质量分。")
    runtime.metadata.update_chunk("qv", {"verification_status": "verified", "status": "verified"})
    verified = assess_quality(runtime.metadata.get_chunk("qv"), [])
    unverified = assess_quality(runtime.metadata.get_chunk("qu"), [])
    assert verified.score > unverified.score


def test_verification_persists_quality(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="qv2",
        content="对比度要求不低于 4.5:1。",
        knowledge_type="concept",
        source_quality=0.9,
        source_type="official_doc",
    )
    outcome = runtime.verifier.verify(
        "qv2",
        method="manual_review",
        evidence=[{"kind": "user_review", "actor": "user", "note": "已核对 WCAG"}],
        verifier="user",
    )
    assert outcome["status_after"] == "verified", outcome
    row = runtime.metadata.get_chunk("qv2")
    assert row["quality_score"] > 0
    assert isinstance(row["quality_components"], dict)
    assert row["quality_components"]["factuality"] >= 0.8


def test_domain_quality_overrides_are_applied():
    """量化领域的公式门槛比通用领域更严（由注册表声明，不是写死常量）。"""

    general = evidence_requirements("formula", "general")
    quant = evidence_requirements("formula", "quant")
    assert quant[2] > general[2], (general, quant)


def test_quant_formula_with_mid_quality_does_not_verify(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="qf",
        content="夏普比率 = (年化收益 - 无风险利率) / 年化波动率。",
        knowledge_type="formula",
        domain="quant",
        source_quality=0.65,  # 通用门槛 0.60 够，量化门槛 0.70 不够
        source_type="tech_doc",
    )
    outcome = runtime.verifier.verify(
        "qf",
        method="formula_recompute",
        expression="(0.12 - 0.02) / 0.1",
        variables={},
        expected=1.0,
        tolerance=1e-6,
    )
    assert outcome["status_after"] != "verified", outcome
    assert outcome["result"] in {"pass", "partial"}


def test_practice_success_promotes_to_practiced(runtime):
    """实践成功 → practiced（L4），以前这一步根本没有写入点。"""

    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="qp",
        content="夏普比率 = (年化收益 - 无风险利率) / 年化波动率。",
        knowledge_type="formula",
        source_quality=0.8,
        status="verified",
        verification_status="verified",
        level="L3",
    )
    orchestrator = LearningOrchestrator(runtime)
    status = orchestrator._mark_practiced("qp", method="formula_recompute", practice_id="pt_1")
    assert status == "practiced"
    row = runtime.metadata.get_chunk("qp")
    assert row["status"] == "practiced"
    assert row["level"] == "L4"


def test_evaluation_promotes_practiced_to_evaluated(runtime):
    ensure_project(runtime, "prj_test")
    make_chunk(
        runtime,
        chunk_id="qe",
        content="夏普比率 = (年化收益 - 无风险利率) / 年化波动率。",
        knowledge_type="formula",
        source_quality=0.8,
        status="verified",
        verification_status="verified",
        level="L3",
    )
    orchestrator = LearningOrchestrator(runtime)
    orchestrator._mark_practiced("qe", method="formula_recompute", practice_id="pt_2")
    promoted = orchestrator._mark_evaluated("prj_test", run_id="run_1", goal_met=True)
    assert promoted >= 1
    row = runtime.metadata.get_chunk("qe")
    assert row["status"] == "evaluated"
    assert row["level"] == "L5"


def test_level_follows_status(runtime):
    """level 必须由 status 推导，不能出现 L3 + pending 这种组合。"""

    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="ql", content="用于校验等级与状态一致性的一条知识。")
    row = runtime.metadata.get_chunk("ql")
    chunk = chunk_from_dict(row)
    assert compute_level(chunk, []) == "L2"
    runtime.metadata.update_chunk("ql", {"status": KnowledgeStatus.VERIFIED.value})
    chunk = chunk_from_dict(runtime.metadata.get_chunk("ql"))
    assert compute_level(chunk, []) == "L3"
    runtime.metadata.update_chunk("ql", {"status": KnowledgeStatus.PRACTICED.value})
    chunk = chunk_from_dict(runtime.metadata.get_chunk("ql"))
    assert compute_level(chunk, []) == "L4"
    runtime.metadata.update_chunk("ql", {"status": KnowledgeStatus.EVALUATED.value})
    chunk = chunk_from_dict(runtime.metadata.get_chunk("ql"))
    assert compute_level(chunk, []) == "L5"
    assert LearningLevel.L5.value == "L5"
    assert VerificationRecord is not None
