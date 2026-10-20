"""评估工具（检索质量、质量分布等）。

这些模块只读不写，用于给"优化前后"提供可重复的基线。
"""

from __future__ import annotations

from .retrieval_eval import RetrievalCase, run_retrieval_eval

__all__ = ["RetrievalCase", "run_retrieval_eval"]
