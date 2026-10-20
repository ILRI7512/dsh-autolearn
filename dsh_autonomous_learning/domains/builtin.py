"""内置领域声明。

这些领域以前散落在四个地方（``core/models.Partition``、``knowledge/partitions.PARTITION_SPECS``、
``core/planner.DOMAIN_TEMPLATES``、工具 schema 与 CLI 的 enum）。现在它们只是注册表的
普通条目，与第三方领域没有区别：新增一个领域不需要改核心代码。
"""

from __future__ import annotations

from .registry import DomainSpec, register_domain

BUILTIN_DOMAINS: tuple[DomainSpec, ...] = (
    DomainSpec(
        key="general",
        label="通用知识",
        partition="general_knowledge",
        description="数学、逻辑、基础理论与跨领域通用概念",
        topic_templates=("基础概念与定义", "核心原理与机制", "方法与流程", "常见风险与误区", "实践案例"),
        keywords=("数学", "逻辑", "统计", "概率", "算法", "math", "logic", "probability"),
    ),
    DomainSpec(
        key="uiux",
        label="UI/UX 设计",
        partition="uiux_knowledge",
        description="视觉设计、交互设计、设计规范、可用性与无障碍",
        topic_templates=("设计原则与规范", "组件与交互模式", "可用性与无障碍", "视觉与排版", "设计流程与交付"),
        keywords=("ui", "ux", "设计", "交互", "可用性", "无障碍", "material", "figma", "视觉"),
        knowledge_fields=("accessibility_level", "design_token"),
    ),
    DomainSpec(
        key="finance",
        label="金融知识",
        partition="finance_knowledge",
        description="金融基础、外汇、CFD、加密货币与风险管理",
        topic_templates=("基础概念与术语", "市场结构与参与者", "风险、杠杆与保证金", "工具与产品差异"),
        keywords=("金融", "外汇", "利率", "通胀", "cfd", "加密货币", "风控", "杠杆", "保证金"),
        knowledge_fields=("instrument", "regulatory_note"),
    ),
    DomainSpec(
        key="quant",
        label="量化交易",
        partition="quant_knowledge",
        description="策略、指标、回测、样本外测试与鲁棒性",
        topic_templates=("数据质量与预处理", "策略与信号构造", "回测方法与偏差", "风险管理与仓位", "交易成本与执行"),
        keywords=("量化", "回测", "夏普", "滑点", "样本外", "策略", "指标", "过拟合", "backtest"),
        knowledge_fields=("lookback_window", "universe", "data_frequency"),
        # 量化里"公式"必须能重算才可信，门槛单独抬高
        quality_overrides={"formula": (1, 1, 0.70), "experimental_result": (1, 1, 0.60)},
    ),
    DomainSpec(
        key="programming",
        label="编程知识",
        partition="programming_knowledge",
        description="Python / Rust / Kotlin / TypeScript 等语言与工程实践",
        topic_templates=("语言核心与类型系统", "工程结构与依赖管理", "测试、调试与可观测性", "性能与并发", "生态与工具链"),
        keywords=("python", "rust", "kotlin", "typescript", "函数", "接口", "编译", "代码", "api"),
        knowledge_fields=("language_version", "runtime"),
    ),
    DomainSpec(
        key="project",
        label="项目知识",
        partition="project_knowledge",
        description="特定项目的架构、接口、决策记录与技术文档（默认项目内可见）",
        topic_templates=("架构与模块边界", "接口与数据契约", "决策记录与权衡", "部署与运维"),
        keywords=("本项目", "架构", "接口", "决策", "adr", "模块", "部署"),
        project_scoped=True,
        knowledge_fields=("component", "owner"),
    ),
    DomainSpec(
        key="experiment",
        label="实验知识",
        partition="experiment_knowledge",
        description="实验记录、测试结果、失败案例与性能数据",
        topic_templates=("实验设计", "执行与观测", "结果与统计", "失败复盘"),
        keywords=("实验", "测试结果", "benchmark", "复现", "失败案例", "性能"),
        project_scoped=True,
        knowledge_fields=("hypothesis", "metrics"),
    ),
)

#: 待审分区不属于任何领域：它是所有领域的默认落地区
PENDING_PARTITION = "pending_knowledge"


def register_builtin_domains() -> None:
    for spec in BUILTIN_DOMAINS:
        register_domain(spec, replace=True)


__all__ = ["BUILTIN_DOMAINS", "PENDING_PARTITION", "register_builtin_domains"]
