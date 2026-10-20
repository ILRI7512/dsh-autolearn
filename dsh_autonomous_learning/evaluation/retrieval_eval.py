"""检索质量评估集（可重复的基线）。

用法：

    from dsh_autonomous_learning.evaluation import RetrievalCase, run_retrieval_eval
    report = run_retrieval_eval(store, [RetrievalCase("滑点怎么算", ["滑点"]), ...])

指标：
- ``recall@k``：期望知识是否出现在前 k 条里；
- ``mrr``：第一个命中排名的倒数均值（越接近 1 越好）；
- ``precision@k``：返回结果中与期望相关的比例（近似误召回率的反面）；
- ``empty_rate``：完全没有返回结果的比例（应该接近 0，但"证据不足"时允许非 0）。

设计取舍：不按 chunk_id 做期望（那是实现细节），而是按"标题/摘要/正文里是否出现
期望关键词"判定命中——换切块策略时基线仍然可比。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from ..storage.metadata_store import ChunkFilter


@dataclass
class RetrievalCase:
    query: str
    expected: Sequence[str]
    note: str = ""

    def __post_init__(self) -> None:
        if not self.query.strip():
            raise ValueError("检索用例的 query 不能为空")
        if not self.expected:
            raise ValueError(f"用例 {self.query!r} 必须给出至少一个期望关键词")


def _matches(item: Dict[str, Any], keywords: Sequence[str]) -> bool:
    blob = " ".join(
        str(item.get(key) or "") for key in ("title", "summary", "content", "topic", "subtopic")
    )
    return any(keyword and keyword in blob for keyword in keywords)


def run_retrieval_eval(
    store: Any,
    cases: Sequence[RetrievalCase],
    *,
    top_k: int = 5,
    mode: str = "hybrid",
    filters: Optional[ChunkFilter] = None,
) -> Dict[str, Any]:
    """跑一遍评估集，返回可比较的指标与逐条明细。"""

    if not cases:
        raise ValueError("评估集不能为空")
    per_case: List[Dict[str, Any]] = []
    hits = 0
    reciprocal = 0.0
    precision_sum = 0.0
    empty = 0
    for case in cases:
        result = store.search(case.query, filters, top_k=top_k, mode=mode, include_content=True)
        items = list(result.get("results") or [])
        rank = 0
        matched = 0
        for position, item in enumerate(items, 1):
            if _matches(item, case.expected):
                matched += 1
                if not rank:
                    rank = position
        if not items:
            empty += 1
        if rank:
            hits += 1
            reciprocal += 1.0 / rank
        precision_sum += (matched / len(items)) if items else 0.0
        per_case.append(
            {
                "query": case.query,
                "expected": list(case.expected),
                "rank": rank,
                "returned": len(items),
                "matched": matched,
                "top_titles": [item.get("title", "") for item in items[:3]],
            }
        )
    total = len(cases)
    return {
        "cases": total,
        "top_k": top_k,
        "mode": mode,
        f"recall@{top_k}": round(hits / total, 4),
        "mrr": round(reciprocal / total, 4),
        f"precision@{top_k}": round(precision_sum / total, 4),
        "empty_rate": round(empty / total, 4),
        "per_case": per_case,
    }
