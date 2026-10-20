/**
 * 自主学习编排器：run_round 的完整闭环。
 *
 * 流程：恢复中断 → 规划（如无任务）→ 取就绪任务 → 执行 → 记账 →
 *       预算/停滞/上限判定 → 评估 → 写 run 记录。
 * 失败：attempts <= max_retries 进入 retrying，超限 failed 并阻塞直接依赖者（一跳）。
 *
 * 与 v1.2 的差异（有意修复，见 docs/refactor/audit.md）：
 * - 任务启动前预算耗尽时，把任务置回 retrying 而不是留在 running；
 * - run.status 的 failed 分支真实可达（旧版 error 变量恒空）；
 * - summary.note 在写库前组装，不再丢失。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { BudgetExceededError, AutolearnError, ERROR_CODES } from '../../core/errors.ts'
import { contentFingerprint, makeChunkId, newId, round, utcnowIso } from '../../core/ids.ts'
import { parseJsonObject } from '../../core/json.ts'
import {
  KnowledgeStatus, LearningDepth, VerificationMethod, VerificationResult,
  type ChunkRow, type RunRow, type TaskRow,
} from '../../core/types.ts'
import type { Config } from '../../core/config.ts'
import type { Database } from '../../infrastructure/database/database.ts'
import type { PathPolicy } from '../../security/paths.ts'
import type { PermissionManager } from '../../security/permissions.ts'
import type { AuditLogger } from '../../security/audit.ts'
import { BudgetTracker } from '../../security/budget.ts'
import { ensurePartitionAllowed, partitionForDomain, projectPartitions, REGISTRY } from '../knowledge/domains.ts'
import { classifyKnowledgeType, extractKnowledge, type ExtractionDocument } from '../knowledge/extractor.ts'
import { assessQuality } from '../knowledge/quality.ts'
import type { KnowledgeStore } from '../knowledge/store.ts'
import type { SourceReader, ReadResult } from '../../infrastructure/sources/reader.ts'
import { discover as discoverSources } from '../../infrastructure/sources/discovery.ts'
import { describeSource, normalizeLocation } from '../../infrastructure/sources/metadata.ts'
import { computeLevel, evaluateTransition } from './state-machine.ts'
import type { LearningRepository } from './repository.ts'
import type { LearningPlanner } from './planner.ts'
import type { GapAnalyzer } from './gaps.ts'
import type { LearningEvaluator } from './evaluator.ts'
import type { KnowledgeVerifier } from './verifier.ts'
import type { PracticeGenerator } from '../practice/generator.ts'
import type { CodeTestRunner } from '../practice/runner.ts'
import type { ReportGenerator } from './report.ts'

export interface OrchestratorDeps {
  config: Config
  db: Database
  store: KnowledgeStore
  repo: LearningRepository
  planner: LearningPlanner
  gaps: GapAnalyzer
  evaluator: LearningEvaluator
  verifier: KnowledgeVerifier
  reader: SourceReader
  practice: PracticeGenerator
  runner: CodeTestRunner
  report: ReportGenerator
  permissions: PermissionManager
  audit: AuditLogger
  pathPolicy: PathPolicy
  telemetry?: (event: string, fields: Record<string, unknown>) => void
  /** 每轮重读宿主设置卡（可选，测试可注入）。 */
  reloadSettings?: () => Record<string, unknown>
}

export interface CreateProjectOptions {
  goal: string
  title?: string
  domain?: string
  depth?: string
  mode?: string
  partitions?: string[]
  acceptanceCriteria?: string[]
  deliverables?: string[]
  allowedSources?: string[]
  budget?: Record<string, unknown>
}

export interface ProjectDetail {
  project: import('../../core/types.ts').ProjectRow
  tasks: Record<string, number>
  chunks: number
  budget_config: Record<string, number>
}

export interface RunRoundResult {
  project_id: string
  run_id: string
  iteration: number
  tasks_executed: Array<Record<string, unknown>>
  new_knowledge: number
  stop_reason: string
  budget: Record<string, unknown>
  evaluation: Record<string, unknown>
  settings: Record<string, unknown>
  continue_recommended: boolean
}

export class LearningOrchestrator {
  private readonly deps: OrchestratorDeps
  private readonly cfg: Config['learning']

  constructor(deps: OrchestratorDeps) {
    this.deps = deps
    this.cfg = deps.config.learning
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.deps.telemetry?.(event, fields)
  }

  // ------------------------------------------------------------------ //
  // 项目
  // ------------------------------------------------------------------ //
  createProject(options: CreateProjectOptions): ProjectDetail {
    const goal = (options.goal ?? '').trim()
    if (!goal) throw new AutolearnError('学习目标 goal 不能为空', { code: ERROR_CODES.VALIDATION_FAILED })
    const depth = options.depth ?? LearningDepth.WORKING
    if (!Object.values(LearningDepth).includes(depth as LearningDepth)) {
      throw new AutolearnError('depth 必须是 overview/working/deep', { code: ERROR_CODES.VALIDATION_FAILED })
    }
    const domain = options.domain && REGISTRY.has(options.domain) ? options.domain : REGISTRY.resolveByKeywords(goal)
    const partitions = options.partitions ?? projectPartitions(domain)
    for (const partition of partitions) ensurePartitionAllowed(null, partition)
    const mode = options.mode ?? this.deps.permissions.mode
    const project = this.deps.repo.createProject({
      title: options.title?.trim() || goal.slice(0, 40),
      goal, domain, partitions, depth, mode,
      acceptanceCriteria: options.acceptanceCriteria,
      deliverables: options.deliverables,
      allowedSources: options.allowedSources,
      budget: options.budget,
    })
    this.deps.audit.log({ action: 'create_learning_project', target: project.project_id, risk: 'write', allowed: true, projectId: project.project_id })
    this.deps.repo.recordMetric('project', 'created', 1, project.project_id)
    return this.getProject(project.project_id)
  }

