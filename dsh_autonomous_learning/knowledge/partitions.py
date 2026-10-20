"""逻辑知识分区（规则 1）。

第一阶段：**一个**向量索引 + ``partition`` 元数据字段实现逻辑分区，
不绑定任何具体数据库集合名，将来可平滑迁移到物理分区。

v1.2 起分区**不再硬编码在核心层**：分区由 ``domains`` 注册表里的
:class:`~dsh_autonomous_learning.domains.DomainSpec` 声明，核心只面对
``PartitionSpec`` 视图。新增领域（= 新分区）只需要 ``register_domain()``。

分区规则：
- 每条知识必须属于且仅属于一个分区；
- 项目分区与实验分区默认只在所属项目的检索中可见；
- 跨领域引用通过知识关系（edges）表达，**不合并**两条相似知识；
- 待审区（pending_knowledge）是默认落地区，核验通过后才考虑迁出。
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Dict, List, Optional

from ..domains import PENDING_PARTITION, REGISTRY, DomainSpec


@dataclass(frozen=True)
class PartitionSpec:
    key: str
    label: str
    description: str
    default_domain: str
    keywords: tuple = ()
    allow_auto_write: bool = True  # auto 模式下是否允许自动写入


def _to_partition_spec(spec: DomainSpec) -> PartitionSpec:
    return PartitionSpec(
        key=spec.partition,
        label=spec.label,
        description=spec.description,
        default_domain=spec.key,
        keywords=tuple(spec.keywords),
        allow_auto_write=spec.allow_auto_write,
    )


_PENDING_SPEC = PartitionSpec(
    key=PENDING_PARTITION,
    label="待审知识",
    description="尚未核验、等待审核或需要进一步处理的知识（默认落地区）",
    default_domain="general",
    keywords=(),
    allow_auto_write=True,
)


class _PartitionSpecView(Mapping[str, PartitionSpec]):
    """分区视图：每次访问都按当前注册表重建，因此注册新领域立刻生效。"""

    def _build(self) -> Dict[str, PartitionSpec]:
        view = {spec.partition: _to_partition_spec(spec) for spec in REGISTRY.all()}
        view.setdefault(PENDING_PARTITION, _PENDING_SPEC)
        return view

    def __getitem__(self, key: str) -> PartitionSpec:
        return self._build()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._build())

    def __len__(self) -> int:
        return len(self._build())


#: 分区声明视图（不再是硬编码字典）
PARTITION_SPECS: Mapping[str, PartitionSpec] = _PartitionSpecView()


def project_scoped_partitions() -> set:
    """默认只在所属项目内可见的分区（随注册表变化）。"""

    scoped = {spec.partition for spec in REGISTRY.all() if spec.project_scoped}
    scoped.add(PENDING_PARTITION)
    return scoped


#: 兼容常量（内置领域的快照；判断请优先用 project_scoped_partitions()）
PROJECT_SCOPED_PARTITIONS = project_scoped_partitions()


def all_partitions() -> List[str]:
    return list(PARTITION_SPECS.keys())


def get_spec(partition: str) -> PartitionSpec:
    specs = PARTITION_SPECS
    if partition not in specs:
        raise ValueError(f"未知知识分区: {partition}，允许值: {', '.join(all_partitions())}")
    return specs[partition]


def partition_for_domain(domain: str) -> str:
    """领域 → 分区。未知领域回落到 general（由注册表决定，不再写死映射）。"""

    return REGISTRY.partition_of(domain)


def default_visibility(partition: str) -> str:
    return "project" if partition in project_scoped_partitions() else "global"


def project_partitions(domain: str) -> List[str]:
    """项目默认允许写入的分区：待审区 + 领域分区。"""

    allowed = [PENDING_PARTITION]
    mapped = partition_for_domain(domain)
    if mapped not in allowed:
        allowed.append(mapped)
    return allowed


def ensure_partition_allowed(project: Optional[dict], partition: str) -> None:
    """校验分区是否属于项目的可写范围。"""

    get_spec(partition)
    if not project:
        return
    allowed = project.get("partitions") or []
    if allowed and partition not in allowed:
        raise PermissionError(
            f"分区 {partition} 不在项目 {project.get('project_id')} 的授权分区内"
            f"（允许: {', '.join(allowed)}）"
        )


def describe_partitions() -> List[Dict[str, object]]:
    scoped = project_scoped_partitions()
    return [
        {
            "partition": spec.key,
            "label": spec.label,
            "description": spec.description,
            "default_domain": spec.default_domain,
            "project_scoped": spec.key in scoped,
            "auto_write": spec.allow_auto_write,
        }
        for spec in PARTITION_SPECS.values()
    ]


__all__ = [
    "PARTITION_SPECS",
    "PROJECT_SCOPED_PARTITIONS",
    "PartitionSpec",
    "all_partitions",
    "default_visibility",
    "describe_partitions",
    "ensure_partition_allowed",
    "get_spec",
    "partition_for_domain",
    "project_partitions",
    "project_scoped_partitions",
]
