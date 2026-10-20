/**
 * DSH 原生工具定义（11 个模型可见接口）。
 *
 * 这里只做三件事：参数 Schema、运行时校验、结果截断；
 * 业务逻辑全部在 AutolearnServices，MCP 适配层调用同一份服务。
 */
import { describeError, AutolearnError, ERROR_CODES } from '../../core/errors.ts'
import { validateSchema, type JsonSchema } from '../../core/validation.ts'
import type { AutolearnServices } from '../../application/services.ts'

export interface NativeToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  output: {
    schema: JsonSchema
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs?: number
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

const objectSchema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra })
const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', description, ...extra })
const int = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', description, ...extra })
const bool = (description: string): JsonSchema => ({ type: 'boolean', description })
const strArray = (description: string): JsonSchema => ({ type: 'array', description, items: { type: 'string' } })

const OUTPUT_SCHEMA: JsonSchema = { type: 'object', additionalProperties: true }

function render(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export interface ToolContext {
  services: AutolearnServices
  maxOutputBytes: number
}

export function buildNativeTools(context: ToolContext): NativeToolDefinition[] {
  const { services } = context
  const define = (
    name: string,
    description: string,
    parameters: JsonSchema,
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
    timeoutMs = 120_000,
  ): NativeToolDefinition => ({
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    timeoutMs,
    async execute(args) {
      try {
        const violations = validateSchema(parameters, args)
        if (violations.length > 0) {
          throw new AutolearnError(
            `参数校验失败: ${violations.slice(0, 6).map((v) => `${v.path} ${v.message}`).join('; ')}`,
            { code: ERROR_CODES.VALIDATION_FAILED, details: { violations } },
          )
        }
        const result = await handler(args)
        return truncateValue(result, context.maxOutputBytes)
      } catch (error) {
        // 失败必须以结构化形式返回，不能伪造成功。
        return describeError(error)
      }
    },
  })

  const filtersSchema = objectSchema({
    statuses: strArray('按知识状态过滤'),
    partitions: strArray('按分区过滤'),
    domains: strArray('按领域过滤'),
    topics: strArray('按主题过滤'),
    verificationStatuses: strArray('按核验状态过滤'),
    knowledgeTypes: strArray('按知识类型过滤'),
    includeInvalidated: bool('是否包含已失效知识（默认 false）'),
    limit: int('最多返回条数', { minimum: 1, maximum: 5000 }),
  })

  return [
    define(
      'learning_create',
      '创建自主学习项目：登记目标、领域、深度、验收标准，并生成主题→发现→提取→核验→实践的任务计划。不会自动开始执行。',
      objectSchema({
        goal: str('学习目标（必填，自然语言）', { minLength: 2, maxLength: 2000 }),
        title: str('项目标题，缺省取目标前 40 字'),
        domain: str('领域 key：general/uiux/finance/quant/programming/project/experiment', { enum: ['general', 'uiux', 'finance', 'quant', 'programming', 'project', 'experiment'] }),
        depth: str('学习深度', { enum: ['overview', 'working', 'deep'] }),
        mode: str('自主模式', { enum: ['assisted', 'auto', 'lab'] }),
        acceptanceCriteria: strArray('可验证的验收标准'),
        deliverables: strArray('期望交付物'),
        allowedSources: strArray('允许的资料地址（URL 或本地路径）'),
        plan: bool('是否立即生成计划（默认 true）'),
      }, ['goal']),
      (args) => services.learningCreate(args),
    ),
    define(
      'learning_run',
      '执行一轮有界学习：恢复中断任务 → 取就绪任务 → 发现/提取/核验/实践/评估 → 写运行记录。受预算、任务数、时长与停滞条件约束，不会无限循环。',
      objectSchema({
        projectId: str('项目 ID（必填）'),
        maxTasks: int('本轮最多执行任务数（不超过配置上限）', { minimum: 1, maximum: 200 }),
        useModel: bool('是否启用模型辅助（当前仅规则链路；会返回明确警告）'),
      }, ['projectId']),
      (args) => services.learningRun(args),
      600_000,
    ),
    define(
      'learning_status',
      '查询项目状态：任务分布、知识量、覆盖率、核验率、未达标项、最近运行与开放缺口。省略 projectId 时列出全部项目。',
      objectSchema({
        projectId: str('项目 ID（可省略）'),
        status: str('列出项目时按状态过滤', { enum: ['active', 'paused', 'completed', 'cancelled', 'blocked'] }),
      }),
      (args) => services.learningStatus(args),
    ),
    define(
      'knowledge_search',
      '混合检索知识库（BM25 + 特征哈希向量 + RRF 融合）。结果带核验状态、来源、冲突与时效警告；相似度不代表正确。必须给 projectId 才能检索项目内知识。',
      objectSchema({
        query: str('检索词（必填）', { minLength: 1, maxLength: 500 }),
        projectId: str('项目 ID（强烈建议；省略时只检索全局可见知识）'),
        projectIds: strArray('跨多个项目检索'),
        topK: int('返回条数', { minimum: 1, maximum: 50 }),
        mode: str('检索模式', { enum: ['hybrid', 'vector', 'keyword'] }),
        includeContent: bool('是否返回正文（默认 true）'),
        filters: filtersSchema,
      }, ['query']),
      (args) => services.knowledgeSearch(args),
    ),
    define(
      'knowledge_manage',
      '管理知识：save/update/invalidate/rollback/export/get/partitions。危险操作（删除、恢复、索引重建）不在本工具，见 system_maintenance。',
      objectSchema({
        action: str('操作', { enum: ['save', 'update', 'invalidate', 'rollback', 'export', 'get', 'partitions'] }),
        projectId: str('项目 ID'),
        chunkId: str('知识片段 ID'),
        items: { type: 'array', description: 'save 时的批量条目', items: { type: 'object', additionalProperties: true } },
        fields: { type: 'object', description: 'update 的字段（content/title/summary/topic/tags/metadata 等）', additionalProperties: true },
        reason: str('变更原因（写入版本历史）'),
        version: int('rollback 的目标版本', { minimum: 1 }),
        path: str('export 的目标路径（必须位于 data 目录或授权根目录）'),
        format: str('export 格式', { enum: ['jsonl', 'json', 'csv'] }),
        confirmToken: str('本地确认令牌（作用域绑定 action+target，单次使用）'),
        content: str('save 单条内容的快捷写法'),
        title: str('save 单条标题'),
        summary: str('save 单条摘要'),
        source_url: str('save 单条来源 URL'),
        source_title: str('save 单条来源标题'),
        source_type: str('save 单条来源类型'),
        source_quality: num('save 单条来源质量 0..1', { minimum: 0, maximum: 1 }),
        topic: str('主题'),
        subtopic: str('子主题'),
        partition: str('分区（默认 pending_knowledge）'),
        knowledge_type: str('知识类型'),
        tags: strArray('标签'),
        confidence: num('置信度 0..1', { minimum: 0, maximum: 1 }),
        visibility: str('可见性', { enum: ['project', 'global'] }),
      }, ['action']),
      (args) => services.knowledgeManage(args),
    ),
    define(
      'knowledge_verify',
      '核验知识：verify 按证据规则升级/降级状态（无证据一律 fail）；verify_formula 重算公式；list_evidence 查核验记录；find_duplicates 查重复；detect_conflicts 检测数值/极性矛盾。模型通道不能自称为人工复核。',
      objectSchema({
        action: str('操作', { enum: ['verify', 'verify_formula', 'list_evidence', 'find_duplicates', 'detect_conflicts'] }),
        projectId: str('项目 ID'),
        chunkId: str('知识片段 ID'),
        method: str('核验方法（缺省按知识类型自动选择）', {
          enum: ['source_check', 'cross_source', 'official_doc_check', 'formula_recompute', 'code_test', 'experiment', 'usability_test', 'static_analysis', 'manual_review'],
        }),
        evidence: { type: 'array', description: '证据条目', items: { type: 'object', additionalProperties: true } },
        expression: str('公式表达式'),
        variables: { type: 'object', description: '公式变量', additionalProperties: true },
        expected: num('公式期望值'),
        tolerance: num('容差（默认 1e-6）', { minimum: 0 }),
        threshold: num('重复判定阈值（默认取配置）', { minimum: 0, maximum: 1 }),
      }, ['action']),
      (args) => services.knowledgeVerify(args),
    ),
    define(
      'source_manage',
      '管理学习来源：discover 发现候选（本地语料/显式地址）；read 读取并可选入库；list 列出已登记来源。网络访问受 allow_network、域名白名单与 SSRF 防护约束。',
      objectSchema({
        action: str('操作', { enum: ['discover', 'read', 'list'] }),
        projectId: str('项目 ID'),
        topics: strArray('按主题发现'),
        locations: strArray('显式地址（URL 或本地路径）'),
        limit: int('发现数量上限', { minimum: 1, maximum: 200 }),
        persist: bool('read 时是否落库为文档（默认 true，需要 projectId）'),
        topic: str('归属主题'),
      }, ['action']),
      (args) => services.sourceManage(args),
      180_000,
    ),
    define(
      'learning_evaluate',
      '评估学习成果：覆盖率、核验率、来源完整率、冲突、实践通过率、成本，并给出未达标项与结论。可同时生成 Markdown/JSON 报告。',
      objectSchema({
        projectId: str('项目 ID（必填）'),
        includeReport: bool('是否同时生成报告文件'),
      }, ['projectId']),
      (args) => services.learningEvaluate(args),
    ),
    define(
      'learning_review',
      '复盘：列出失败/阻塞任务、耗尽重试的任务、开放冲突与缺口、最近审计，并给出改进建议；action=retry_failed 可重置失败任务（需确认）。',
      objectSchema({
        projectId: str('项目 ID（必填）'),
        action: str('可选动作', { enum: ['status', 'retry_failed'] }),
        confirmToken: str('本地确认令牌'),
      }, ['projectId']),
      (args) => services.learningReview(args),
    ),
    define(
      'system_diagnostics',
      '系统诊断：数据库/外键/索引一致性、schema 版本、路径、权限模式、网络策略、预算与最近拒绝记录。',
      objectSchema({}),
      () => services.systemDiagnostics(),
    ),
    define(
      'system_maintenance',
      '系统维护（高风险）：integrity 一致性检查、rebuild_index 重建向量索引、backup/verify_backup/restore 备份恢复、delete_chunk 删除知识、vacuum 压缩数据库。删除/恢复需要用户确认。',
      objectSchema({
        action: str('操作', { enum: ['integrity', 'rebuild_index', 'backup', 'verify_backup', 'restore', 'delete_chunk', 'vacuum'] }),
        projectId: str('项目 ID（用于审计）'),
        destDir: str('备份目标目录'),
        manifestPath: str('备份清单路径'),
        dbFile: str('恢复用的数据库文件'),
        indexDir: str('恢复用的索引目录'),
        chunkId: str('要删除的知识片段'),
        note: str('备份备注'),
        confirmToken: str('本地确认令牌（作用域绑定 action+target）'),
      }, ['action']),
      (args) => services.systemMaintenance(args),
      300_000,
    ),
  ]
}

/** 递归截断字符串，保证工具结果不超过输出预算。 */
export function truncateValue(value: unknown, maxBytes: number): unknown {
  const limit = Math.max(1024, maxBytes)
  let used = 0
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 8) return '[depth-limit]'
    if (typeof input === 'string') {
      const remaining = limit - used
      if (input.length * 2 <= remaining) {
        used += input.length * 2
        return input
      }
      const keep = Math.max(0, Math.floor(remaining / 2))
      used = limit
      return `${input.slice(0, keep)}…[truncated]`
    }
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => walk(item, depth + 1))
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        out[key] = walk(item, depth + 1)
      }
      return out
    }
    return input
  }
  return walk(value, 0)
}

/** 需要用户批准的调用：危险工具整体 + knowledge_manage 里的危险 action。 */
export function needsApproval(name: string, args: Record<string, unknown>): boolean {
  if (name === 'system_maintenance') return true
  if (name === 'knowledge_manage') {
    return ['invalidate', 'rollback'].includes(String(args.action ?? ''))
  }
  return false
}

export function approvalReason(name: string, args: Record<string, unknown>): string {
  const target = String(args.chunkId ?? args.dbFile ?? args.destDir ?? args.projectId ?? '')
  const suffix = target ? `（${target.slice(0, 80)}）` : ''
  return `自主学习插件请求执行高风险操作「${name}${args.action ? `:${String(args.action)}` : ''}」${suffix}。批准仅对本次调用有效；拒绝则不会改动知识库。`
}