  getProject(projectId: string): ProjectDetail {
    const project = this.deps.repo.requireProject(projectId)
    return {
      project,
      tasks: this.deps.repo.taskCounts(projectId),
      chunks: this.deps.store.countChunks({ projectId }),
      budget_config: {
        max_iterations_per_run: this.cfg.max_iterations_per_run,
        max_tasks_per_run: this.cfg.max_tasks_per_run,
        max_sources_per_task: this.cfg.max_sources_per_task,
        daily_budget_usd: this.cfg.daily_budget_usd,
      },
    }
  }

  listProjects(status?: string): ReturnType<LearningRepository['listProjects']> {
    return this.deps.repo.listProjects(status)
  }

  setStatus(projectId: string, status: string): Record<string, unknown> {
    if (!['active', 'paused', 'completed', 'cancelled', 'blocked'].includes(status)) {
      throw new AutolearnError(`项目状态非法: ${status}`, { code: ERROR_CODES.VALIDATION_FAILED })
    }
    const project = this.deps.repo.setProjectStatus(projectId, status)
    this.deps.audit.log({ action: 'project_status', target: projectId, risk: 'write', allowed: true, projectId, detail: { status } })
    return { project_id: project.project_id, status: project.status }
  }

  plan(projectId: string, useModel = false): Record<string, unknown> {
    const project = this.deps.repo.requireProject(projectId)
    const existing = this.deps.repo.listTasks(projectId)
    if (existing.length > 0) {
      return { project_id: projectId, already_planned: true, task_count: existing.length, tasks: existing }
    }
    const plan = this.deps.planner.createPlan(project)
    this.deps.repo.recordMetric('plan', 'tasks_created', plan.task_count, projectId)
    const warnings = useModel ? ['模型辅助规划未迁移（本次重构只保留规则规划）；use_model 参数被忽略'] : []
    this.deps.audit.log({ action: 'plan_learning_path', target: projectId, risk: 'write', allowed: true, projectId, detail: { tasks: plan.task_count } })
    return { ...plan, warnings }
  }

  // ------------------------------------------------------------------ //
  // 资料入库
  // ------------------------------------------------------------------ //
  ingestDocument(projectId: string, read: ReadResult, topic = ''): Record<string, unknown> {
    const project = this.deps.repo.requireProject(projectId)
    const location = normalizeLocation(read.location)
    const existing = this.deps.db.query(
      'SELECT * FROM sources WHERE project_id=? AND location=? ORDER BY created_at DESC LIMIT 1',
      [projectId, location],
    )[0]
    const now = utcnowIso()
    let sourceId = String(existing?.source_id ?? '')
    let superseded = 0
    if (existing) {
      const hashChanged = String(existing.content_hash ?? '') !== read.content_hash
      if (hashChanged) superseded = this.supersedeDocuments(projectId, sourceId, '来源内容发生变化')
      if (!hashChanged) {
        this.deps.db.update('sources', sourceId, {
          accessed_at: now, fetch_ok: read.ok ? 1 : 0, error: read.error.slice(0, 500),
          metadata: { ...parseJsonObject(existing.metadata), bytes: read.bytes, doc_type: read.doc_type, topic },
        })
        return { source_id: sourceId, document_id: '', location, unchanged: true, superseded_documents: superseded }
      }
      this.deps.db.update('sources', sourceId, {
        title: read.title, content_hash: read.content_hash, accessed_at: now,
        fetch_ok: read.ok ? 1 : 0, error: read.error.slice(0, 500),
        freshness_status: read.freshness_status, license_status: read.license_status,
        quality: read.quality, quality_basis: read.quality_basis,
        metadata: { ...parseJsonObject(existing.metadata), bytes: read.bytes, doc_type: read.doc_type, topic },
      })
    } else {
      sourceId = newId('src')
      this.deps.db.insert('sources', {
        source_id: sourceId,
        project_id: projectId,
        source_type: read.source_type,
        location,
        title: read.title,
        publisher: '',
        published_at: read.published_at,
        accessed_at: now,
        license_status: read.license_status,
        quality: read.quality,
        quality_basis: read.quality_basis,
        freshness_status: read.freshness_status,
        content_hash: read.content_hash,
        fetch_ok: read.ok ? 1 : 0,
        error: read.error.slice(0, 500),
        metadata: { bytes: read.bytes, doc_type: read.doc_type, topic },
        created_at: now,
      })
    }

    const documentId = newId('doc')
    const contentPath = `${this.deps.config.paths.documents_dir}/${documentId}.txt`
    writeFileSync(contentPath, read.text, 'utf8')
    this.deps.db.insert('documents', {
      document_id: documentId,
      project_id: projectId,
      source_id: sourceId,
      title: read.title,
      doc_type: read.doc_type,
      language: read.language,
      content_path: contentPath,
      content_hash: read.content_hash,
      char_count: read.char_count,
      parser: read.parser,
      parse_status: 'parsed',
      error: '',
      stages: {
        registered: true, fetched: true, parsed: true,
        extracted: false, classified: false, indexed: false,
        retrieval_verified: false, task_verified: false,
      },
      created_at: now,
    })
    this.deps.audit.log({ action: 'ingest_document', target: location, risk: 'read', allowed: true, projectId })
    return {
      source_id: sourceId, document_id: documentId, location,
      chars: read.char_count, source_type: read.source_type, quality: read.quality,
      unchanged: false, superseded_documents: superseded,
      project_domain: project.domain,
    }
  }

