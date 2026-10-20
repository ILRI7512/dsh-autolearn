"""P1-3 确认令牌隔离回归测试（对应审计报告 F-03 / SEC-15 / T-02）。

v1.1.0 的问题：工具需要确认时，把 ``request.token`` 明文写进返回给模型的
错误消息里，而 ``main.py confirmations approve <token>`` 是模型能执行的普通
CLI —— 于是"user-only 审批"在能力上不成立：端到端可以自批。

修复后的约束：
1. 令牌不出现在任何返回给模型/日志的文本中；
2. CLI 批准必须在交互终端中进行（非 TTY 一律拒绝）；
3. 令牌仍然一次性、有 TTL、绑定 action+target。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from dsh_autonomous_learning.tools.registry import ToolError

from .conftest import ensure_project, make_chunk, runtime  # noqa: F401


def _issue_pending_token(rt) -> str:
    """造一条待确认请求，返回真实令牌（用于"断言它没被泄露"）。"""

    decision = rt.permissions.request_confirmation("invalidate_knowledge", "chunk_x", "prj_test")
    rows = rt.metadata.list_confirmations(status="pending")
    assert rows, "应当有 pending 确认"
    token = rows[-1]["token"]
    assert token == decision.token
    return token


def test_request_confirmation_reason_has_no_token(runtime):
    """生成确认请求时，reason 里不得出现令牌。"""

    token = _issue_pending_token(runtime)
    decision = runtime.permissions.request_confirmation("invalidate_knowledge", "chunk_y", "prj_test")
    assert token not in decision.reason
    assert "confirmations approve" not in decision.reason


def test_tool_error_does_not_leak_token(config, tmp_path, monkeypatch):
    """工具要求确认时，返回给调用方的错误消息里不得含令牌。"""

    from dsh_autonomous_learning.core.orchestrator import build_runtime
    from dsh_autonomous_learning.tools import build_registry

    # 指向空 profile：没有活的审批闸门，确认必须走本地令牌流程
    monkeypatch.setenv("DSH_PROFILE_DIR", str(tmp_path / "no-profile"))
    monkeypatch.delenv("DSH_HOME", raising=False)
    config.learning.default_mode = "assisted"
    rt = build_runtime(config, mode="assisted")
    try:
        reg, _, _ = build_registry(rt)
        ensure_project(rt, "prj_test")
        make_chunk(rt, chunk_id="c_tok", content="令牌隔离测试用的知识条目。")

        result = reg.call(
            "invalidate_knowledge",
            {"chunk_id": "c_tok", "project_id": "prj_test", "reason": "t"},
        )
        assert result["success"] is False, result
        assert result["error"]["type"] == "ConfirmationRequired", result
        message = json.dumps(result, ensure_ascii=False)
        pending = rt.metadata.list_confirmations(status="pending")
        assert pending, "应当生成待确认请求"
        token = pending[-1]["token"]
        assert token not in message, "令牌绝不能出现在返回给模型的错误里"
        assert not re.search(r"approve\s+[A-Za-z0-9_\-]{16,}", message)
    finally:
        rt.close()


def test_approve_requires_tty_when_asked(runtime):
    """require_tty=True 时，非交互环境下的批准必须失败。"""

    token = _issue_pending_token(runtime)
    assert runtime.permissions.approve(token, require_tty=True) is False
    assert runtime.metadata.get_confirmation(token)["status"] == "pending"


def test_approve_without_tty_requirement_still_works(runtime):
    """宿主 UI 等受信任通道可以不走 TTY 检查（保持可编程性）。"""

    token = _issue_pending_token(runtime)
    assert runtime.permissions.approve(token, require_tty=False) is True
    assert runtime.metadata.get_confirmation(token)["status"] == "approved"


def test_cli_approve_refuses_without_tty(tmp_path):
    """命令行批准在非 TTY（如被程序调用）时退出码非 0，且不改变状态。"""

    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    repo_root = Path(__file__).resolve().parents[2]
    cmd = [
        sys.executable,
        "-m",
        "dsh_autonomous_learning.main",
        "--home",
        str(home),
        "confirmations",
        "approve",
        "some-token-value",
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(repo_root),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "终端" in (proc.stdout + proc.stderr)


def test_token_is_single_use_and_bound(runtime):
    """令牌一次性，且 action 必须匹配。"""

    token = _issue_pending_token(runtime)
    assert runtime.permissions.approve(token) is True
    assert runtime.permissions.consume_token(token, "wrong_action", "chunk_x") is False
    assert runtime.permissions.consume_token(token, "invalidate_knowledge", "chunk_x") is True
    # 已消费，不能再用
    assert runtime.permissions.consume_token(token, "invalidate_knowledge", "chunk_x") is False
