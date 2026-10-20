"""P3 领域解耦回归测试（对应审计 H-09 与"额外优化要求" 1-10）。

v1.1.0 把领域词表复制在 5 处：``core/models.Partition``、
``knowledge/partitions.PARTITION_SPECS``、``core/planner.DOMAIN_TEMPLATES``、
工具 schema 的 enum、CLI 的 choices。新增领域要改 5 个核心文件。

修复后：领域由 ``domains`` 注册表声明，核心只面对 ``DomainSpec`` / 注册表接口。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dsh_autonomous_learning.domains import (
    REGISTRY,
    DomainSpec,
    domain_keys,
    register_domain,
)
from dsh_autonomous_learning.knowledge.partitions import (
    PARTITION_SPECS,
    partition_for_domain,
    project_partitions,
)

CUSTOM = DomainSpec(
    key="music_theory",
    label="乐理",
    partition="music_knowledge",
    description="和声、节奏与曲式",
    topic_templates=("音程与音阶", "和声进行", "节奏与节拍", "曲式分析"),
    keywords=("和声", "音阶", "调式", "节奏", "chord", "harmony"),
    knowledge_fields=("key_signature", "instrument"),
)


@pytest.fixture()
def custom_domain():
    register_domain(CUSTOM, replace=True)
    try:
        yield CUSTOM
    finally:
        REGISTRY.unregister(CUSTOM.key)


def test_builtin_domains_are_registered():
    keys = domain_keys()
    for expected in ("general", "uiux", "finance", "quant", "programming", "project", "experiment"):
        assert expected in keys


def test_registering_domain_is_enough(custom_domain):
    """新增领域只调一次 register，分区/模板/关键词全部生效。"""

    assert custom_domain.key in domain_keys()
    assert partition_for_domain(custom_domain.key) == "music_knowledge"
    assert "music_knowledge" in PARTITION_SPECS
    assert "music_knowledge" in project_partitions(custom_domain.key)

    spec = PARTITION_SPECS["music_knowledge"]
    assert spec.label == "乐理"
    assert spec.default_domain == custom_domain.key
    assert "和声" in spec.keywords


def test_planner_uses_registry_templates(custom_domain):
    from dsh_autonomous_learning.core.planner import LearningPlanner

    planner = LearningPlanner.__new__(LearningPlanner)  # 只用 decompose_goal，不需要 store
    result = LearningPlanner.decompose_goal(
        planner, "学习和声进行与曲式", domain=custom_domain.key, depth="working"
    )
    names = [t["name"] for t in result["topics"]]
    assert "和声进行" in names


def test_tool_schema_enum_follows_registry(custom_domain):
    from dsh_autonomous_learning.tools.registry import ToolRegistry
    from dsh_autonomous_learning.tools import learning_tools

    reg = ToolRegistry()
    learning_tools.register(reg, _FakeRuntime(), None)
    spec = reg.get("create_learning_project")
    enum = spec.input_schema["properties"]["domain"]["enum"]
    assert custom_domain.key in enum


def test_cli_choices_follow_registry(custom_domain):
    from dsh_autonomous_learning.main import build_parser

    parser = build_parser()
    found = []
    for action in parser._actions:
        if action.dest == "domain":
            found.append(action)
        for sub in getattr(action, "choices", {}).values() if isinstance(getattr(action, "choices", None), dict) else []:
            found.extend(a for a in getattr(sub, "_actions", []) if a.dest == "domain")
    assert found, "CLI 应当有 --domain 参数"
    assert any(custom_domain.key in (a.choices or []) for a in found)


def test_core_files_have_no_hardcoded_domains():
    """核心层不能再出现具体领域的词表。"""

    root = Path(__file__).resolve().parents[1]
    models_src = (root / "core" / "models.py").read_text(encoding="utf-8")
    planner_src = (root / "core" / "planner.py").read_text(encoding="utf-8")

    for forbidden in ("uiux_knowledge", "quant_knowledge", "finance_knowledge"):
        assert forbidden not in models_src, f"core/models.py 仍写死 {forbidden}"
    for template in ("设计原则与规范", "策略与信号构造", "语言核心与类型系统"):
        assert template not in planner_src, f"core/planner.py 仍写死主题模板 {template}"


def test_duplicate_registration_needs_replace():
    register_domain(CUSTOM, replace=True)
    try:
        with pytest.raises(ValueError):
            register_domain(CUSTOM)
    finally:
        REGISTRY.unregister(CUSTOM.key)


def test_chunks_have_structured_columns(runtime):
    """22 字段里缺的 8 项必须有真实列（不是只写在文档里）。"""

    columns = {r["name"] for r in runtime.metadata.query("PRAGMA table_info(chunks)")}
    for name in (
        "tags",
        "source_version",
        "source_excerpt",
        "core_principle",
        "reasoning",
        "application",
        "implementation",
        "anti_patterns",
        "limitations",
    ):
        assert name in columns, f"chunks 缺少列 {name}"


def test_extractor_fills_derivable_structure_fields(runtime, home):
    from .conftest import ensure_project

    ensure_project(runtime, "prj_test")
    path = home / "struct.md"
    path.write_text(
        "# 滑点\n滑点是指成交价与预期成交价之间的差额，回测必须把滑点成本计入，否则收益会被系统性高估。\n",
        encoding="utf-8",
    )
    read = runtime.reader.read(str(path), project_id="prj_test")
    assert read.ok, read.error
    from dsh_autonomous_learning.core.orchestrator import LearningOrchestrator

    orch = LearningOrchestrator(runtime)
    orch.ingest_document("prj_test", read, topic="滑点")
    project = runtime.metadata.get_project("prj_test")
    result = orch._task_extract({"project_id": "prj_test", "inputs": {"topic": "滑点"}}, use_model=False)
    assert result["chunks_added"] >= 1, result

    chunk = runtime.metadata.query_dicts("SELECT * FROM chunks")[0]
    assert chunk["source_excerpt"], "应当保存原文摘录"
    import json

    tags = json.loads(chunk["tags"]) if isinstance(chunk["tags"], str) else chunk["tags"]
    assert isinstance(tags, list)


class _FakeRuntime:
    """只够 learning_tools 构造 schema 用的最小替身。"""

    def __init__(self) -> None:
        self.config = type("C", (), {"learning": type("L", (), {"default_mode": "auto", "max_tasks_per_run": 10})()})()
        self.metadata = None
        self.permissions = type(
            "P",
            (),
            {
                "mode": "auto",
                "audit": type("A", (), {"log": staticmethod(lambda **kw: None)})(),
                "decide": staticmethod(lambda **kw: type("D", (), {"allowed": True, "needs_confirmation": False, "reason": "", "token": ""})()),
            },
        )()
        self.store = None
