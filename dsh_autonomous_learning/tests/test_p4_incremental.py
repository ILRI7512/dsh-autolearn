"""P4 增量 / 去重 / 来源追溯回归测试（对应审计 F-06 的完成态、SEC-06、K-07、S-20）。

v1.1.0 的问题：
- 来源没有稳定标识：同一 location 每轮插一行，表会膨胀；
- 不发条件请求（无 ETag/Last-Modified），每轮全量重下再靠解析后的哈希去重；
- 文档内容变化后，旧 chunk 不失效，v1/v2 并行存活且都可能带 verified；
- 批量去重只比向量，不比内容指纹（同内容不同标题 sim=0.909 会漏检）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dsh_autonomous_learning.core.orchestrator import LearningOrchestrator
from dsh_autonomous_learning.sources.metadata import normalize_location
from dsh_autonomous_learning.sources.reader import ReadResult, SourceReader

from .conftest import ensure_project, runtime  # noqa: F401


def _doc(home: Path, name: str, body: str) -> Path:
    path = home / "p4docs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


BODY_V1 = "# 滑点\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则收益会被系统性高估。\n"
BODY_V2 = "# 滑点\n滑点是指成交价与预期成交价之间的差额，还要叠加点差与佣金，回测漏算会显著高估收益。\n"


def test_normalize_location_is_stable():
    assert normalize_location("https://Example.com/a/?utm_source=x&b=1#frag") == "https://example.com/a?b=1"
    assert normalize_location("https://example.com/a") == normalize_location("https://example.com/a/")
    assert normalize_location("/tmp/../tmp/k.md") == "/tmp/k.md"


def test_same_location_reuses_source_row(orchestrator, runtime, home):
    """同一来源重复抓取是"更新"，不是"新增一行"。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "来源复用"})
    path = _doc(home, "s.md", BODY_V1)

    first = orchestrator.rt.reader.read(str(path), project_id="prj_test")
    orchestrator.ingest_document("prj_test", first, topic="滑点")
    second = orchestrator.rt.reader.read(str(path), project_id="prj_test")
    info = orchestrator.ingest_document("prj_test", second, topic="滑点")

    assert info["unchanged"] is True
    assert runtime.metadata.scalar("SELECT COUNT(*) FROM sources", (), 0) == 1


def test_changed_content_supersedes_old_chunks(orchestrator, runtime, home):
    """文档内容变化：旧文档与旧片段标 superseded，新内容重新提取。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "增量更新"})
    path = _doc(home, "s.md", BODY_V1)

    read = orchestrator.rt.reader.read(str(path), project_id="prj_test")
    orchestrator.ingest_document("prj_test", read, topic="滑点")
    orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    old_chunks = runtime.metadata.query_dicts("SELECT chunk_id FROM chunks WHERE invalidated_at=''")
    assert old_chunks, "第一版应当产出知识"

    # 内容改了，再抓一次
    path.write_text(BODY_V2, encoding="utf-8")
    read2 = orchestrator.rt.reader.read(str(path), project_id="prj_test")
    info = orchestrator.ingest_document("prj_test", read2, topic="滑点")
    assert info["superseded_documents"] >= 1

    live_old = runtime.metadata.query_dicts("SELECT chunk_id FROM chunks WHERE invalidated_at=''")
    assert live_old == [], "旧版本片段必须失效，不能与新版本并行存活"
    superseded = runtime.metadata.query_dicts("SELECT status FROM chunks WHERE invalidated_at<>''")
    assert superseded and all(r["status"] == "superseded" for r in superseded)
    # 旧数据保留（可追溯），不是删除
    assert runtime.metadata.scalar("SELECT COUNT(*) FROM chunks", (), 0) == len(old_chunks)

    # 新版本重新提取
    result = orchestrator._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    assert result["chunks_added"] >= 1
    assert runtime.metadata.scalar("SELECT COUNT(*) FROM chunks WHERE invalidated_at=''", (), 0) >= 1


def test_conditional_headers_from_previous_metadata():
    headers = SourceReader.conditional_headers({"etag": 'W/"abc"', "last_modified": "Wed, 21 Oct 2026 07:28:00 GMT"})
    assert headers["If-None-Match"] == 'W/"abc"'
    assert headers["If-Modified-Since"] == "Wed, 21 Oct 2026 07:28:00 GMT"
    assert SourceReader.conditional_headers(None) == {}
    assert SourceReader.conditional_headers({}) == {}


def test_not_modified_is_skipped_without_new_source(orchestrator, runtime, home, monkeypatch):
    """304（not_modified）时不重新入库、不新增来源行。"""

    ensure_project(runtime, "prj_test")
    orchestrator.metadata.update("projects", "prj_test", {"goal": "304"})
    path = _doc(home, "s.md", BODY_V1)
    read = orchestrator.rt.reader.read(str(path), project_id="prj_test")
    orchestrator.ingest_document("prj_test", read, topic="滑点")
    before = runtime.metadata.scalar("SELECT COUNT(*) FROM sources", (), 0)

    def fake_read(*args, **kwargs):
        return ReadResult(ok=False, location=str(path), not_modified=True, error="未修改")

    monkeypatch.setattr(orchestrator.rt.reader, "read", fake_read)
    task = {
        "project_id": "prj_test",
        "inputs": {"topic": "滑点", "locations": [str(path)]},
    }
    result = orchestrator._task_discover(task)
    assert result["sources_saved"] == 0
    assert runtime.metadata.scalar("SELECT COUNT(*) FROM sources", (), 0) == before
    assert any("未修改" in w for w in result["warnings"])


def test_only_one_live_chunk_per_content(runtime):
    """同一项目内同内容只能有一个活跃实体（去重在写入时完成，不靠事后比对）。"""

    from .conftest import make_chunk

    ensure_project(runtime, "prj_test")
    text = "对比度要求不低于 4.5:1，否则低视力用户无法辨认正文内容。"
    make_chunk(runtime, chunk_id="h1", content=text, title="标题甲")
    make_chunk(runtime, chunk_id="h2", content=text, title="标题乙")

    live = runtime.metadata.query_dicts(
        "SELECT chunk_id FROM chunks WHERE project_id='prj_test' AND invalidated_at=''"
    )
    assert len(live) == 1, live
    assert runtime.metadata.list_duplicates("prj_test"), "重复关系仍要登记"