  private supersedeDocuments(projectId: string, sourceId: string, reason: string): number {
    const docs = this.deps.db.query(
      "SELECT document_id FROM documents WHERE project_id=? AND source_id=? AND parse_status='parsed'",
      [projectId, sourceId],
    ) as Array<{ document_id: string }>
    const now = utcnowIso()
    for (const doc of docs) {
      this.deps.db.update('documents', doc.document_id, { parse_status: 'superseded', error: reason, stages: { superseded: true, reason } })
    }
    let invalidated = 0
    for (const doc of docs) {
      const chunks = this.deps.store.listChunks({ projectId, limit: 5000, includeInvalidated: false })
      for (const chunk of chunks) {
        if (chunk.document_id !== doc.document_id) continue
        this.deps.store.invalidateChunk(chunk.chunk_id, reason)
        invalidated += 1
      }
    }
    return docs.length + invalidated
  }

  saveKnowledge(projectId: string, items: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
    const project = this.deps.repo.requireProject(projectId)
    const saved: Array<Record<string, unknown>> = []
    const warnings: string[] = []
    for (const item of items) {
      const content = String(item.content ?? '')
      const summary = String(item.summary ?? '')
      if (!content.trim() && !summary.trim()) {
        throw new AutolearnError('保存知识需要 content 或 summary', { code: ERROR_CODES.VALIDATION_FAILED })
      }
      const partition = String(item.partition ?? 'pending_knowledge')
      ensurePartitionAllowed(project, partition)
      const classification = classifyKnowledgeType(content || summary, String(item.title ?? ''))
      const domain = typeof item.domain === 'string' && REGISTRY.has(item.domain) ? item.domain : project.domain
      const sourceUrl = String(item.source_url ?? '')
      const described = sourceUrl ? describeSource(sourceUrl, { title: String(item.source_title ?? '') }) : null
      const decision = this.deps.permissions.decide('save_knowledge', 'write', partition, { projectId, content })
      if (!decision.allowed) {
        throw new AutolearnError(decision.reason, { code: ERROR_CODES.POLICY_DENIED, details: { ...decision } })
      }
      const chunk: Partial<ChunkRow> = {
        chunk_id: makeChunkId(projectId, contentFingerprint(content || summary)),
        project_id: projectId,
        partition,
        domain,
        topic: String(item.topic ?? ''),
        subtopic: String(item.subtopic ?? ''),
        title: String(item.title ?? ''),
        content,
        summary,
        knowledge_type: typeof item.knowledge_type === 'string' && item.knowledge_type ? item.knowledge_type : classification.type,
        status: KnowledgeStatus.PENDING_VERIFICATION,
        level: 'L2',
        source_url: sourceUrl,
        source_title: String(item.source_title ?? ''),
        source_type: String(item.source_type ?? described?.source_type ?? 'unknown'),
        author_or_publisher: String(item.author_or_publisher ?? ''),
        published_at: String(item.published_at ?? ''),
        accessed_at: utcnowIso(),
        source_quality: Number(item.source_quality ?? described?.quality ?? 0.5),
        confidence: Number(item.confidence ?? 0.3),
        confidence_basis: described ? String(described.quality_basis) : '调用方显式指定来源质量',
        verification_status: 'unverified',
        verification_method: 'none',
        verification_evidence: [],
        license_status: String(item.license_status ?? described?.license_status ?? 'unknown'),
        source_excerpt: String(item.source_excerpt ?? content.slice(0, 300)),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        visibility: String(item.visibility ?? 'project'),
        metadata: { extraction_method: 'tool', classification_scores: classification.scores, classification_basis: classification.basis },
      }
      const result = this.deps.store.addChunks([chunk])
      warnings.push(...result.warnings)
      saved.push({ chunk_id: chunk.chunk_id, title: chunk.title, knowledge_type: chunk.knowledge_type })
    }
    this.deps.audit.log({ action: 'save_knowledge', target: projectId, risk: 'write', allowed: true, projectId, detail: { count: saved.length } })
    return { project_id: projectId, saved: saved.length, chunks: saved, warnings }
  }

