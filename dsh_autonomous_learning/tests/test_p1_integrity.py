"""P1-1 数据完整性回归测试（对应审计报告 F-01 / F-05 / S-13 / S-23）。

这些用例在 v1.1.0 上会失败：
- 覆盖式 upsert 把 verified/v3 打回 pending/v1；
- 部分列 upsert 会清空倒排索引；
- chunks 与 tokens 分属两个事务，中途失败留下半截数据；
- ``query("DELETE ...")`` 不提交，删除被静默回滚。
"""

from __future__ import annotations

import pytest

from dsh_autonomous_learning.core.embedder import HashingEmbedder
from dsh_autonomous_learning.core.models import Chunk
from dsh_autonomous_learning.storage.metadata_store import MetadataStore, StorageError
from dsh_autonomous_learning.storage.vector_store import KnowledgeStore

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401  (fixture 复用)


def _verified_chunk(chunk_id: str = "chk_v1") -> dict:
    return Chunk(
        chunk_id=chunk_id,
        project_id="prj_test",
        document_id="doc_1",
        title="滑点",
        content="滑点是指成交价与预期成交价的差额，回测必须计入。",
        knowledge_type="fact",
        status="verified",
        level="L3",
        version=3,
        verification_status="verified",
        verification_method="cross_source",
        evidence_count=2,
        evidence_independence=2,
        confidence=0.9,
        confidence_basis="两条独立来源一致",
        content_hash="hash_v1",
        source_id="src_a",
    ).to_row()


def test_metadata_rewrite_keeps_verified_status(runtime):
    """只改标题等元数据，不得清除核验状态与版本。"""
    ensure_project(runtime, "prj_test")

    runtime.store.add_chunks([_verified_chunk()])
    before = runtime.metadata.get_chunk("chk_v1")
    assert before["status"] == "verified" and before["version"] == 3

    # 模拟"重新提取/重复提交"：只给出少量字段，状态字段一个都不给，内容不变
    runtime.store.add_chunks(
        [
            {
                "chunk_id": "chk_v1",
                "project_id": "prj_test",
                "title": "滑点（新版标题）",
                "content": before["content"],
            }
        ]
    )

    after = runtime.metadata.get_chunk("chk_v1")
    assert after["status"] == "verified", "元数据更新不得把 verified 打回 pending"
    assert after["verification_status"] == "verified"
    assert after["version"] == 3
    assert after["evidence_count"] == 2
    assert after["confidence"] == pytest.approx(0.9)
    assert after["title"] == "滑点（新版标题）", "非状态字段应当被更新"

    # 再写一次纯元数据更新：指纹与状态都不应漂移
    runtime.store.add_chunks(
        [{"chunk_id": "chk_v1", "project_id": "prj_test", "subtopic": "成本"}]
    )
    again = runtime.metadata.get_chunk("chk_v1")
    assert again["content_hash"] == after["content_hash"]
    assert again["status"] == "verified" and again["version"] == 3


def test_content_change_resets_verification_with_snapshot(runtime):
    """实质内容变更：旧版本进快照，核验状态重新判断，不得沿用 verified。"""
    ensure_project(runtime, "prj_test")

    runtime.store.add_chunks([_verified_chunk()])
    before = runtime.metadata.get_chunk("chk_v1")

    runtime.store.add_chunks(
        [{"chunk_id": "chk_v1", "project_id": "prj_test", "content": "滑点还包括点差与佣金成本。"}]
    )

    after = runtime.metadata.get_chunk("chk_v1")
    assert after["version"] == before["version"] + 1, "内容变更必须升版本"
    assert after["status"] == "pending_verification", "内容变了必须重新核验"
    assert after["verification_status"] == "unverified"
    assert after["evidence_count"] == 0 and after["confidence"] <= 0.3
    assert after["level"] == "L2", "等级要跟着状态重算"

    versions = runtime.metadata.list_versions("chk_v1")
    assert versions and versions[0]["version"] == before["version"], "旧版本必须留快照"
    assert versions[0]["status"] == "verified"


def test_explicit_state_fields_from_caller_are_ignored(runtime):
    """调用方不能借普通写入把状态改掉（必须走状态机）。"""
    ensure_project(runtime, "prj_test")

    runtime.store.add_chunks([_verified_chunk()])
    runtime.store.add_chunks(
        [
            {
                "chunk_id": "chk_v1",
                "project_id": "prj_test",
                "title": "滑点",
                "content": "滑点是指成交价与预期成交价的差额，回测必须计入。",
                "status": "pending_verification",
                "verification_status": "unverified",
                "confidence": 0.1,
                "version": 1,
            }
        ]
    )
    after = runtime.metadata.get_chunk("chk_v1")
    assert after["status"] == "verified"
    assert after["verification_status"] == "verified"
    assert after["confidence"] == pytest.approx(0.9)
    assert after["version"] == 3


