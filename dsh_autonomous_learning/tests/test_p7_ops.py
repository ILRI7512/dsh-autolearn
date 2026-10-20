"""P7 日志 / 缓存淘汰 / 备份校验回归测试（审计 P7、S-22、S-15 的收口）。

v1.1.0 的问题：
- 没有结构化运行日志：任务/预算/失败只能靠代码猜；
- embedding 缓存（P5 新增）没有淘汰策略，表会无限增长；
- 备份清单不含 schema 版本与校验和，恢复也不做校验；
- restore 先 close() 再 copy，复制失败后连接不再恢复。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dsh_autonomous_learning.core.telemetry import JsonlLogger, build_logger
from dsh_autonomous_learning.storage.metadata_store import SCHEMA_VERSION
from dsh_autonomous_learning.storage.vector_store import KnowledgeStore

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401


# --------------------------------------------------------------------------- #
# 结构化日志
# --------------------------------------------------------------------------- #
def test_logger_writes_jsonl(tmp_path):
    logger = JsonlLogger(tmp_path / "logs" / "agent.jsonl")
    logger.log("task.started", task_id="t1", kind="extract")
    logger.log("task.completed", task_id="t1", new_knowledge=2)
    rows = logger.read()
    assert [r["event"] for r in rows] == ["task.started", "task.completed"]
    assert rows[0]["ts"].endswith("Z")
    assert rows[1]["new_knowledge"] == 2
    assert logger.stats()["entries"] == 2


def test_logger_never_raises(tmp_path):
    """日志写不进去也不能影响业务。"""

    target = tmp_path / "blocked"
    target.mkdir()
    logger = JsonlLogger(target)  # 目录当文件路径 → 打开会失败
    assert logger.log("boom", level="ERROR") is None
    assert logger.failures == 1


def test_round_emits_structured_events(runtime, orchestrator):
    ensure_project(runtime, "prj_test")
    runtime.metadata.update("projects", "prj_test", {"goal": "日志"})
    orchestrator.run_round("prj_test", max_tasks=1)

    events = [row["event"] for row in runtime.telemetry.read()]
    assert "task.started" in events
    assert "run.finished" in events
    last = [r for r in runtime.telemetry.read() if r["event"] == "run.finished"][-1]
    assert last["run_id"] and "stop_reason" in last
    assert "tasks" in last and "llm_calls" in last


def test_logger_can_be_disabled(runtime):
    logger = build_logger(
        type("C", (), {"logging": type("L", (), {"jsonl": False, "level": "INFO", "file": ""})()})(),
        runtime.config.paths.data_dir,
    )
    assert logger.enabled is False
    logger.log("ignored", x=1)
    assert logger.read() == []


# --------------------------------------------------------------------------- #
# 缓存淘汰
# --------------------------------------------------------------------------- #
def test_embedding_cache_is_pruned(runtime):
    ensure_project(runtime, "prj_test")
    for i in range(6):
        runtime.metadata.put_embedding_blobs(
            [
                {
                    "cache_key": f"k{i}",
                    "embedder_id": "e1",
                    "dim": 2,
                    "vector": b"\x00" * 8,
                    "created_at": f"2026-01-0{i + 1}T00:00:00Z",
                }
            ]
        )
    removed = runtime.metadata.prune_embedding_cache(4)
    assert removed == 2
    remaining = {
        row["cache_key"] for row in runtime.metadata.query("SELECT cache_key FROM embedding_cache")
    }
    assert remaining == {"k2", "k3", "k4", "k5"}, remaining
    assert runtime.metadata.prune_embedding_cache(10) == 0


# --------------------------------------------------------------------------- #
# 备份与恢复
# --------------------------------------------------------------------------- #
def test_backup_manifest_is_verifiable(runtime, tmp_path):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="b1", content="备份校验用的知识条目。")
    result = runtime.store.backup(tmp_path / "backups", note="p7")
    manifest_path = tmp_path / "backups" / f"backup-{result['db'].split('metadata-')[1].replace('.sqlite3', '')}.json"
    assert manifest_path.exists(), list((tmp_path / "backups").glob("*.json"))

    verification = runtime.store.verify_backup(manifest_path)
    assert verification["ok"] is True, verification
    manifest = verification["manifest"]
    assert manifest["schema_version"] == SCHEMA_VERSION
    assert manifest["chunks"] >= 1
    assert manifest["chunks_sha256"]


def test_backup_verify_rejects_too_new_schema(runtime, tmp_path):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="b2", content="伪造未来 schema 的备份。")
    result = runtime.store.backup(tmp_path / "backups2")
    manifest_path = next((tmp_path / "backups2").glob("backup-*.json"))
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["schema_version"] = SCHEMA_VERSION + 5
    manifest_path.write_text(json.dumps(data), encoding="utf-8")

    verification = runtime.store.verify_backup(manifest_path)
    assert verification["ok"] is False
    assert any("schema" in issue for issue in verification["issues"])


def test_backup_verify_detects_corrupted_db(runtime, tmp_path):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="b3", content="用于校验和检测的条目。")
    runtime.store.backup(tmp_path / "backups3")
    manifest_path = next((tmp_path / "backups3").glob("backup-*.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    db_path = tmp_path / "backups3" / manifest["db"]
    db_path.write_bytes(b"corrupted")

    verification = runtime.store.verify_backup(manifest_path)
    assert verification["ok"] is False
    assert any("校验和" in issue for issue in verification["issues"])


def test_restore_with_manifest(runtime, tmp_path):
    """带清单校验的恢复：数据能回来，且返回校验结果。"""

    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="r1", content="恢复测试用的知识。")
    runtime.store.backup(tmp_path / "bk")
    manifest_path = next((tmp_path / "bk").glob("backup-*.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    make_chunk(runtime, chunk_id="r2", content="备份之后新增，恢复后应当消失。")
    assert runtime.metadata.get_chunk("r2") is not None

    result = runtime.store.restore(
        tmp_path / "bk" / manifest["db"],
        manifest_path=manifest_path,
    )
    assert result["verification"]["ok"] is True
    assert runtime.metadata.get_chunk("r1") is not None
    assert runtime.metadata.get_chunk("r2") is None


def test_restore_rejects_bad_manifest(runtime, tmp_path):
    ensure_project(runtime, "prj_test")
    make_chunk(runtime, chunk_id="r3", content="清单不匹配时不得恢复。")
    runtime.store.backup(tmp_path / "bk4")
    manifest_path = next((tmp_path / "bk4").glob("backup-*.json"))
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["schema_version"] = SCHEMA_VERSION + 1
    manifest_path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(Exception):
        runtime.store.restore(
            tmp_path / "bk4" / data["db"], manifest_path=manifest_path
        )