  // ------------------------------------------------------------------ //
  // 运行
  // ------------------------------------------------------------------ //
  async runRound(projectId: string, options: { maxTasks?: number } = {}): Promise<RunRoundResult> {
    const project = this.deps.repo.requireProject(projectId)
    if (project.status !== 'active') {
      return {
        project_id: projectId, run_id: '', iteration: 0, tasks_executed: [],
        new_knowledge: 0, stop_reason: `项目状态为 ${project.status}，不是 active，拒绝运行`,
        budget: {}, evaluation: {}, settings: {}, continue_recommended: false,
      }
    }
    const settings = this.deps.reloadSettings?.() ?? {}
    const recovered = this.recover(projectId)
    const iteration = this.deps.repo.nextIteration(projectId)
    const runId = newId('run')
    const run: RunRow = {
      run_id: runId, project_id: projectId, iteration, status: 'running',
      summary: {}, stop_reason: '', started_at: utcnowIso(), finished_at: '',
    }
    this.deps.repo.startRun(run)
    const tracker = new BudgetTracker(this.cfg, this.deps.config.model, {
      db: this.deps.db, runId, projectId, dailySpent: this.deps.repo.todaySpend(),
    })
    tracker.setIteration(iteration)
    if (this.deps.repo.listTasks(projectId).length === 0) this.plan(projectId)

    const limit = Math.max(1, Math.min(Number(options.maxTasks ?? this.cfg.max_tasks_per_run), this.cfg.max_tasks_per_run))
    const executed: Array<Record<string, unknown>> = []
    let newKnowledge = 0
    let stopReason = ''
    let evaluation: Record<string, unknown> = {}
    let failed = false

    try {
      for (;;) {
        const stop = tracker.shouldStop()
        if (stop.stop) {
          stopReason = stop.reason
          break
        }
        const ready = this.deps.repo.nextReadyTasks(projectId, 1)
        if (ready.length === 0) {
          stopReason = 'no_ready_tasks'
          break
        }
        const task = ready[0] as TaskRow
        try {
          const outcome = await this.executeTask(task, tracker, runId)
          const gained = Number(outcome.new_knowledge ?? 0)
          newKnowledge += gained
          tracker.finishTask(gained, Boolean(outcome.progress))
          if (task.kind === 'discover') tracker.consumeSources(Number(outcome.sources_saved ?? 0))
          executed.push({
            task_id: task.task_id, kind: task.kind, title: task.title,
            status: 'completed', new_knowledge: gained,
            details: Object.fromEntries(
              Object.entries(outcome).filter(([key, value]) =>
                !['new_knowledge', 'progress', 'sources_saved', 'documents', 'drafts', 'chunks', 'warnings'].includes(key) &&
                (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
              ),
            ),
          })
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            this.deps.repo.updateTask(task.task_id, { status: 'retrying', started_at: '', error: error.message.slice(0, 1000) })
            stopReason = String(error.details.dimension ?? 'budget_exceeded')
            executed.push({ task_id: task.task_id, status: 'blocked', error: error.message })
            break
          }
          this.handleTaskFailure(task, error)
          executed.push({
            task_id: task.task_id, kind: task.kind,
            status: this.deps.repo.getTask(task.task_id)?.status ?? 'failed',
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          })
          continue
        }
        if (executed.length >= limit) {
          stopReason = 'max_tasks_per_run'
          break
        }
      }

      if (!stopReason && this.cfg.stop_when_no_new_knowledge) {
        if (this.roundsWithoutProgress(projectId, runId) >= this.cfg.no_progress_rounds) stopReason = 'no_progress'
      }
      if (!stopReason && this.deps.repo.nextReadyTasks(projectId, 1).length > 0) {
        stopReason = limit >= this.cfg.max_tasks_per_run ? 'max_tasks_per_run' : 'task_limit_reached'
      }
    } catch (error) {
      failed = true
      stopReason = stopReason || 'error'
      evaluation = { error: error instanceof Error ? error.message : String(error) }
    } finally {
      const safeEvaluation = this.safeEvaluate(projectId)
      evaluation = Object.keys(evaluation).length > 0 ? { ...safeEvaluation, error: evaluation.error } : safeEvaluation
      const summary: Record<string, unknown> = {
        run_id: runId, iteration, tasks_executed: executed.length, new_knowledge: newKnowledge,
        stop_reason: stopReason, budget: tracker.snapshot(),
        goal_met: Boolean(safeEvaluation.goal_met),
        coverage_rate: Number((safeEvaluation.metrics as Record<string, unknown> | undefined)?.coverage_rate ?? 0),
        remaining: Array.isArray(safeEvaluation.remaining) ? safeEvaluation.remaining.slice(0, 10) : [],
        recovered,
      }
      if (safeEvaluation.goal_met) summary.note = '量化指标已达标，等待人工评审确认后才算完成'
      this.deps.repo.finishRun(runId, failed ? 'failed' : stopReason ? 'stopped' : 'completed', summary, stopReason)
      this.deps.repo.recordMetric('run', 'new_knowledge', newKnowledge, projectId, runId)
      this.log('run.finished', { project_id: projectId, run_id: runId, stop_reason: stopReason, new_knowledge: newKnowledge })
    }

    return {
      project_id: projectId,
      run_id: runId,
      iteration,
      tasks_executed: executed,
      new_knowledge: newKnowledge,
      stop_reason: stopReason,
      budget: tracker.snapshot() as unknown as Record<string, unknown>,
      evaluation,
      settings,
      continue_recommended: this.shouldContinue(projectId, evaluation, stopReason),
    }
  }

