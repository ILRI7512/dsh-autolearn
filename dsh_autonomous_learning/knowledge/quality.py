"""知识质量评估（可解释、可复现、不靠模型自评）。

审计要求（第四阶段）质量评估至少要能说清：来源可信度、内容完整性、事实准确性、
时效性、重复/冲突、分类准确率、适用场景、可复用程度、实际验证结果。

这里的做法：每个维度单独打 0..1 的分，权重固定且公开，最终分只是加权和——
不是模型给的一个"感觉分"。所有输入都来自库里的真实字段（来源质量、核验记录、
结构化字段是否为空、时效标记、冲突状态），因此同一条知识重复评估结果稳定。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Sequence

#: 各维度权重（合计 1.0）。调整这里会改变排序倾向，但不会改变"有证据才高分"的方向。
WEIGHTS: Dict[str, float] = {
    "source_trust": 0.22,
    "completeness": 0.16,
    "factuality": 0.24,
    "freshness": 0.10,
    "non_duplication": 0.08,
    "classification": 0.06,
    "applicability": 0.08,
    "practice": 0.06,
}

_FRESHNESS_SCORE = {
    "fresh": 1.0,
    "aging": 0.7,
    "stale": 0.35,
    "expired": 0.1,
    "unknown": 0.5,
}


@dataclass
class QualityAssessment:
    score: float
    components: Dict[str, float] = field(default_factory=dict)
    basis: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"score": self.score, "components": dict(self.components), "basis": self.basis}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _freshness_score(chunk: Mapping[str, Any], now: Optional[datetime] = None) -> float:
    status = str(chunk.get("freshness_status") or "unknown")
    return _FRESHNESS_SCORE.get(status, 0.5)


def _completeness(chunk: Mapping[str, Any]) -> float:
    """结构化字段的填充程度（空字段越多，完整性越低）。"""

    def filled(key: str) -> bool:
        value = chunk.get(key)
        if isinstance(value, (list, tuple, dict)):
            return bool(value)
        return bool(str(value or "").strip())

    checks = ["summary", "source_url", "source_excerpt", "tags"]
    optional = ["core_principle", "reasoning", "application", "implementation"]
    base = sum(1 for key in checks if filled(key)) / len(checks)
    extra = sum(1 for key in optional if filled(key)) / len(optional)
    content = str(chunk.get("content") or "")
    length_score = _clamp(len(content) / 400.0)  # 400 字以上视为内容充实
    return _clamp(0.5 * base + 0.3 * extra + 0.2 * length_score)


def _factuality(chunk: Mapping[str, Any], records: Sequence[Any]) -> float:
    status = str(chunk.get("verification_status") or "unverified")
    passing = [
        r for r in records if getattr(r, "result", "") == "pass" and getattr(r, "evidence", None)
    ]
    if status == "verified":
        return 1.0 if passing else 0.8
    if status == "partial":
        return 0.55
    if status == "disputed":
        return 0.15
    if status == "failed":
        return 0.1
    return 0.25 if not passing else 0.45


def _classification(chunk: Mapping[str, Any]) -> float:
    metadata = chunk.get("metadata") or {}
    if isinstance(metadata, str):
        metadata = {}
    if metadata.get("classification_low_confidence"):
        return 0.45
    scores = metadata.get("classification_scores") or {}
    if scores:
        return _clamp(0.5 + min(1.0, max(scores.values(), default=0.0) / 6.0) * 0.5)
    return 0.6


def _applicability(chunk: Mapping[str, Any]) -> float:
    """可复用程度：有没有把"怎么用"写出来。"""

    hint = " ".join(
        str(chunk.get(key) or "") for key in ("application", "implementation", "core_principle")
    ).strip()
    if hint:
        return _clamp(0.6 + min(len(hint), 200) / 500.0)
    tags = chunk.get("tags") or []
    return 0.55 if tags else 0.4


def _practice(chunk: Mapping[str, Any], records: Sequence[Any]) -> float:
    methods = {getattr(r, "method", "") for r in records if getattr(r, "result", "") == "pass"}
    if methods & {"code_test", "experiment", "formula_recompute", "usability_test"}:
        return 1.0
    status = str(chunk.get("status") or "")
    if status in {"practiced", "evaluated"}:
        return 0.9
    return 0.2


def assess_quality(
    chunk: Mapping[str, Any],
    records: Optional[Sequence[Any]] = None,
    *,
    now: Optional[datetime] = None,
) -> QualityAssessment:
    """按公开权重评估一条知识，返回分数 + 分维度明细 + 依据说明。"""

    records = list(records or [])
    non_dup = 0.35 if str(chunk.get("conflict_status") or "") == "confirmed" else 1.0
    components = {
        "source_trust": _clamp(float(chunk.get("source_quality") or 0.0)),
        "completeness": _completeness(chunk),
        "factuality": _factuality(chunk, records),
        "freshness": _freshness_score(dict(chunk), now),
        "non_duplication": non_dup,
        "classification": _classification(dict(chunk)),
        "applicability": _applicability(dict(chunk)),
        "practice": _practice(dict(chunk), records),
    }
    score = sum(WEIGHTS[key] * components.get(key, 0.0) for key in WEIGHTS)
    weakest = min(components, key=lambda k: components[k])
    basis = (
        f"质量分 {round(score, 3)}（加权，见 WEIGHTS）；"
        f"最弱维度 {weakest}={round(components[weakest], 2)}；"
        f"核验状态 {chunk.get('verification_status') or 'unverified'}"
    )
    return QualityAssessment(score=round(_clamp(score), 3), components=components, basis=basis)


__all__ = ["QualityAssessment", "WEIGHTS", "assess_quality"]
