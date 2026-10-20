"""领域注册表。

设计目标（对应审计 H-09 与"额外优化要求 1-10"）：

1. 核心引擎**不**依赖任何具体领域：分区、主题模板、分类关键词、质量门槛、
   领域扩展字段都由 :class:`DomainSpec` 声明，核心只面对注册表接口；
2. 新增领域 = 调一次 ``register_domain()``，不用改核心代码；
3. 内置领域（general/uiux/finance/quant/programming/project/experiment）走同一套
   API 注册，与第三方领域没有特权差异；
4. 领域之间共享来源、去重、任务调度、向量检索等基础设施（它们都不在领域层）。

注册表是进程内单例；写入应发生在启动阶段（插件加载时），避免并发注册。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

#: 证据门槛：(最少证据条数, 最少独立来源数, 最低来源质量)
QualityThreshold = Tuple[int, int, float]


@dataclass(frozen=True)
class DomainSpec:
    """一个知识领域的完整声明。"""

    key: str
    label: str
    partition: str
    description: str = ""
    #: 目标拆解时使用的默认主题模板（越靠前优先级越高）
    topic_templates: Sequence[str] = ()
    #: 分类器用的领域关键词（子串匹配，小写）
    keywords: Sequence[str] = ()
    #: 该领域的知识扩展字段（除统一字段外，领域特有字段名）
    knowledge_fields: Sequence[str] = ()
    #: 按知识类型覆盖的证据门槛，例如 {"formula": (1, 1, 0.7)}
    quality_overrides: Mapping[str, QualityThreshold] = field(default_factory=dict)
    #: 是否允许 auto 模式自动写入该分区
    allow_auto_write: bool = True
    #: 该分区是否默认只在所属项目内可见
    project_scoped: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "partition": self.partition,
            "description": self.description,
            "topic_templates": list(self.topic_templates),
            "keywords": list(self.keywords),
            "knowledge_fields": list(self.knowledge_fields),
            "quality_overrides": {k: list(v) for k, v in self.quality_overrides.items()},
            "allow_auto_write": self.allow_auto_write,
            "project_scoped": self.project_scoped,
        }


class DomainRegistry:
    """领域注册表（进程内单例，线程安全用法：启动期写入、运行期只读）。"""

    def __init__(self) -> None:
        self._specs: Dict[str, DomainSpec] = {}

    # ------------------------------------------------------------------ #
    def register(self, spec: DomainSpec, *, replace: bool = False) -> DomainSpec:
        key = (spec.key or "").strip().lower()
        if not key:
            raise ValueError("领域 key 不能为空")
        if not spec.partition:
            raise ValueError(f"领域 {key} 必须声明 partition")
        if key in self._specs and not replace:
            raise ValueError(f"领域 {key} 已注册；如需覆盖请显式 replace=True")
        normalized = DomainSpec(
            key=key,
            label=spec.label or key,
            partition=spec.partition,
            description=spec.description,
            topic_templates=tuple(spec.topic_templates),
            keywords=tuple(k.lower() for k in spec.keywords),
            knowledge_fields=tuple(spec.knowledge_fields),
            quality_overrides=dict(spec.quality_overrides),
            allow_auto_write=spec.allow_auto_write,
            project_scoped=spec.project_scoped,
        )
        self._specs[key] = normalized
        return normalized

    def unregister(self, key: str) -> bool:
        return self._specs.pop((key or "").lower(), None) is not None

    # ------------------------------------------------------------------ #
    def get(self, key: str) -> DomainSpec:
        """按 key 取领域；未知 key 回落到 general（而不是抛错炸掉整轮）。"""

        normalized = (key or "").strip().lower()
        if normalized in self._specs:
            return self._specs[normalized]
        return self._specs[self.general_key]

    @property
    def general_key(self) -> str:
        return "general" if "general" in self._specs else next(iter(self._specs))

    def has(self, key: str) -> bool:
        return (key or "").strip().lower() in self._specs

    def keys(self) -> List[str]:
        return list(self._specs.keys())

    def all(self) -> List[DomainSpec]:
        return list(self._specs.values())

    def by_partition(self) -> Dict[str, DomainSpec]:
        return {spec.partition: spec for spec in self._specs.values()}

    def partition_of(self, key: str) -> str:
        return self.get(key).partition

    def topic_templates(self, key: str) -> List[str]:
        return list(self.get(key).topic_templates)

    def keywords(self, key: str) -> Sequence[str]:
        return self.get(key).keywords

    def resolve_by_keywords(self, text: str) -> str:
        """按关键词命中数猜领域（0 命中回落 general）。"""

        sample = (text or "").lower()
        best, best_score = self.general_key, 0
        for spec in self._specs.values():
            score = sum(1 for kw in spec.keywords if kw and kw in sample)
            if score > best_score:
                best, best_score = spec.key, score
        return best

    def snapshot(self) -> List[Dict[str, Any]]:
        return [spec.to_dict() for spec in self._specs.values()]


#: 全局注册表
REGISTRY = DomainRegistry()


def register_domain(spec: DomainSpec, *, replace: bool = False) -> DomainSpec:
    """注册一个领域（核心与内置领域都走这个入口）。"""

    return REGISTRY.register(spec, replace=replace)


def get_domain(key: str) -> DomainSpec:
    return REGISTRY.get(key)


def domain_keys() -> List[str]:
    return REGISTRY.keys()


def resolve_domain(text: str) -> str:
    return REGISTRY.resolve_by_keywords(text)


__all__ = [
    "DomainRegistry",
    "DomainSpec",
    "QualityThreshold",
    "REGISTRY",
    "domain_keys",
    "get_domain",
    "register_domain",
    "resolve_domain",
]
