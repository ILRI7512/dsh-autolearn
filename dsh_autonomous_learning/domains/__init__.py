"""领域层：可注册的领域声明与内置领域。

核心引擎只依赖 ``domains.registry`` 的接口；新增领域不需要改核心代码。
"""

from __future__ import annotations

from .builtin import BUILTIN_DOMAINS, PENDING_PARTITION, register_builtin_domains
from .registry import (
    REGISTRY,
    DomainRegistry,
    DomainSpec,
    QualityThreshold,
    domain_keys,
    get_domain,
    register_domain,
    resolve_domain,
)

# 内置领域在导入时注册（幂等；第三方领域随后 register 自己的即可）
register_builtin_domains()

__all__ = [
    "BUILTIN_DOMAINS",
    "PENDING_PARTITION",
    "REGISTRY",
    "DomainRegistry",
    "DomainSpec",
    "QualityThreshold",
    "domain_keys",
    "get_domain",
    "register_builtin_domains",
    "register_domain",
    "resolve_domain",
]