  private async executeTask(
    task: TaskRow,
    tracker: BudgetTracker,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const started = Date.now()
    this.deps.repo.updateTask(task.task_id, {
      status: 'running', attempts: Number(task.attempts) + 1,
      started_at: utcnowIso(), error: '',
    })
    tracker.startTask()
    this.log('task.started', { task_id: task.task_id, kind: task.kind })
    this.deps.repo.recordMetric('task', `start:${task.kind}`, 1, task.project_id, runId)
    let result: Record<string, unknown>
    switch (task.kind) {
      case 'plan':
        result = { new_knowledge: 0, progress: true, ...this.plan(task.project_id) }
        break
      case 'gap_analysis': {
        const analysis = this.deps.gaps.analyze(task.project_id, { record: true })
        result = { new_knowledge: 0, progress: true, coverage_rate: analysis.coverage_rate, gaps: analysis.gaps.length, recorded_gaps: analysis.recorded_gaps }
        break
      }
      case 'discover':
        result = await this.taskDiscover(task, tracker)
        break
      case 'extract':
        result = this.taskExtract(task, tracker)
        break
      case 'verify':
        result = this.taskVerify(task)
        break
      case 'practice':
        result = await this.taskPractice(task)
        break
      case 'evaluate':
        result = this.taskEvaluate(task, runId)
        break
      case 'report': {
        const report = this.deps.report.generate(task.project_id)
        result = { new_knowledge: 0, progress: true, report_path: report.report_path, goal_met: report.goal_met }
        break
      }
      default:
        throw new AutolearnError(`未知任务类型: ${task.kind}`, { code: ERROR_CODES.INVALID_STATE })
    }
    const elapsed = (Date.now() - started) / 1000
    this.deps.repo.updateTask(task.task_id, {
      status: 'completed', finished_at: utcnowIso(), error: '',
      result: sanitizeResult(result),
    })
    this.deps.repo.recordMetric('task', `done:${task.kind}`, 1, task.project_id, runId)
    this.log('task.completed', { task_id: task.task_id, kind: task.kind, elapsed_s: round(elapsed, 3) })
    return result
  }

