/**
 * 引擎装配：唯一的依赖注入点。
 *
 * 入口（DSH 原生 Tools / MCP / CLI）都只拿这个对象，
 * 业务逻辑不在适配层复制——这是「单一引擎」约束的落地。
 */
import { mkdirSync } from 'node:fs'
import { loadConfig, ensurePaths, applyHostSettings, type Config } from './core/config.ts'
import { AutolearnError, ERROR_CODES } from './core/errors.ts'
import { Database } from './infrastructure/database/database.ts'
import { SCHEMA_VERSION } from './infrastructure/database/schema.ts'
import { HashingEmbedder } from './infrastructure/embeddings/hashing-embedder.ts'
import { VectorIndex } from './infrastructure/embeddings/vector-index.ts'
import { bm25Search } from './infrastructure/retrieval/bm25.ts'
import { tokenize } from './infrastructure/retrieval/tokenizer.ts'
import { KnowledgeStore } from './domain/knowledge/store.ts'
import { KnowledgeVerifier } from './domain/learning/verifier.ts'
import { LearningPlanner } from './domain/learning/planner.ts'
import { LearningRepository } from './domain/learning/repository.ts'
import { GapAnalyzer } from './domain/learning/gaps.ts'
import { LearningEvaluator } from './domain/learning/evaluator.ts'
import { LearningOrchestrator } from './domain/learning/orchestrator.ts'
import { ReportGenerator } from './domain/learning/report.ts'
import { PracticeGenerator } from './domain/practice/generator.ts'
import { CodeTestRunner } from './domain/practice/runner.ts'
import { SourceReader } from './infrastructure/sources/reader.ts'
import { AuditLogger } from './security/audit.ts'
import { ApprovalService } from './security/approval.ts'
import { PathPolicy } from './security/paths.ts'
import { PermissionManager } from './security/permissions.ts'
import { describeNetworkPolicy, type NetworkPolicyOptions } from './security/network.ts'
import { ensurePartitionAllowed, describePartitions } from './domain/knowledge/domains.ts'
import { AutolearnServices } from './application/services.ts'

export interface EngineOptions {
  config?: Config
  home?: string
  env?: NodeJS.ProcessEnv
  /** 只有 DSH 原生适配层（真的注册了 pre-execute 审批）才允许传 true。 */
  hostApproval?: boolean
  telemetry?: (event: string, fields: Record<string, unknown>) => void
}

export interface EngineDiagnostics {
  ok: boolean
  schema_version: number
  schema_supported: number
  paths: Record<string, string>
  config: Record<string, unknown>
  permissions: Record<string, unknown>
  network: Record<string, unknown>
  storage: Record<string, unknown>
  integrity: Record<string, unknown>
  index: Record<string, unknown>
  tools: string[]
  partitions: Array<Record<string, unknown>>
}

export class AutolearnEngine {
  readonly config: Config
  readonly db: Database
  readonly store: KnowledgeStore
  readonly repo: LearningRepository
  readonly verifier: KnowledgeVerifier
  readonly planner: LearningPlanner
  readonly gaps: GapAnalyzer
  readonly evaluator: LearningEvaluator
  readonly orchestrator: LearningOrchestrator
  readonly report: ReportGenerator
  readonly practice: PracticeGenerator
  readonly runner: CodeTestRunner
  readonly reader: SourceReader
  readonly permissions: PermissionManager
  readonly audit: AuditLogger
  readonly approval: ApprovalService
  readonly pathPolicy: PathPolicy
  readonly index: VectorIndex
  readonly services: AutolearnServices
  private readonly hostApproval: boolean
  private closed = false

