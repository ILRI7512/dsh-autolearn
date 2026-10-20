"""P5 embedding 缓存 + 检索评估集回归测试（对应审计 S-15 / S-17 / 检索无基线）。

v1.1.0 的问题：
- 全仓没有 embedding 缓存：add / update / rebuild / search 每次都重新向量化，
  连查询字符串都每次重算；
- 没有任何检索评估集，检索质量变化无法度量（"优化后变好了"只能靠感觉）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from dsh_autonomous_learning.core.embedder import HashingEmbedder
from dsh_autonomous_learning.core.orchestrator import LearningOrchestrator
from dsh_autonomous_learning.core.models import Chunk
from dsh_autonomous_learning.evaluation import RetrievalCase, run_retrieval_eval
from dsh_autonomous_learning.storage.metadata_store import ChunkFilter
from dsh_autonomous_learning.storage.vector_store import KnowledgeStore

from .conftest import ensure_project, runtime  # noqa: F401


class CountingEmbedder(HashingEmbedder):
    """统计 embed() 调用次数与文本条数。"""

    def __init__(self, dim: int = 128) -> None:
        super().__init__(dim=dim)
        self.calls = 0
        self.texts = 0

    def embed(self, texts):
        self.calls += 1
        self.texts += len(list(texts))
        return super().embed(texts)


def _chunk(cid: str, content: str, title: str = "") -> dict:
    return Chunk(
        chunk_id=cid,
        project_id="prj_test",
        document_id="doc_1",
        title=title or cid,
        content=content,
        summary=content[:40],
        content_hash="",
    ).to_row()


def test_embedding_is_cached(runtime):
    """同内容第二次向量化不再调用 embedder。"""

    ensure_project(runtime, "prj_test")
    counting = CountingEmbedder()
    store = KnowledgeStore(runtime.metadata, Path(runtime.config.paths.index_dir) / "cachetest", counting)
    text = "滑点是指成交价与预期成交价之间的差额，回测必须计入。"
    first = store._embed_texts([text])
    calls_after_first = counting.texts
    second = store._embed_texts([text])
    assert counting.texts == calls_after_first, "命中缓存不应再调用 embedder"
    assert np.allclose(first, second)
    assert runtime.metadata.embedding_cache_stats(counting.embedder_id)["entries"] >= 1


def test_cache_is_keyed_by_embedder(runtime):
    """换向量器后 cache_key 不同，不会复用另一套语义空间的向量。"""

    ensure_project(runtime, "prj_test")
    a = HashingEmbedder(dim=64)
    b = HashingEmbedder(dim=128)
    store_a = KnowledgeStore(runtime.metadata, Path(runtime.config.paths.index_dir) / "k1", a)
    store_b = KnowledgeStore(runtime.metadata, Path(runtime.config.paths.index_dir) / "k2", b)
    text = "夏普比率衡量单位波动带来的超额收益。"
    store_a._embed_texts([text])
    store_b._embed_texts([text])
    assert store_a._cache_key(text) != store_b._cache_key(text)
    assert runtime.metadata.embedding_cache_stats(a.embedder_id)["entries"] >= 1
    assert runtime.metadata.embedding_cache_stats(b.embedder_id)["entries"] >= 1


def test_query_embedding_is_cached(runtime):
    ensure_project(runtime, "prj_test")
    counting = CountingEmbedder()
    store = KnowledgeStore(runtime.metadata, Path(runtime.config.paths.index_dir) / "qc", counting)
    store.add_chunks([_chunk("c1", "滑点会侵蚀策略的期望收益，回测必须计入。")])
    before = counting.texts
    store.search("滑点", ChunkFilter(project_id="prj_test"), top_k=3)
    after_first = counting.texts
    store.search("滑点", ChunkFilter(project_id="prj_test"), top_k=3)
    assert counting.texts == after_first, "同一个查询第二次不应重新向量化"
    assert after_first >= before


def test_cache_can_be_disabled(runtime):
    """cache=False 时必须每次都真算（给调试/对照用）。"""

    ensure_project(runtime, "prj_test")
    counting = CountingEmbedder()
    cfg = type("C", (), {"cache": False})()
    store = KnowledgeStore(
        runtime.metadata, Path(runtime.config.paths.index_dir) / "nocache", counting, None, cfg
    )
    store._embed_texts(["同一个文本"])
    store._embed_texts(["同一个文本"])
    assert counting.texts == 2


# --------------------------------------------------------------------------- #
# 检索评估集
# --------------------------------------------------------------------------- #
CORPUS = {
    "滑点.md": "# 滑点\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则策略收益会被系统性高估，实盘表现会明显劣于回测。",
    "回测.md": "# 回测\n回测必须在样本外数据上验证，否则过拟合会让历史收益完全失去参考价值，样本内调参越多，样本外衰减通常越严重。",
    "夏普.md": "# 夏普比率\n夏普比率衡量单位波动带来的超额收益，数值越高说明风险调整后的收益越好，但高夏普也可能是低波动假象。",
    "对比度.md": "# 对比度\n正文对比度要求不低于 4.5 比 1，大号文字可以放宽到 3 比 1，否则低视力用户在弱光环境下无法辨认文字。",
    "无障碍.md": "# 无障碍\n所有可交互元素必须有键盘焦点与可读标签，屏幕阅读器才能正确朗读，图标按钮需要额外的无障碍名称。",
    "杠杆.md": "# 杠杆\n杠杆会同时放大盈利与亏损，保证金不足时会触发强制平仓，仓位管理必须把强平距离纳入考虑。",
}

CASES = [
    RetrievalCase("滑点是什么", ["滑点"]),
    RetrievalCase("回测怎么避免过拟合", ["回测"]),
    RetrievalCase("夏普比率怎么理解", ["夏普"]),
    RetrievalCase("文字对比度要求", ["对比度"]),
    RetrievalCase("屏幕阅读器要什么", ["无障碍"]),
    RetrievalCase("杠杆风险", ["杠杆"]),
    RetrievalCase("保证金不足会怎样", ["杠杆", "保证金"]),
    RetrievalCase("样本外验证", ["回测"]),
]


@pytest.fixture()
def eval_store(runtime, home):
    ensure_project(runtime, "prj_eval")
    orchestrator = LearningOrchestrator(runtime)
    runtime.metadata.update("projects", "prj_eval", {"goal": "检索评估", "domain": "general"})
    for name, body in CORPUS.items():
        path = home / "evalcorpus" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body + "\n", encoding="utf-8")
        read = runtime.reader.read(str(path), project_id="prj_eval")
        assert read.ok, read.error
        orchestrator.ingest_document("prj_eval", read, topic=name.replace(".md", ""))
    result = orchestrator._task_extract({"project_id": "prj_eval", "inputs": {}}, use_model=False)
    assert result["chunks_added"] >= len(CORPUS) - 1, result
    return runtime.store


def test_retrieval_eval_baseline(eval_store):
    """评估集必须能跑出稳定指标，并作为后续检索改动的基线。"""

    report = run_retrieval_eval(
        eval_store,
        CASES,
        top_k=5,
        mode="hybrid",
        filters=ChunkFilter(project_id="prj_eval"),
    )
    assert report["cases"] == len(CASES)
    assert report["recall@5"] >= 0.85, report
    assert report["mrr"] >= 0.6, report
    assert report["empty_rate"] == 0.0, report
    # 明细要能定位失败用例，而不是只给一个总数
    assert len(report["per_case"]) == len(CASES)
    assert all("rank" in item for item in report["per_case"])


def test_retrieval_eval_detects_regression(eval_store):
    """故意用不存在的关键词时，指标必须掉下来（证明评估集不是恒真）。"""

    bogus = [RetrievalCase("完全不相关的查询词 zzzqqq", ["不存在的概念zzz"])]
    report = run_retrieval_eval(
        eval_store, bogus, top_k=3, mode="hybrid", filters=ChunkFilter(project_id="prj_eval")
    )
    assert report["recall@3"] == 0.0
    assert report["mrr"] == 0.0
