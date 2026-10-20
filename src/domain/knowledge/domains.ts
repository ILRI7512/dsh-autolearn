/**
 * 领域注册表与知识分区（与 v1.2 的内置领域完全一致）。
 *
 * 注册表是**纯数据**：领域只描述模板、关键词、分区与证据门槛，
 * 不承载业务逻辑，避免「每加一个领域就复制一套流程」。
 */
import { Partition } from '../../core/types.ts'

export interface DomainSpec {
  key: string
  label: string
  partition: string
  description: string
  topicTemplates: readonly string[]
  keywords: readonly string[]
  knowledgeFields: readonly string[]
  qualityOverrides: Record<string, readonly [number, number, number]>
  allowAutoWrite: boolean
  projectScoped: boolean
}

export interface PartitionSpec {
  key: string
  label: string
  description: string
  defaultDomain: string
  keywords: readonly string[]
  allowAutoWrite: boolean
  projectScoped: boolean
}

const GENERAL_TOPICS = ['基础概念与定义', '核心原理与机制', '方法与流程', '常见风险与误区', '实践案例']

const BUILTIN: DomainSpec[] = [
  {
    key: 'general', label: '通用知识', partition: 'general_knowledge',
    description: '跨领域的基础知识：概念、原理、方法、风险与实践',
    topicTemplates: GENERAL_TOPICS,
    keywords: ['数学', '逻辑', '统计', '概率', '算法', 'math', 'logic', 'probability'],
    knowledgeFields: [], qualityOverrides: {}, allowAutoWrite: true, projectScoped: false,
  },
  {
    key: 'uiux', label: 'UI/UX 设计', partition: 'uiux_knowledge',
    description: '界面与体验设计：规范、组件、可用性、视觉与交付',
    topicTemplates: ['设计原则与规范', '组件与交互模式', '可用性与无障碍', '视觉与排版', '设计流程与交付'],
    keywords: ['设计', '交互', 'ui', 'ux', '可用性', '无障碍', '排版'],
    knowledgeFields: ['accessibility_level', 'design_token'],
    qualityOverrides: {}, allowAutoWrite: true, projectScoped: false,
  },
  {
    key: 'finance', label: '金融知识', partition: 'finance_knowledge',
    description: '金融市场与产品：术语、结构、风险与监管',
    topicTemplates: ['基础概念与术语', '市场结构与参与者', '风险、杠杆与保证金', '工具与产品差异'],
    keywords: ['金融', '市场', '利率', '汇率', '监管', 'finance'],
    knowledgeFields: ['instrument', 'regulatory_note'],
    qualityOverrides: {}, allowAutoWrite: true, projectScoped: false,
  },
  {
    key: 'quant', label: '量化交易', partition: 'quant_knowledge',
    description: '量化研究：数据、信号、回测、风控与执行',
    topicTemplates: ['数据质量与预处理', '策略与信号构造', '回测方法与偏差', '风险管理与仓位', '交易成本与执行'],
    keywords: ['量化', '回测', '滑点', '夏普', '信号', '仓位', 'quant'],
    knowledgeFields: ['lookback_window', 'universe', 'data_frequency'],
    qualityOverrides: { formula: [1, 1, 0.7], experimental_result: [1, 1, 0.6] },
    allowAutoWrite: true, projectScoped: false,
  },
  {
    key: 'programming', label: '编程知识', partition: 'programming_knowledge',
    description: '语言、工程结构、测试、性能与生态',
    topicTemplates: ['语言核心与类型系统', '工程结构与依赖管理', '测试、调试与可观测性', '性能与并发', '生态与工具链'],
    keywords: ['编程', '代码', '类型', '测试', '并发', 'programming'],
    knowledgeFields: ['language_version', 'runtime'],
    qualityOverrides: {}, allowAutoWrite: true, projectScoped: false,
  },
  {
    key: 'project', label: '项目知识', partition: 'project_knowledge',
    description: '具体项目的架构、契约、决策与运维（项目内可见）',
    topicTemplates: ['架构与模块边界', '接口与数据契约', '决策记录与权衡', '部署与运维'],
    keywords: ['项目', '架构', '部署', '运维', 'project'],
    knowledgeFields: ['component', 'owner'],
    qualityOverrides: {}, allowAutoWrite: true, projectScoped: true,
  },
  {
    key: 'experiment', label: '实验知识', partition: 'experiment_knowledge',
    description: '实验设计、观测、统计与失败复盘（项目内可见）',
    topicTemplates: ['实验设计', '执行与观测', '结果与统计', '失败复盘'],
    keywords: ['实验', '假设', '指标', '复盘', 'experiment'],
    knowledgeFields: ['hypothesis', 'metrics'],
    qualityOverrides: {}, allowAutoWrite: true, projectScoped: true,
  },
]