  private constructor(config: Config, hostApproval: boolean, telemetry?: EngineOptions['telemetry']) {
    this.config = config
    this.hostApproval = hostApproval
    ensurePaths(config.paths)

    this.db = new Database(config.paths.db_path)
    this.db.migrate()

    this.audit = new AuditLogger(this.db, {
      enabled: config.security.audit_log,
      sink: (line) => telemetry?.('audit', { line }),
    })
    this.approval = new ApprovalService(this.db, { audit: this.audit })
    this.pathPolicy = new PathPolicy({
      allowedRoots: config.security.allowed_roots,
      dataDir: config.paths.data_dir,
    })
    this.permissions = new PermissionManager({
      security: config.security,
      learning: config.learning,
      pathPolicy: this.pathPolicy,
      approvals: this.approval,
      audit: this.audit,
      mode: config.learning.default_mode,
      delegateToHost: hostApproval,
    })

    const embedder = new HashingEmbedder(config.embedding.dim, config.embedding.model || 'hashed-ngram')
    this.index = new VectorIndex({
      indexDir: config.paths.index_dir,
      embedder,
      cache: config.embedding.cache,
      maxCacheEntries: config.embedding.max_cache_entries,
    })
    this.index.load()
    this.store = new KnowledgeStore(this.db, this.index, config.retrieval)
    this.repo = new LearningRepository(this.db)
    this.verifier = new KnowledgeVerifier(this.store)
    this.planner = new LearningPlanner(this.repo, config.learning)
    this.gaps = new GapAnalyzer(this.db, this.store, this.repo)
    this.evaluator = new LearningEvaluator(this.db, this.store, this.repo, this.gaps)
    this.practice = new PracticeGenerator(this.db, this.store)
    this.runner = new CodeTestRunner({
      timeoutSeconds: config.security.exec_timeout_s,
      maxOutputBytes: config.security.max_output_bytes,
      experimentsDir: config.paths.experiments_dir,
      pathPolicy: this.pathPolicy,
    })
    this.report = new ReportGenerator({
      db: this.db, repo: this.repo, evaluator: this.evaluator, gaps: this.gaps,
      reportsDir: config.paths.reports_dir,
    })
    this.reader = new SourceReader({
      pathPolicy: this.pathPolicy,
      network: this.networkOptions(),
      maxBytes: config.security.max_download_bytes,
      maxChars: config.learning.max_doc_chars,
      allowNetwork: config.security.allow_network,
    })
    this.orchestrator = new LearningOrchestrator({
      config, db: this.db, store: this.store, repo: this.repo, planner: this.planner,
      gaps: this.gaps, evaluator: this.evaluator, verifier: this.verifier, reader: this.reader,
      practice: this.practice, runner: this.runner, report: this.report,
      permissions: this.permissions, audit: this.audit, pathPolicy: this.pathPolicy, telemetry,
      reloadSettings: () => this.reloadHostSettings(),
    })
    this.services = new AutolearnServices(this)
  }

  static open(options: EngineOptions = {}): AutolearnEngine {
    const config = options.config ?? loadConfig({ home: options.home, env: options.env })
    mkdirSync(config.paths.data_dir, { recursive: true })
    return new AutolearnEngine(config, options.hostApproval ?? false, options.telemetry)
  }

  networkOptions(): NetworkPolicyOptions {
    const security = this.config.security
    return {
      allowNetwork: security.allow_network,
      allowedDomains: security.allowed_domains,
      allowPrivateNetworks: security.allow_private_networks,
      maxRedirects: security.max_redirects,
      maxBytes: security.max_download_bytes,
      allowedContentTypes: security.allowed_content_types,
    }
  }

  get hostApprovalActive(): boolean {
    return this.hostApproval
  }

  /**
   * 宿主设置卡热生效：模式与每日预算在每轮开始时重读（与旧版行为一致）。
   * 只接受白名单键，非法值被忽略；dataDir 变更仍需重启（数据库已打开）。
   */
  reloadHostSettings(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    const applied = applyHostSettings(this.config, this.config.paths.home, env)
    if (typeof applied.mode === 'string') this.permissions.setMode(applied.mode)
    return applied
  }

  /** 插件的所有句柄都在这里释放：数据库连接 + 索引文件锁。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  get isClosed(): boolean {
    return this.closed
  }

  diagnostics(): EngineDiagnostics {
    if (this.closed) {
      throw new AutolearnError('引擎已关闭', { code: ERROR_CODES.INVALID_STATE })
    }
    const storage = this.db.stats()
    const integrity = this.store.checkIntegrity()
    return {
      ok: Boolean((integrity.database as { ok?: boolean } | undefined)?.ok),
      schema_version: this.db.schemaVersion(),
      schema_supported: SCHEMA_VERSION,
      paths: {
        home: this.config.paths.home,
        data_dir: this.config.paths.data_dir,
        db_path: this.config.paths.db_path,
        index_dir: this.config.paths.index_dir,
        corpus_dir: this.config.paths.corpus_dir,
      },
      config: {
        mode: this.permissions.mode,
        network: this.config.security.allow_network,
        embedding: this.config.embedding.provider,
        model: this.config.model.provider,
        daily_budget_usd: this.config.learning.daily_budget_usd,
        max_tasks_per_run: this.config.learning.max_tasks_per_run,
        host_approval: this.hostApproval,
      },
      permissions: {
        mode: this.permissions.mode,
        allowed_roots: this.pathPolicy.allowedRoots,
        delegate_to_host: this.hostApproval,
        pending_confirmations: this.approval.pending().length,
      },
      network: describeNetworkPolicy(this.networkOptions()),
      storage: { ...storage, counts: storage },
      integrity,
      index: this.index.stats(),
      tools: [],
      partitions: describePartitions(),
    }
  }

  // 供服务层复用的内部能力
  assertPartitionAllowed(project: { partitions?: string[] } | null, partition: string): void {
    ensurePartitionAllowed(project, partition)
  }

  bm25(query: string, allowed: readonly string[] | null, topK = 20): Array<{ chunkId: string; score: number }> {
    return bm25Search(this.db, query, allowed, topK)
  }

  tokenize(text: string): string[] {
    return tokenize(text)
  }
}

export { loadConfig, AutolearnServices }
export type { Config }
