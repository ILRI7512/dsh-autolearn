"""P1-2 审批 fail-closed 回归测试（对应审计报告 F-02）。

v1.1.0 的问题：``cordis.patch.yml`` 无条件注入 ``DSH_AL_HOST_APPROVAL=1``，
``config.py`` 把它写进 ``security.delegate_approval_to_host``，而
``PermissionManager`` 见到这个配置就直接委派，完全跳过
``_host_gate_available()``（闸门是否安装 / 是否被 disabled / 心跳是否新鲜）。

结果：审批插件没装、被禁用、崩溃，Python 侧照样认为"有人审批"，
``destructive`` 直接放行。本文件锁定修复后的行为：**没有活着的闸门 = 本地确认流**。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dsh_autonomous_learning.security.permissions import PermissionManager

PLUGIN = "@local/dsh-autolearn-approval"


def _profile(tmp_path: Path, *, bundles: list[str] | None = None, patch: str | None = None) -> Path:
    profile = tmp_path / "profile"
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "package.json").write_text(
        json.dumps({"dsh": {"profile": {"bundles": bundles if bundles is not None else [PLUGIN]}}}),
        encoding="utf-8",
    )
    if patch is not None:
        (profile / "cordis.patch.yml").write_text(patch, encoding="utf-8")
    return profile


def _manager(config, tmp_path: Path) -> PermissionManager:
    return PermissionManager(
        config.security, config.learning, None, mode="assisted", data_dir=str(tmp_path / "data")
    )


def test_config_flag_alone_does_not_delegate(config, tmp_path, monkeypatch):
    """只有配置开关、没有活闸门时不得委派（v1.1.0 这里是 True）。"""

    monkeypatch.delenv("DSH_AL_HOST_APPROVAL", raising=False)
    monkeypatch.delenv("DSH_PROFILE_DIR", raising=False)
    monkeypatch.delenv("DSH_HOME", raising=False)
    config.security.delegate_approval_to_host = True
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False


def test_env_flag_alone_does_not_delegate(config, tmp_path, monkeypatch):
    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    monkeypatch.delenv("DSH_PROFILE_DIR", raising=False)
    monkeypatch.delenv("DSH_HOME", raising=False)
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False


def test_destructive_not_allowed_without_gate(config, tmp_path, monkeypatch):
    """没有闸门时，破坏性操作必须回到"需要确认"，而不是静默放行。"""

    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    # 指向一个空 profile：闸门不可能被判定为已安装
    monkeypatch.setenv("DSH_PROFILE_DIR", str(tmp_path / "no-profile"))
    monkeypatch.delenv("DSH_HOME", raising=False)
    config.security.delegate_approval_to_host = True
    manager = _manager(config, tmp_path)
    decision = manager.decide("delete_everything", risk="destructive", target="project:prj_x")
    # 约定的语义：allowed=True + needs_confirmation=True 表示"必须先拿本地令牌"
    assert decision.needs_confirmation is True
    assert not (decision.allowed and not decision.needs_confirmation)


def test_gate_probe_exception_is_fail_closed(config, tmp_path, monkeypatch):
    """闸门探测自身抛异常时按"不可用"处理，不得放行。"""

    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    config.security.delegate_approval_to_host = True

    def boom(*args, **kwargs):
        raise RuntimeError("profile 读取炸了")

    monkeypatch.setattr(PermissionManager, "_host_gate_available", boom)
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False


def test_live_gate_still_delegates(config, tmp_path, monkeypatch):
    """闸门确实装着且没被禁用时，委派仍然生效（避免把功能修没了）。"""

    profile = _profile(tmp_path)
    monkeypatch.setenv("DSH_PROFILE_DIR", str(profile))
    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    monkeypatch.delenv("DSH_AL_HOST_APPROVAL_FILE", raising=False)
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is True


def test_disabled_gate_is_fail_closed(config, tmp_path, monkeypatch):
    profile = _profile(
        tmp_path, patch="- id: autolearn-approval\n  disabled: true\n"
    )
    monkeypatch.setenv("DSH_PROFILE_DIR", str(profile))
    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False


def test_gate_not_in_bundles_is_fail_closed(config, tmp_path, monkeypatch):
    profile = _profile(tmp_path, bundles=[])
    monkeypatch.setenv("DSH_PROFILE_DIR", str(profile))
    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False


def test_corrupt_gate_state_is_fail_closed(config, tmp_path, monkeypatch):
    """代际标记损坏时按"新一代闸门"处理，必须有心跳才委派。"""

    profile = _profile(tmp_path)
    monkeypatch.setenv("DSH_PROFILE_DIR", str(profile))
    monkeypatch.setenv("DSH_AL_HOST_APPROVAL", "1")
    state = tmp_path / "data" / "host_approval.gate.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text("{ 坏掉的 json", encoding="utf-8")
    manager = _manager(config, tmp_path)
    assert manager.delegate_to_host is False