export class DomainRegistry {
  private readonly specs = new Map<string, DomainSpec>()

  register(spec: DomainSpec, replace = false): void {
    const key = spec.key.trim().toLowerCase()
    if (!key) throw new Error('领域 key 不能为空')
    if (!spec.partition.trim()) throw new Error(`领域 ${key} 缺少 partition`)
    if (this.specs.has(key) && !replace) throw new Error(`领域已存在: ${key}`)
    this.specs.set(key, {
      ...spec,
      key,
      keywords: spec.keywords.map((item) => item.toLowerCase()),
    })
  }

  unregister(key: string): boolean {
    return this.specs.delete(key.trim().toLowerCase())
  }

  get(key: string): DomainSpec {
    return this.specs.get((key ?? '').trim().toLowerCase()) ?? (this.specs.get('general') as DomainSpec)
  }

  has(key: string): boolean {
    return this.specs.has(key.trim().toLowerCase())
  }

  keys(): string[] {
    return [...this.specs.keys()]
  }

  all(): DomainSpec[] {
    return [...this.specs.values()]
  }

  topicTemplates(key: string): readonly string[] {
    return this.get(key).topicTemplates
  }

  keywords(key: string): readonly string[] {
    return this.get(key).keywords
  }

  partitionOf(key: string): string {
    return this.get(key).partition
  }

  resolveByKeywords(text: string): string {
    const sample = (text ?? '').toLowerCase()
    let best = 'general'
    let bestHits = 0
    for (const spec of this.specs.values()) {
      let hits = 0
      for (const keyword of spec.keywords) if (sample.includes(keyword)) hits += 1
      if (hits > bestHits) {
        best = spec.key
        bestHits = hits
      }
    }
    return best
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.specs.entries()].map(([key, spec]) => [
        key,
        {
          label: spec.label, partition: spec.partition, project_scoped: spec.projectScoped,
          topics: spec.topicTemplates, keywords: spec.keywords,
        },
      ]),
    )
  }
}

export const REGISTRY = new DomainRegistry()
for (const spec of BUILTIN) REGISTRY.register(spec, true)

export function domainKeys(): string[] {
  return REGISTRY.keys()
}

/** 分区视图每次从注册表重建（新领域立即生效）。 */
export function allPartitions(): PartitionSpec[] {
  const specs: PartitionSpec[] = [
    {
      key: Partition.PENDING, label: '待审知识',
      description: '尚未核验、等待复核的知识（默认落地区）',
      defaultDomain: 'general', keywords: [], allowAutoWrite: true, projectScoped: true,
    },
  ]
  for (const domain of REGISTRY.all()) {
    specs.push({
      key: domain.partition, label: domain.label, description: domain.description,
      defaultDomain: domain.key, keywords: domain.keywords,
      allowAutoWrite: domain.allowAutoWrite, projectScoped: domain.projectScoped,
    })
  }
  return specs
}

export function partitionForDomain(domain: string): string {
  return REGISTRY.partitionOf(domain)
}

export function projectScopedPartitions(): Set<string> {
  const scoped = new Set<string>([Partition.PENDING])
  for (const spec of allPartitions()) if (spec.projectScoped) scoped.add(spec.key)
  return scoped
}

export function defaultVisibility(partition: string): 'project' | 'global' {
  return projectScopedPartitions().has(partition) ? 'project' : 'global'
}

export function projectPartitions(domain: string): string[] {
  const target = partitionForDomain(domain)
  return target === Partition.PENDING ? [Partition.PENDING] : [Partition.PENDING, target]
}

export function getPartitionSpec(partition: string): PartitionSpec {
  const found = allPartitions().find((spec) => spec.key === partition)
  if (!found) {
    throw new Error(`未知分区: ${partition}（允许值: ${allPartitions().map((s) => s.key).join(', ')}）`)
  }
  return found
}

/** 项目只允许写入自己声明的分区（越权写入是硬拒绝）。 */
export function ensurePartitionAllowed(project: { partitions?: string[] } | null, partition: string): void {
  getPartitionSpec(partition)
  if (!project) return
  const allowed = project.partitions ?? []
  if (allowed.length > 0 && !allowed.includes(partition)) {
    throw new Error(`分区 ${partition} 不在项目允许范围内（${allowed.join(', ')}）`)
  }
}

export function describePartitions(): Array<Record<string, unknown>> {
  return allPartitions().map((spec) => ({
    partition: spec.key,
    label: spec.label,
    description: spec.description,
    default_domain: spec.defaultDomain,
    project_scoped: spec.projectScoped,
    auto_write: spec.allowAutoWrite,
  }))
}