  private async taskDiscover(task: TaskRow, _tracker: BudgetTracker): Promise<Record<string, unknown>> {
    const project = this.deps.repo.requireProject(task.project_id)
    const topic = String(task.inputs.topic ?? '')
    const locations = Array.isArray(task.inputs.locations)
      ? (task.inputs.locations as unknown[]).map(String)
      : project.allowed_sources ?? []
    const warnings: string[] = []
    const failures: string[] = []
    const documents: string[] = []

    const discovered = await discoverSources({
      topics: topic ? [topic] : [],
      explicitLocations: locations,
      keywords: topic ? [topic] : [],
      corpusDir: this.deps.config.paths.corpus_dir,
      limit: this.cfg.max_sources_per_task,
      allowNetwork: this.deps.config.security.allow_network,
    })
    warnings.push(...discovered.warnings)
    let saved = 0
    for (const candidate of discovered.candidates.slice(0, this.cfg.max_sources_per_task)) {
      const location = normalizeLocation(candidate.location)
      const previousSource = this.deps.db.query(
        'SELECT metadata FROM sources WHERE project_id=? AND location=? ORDER BY created_at DESC LIMIT 1',
        [task.project_id, location],
      )[0]
      const previousMeta = parseJsonObject(previousSource?.metadata)
      const read = await this.deps.reader.read(candidate.location, previousMeta)
      if (read.not_modified) {
        warnings.push(`内容未修改，已跳过: ${candidate.location}`)
        continue
      }
      if (!read.ok) {
        failures.push(`${candidate.location}: ${read.error}`)
        const sourceId = newId('src')
        this.deps.db.insert('sources', {
          source_id: sourceId, project_id: task.project_id, source_type: candidate.source_type,
          location, title: candidate.title, publisher: '', published_at: '',
          accessed_at: utcnowIso(), license_status: 'unknown', quality: candidate.quality,
          quality_basis: candidate.quality_basis, freshness_status: 'unknown', content_hash: '',
          fetch_ok: 0, error: read.error.slice(0, 500), metadata: { topic }, created_at: utcnowIso(),
        })
        continue
      }
      const duplicate = this.deps.db.query(
        'SELECT source_id FROM sources WHERE project_id=? AND content_hash=? LIMIT 1',
        [task.project_id, read.content_hash],
      )
      if (duplicate.length > 0) {
        warnings.push(`内容重复，已跳过: ${candidate.location}`)
        continue
      }
      try {
        const ingested = this.ingestDocument(task.project_id, read, topic)
        saved += 1
        documents.push(String(ingested.document_id))
      } catch (error) {
        failures.push(`${candidate.location}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (saved > 0) {
      this.deps.audit.log({ action: 'discover_sources', target: topic, risk: 'read', allowed: true, projectId: task.project_id, detail: { saved } })
    }
    return {
      new_knowledge: 0, progress: saved > 0, sources_saved: saved,
      documents: documents.slice(0, 10), failures: failures.slice(0, 10), warnings: warnings.slice(0, 20),
    }
  }

  private taskExtract(task: TaskRow, tracker: BudgetTracker): Record<string, unknown> {
    const project = this.deps.repo.requireProject(task.project_id)
    const topic = String(task.inputs.topic ?? '')
    let documents = this.deps.db.query(
      "SELECT * FROM documents WHERE project_id=? AND parse_status='parsed' ORDER BY created_at LIMIT ?",
      [task.project_id, Math.max(this.cfg.max_sources_per_task * 4, 20)],
    )
    if (topic) {
      const tagged: typeof documents = []
      const untagged: typeof documents = []
      for (const doc of documents) {
        const source = this.deps.db.get('sources', String(doc.source_id))
        const meta = parseJsonObject(source?.metadata)
        if (meta.topic === topic) tagged.push(doc)
        else if (!meta.topic) untagged.push(doc)
      }
      documents = (tagged.length > 0 ? tagged : untagged).slice(0, this.cfg.max_sources_per_task)
    } else {
      documents = documents.slice(0, this.cfg.max_sources_per_task)
    }
    const warnings: string[] = []
    let processed = 0
    let added = 0
    const startedAt = Date.now()
    for (const doc of documents) {
      if (Date.now() - startedAt > this.cfg.max_task_seconds * 1000) {
        warnings.push('任务超时：停止继续提取')
        break
      }
      let text: string
      try {
        text = readFileSync(String(doc.content_path), 'utf8')
      } catch (error) {
        this.deps.db.update('documents', String(doc.document_id), {
          parse_status: 'error', error: `读取文档失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        warnings.push(`文档读取失败: ${String(doc.document_id)}`)
        continue
      }
      const source = this.deps.db.get('sources', String(doc.source_id))
      const docMeta: ExtractionDocument = {
        document_id: String(doc.document_id),
        title: String(doc.title),
        source_id: String(doc.source_id),
        source_url: String(source?.location ?? ''),
        source_title: String(source?.title ?? ''),
        source_type: String(source?.source_type ?? 'unknown'),
        author_or_publisher: String(source?.publisher ?? ''),
        published_at: String(source?.published_at ?? ''),
        accessed_at: String(source?.accessed_at ?? ''),
        language: String(doc.language ?? 'unknown'),
        quality: Number(source?.quality ?? 0.5),
        parser: String(doc.parser ?? ''),
        source_version: '',
      }
      const outcome = extractKnowledge({ project, document: docMeta, text, topic, config: this.cfg })
      warnings.push(...outcome.warnings)
      processed += 1
      if (outcome.drafts.length > 0) {
        const result = this.deps.store.addChunks(outcome.drafts)
        warnings.push(...result.warnings)
        added += result.added + result.updated
        this.deps.db.update('documents', String(doc.document_id), {
          parse_status: 'extracted',
          stages: { ...parseJsonObject(doc.stages), extracted: true, classified: true, indexed: true },
        })
      } else {
        this.deps.db.update('documents', String(doc.document_id), {
          parse_status: 'no_knowledge',
          error: outcome.warnings.join('；').slice(0, 500) || '未提取到知识',
          stages: { ...parseJsonObject(doc.stages), extracted: false, zero_yield: true },
        })
      }
    }
    let reason = ''
    if (documents.length === 0) reason = topic ? `没有属于主题「${topic}」的待提取文档` : '没有待提取文档'
    return {
      new_knowledge: added, progress: processed > 0 && added > 0,
      documents_processed: processed, chunks_added: added,
      warnings: warnings.slice(0, 20), reason,
    }
  }

  private taskVerify(task: TaskRow): Record<string, unknown> {
    const topic = String(task.inputs.topic ?? '')
    const chunks = this.deps.store.listChunks({
      projectId: task.project_id,
      statuses: ['pending_verification'],
      ...(topic ? { topics: [topic] } : {}),
      limit: 40,
    })
    const failures: string[] = []
    const warnings: string[] = []
    let verified = 0
    for (const chunk of chunks) {
      try {
        const outcome = this.deps.verifier.verify(chunk.chunk_id)
        warnings.push(...outcome.warnings)
        if (outcome.status_after === 'verified') verified += 1
      } catch (error) {
        failures.push(`${chunk.chunk_id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const promoted = this.promoteVerified(task.project_id)
    return {
      new_knowledge: 0, progress: chunks.length > 0, attempted: chunks.length,
      verified, promoted, failures: failures.slice(0, 10), warnings: warnings.slice(0, 20),
    }
  }

  /** assisted 模式不自动改分区；auto/lab 才把已核验知识移出待审区。 */
  private promoteVerified(projectId: string): number {
    if (this.deps.permissions.mode === 'assisted') return 0
    const project = this.deps.repo.requireProject(projectId)
    const chunks = this.deps.store.listChunks({
      projectId, partitions: ['pending_knowledge'], statuses: ['verified'], limit: 50,
    })
    let moved = 0
    for (const chunk of chunks) {
      const target = partitionForDomain(chunk.domain)
      if (target === 'pending_knowledge') continue
      if (!project.partitions.includes(target)) continue
      this.deps.db.update('chunks', chunk.chunk_id, { partition: target, updated_at: utcnowIso() })
      moved += 1
    }
    return moved
  }

  private async taskPractice(task: TaskRow): Promise<Record<string, unknown>> {
    const generated = this.deps.practice.generate(task.project_id, 5)
    const results: Array<Record<string, unknown>> = []
    const skipped: Array<Record<string, unknown>> = []
    let executed = 0

    for (const practice of generated) {
      const spec = parseJsonObject(practice.spec)
      if (practice.kind === 'formula') {
        const expected = spec.expected
        if (typeof expected !== 'number') {
          skipped.push({ practice_id: practice.practice_id, reason: '缺少期望值，无法重算' })
          continue
        }
        const chunk = this.deps.store.getChunk(practice.chunk_id)
        try {
          const outcome = this.deps.verifier.verifyFormula(practice.chunk_id, {
            expression: Array.isArray(spec.expressions) ? String(spec.expressions[0] ?? '') : undefined,
            variables: parseJsonObject(spec.variables) as Record<string, number>,
            expected,
          })
          executed += 1
          results.push({ practice_id: practice.practice_id, result: outcome.result })
          if (outcome.result === VerificationResult.PASS && chunk) this.markPracticed(chunk.chunk_id, 'formula_recompute', practice.practice_id)
        } catch (error) {
          skipped.push({ practice_id: practice.practice_id, reason: error instanceof Error ? error.message : String(error) })
        }
        continue
      }
      if (practice.kind === 'code_example') {
        if (this.deps.permissions.mode !== 'lab') {
          skipped.push({ practice_id: practice.practice_id, reason: `代码执行仅在 lab 模式允许（当前 ${this.deps.permissions.mode}）` })
          continue
        }
        const decision = this.deps.permissions.decide('run_code_test', 'execute', task.project_id, { projectId: task.project_id })
        if (!decision.allowed) {
          skipped.push({ practice_id: practice.practice_id, reason: decision.reason })
          continue
        }
        try {
          const run = await this.deps.runner.run(String(spec.code ?? ''), {
            trusted: false, practiceId: practice.practice_id, projectId: task.project_id,
            language: String(spec.language ?? 'javascript'),
          })
          executed += 1
          this.deps.practice.addResult({
            result_id: newId('res'),
            practice_id: practice.practice_id,
            status: run.status === 'pass' ? 'pass' : 'fail',
            input_data: { language: spec.language ?? 'javascript' },
            environment: run.environment,
            output: run.stdout,
            error: run.stderr,
            exit_code: run.exit_code,
            conclusion: run.ok ? '执行成功（进程级隔离）' : '执行失败',
            artifact_dir: run.artifact_dir,
            duration_ms: run.duration_ms,
            created_at: utcnowIso(),
          })
          results.push({ practice_id: practice.practice_id, status: run.status })
          if (run.ok) this.markPracticed(practice.chunk_id, 'code_test', practice.practice_id)
        } catch (error) {
          results.push({ practice_id: practice.practice_id, error: error instanceof Error ? error.message : String(error) })
        }
        continue
      }
      skipped.push({ practice_id: practice.practice_id, reason: '该类型不做自动判分' })
    }

    return {
      new_knowledge: 0, progress: executed > 0 || generated.length > 0,
      generated: generated.length, executed,
      results: results.slice(0, 10), skipped: skipped.slice(0, 10),
    }
  }

  private markPracticed(chunkId: string, method: string, practiceId: string): void {
    const chunk = this.deps.store.getChunk(chunkId)
    if (!chunk) return
    if (!['verified', 'pending_verification'].includes(chunk.status)) return
    const record = this.deps.store.addVerification({
      record_id: newId('vrf'), chunk_id: chunkId, method,
      result: VerificationResult.PASS,
      evidence: [{ kind: 'practice_result', practice_id: practiceId, source_id: chunk.source_id }],
      notes: `实践执行成功（${method}）`, verifier: 'system',
    })
    const records = this.deps.store.listVerifications(chunkId)
    const decision = evaluateTransition(chunk, KnowledgeStatus.PRACTICED, records)
    if (!decision.allowed) return
    const level = computeLevel({ ...chunk, status: KnowledgeStatus.PRACTICED }, records)
    this.deps.store.forceVerificationState(chunkId, {
      status: KnowledgeStatus.PRACTICED, level,
      verification_method: method,
      verification_evidence: [...(chunk.verification_evidence as unknown[]), { kind: 'practice_result', practice_id: practiceId }],
      updated_at: utcnowIso(),
      quality_components: assessQuality({ ...chunk, status: KnowledgeStatus.PRACTICED }, records).components,
      quality_score: assessQuality({ ...chunk, status: KnowledgeStatus.PRACTICED }, records).score,
    })
    void record
  }

  private taskEvaluate(task: TaskRow, runId: string): Record<string, unknown> {
    const evaluation = this.deps.evaluator.evaluate(task.project_id)
    const project = this.deps.repo.requireProject(task.project_id)
    let followup = 0
    for (const gap of [...evaluation.gaps].filter((item) => item.kind !== 'duplicates').slice(0, 3)) {
      const gapRow = this.deps.gaps.openGaps(task.project_id).find((row) => row.topic === gap.topic)
      if (!gapRow) continue
      try {
        this.deps.planner.tasksForGap(project, { ...gapRow, reason: gap.reason })
        followup += 2
      } catch {
        /* 幂等冲突不影响本轮 */
      }
    }
    const conflicts = this.deps.db.query(
      "SELECT * FROM conflicts WHERE project_id=? AND status='open' ORDER BY created_at DESC LIMIT 3",
      [task.project_id],
    )
    for (const conflict of conflicts) {
      try {
        this.deps.planner.tasksForConflict(project, {
          conflict_id: String(conflict.conflict_id),
          chunk_a: String(conflict.chunk_a),
          chunk_b: String(conflict.chunk_b),
          detail: String(conflict.detail),
        })
        followup += 1
      } catch {
        /* 同上 */
      }
    }
    const marked = this.markEvaluated(task.project_id, runId, evaluation.goal_met)
    return {
      new_knowledge: 0, progress: true,
      evaluated_chunks: marked, goal_met: evaluation.goal_met,
      coverage_rate: evaluation.metrics.coverage_rate,
      verification_rate: evaluation.metrics.verification_rate,
      remaining: evaluation.remaining.slice(0, 10),
      followup_tasks: followup,
    }
  }

  private markEvaluated(projectId: string, runId: string, goalMet: boolean): number {
    const chunks = this.deps.store.listChunks({ projectId, statuses: ['practiced'], limit: 50 })
    let marked = 0
    for (const chunk of chunks) {
      if (chunk.invalidated_at) continue
      const metadata = { ...parseJsonObject(chunk.metadata), evaluation: { run_id: runId, goal_met: goalMet } }
      this.deps.db.update('chunks', chunk.chunk_id, { metadata, updated_at: utcnowIso() })
      const records = this.deps.store.listVerifications(chunk.chunk_id)
      const decision = evaluateTransition({ ...chunk, metadata }, KnowledgeStatus.EVALUATED, records)
      if (!decision.allowed) continue
      const openConflict = this.deps.db.query(
        "SELECT conflict_id FROM conflicts WHERE status='open' AND (chunk_a=? OR chunk_b=?)",
        [chunk.chunk_id, chunk.chunk_id],
      )
      if (openConflict.length > 0) continue
      this.deps.store.forceVerificationState(chunk.chunk_id, {
        status: KnowledgeStatus.EVALUATED,
        level: computeLevel({ ...chunk, status: KnowledgeStatus.EVALUATED }, records),
        updated_at: utcnowIso(),
      })
      marked += 1
    }
    return marked
  }

  // ------------------------------------------------------------------ //
  // 恢复与判定
  // ------------------------------------------------------------------ //
  recover(projectId: string): { recovered: Array<{ task_id: string; status: string }>; count: number } {
    const rows = this.deps.db.query(
      "SELECT * FROM tasks WHERE project_id=? AND status='running'",
      [projectId],
    )
    const recovered: Array<{ task_id: string; status: string }> = []
    const now = Date.now()
    for (const row of rows) {
      const started = Date.parse(String(row.started_at ?? ''))
      const timeoutMs = Math.max(60, Number(row.timeout_s ?? 300)) * 1000
      const stale = !Number.isFinite(started) || now - started > timeoutMs
      if (!stale) continue
      const attempts = Number(row.attempts ?? 0)
      const maxRetries = Number(row.max_retries ?? 3)
      const status = attempts <= maxRetries ? 'retrying' : 'failed'
      this.deps.repo.updateTask(String(row.task_id), {
        status,
        error: `${String(row.error ?? '')}\n[recover] 检测到中断的运行状态`.trim().slice(0, 1000),
        started_at: '',
      })
      recovered.push({ task_id: String(row.task_id), status })
    }
    return { recovered, count: recovered.length }
  }

  private handleTaskFailure(task: TaskRow, error: unknown): void {
    const attempts = Number(task.attempts) + 1
    const maxRetries = Number(task.max_retries ?? this.cfg.max_retries_per_task)
    const status = attempts <= maxRetries ? 'retrying' : 'failed'
    this.deps.repo.updateTask(task.task_id, {
      status, attempts,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      finished_at: status === 'failed' ? utcnowIso() : '',
    })
    this.log('task.failed', { task_id: task.task_id, kind: task.kind, status, attempts })
    if (status === 'failed') {
      this.deps.repo.blockDependents(task.task_id, task.project_id, (error instanceof Error ? error.message : String(error)).slice(0, 300))
    }
    this.deps.audit.log({
      action: 'task_failed', target: task.task_id, risk: 'write', allowed: false,
      projectId: task.project_id,
      detail: { attempts, status, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
    })
  }

  private roundsWithoutProgress(projectId: string, excludeRunId: string): number {
    const runs = this.deps.repo.lastRuns(projectId, this.cfg.no_progress_rounds + 1)
      .filter((run) => run.run_id !== excludeRunId)
    let count = 0
    for (const run of runs.slice(0, this.cfg.no_progress_rounds)) {
      if (Number(parseJsonObject(run.summary).new_knowledge ?? 0) === 0) count += 1
      else break
    }
    return count
  }

  private safeEvaluate(projectId: string): Record<string, unknown> {
    try {
      return this.deps.evaluator.evaluate(projectId) as unknown as Record<string, unknown>
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), goal_met: false, metrics: {}, remaining: [] }
    }
  }

  private shouldContinue(projectId: string, evaluation: Record<string, unknown>, stopReason: string): boolean {
    if (['daily_budget', 'max_llm_calls_per_run', 'max_tasks_per_run', 'no_progress'].includes(stopReason)) return false
    if (evaluation.goal_met) return false
    return this.deps.repo.nextReadyTasks(projectId, 1).length > 0
  }

  evaluate(projectId: string): Record<string, unknown> {
    return this.deps.evaluator.evaluate(projectId) as unknown as Record<string, unknown>
  }

  generateReport(projectId: string): Record<string, unknown> {
    return this.deps.report.generate(projectId)
  }

  /** 供应用层调用的还原入口。 */
  restoreBackup(dbFile: string, indexDir?: string, manifestPath?: string): Record<string, unknown> {
    const decision = this.deps.permissions.decide('restore_knowledge_base', 'destructive', dbFile)
    if (!decision.allowed) {
      throw new AutolearnError(decision.reason, { code: ERROR_CODES.POLICY_DENIED, details: { ...decision } })
    }
    return this.deps.store.restore(dbFile, indexDir, manifestPath)
  }
}

function sanitizeResult(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
    else if (Array.isArray(value)) out[key] = value.slice(0, 20)
    else if (value && typeof value === 'object') out[key] = value
  }
  return out
}