def test_partial_upsert_keeps_keyword_index(runtime):
    """部分列 upsert 不能把倒排索引清空。"""

    make_chunk(runtime, chunk_id="c_lex", content="夏普比率衡量单位波动带来的超额收益。")
    tokens_before = runtime.metadata.scalar("SELECT COUNT(*) FROM tokens WHERE chunk_id=?", ("c_lex",), 0)
    assert int(tokens_before) > 0

    runtime.metadata.upsert("chunks", {"chunk_id": "c_lex", "title": "夏普比率"})
    tokens_after = runtime.metadata.scalar("SELECT COUNT(*) FROM tokens WHERE chunk_id=?", ("c_lex",), 0)
    assert int(tokens_after) > 0, "只更新标题不应抹掉倒排"


def test_bulk_upsert_is_atomic(runtime):
    """批量写入中途失败必须整批回滚，不留半截数据。"""
    ensure_project(runtime, "prj_test")

    good = {
        "chunk_id": "c_ok",
        "project_id": "prj_test",
        "title": "正常",
        "content": "这是一条正常的知识。",
        "content_hash": "h_ok",
    }
    bad = {"project_id": "prj_test", "title": "缺少主键", "content": "没有 chunk_id"}
    with pytest.raises(StorageError):
        runtime.metadata.upsert_chunks_bulk([good, bad])
    assert runtime.metadata.get_chunk("c_ok") is None, "失败批次不得留下半截数据"


def test_query_rejects_write_statements(runtime):
    """只读通道拒绝写语句，防止"删了但没提交"。"""

    make_chunk(runtime, chunk_id="c_q", content="用来说明 query 通道只读。")
    with pytest.raises(StorageError):
        runtime.metadata.query("DELETE FROM chunks WHERE chunk_id=?", ("c_q",))
    assert runtime.metadata.get_chunk("c_q") is not None

    affected = runtime.metadata.execute_write("DELETE FROM chunks WHERE chunk_id=?", ("c_q",))
    assert affected == 1
    assert runtime.metadata.get_chunk("c_q") is None


def test_concurrent_writers_do_not_lose_vectors(tmp_path):
    """两个进程内实例写同一个索引目录时，不得互相覆盖。"""

    db = tmp_path / "meta.sqlite3"
    index_dir = tmp_path / "index"

    meta_a = MetadataStore(db)
    meta_a.migrate()
    meta_a.insert(
        "projects",
        {
            "project_id": "prj_c",
            "title": "并发",
            "goal": "并发写",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        },
    )
    store_a = KnowledgeStore(meta_a, index_dir, HashingEmbedder(dim=64))

    meta_b = MetadataStore(db)
    meta_b.migrate()
    store_b = KnowledgeStore(meta_b, index_dir, HashingEmbedder(dim=64))

    store_a.add_chunks([{"chunk_id": "c_a", "project_id": "prj_c", "title": "A", "content": "实例 A 写入的知识。"}])
    store_b.add_chunks([{"chunk_id": "c_b", "project_id": "prj_c", "title": "B", "content": "实例 B 写入的知识。"}])

    reloaded = KnowledgeStore(MetadataStore(db), index_dir, HashingEmbedder(dim=64))
    assert set(reloaded._ids) == {"c_a", "c_b"}, f"索引丢失向量: {reloaded._ids}"
    assert reloaded._matrix.shape[0] == 2


def test_duplicate_content_is_registered_at_write_time(runtime):
    """同内容不同来源：两条都保留，但重复关系必须落库，不能只报告。"""

    text = "完全相同的知识内容，用于验证写入时即登记重复关系。"
    make_chunk(runtime, chunk_id="d1", content=text)
    make_chunk(runtime, chunk_id="d2", content=text)
    rows = runtime.metadata.list_duplicates("prj_test")
    assert rows, "写入时就应登记 duplicates"
    assert {rows[0]["chunk_a"], rows[0]["chunk_b"]} == {"d1", "d2"}
    assert runtime.metadata.get_chunk("d1") and runtime.metadata.get_chunk("d2")
