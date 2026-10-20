"""P1-6 SSRF 与写入边界回归测试（对应审计报告 H-03 / H-04 / SEC-02 / SEC-03）。

v1.1.0 的问题：
- HTTP 抓取只校验初始 host，``follow_redirects=True`` 不逐跳复检，
  也没有任何私有网段/回环/云元数据地址判定 → 可以被资料引导去打
  ``127.0.0.1:3090``（本机桥）或 ``169.254.169.254``；
- ``WRITE`` 风险等级完全不校验路径，``export_knowledge(path=...)`` /
  ``backup_knowledge_base(dest_dir=...)`` 的路径直接来自调用方 →
  任意文件覆盖/截断，且零确认。
"""

from __future__ import annotations

import pytest

from dsh_autonomous_learning.sources.reader import SourceReader, assert_public_target

from .conftest import ensure_project, runtime  # noqa: F401


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:3090/app/health",
        "http://localhost:8080/x",
        "http://10.1.2.3/internal",
        "http://192.168.1.10/router",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:8000/x",
        "http://0.0.0.0:80/x",
    ],
)
def test_private_targets_are_rejected(url):
    with pytest.raises(Exception):
        assert_public_target(url, allow_private=False)


def test_public_host_passes_guard():
    # 只做地址判定，不发网络请求
    assert_public_target("https://example.com/docs", allow_private=False)
    assert_public_target("https://github.com/ILRI7512/dsh-autolearn", allow_private=False)


def test_guard_allows_private_when_explicitly_enabled():
    assert_public_target("http://127.0.0.1:3090/x", allow_private=True)


def test_reader_refuses_local_bridge(config):
    """抓取入口必须在连接前就拒绝本机地址。"""

    config.security.allow_network = True
    rt = None
    from dsh_autonomous_learning.core.orchestrator import build_runtime

    rt = build_runtime(config, mode="auto")
    try:
        result = rt.reader.read("http://127.0.0.1:3090/app/health")
        assert result.ok is False
        assert "内网" in result.error or "私有" in result.error or "禁止" in result.error
    finally:
        rt.close()


def test_write_outside_allowed_roots_denied(runtime):
    decision = runtime.permissions.decide(
        "export_knowledge", risk="write", target="/etc/passwd", project_id="prj_test"
    )
    assert decision.allowed is False


def test_write_inside_data_dir_allowed(runtime):
    target = f"{runtime.config.paths.data_dir}/exports/knowledge.jsonl"
    decision = runtime.permissions.decide("export_knowledge", risk="write", target=target)
    assert decision.allowed is True


def test_export_tool_rejects_outside_path(runtime):
    from dsh_autonomous_learning.tools import build_registry

    ensure_project(runtime, "prj_test")
    reg, _, _ = build_registry(runtime)
    result = reg.call("export_knowledge", {"project_id": "prj_test", "path": "/tmp/al_evil_export.jsonl"})
    assert result["success"] is False, result


def test_backup_tool_rejects_outside_dest(runtime):
    from dsh_autonomous_learning.tools import build_registry

    reg, _, _ = build_registry(runtime)
    result = reg.call("backup_knowledge_base", {"dest_dir": "/tmp/al_evil_backup"})
    assert result["success"] is False, result
