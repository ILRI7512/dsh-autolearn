"""P1-5 指纹与唯一约束回归测试（对应审计报告 F-06 / S-04 / S-14）。

v1.1.0 的问题：
- ``content_hash = sha256(document_id + chunk)``：同一段文字换个文件就是不同指纹，
  跨文档去重永远不触发；
- ``chunks`` 表没有内容唯一约束，重复行可以真实产生；
- 迁移只有版本号没有步骤，``CREATE TABLE IF NOT EXISTS`` 会跳过已存在的表。

修复后：指纹只由正文决定；chunk_id = 项目 + 内容指纹；活跃片段按
(project_id, content_hash) 唯一；迁移可重复执行。
"""

from __future__ import annotations

import sqlite3

import pytest

from dsh_autonomous_learning.core.models import content_fingerprint, make_chunk_id
from dsh_autonomous_learning.knowledge.extractor import KnowledgeExtractor
from dsh_autonomous_learning.storage.metadata_store import MetadataStore

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401

TEXT = "夏普比率衡量单位波动带来的超额收益，回测必须扣除交易成本与滑点，并在样本外数据上复核结论。"


def test_fingerprint_ignores_document_id(runtime):
    extractor = KnowledgeExtractor(runtime.config.learning, None)
    project = {"project_id": "prj_test", "domain": "quant", "title": "测试"}
    doc_a = {
        "document_id": "doc_a",
        "title": "资料 A",
        "text": "# 夏普比率\n" + TEXT,
        "quality": 0.7,
        "source_type": "local_file",
    }
    doc_b = dict(doc_a, document_id="doc_b", title="资料 B")

    drafts_a = extractor.extract(project=project, document=doc_a)["drafts"]
    drafts_b = extractor.extract(project=project, document=doc_b)["drafts"]
    assert drafts_a and drafts_b
    assert drafts_a[0]["content_hash"] == drafts_b[0]["content_hash"], "同内容指纹必须一致"
    assert drafts_a[0]["chunk_id"] == drafts_b[0]["chunk_id"], "同内容同项目 → 同一实体 ID"


def test_chunk_id_is_content_derived_not_random():
    h = content_fingerprint(TEXT)
    assert make_chunk_id("prj_x", h) == make_chunk_id("prj_x", h)
    assert make_chunk_id("prj_x", h) != make_chunk_id("prj_y", h)


def test_reingest_same_content_is_idempotent(runtime):
    """同一内容重复入库：只有一条，版本不变，不产生重复行。"""

    ensure_project(runtime, "prj_test")
    payload = {
        "chunk_id": "chk_same",
        "project_id": "prj_test",
        "title": "夏普比率",
        "content": TEXT,
    }
    first = runtime.store.add_chunks([payload])
    second = runtime.store.add_chunks([payload])
    assert first["added"] == 1
    assert second["updated"] == 1 and second["added"] == 0
    assert runtime.metadata.count_chunks(__import__(
        "dsh_autonomous_learning.storage.metadata_store", fromlist=["ChunkFilter"]
    ).ChunkFilter(project_id="prj_test")) == 1


def test_unique_index_blocks_second_live_row(runtime):
    """活跃片段的内容唯一约束必须真的存在于数据库里。"""

    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="live_1", content=TEXT)
    live = runtime.metadata.get_chunk("live_1")
    with pytest.raises(sqlite3.IntegrityError):
        runtime.metadata.insert(
            "chunks",
            {
                "chunk_id": "live_2",
                "project_id": "prj_test",
                "title": "重复",
                "content": live["content"],
                "content_hash": live["content_hash"],
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            },
        )


def test_migration_v3_dedupes_and_preserves_history(tmp_path):
    """旧库里的重复活跃片段：迁移后只留一条活跃，其余标 superseded 且数据保留。"""

    db = tmp_path / "old.sqlite3"
    store = MetadataStore(db)
    store.migrate()
    store.insert(
        "projects",
        {
            "project_id": "prj_old",
            "title": "旧库",
            "goal": "迁移",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        },
    )
    # 模拟 v2 时代：两条同内容活跃片段（并绕过唯一索引）
    store.execute_write("DROP INDEX IF EXISTS uq_chunks_live_content")
    for cid, status, version in (("old_a", "pending_verification", 1), ("old_b", "verified", 2)):
        store.insert(
            "chunks",
            {
                "chunk_id": cid,
                "project_id": "prj_old",
                "title": "夏普比率",
                "content": TEXT,
                "content_hash": content_fingerprint(TEXT),
                "status": status,
                "version": version,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            },
        )
    store.execute_write("UPDATE meta SET value='2' WHERE key='schema_version'")
    store.close()

    reopened = MetadataStore(db)
    reopened.migrate()
    try:
        live = reopened.query(
            "SELECT chunk_id, status FROM chunks WHERE project_id='prj_old' AND invalidated_at=''"
        )
        assert len(live) == 1, [dict(r) for r in live]
        assert live[0]["chunk_id"] == "old_b", "保留 verified/高版本那条"
        archived = reopened.query(
            "SELECT chunk_id, status, superseded_by FROM chunks WHERE project_id='prj_old' "
            "AND invalidated_at<>''"
        )
        assert len(archived) == 1
        assert archived[0]["superseded_by"] == "old_b"
        assert archived[0]["status"] == "superseded"
        # 迁移可重复执行
        reopened.migrate()
        from dsh_autonomous_learning.storage.metadata_store import SCHEMA_VERSION

        assert reopened.scalar("SELECT value FROM meta WHERE key='schema_version'") == str(SCHEMA_VERSION)
    finally:
        reopened.close()
