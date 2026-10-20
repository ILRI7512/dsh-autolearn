/**
 * 知识存储：写入（行 + 倒排 + 向量）、版本、检索、去重、备份恢复。
 *
 * 关键不变量：
 * 1. 行写入与倒排（tokens/chunk_lex）在同一事务内完成，永不出现「有行无索引」；
 * 2. 向量写入失败不会丢行，但会返回 warning，并由 checkIntegrity 暴露；
 * 3. 所有检索都先算 allowedIds（项目 + visibility），再在该集合内排序，
 *    因此向量/倒排共享不会跨项目泄漏；
 * 4. 部分字段更新后必须用「合并后的整行」重建倒排（旧版踩过的坑）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AutolearnError, ERROR_CODES, NotFoundError, StorageError } from '../../core/errors.ts'
import { contentFingerprint, newId, normalizeText, utcnowIso } from '../../core/ids.ts'
import { parseJsonArray, parseJsonObject } from '../../core/json.ts'
import type { ChunkFilterInput, ChunkRow, VerificationRecordRow } from '../../core/types.ts'
import { KnowledgeStatus } from '../../core/types.ts'
import type { RetrievalConfig } from '../../core/config.ts'
import type { Database, Row } from '../../infrastructure/database/database.ts'
import { SCHEMA_VERSION } from '../../infrastructure/database/schema.ts'
import { bm25Search, type Bm25Hit } from '../../infrastructure/retrieval/bm25.ts'
import { termFrequencies, tokenize } from '../../infrastructure/retrieval/tokenizer.ts'
import type { VectorIndex } from '../../infrastructure/embeddings/vector-index.ts'

export interface ChunkFilter {
  projectId?: string
  projectIds?: string[]
  /** 显式跨项目（默认 false，避免无作用域检索泄漏）。 */
  includeAllProjects?: boolean
  statuses?: string[]
  partitions?: string[]
  domains?: string[]
  topics?: string[]
  subtopics?: string[]
  knowledgeTypes?: string[]
  levels?: string[]
  verificationStatuses?: string[]
  sourceTypes?: string[]
  visibility?: string[]
  includeInvalidated?: boolean
  limit?: number
  offset?: number
}

export interface SearchResultItem {
  chunk_id: string
  title: string
  summary: string
  content: string
  score: number
  similarity: number
  partition: string
  domain: string
  topic: string
  subtopic: string
  knowledge_type: string
  status: string
  level: string
  verification_status: string
  reliability: Record<string, unknown>
  source: Record<string, string>
  version: number
  updated_at: string
  freshness_status: string
  conflict_status: string
  need_reverify: boolean
  warnings: string[]
}

export interface SearchOutcome {
  query: string
  mode: string
  results: SearchResultItem[]
  warnings: string[]
  gap: boolean
  elapsed_ms: number
  filters: Record<string, unknown>
}

export interface DuplicatePair {
  chunk_a: string
  chunk_b: string
  similarity: number
  reason: string
}

const PROTECTED_UPDATE_FIELDS = new Set([
  'chunk_id', 'project_id', 'content_hash', 'status', 'level', 'verification_status',
  'verification_method', 'verification_evidence', 'confidence', 'evidence_count',
  'evidence_independence', 'quality_score', 'quality_components', 'invalidated_at',
  'superseded_by', 'created_at', 'updated_at', 'version',
])

const UPDATABLE_FIELDS = new Set([
  'title', 'summary', 'content', 'metadata', 'tags', 'topic', 'subtopic', 'domain',
  'partition', 'knowledge_type', 'limitations', 'license_status', 'freshness_status',
  'source_url', 'source_title', 'source_type', 'author_or_publisher', 'published_at',
  'source_quality', 'core_principle', 'reasoning', 'application', 'implementation',
  'anti_patterns', 'source_excerpt', 'language', 'visibility', 'document_id',
])

export class KnowledgeStore {
  private readonly db: Database
  private readonly index: VectorIndex
  private readonly retrieval: RetrievalConfig

  constructor(db: Database, index: VectorIndex, retrieval: RetrievalConfig) {
    this.db = db
    this.index = index
    this.retrieval = retrieval
    this.index.load()
  }

  get database(): Database { return this.db }
  get vectorIndex(): VectorIndex { return this.index }

  // ------------------------------------------------------------------ //
  // 写入
  // ------------------------------------------------------------------ //
  addChunks(chunks: readonly Partial<ChunkRow>[]): { added: number; updated: number; warnings: string[] } {
    if (chunks.length === 0) return { added: 0, updated: 0, warnings: [] }
    const warnings: string[] = []
    const rows = chunks.map((raw) => {
      const chunkId = String(raw.chunk_id ?? '')
      if (!chunkId) throw new StorageError('chunk 缺少 chunk_id')
      return this.normalizeChunk(raw)
    })
    // 批量写：一次事务 + 一次存在性查询，避免 N 次 BEGIN/COMMIT（100 条从 ~480ms 降到几十毫秒）。
    const ids = rows.map((row) => row.chunk_id)
    const existing = new Set<string>()
    for (let i = 0; i < ids.length; i += 400) {
      const batch = ids.slice(i, i + 400)
      const placeholders = batch.map(() => '?').join(',')
      for (const row of this.db.query(`SELECT chunk_id FROM chunks WHERE chunk_id IN (${placeholders})`, batch)) {
        existing.add(String(row.chunk_id))
      }
    }
    this.db.transaction(() => {
      for (const row of rows) {
        this.upsertChunkRow(row)
        const merged = this.db.get('chunks', row.chunk_id) as unknown as ChunkRow
        this.reindexChunk(merged)
      }
    })
    const saved = this.getChunks(ids)
    try {
      this.index.upsertChunks(this.db, saved)
    } catch (error) {
      warnings.push(`向量索引更新失败（行已写入，需要 rebuild_vector_index）: ${error instanceof Error ? error.message : String(error)}`)
    }
    let added = 0
    let updated = 0
    for (const id of ids) {
      if (existing.has(id)) updated += 1
      else added += 1
    }
    return { added, updated, warnings }
  }

  private normalizeChunk(raw: Partial<ChunkRow>): ChunkRow {
    const content = String(raw.content ?? '')
    const hash = raw.content_hash || contentFingerprint(content)
    return {
      chunk_id: String(raw.chunk_id ?? ''),
      project_id: String(raw.project_id ?? ''),
      document_id: raw.document_id ?? '',
      partition: raw.partition ?? 'pending_knowledge',
      domain: raw.domain ?? 'general',
      topic: raw.topic ?? '',
      subtopic: raw.subtopic ?? '',
      title: raw.title ?? '',
      content,
      summary: raw.summary ?? '',
      knowledge_type: raw.knowledge_type ?? 'fact',
      status: raw.status ?? KnowledgeStatus.PENDING_VERIFICATION,
      level: raw.level ?? 'L2',
      source_id: raw.source_id ?? '',
      source_url: raw.source_url ?? '',
      source_title: raw.source_title ?? '',
      source_type: raw.source_type ?? 'unknown',
      author_or_publisher: raw.author_or_publisher ?? '',
      published_at: raw.published_at ?? '',
      accessed_at: raw.accessed_at ?? '',
      language: raw.language ?? 'unknown',
      content_hash: hash,
      version: Number(raw.version ?? 1),
      source_quality: Number(raw.source_quality ?? 0.5),
      evidence_count: Number(raw.evidence_count ?? 0),
      evidence_independence: Number(raw.evidence_independence ?? 0),
      confidence: Number(raw.confidence ?? 0.3),
      confidence_basis: raw.confidence_basis ?? '',
      verification_status: raw.verification_status ?? 'unverified',
      verification_method: raw.verification_method ?? 'none',
      verification_evidence: raw.verification_evidence ?? [],
      freshness_status: raw.freshness_status ?? 'unknown',
      conflict_status: raw.conflict_status ?? 'none',
      limitations: raw.limitations ?? '',
      tags: raw.tags ?? [],
      source_version: raw.source_version ?? '',
      source_excerpt: raw.source_excerpt ?? '',
      core_principle: raw.core_principle ?? '',
      reasoning: raw.reasoning ?? '',
      application: raw.application ?? '',
      implementation: raw.implementation ?? '',
      anti_patterns: raw.anti_patterns ?? '',
      quality_score: Number(raw.quality_score ?? 0),
      quality_components: raw.quality_components ?? {},
      license_status: raw.license_status ?? 'unknown',
      visibility: raw.visibility ?? 'project',
      metadata: raw.metadata ?? {},
      invalidated_at: raw.invalidated_at ?? '',
      superseded_by: raw.superseded_by ?? '',
      created_at: raw.created_at ?? utcnowIso(),
      updated_at: raw.updated_at ?? utcnowIso(),
    }
  }

  private upsertChunkRow(row: ChunkRow): void {
    const encoded = this.db.encode('chunks', row as unknown as Row)
    const keys = Object.keys(encoded)
    if (!keys.includes('chunk_id')) throw new StorageError('chunks upsert 缺少 chunk_id')
    const updates = keys.filter((key) => key !== 'chunk_id').map((key) => `${key}=excluded.${key}`)
    const sql = `INSERT INTO chunks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(chunk_id) DO UPDATE SET ${updates.join(',')}`
    this.db.connection.prepare(sql).run(...keys.map((key) => encoded[key] as never))
  }

  /** 倒排重建：文本固定为 title\nsummary\ncontent（顺序敏感）。 */
  private reindexChunk(chunk: ChunkRow): void {
    const conn = this.db.connection
    const text = `${chunk.title ?? ''}\n${chunk.summary ?? ''}\n${chunk.content ?? ''}`
    const freqs = termFrequencies(text)
    const length = tokenize(text).length
    conn.prepare('DELETE FROM tokens WHERE chunk_id=?').run(chunk.chunk_id)
    const insert = conn.prepare('INSERT OR REPLACE INTO tokens(chunk_id, token, tf) VALUES (?,?,?)')
    for (const [token, tf] of freqs) insert.run(chunk.chunk_id, token, tf)
    conn.prepare('INSERT OR REPLACE INTO chunk_lex(chunk_id, length) VALUES (?,?)').run(chunk.chunk_id, length)
  }

  updateChunk(chunkId: string, fields: Partial<ChunkRow>, reason = 'update'): ChunkRow {
    const existing = this.getChunk(chunkId)
    if (!existing) throw new NotFoundError(`知识片段不存在: ${chunkId}`)
    const clean: Record<string, unknown> = {}
    let contentChanged = false
    for (const [key, value] of Object.entries(fields)) {
      if (PROTECTED_UPDATE_FIELDS.has(key)) continue
      if (!UPDATABLE_FIELDS.has(key)) continue
      clean[key] = value
    }
    if (typeof clean.content === 'string' && normalizeText(clean.content) !== normalizeText(existing.content)) {
      contentChanged = true
      clean.content_hash = contentFingerprint(clean.content)
      clean.version = Number(existing.version) + 1
      clean.status = KnowledgeStatus.PENDING_VERIFICATION
      clean.verification_status = 'unverified'
      clean.verification_method = 'none'
      clean.verification_evidence = []
      clean.evidence_count = 0
      clean.evidence_independence = 0
      clean.confidence = 0.3
      clean.confidence_basis = '内容已变更，核验状态重置'
      clean.quality_score = 0
      clean.quality_components = {}
    }
    if (Object.keys(clean).length === 0) return existing
    this.db.transaction(() => {
      if (contentChanged) {
        this.db.insert('chunk_versions', {
          id: newId('ver'),
          chunk_id: chunkId,
          version: Number(existing.version),
          content_hash: existing.content_hash,
          content: existing.content,
          status: existing.status,
          change_reason: reason,
          changed_at: utcnowIso(),
        })
      }
      this.db.update('chunks', chunkId, { ...clean, updated_at: utcnowIso() })
      const merged = this.db.get('chunks', chunkId) as unknown as ChunkRow
      this.reindexChunk(merged)
    })
    // 向量索引文本包含 title/summary（标题重复 2 次），它们变化时也必须刷新向量，
    // 否则 vector 通道会继续命中旧标题（vNext 审计 D-02）。
    if (contentChanged || 'metadata' in clean || 'tags' in clean || 'title' in clean || 'summary' in clean) {
      const updated = this.getChunk(chunkId) as ChunkRow
      try {
        this.index.upsertChunks(this.db, [updated])
      } catch {
        /* 由 checkIntegrity 暴露，不阻断知识写入 */
      }
    }
    return this.getChunk(chunkId) as ChunkRow
  }

  /**
   * 核验专用状态写入：受保护字段只允许核验器经此入口更新。
   * 常规 updateChunk 会丢弃这些字段，防止调用方直接伪造 verified。
   */
  forceVerificationState(chunkId: string, fields: Partial<ChunkRow>): void {
    const allowed = new Set([
      'status', 'level', 'verification_status', 'verification_method',
      'verification_evidence', 'evidence_count', 'evidence_independence',
      'confidence', 'confidence_basis', 'quality_score', 'quality_components',
      'updated_at',
    ])
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) if (allowed.has(key)) clean[key] = value
    if (Object.keys(clean).length === 0) return
    if (!clean.updated_at) clean.updated_at = utcnowIso()
    this.db.update('chunks', chunkId, clean)
  }

  invalidateChunk(chunkId: string, reason: string, supersededBy = ''): ChunkRow {
    const existing = this.getChunk(chunkId)
    if (!existing) throw new NotFoundError(`知识片段不存在: ${chunkId}`)
    const limitations = [existing.limitations, reason].filter(Boolean).join('；').slice(0, 1000)
    const metadata = { ...parseJsonObject(existing.metadata), invalidated_reason: reason }
    this.db.update('chunks', chunkId, {
      status: KnowledgeStatus.SUPERSEDED,
      freshness_status: 'stale',
      invalidated_at: utcnowIso(),
      superseded_by: supersededBy,
      limitations,
      metadata,
      updated_at: utcnowIso(),
    })
    try {
      this.index.remove([chunkId])
    } catch {
      /* 索引清理失败由 integrity 暴露 */
    }
    return this.getChunk(chunkId) as ChunkRow
  }

  deleteChunk(chunkId: string): boolean {
    const existing = this.getChunk(chunkId)
    if (!existing) return false
    this.db.transaction(() => {
      this.db.connection.prepare('DELETE FROM tokens WHERE chunk_id=?').run(chunkId)
      this.db.connection.prepare('DELETE FROM chunk_lex WHERE chunk_id=?').run(chunkId)
      this.db.connection.prepare('DELETE FROM chunks WHERE chunk_id=?').run(chunkId)
    })
    try {
      this.index.remove([chunkId])
    } catch {
      /* 同上 */
    }
    return true
  }

  // ------------------------------------------------------------------ //
  // 读取
  // ------------------------------------------------------------------ //
  getChunk(chunkId: string): ChunkRow | null {
    return this.db.get('chunks', chunkId) as unknown as ChunkRow | null
  }

  getChunks(chunkIds: readonly string[]): ChunkRow[] {
    if (chunkIds.length === 0) return []
    const out: ChunkRow[] = []
    for (let i = 0; i < chunkIds.length; i += 400) {
      const batch = chunkIds.slice(i, i + 400)
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db.query(`SELECT * FROM chunks WHERE chunk_id IN (${placeholders})`, batch)
      for (const row of rows) {
        const decoded = this.db.decode('chunks', row) as unknown as ChunkRow
        if (decoded) out.push(decoded)
      }
    }
    return out
  }

  private buildFilter(filter: ChunkFilter): { where: string; params: unknown[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    const add = (sql: string, value: unknown): void => {
      clauses.push(sql)
      params.push(value)
    }
    const addList = (column: string, values: readonly string[] | undefined): void => {
      if (!values || values.length === 0) return
      clauses.push(`${column} IN (${values.map(() => '?').join(',')})`)
      params.push(...values)
    }
    if (filter.projectId) add("(project_id = ? OR visibility = 'global')", filter.projectId)
    else if (filter.projectIds && filter.projectIds.length > 0) {
      clauses.push(`(project_id IN (${filter.projectIds.map(() => '?').join(',')}) OR visibility = 'global')`)
      params.push(...filter.projectIds)
    } else if (!filter.includeAllProjects) {
      // 无作用域查询只允许读全局可见知识，杜绝跨项目泄漏。
      clauses.push("visibility = 'global'")
    }
    addList('status', filter.statuses)
    addList('partition', filter.partitions)
    addList('domain', filter.domains)
    addList('topic', filter.topics)
    addList('subtopic', filter.subtopics)
    addList('knowledge_type', filter.knowledgeTypes)
    addList('level', filter.levels)
    addList('verification_status', filter.verificationStatuses)
    addList('source_type', filter.sourceTypes)
    addList('visibility', filter.visibility)
    if (!filter.includeInvalidated) clauses.push("invalidated_at = ''")
    return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params }
  }

  listChunks(filter: ChunkFilter = {}): ChunkRow[] {
    const { where, params } = this.buildFilter(filter)
    const limit = Math.max(1, Math.min(Number(filter.limit ?? 100), 5000))
    const offset = Math.max(0, Number(filter.offset ?? 0))
    const rows = this.db.query(
      `SELECT * FROM chunks${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    return rows.map((row) => this.db.decode('chunks', row) as unknown as ChunkRow).filter(Boolean)
  }

  listChunkIds(filter: ChunkFilter = {}): string[] {
    const { where, params } = this.buildFilter(filter)
    const rows = this.db.query(`SELECT chunk_id FROM chunks${where}`, params)
    return rows.map((row) => String(row.chunk_id))
  }

  countChunks(filter: ChunkFilter = {}): number {
    const { where, params } = this.buildFilter(filter)
    return Number(this.db.scalar<number>(`SELECT COUNT(*) AS n FROM chunks${where}`, params, 0) ?? 0)
  }

  partitionStats(projectId?: string): Array<Record<string, unknown>> {
    const where = projectId ? ' WHERE project_id=?' : ''
    const params = projectId ? [projectId] : []
    const rows = this.db.query(
      `SELECT partition,
              COUNT(*) AS total,
              SUM(CASE WHEN verification_status='verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status='pending_verification' THEN 1 ELSE 0 END) AS pending_verification,
              SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) AS stale,
              SUM(CASE WHEN conflict_status='confirmed' THEN 1 ELSE 0 END) AS conflicts,
              MAX(updated_at) AS last_updated
       FROM chunks${where} GROUP BY partition ORDER BY partition`,
      params,
    )
    const duplicates = Number(this.db.scalar<number>("SELECT COUNT(*) AS n FROM duplicates WHERE status='open'", [], 0) ?? 0)
    return rows.map((row) => ({ ...row, duplicates }))
  }

  // ------------------------------------------------------------------ //
  // 检索
  // ------------------------------------------------------------------ //
  search(query: string, filter: ChunkFilter = {}, options: { topK?: number; mode?: string; includeContent?: boolean } = {}): SearchOutcome {
    const started = Date.now()
    const topK = Math.max(1, Number(options.topK ?? this.retrieval.top_k))
    const mode = (options.mode ?? (this.retrieval.hybrid ? 'hybrid' : 'vector')).toLowerCase()
    const warnings: string[] = []
    if (this.index.error) warnings.push(this.index.error)

    const allowed = this.listChunkIds(filter)
    if (allowed.length === 0) {
      return {
        query, mode, results: [],
        warnings: [...warnings, '知识库中没有满足过滤条件的知识，这本身意味着一个知识缺口'],
        gap: true, elapsed_ms: Date.now() - started, filters: filter as Record<string, unknown>,
      }
    }

    let vectorRank: Array<{ chunkId: string; score: number }> = []
    let keywordRank: Bm25Hit[] = []
    if (mode === 'vector' || mode === 'hybrid') {
      if (!this.index.error) vectorRank = this.index.search(query, allowed, Math.max(topK * 4, 40))
    }
    if (mode === 'keyword' || mode === 'hybrid') {
      keywordRank = bm25Search(this.db, query, allowed, Math.max(topK * 4, 40))
    }

    const fused = this.fuse(vectorRank, keywordRank, mode)
    if (fused.length === 0) {
      return {
        query, mode, results: [],
        warnings: [...warnings, '没有检索到相关知识（既无向量命中也无关键词命中）'],
        gap: true, elapsed_ms: Date.now() - started, filters: filter as Record<string, unknown>,
      }
    }
    const rows = new Map(this.getChunks(fused.map((item) => item.chunkId)).map((chunk) => [chunk.chunk_id, chunk]))
    const results: SearchResultItem[] = []
    for (const item of fused.slice(0, topK)) {
      const chunk = rows.get(item.chunkId)
      if (!chunk) continue
      results.push(this.formatResult(chunk, item.score, options.includeContent ?? true))
    }
    // 之前的实现只把时效/置信度写进 score 字段，却仍按融合顺序返回，
    // 等于“算了排序分但没用它”（vNext 审计 D-04）。这里按最终分重排。
    results.sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    return {
      query, mode, results, warnings, gap: results.length === 0,
      elapsed_ms: Date.now() - started, filters: filter as Record<string, unknown>,
    }
  }

  private fuse(
    vectorRank: ReadonlyArray<{ chunkId: string; score: number }>,
    keywordRank: ReadonlyArray<Bm25Hit>,
    mode: string,
  ): Array<{ chunkId: string; score: number }> {
    if (mode === 'vector') return vectorRank.map((hit) => ({ chunkId: hit.chunkId, score: hit.score }))
    if (mode === 'keyword') return keywordRank.map((hit) => ({ chunkId: hit.chunkId, score: hit.score }))
    const k = Math.max(1, Number(this.retrieval.rrf_k))
    const scores = new Map<string, number>()
    vectorRank.forEach((hit, rank) => {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + this.retrieval.vector_weight / (k + rank + 1))
    })
    keywordRank.forEach((hit, rank) => {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + this.retrieval.keyword_weight / (k + rank + 1))
    })
    if (scores.size === 0) return []
    const peak = Math.max(...scores.values()) || 1
    return [...scores.entries()]
      .map(([chunkId, value]) => ({ chunkId, score: value / peak }))
      .sort((a, b) => b.score - a.score)
  }

  private formatResult(chunk: ChunkRow, score: number, includeContent: boolean): SearchResultItem {
    const warnings: string[] = []
    if (chunk.verification_status !== 'verified') {
      warnings.push(`核验状态为 ${chunk.verification_status}，不能当作既定事实`)
    }
    if (chunk.status === KnowledgeStatus.STALE || ['stale', 'expired'].includes(chunk.freshness_status)) {
      warnings.push('该知识可能已过时，使用前请核验更新版本')
    }
    if (chunk.conflict_status === 'confirmed') warnings.push('该知识存在已确认的来源冲突，请同时查看冲突记录')
    else if (chunk.conflict_status === 'potential') warnings.push('该知识存在潜在冲突，尚未裁定')
    if (['unknown', 'restricted'].includes(chunk.license_status)) {
      warnings.push(`许可状态: ${chunk.license_status}，转载或商用前需确认`)
    }
    // 时效只做**排序微调**，不隐藏结果：过期/过时知识仍然返回并带 warning，
    // 但在分数接近时让当前版本优先（vNext 审计 D-03：stale 曾排在 current 之前）。
    const freshnessFactor: Record<string, number> = {
      fresh: 1, aging: 0.97, unknown: 0.95, stale: 0.7, expired: 0.4,
    }
    const adjusted = score
      * (0.85 + 0.15 * Number(chunk.confidence ?? 0))
      * (freshnessFactor[chunk.freshness_status] ?? 0.95)
    return {
      chunk_id: chunk.chunk_id,
      title: chunk.title,
      summary: chunk.summary,
      content: includeContent ? chunk.content : '',
      score: Math.round(adjusted * 1e6) / 1e6,
      similarity: Math.round(score * 1e6) / 1e6,
      partition: chunk.partition,
      domain: chunk.domain,
      topic: chunk.topic,
      subtopic: chunk.subtopic,
      knowledge_type: chunk.knowledge_type,
      status: chunk.status,
      level: chunk.level,
      verification_status: chunk.verification_status,
      reliability: {
        source_quality: chunk.source_quality,
        evidence_count: chunk.evidence_count,
        evidence_independence: chunk.evidence_independence,
        confidence: chunk.confidence,
        confidence_basis: chunk.confidence_basis,
        verification_method: chunk.verification_method,
      },
      source: {
        source_id: chunk.source_id,
        url: chunk.source_url,
        title: chunk.source_title,
        type: chunk.source_type,
        publisher: chunk.author_or_publisher,
        published_at: chunk.published_at,
        accessed_at: chunk.accessed_at,
      },
      version: Number(chunk.version),
      updated_at: chunk.updated_at,
      freshness_status: chunk.freshness_status,
      conflict_status: chunk.conflict_status,
      need_reverify:
        chunk.verification_status !== 'verified' ||
        ['stale', 'expired'].includes(chunk.freshness_status) ||
        chunk.conflict_status === 'confirmed',
      warnings,
    }
  }

  // ------------------------------------------------------------------ //
  // 重复检测
  // ------------------------------------------------------------------ //
  findDuplicates(options: { chunkId?: string; filter?: ChunkFilter; threshold?: number; maxPairs?: number } = {}): DuplicatePair[] {
    const threshold = Number(options.threshold ?? this.retrieval.dedupe_similarity)
    const maxPairs = Math.max(1, Math.min(Number(options.maxPairs ?? 200), 1000))
    let filter = options.filter ?? {}
    if (options.chunkId) {
      const chunk = this.getChunk(options.chunkId)
      if (!chunk) return []
      if (!filter.projectId) filter = { ...filter, projectId: chunk.project_id }
    }
    const ids = this.listChunkIds({ ...filter, includeInvalidated: false })
    if (options.chunkId && !ids.includes(options.chunkId)) ids.push(options.chunkId)
    if (ids.length < 2) return []
    const allowed = new Set(ids)
    const pairs: DuplicatePair[] = []
    const seen = new Set<string>()

    // 精确重复：一次 SQL 查询取指纹，按 project+hash 分组（不再把所有整行读进内存）
    const { where, params } = this.buildFilter({ ...filter, includeInvalidated: false })
    const hashClause = where ? `${where} AND content_hash <> ''` : " WHERE content_hash <> ''"
    const hashRows = this.db.query(
      `SELECT chunk_id, project_id, content_hash FROM chunks${hashClause}`,
      params,
    ) as Array<{ chunk_id: string; project_id: string; content_hash: string }>
    const byHash = new Map<string, string[]>()
    for (const row of hashRows) {
      if (!allowed.has(row.chunk_id)) continue
      const key = `${row.project_id}|${row.content_hash}`
      const list = byHash.get(key) ?? []
      list.push(row.chunk_id)
      byHash.set(key, list)
    }
    for (const members of byHash.values()) {
      if (members.length < 2) continue
      const sorted = [...members].sort()
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const a = sorted[i] as string
          const b = sorted[j] as string
          if (options.chunkId && a !== options.chunkId && b !== options.chunkId) continue
          const key = [a, b].sort().join('|')
          if (seen.has(key)) continue
          seen.add(key)
          pairs.push({ chunk_a: a, chunk_b: b, similarity: 1, reason: 'content_hash' })
          if (pairs.length >= maxPairs) return pairs
        }
      }
    }

    // 近似重复：复用索引矩阵批量点积；chunkId 模式只返回与该片段相关的对
    const near = this.index.similarPairs(
      ids,
      threshold,
      maxPairs,
      options.chunkId ? [options.chunkId] : undefined,
    )
    for (const pair of near) {
      if (options.chunkId && pair.a !== options.chunkId && pair.b !== options.chunkId) continue
      const key = [pair.a, pair.b].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({
        chunk_a: pair.a,
        chunk_b: pair.b,
        similarity: Math.round(pair.score * 10000) / 10000,
        reason: 'vector_similarity',
      })
      if (pairs.length >= maxPairs) return pairs
    }
    return pairs
  }

  // ------------------------------------------------------------------ //
  // 核验记录与版本
  // ------------------------------------------------------------------ //
  addVerification(record: Partial<VerificationRecordRow>): VerificationRecordRow {
    const row: VerificationRecordRow = {
      record_id: record.record_id ?? newId('vrf'),
      chunk_id: String(record.chunk_id ?? ''),
      method: String(record.method ?? 'source_check'),
      result: String(record.result ?? 'inconclusive'),
      evidence: record.evidence ?? [],
      notes: String(record.notes ?? ''),
      verifier: String(record.verifier ?? 'system'),
      created_at: record.created_at ?? utcnowIso(),
    }
    this.db.insert('verification_records', row as unknown as Row)
    return row
  }

  listVerifications(chunkId: string): VerificationRecordRow[] {
    const rows = this.db.query(
      'SELECT * FROM verification_records WHERE chunk_id=? ORDER BY created_at ASC',
      [chunkId],
    )
    // 必须做 JSON 反序列化：证据是核验判定的输入，字符串会被当成"没有证据"。
    return rows.map((row) => ({
      ...(row as unknown as VerificationRecordRow),
      evidence: parseJsonArray(row.evidence),
    }))
  }

  listVersions(chunkId: string): Array<Record<string, unknown>> {
    return this.db.query('SELECT * FROM chunk_versions WHERE chunk_id=? ORDER BY version DESC', [chunkId])
  }

  /** 版本回滚：当前内容先入历史，再写回目标版本内容（并重置核验）。 */
  rollbackVersion(chunkId: string, version: number): ChunkRow {
    const existing = this.getChunk(chunkId)
    if (!existing) throw new NotFoundError(`知识片段不存在: ${chunkId}`)
    const target = this.db.query(
      'SELECT * FROM chunk_versions WHERE chunk_id=? AND version=?',
      [chunkId, version],
    )[0]
    if (!target) throw new NotFoundError(`版本不存在: ${chunkId} v${version}`)
    return this.updateChunk(chunkId, { content: String(target.content ?? '') }, `rollback to v${version}`)
  }

  // ------------------------------------------------------------------ //
  // 运维
  // ------------------------------------------------------------------ //
  stats(): Record<string, unknown> {
    return {
      chunks: this.countChunks(),
      partitions: this.partitionStats(),
      vectors: this.index.stats(),
      schema_version: SCHEMA_VERSION,
      database: this.db.path,
    }
  }

  checkIntegrity(): Record<string, unknown> {
    const dbCheck = this.db.integrityCheck()
    const indexCheck = this.index.checkIntegrity(this.db)
    const fk = this.db.foreignKeyCheck()
    const orphanTokens = Number(
      this.db.scalar<number>(
        'SELECT COUNT(*) AS n FROM tokens t LEFT JOIN chunks c ON c.chunk_id=t.chunk_id WHERE c.chunk_id IS NULL',
        [], 0,
      ) ?? 0,
    )
    return { database: dbCheck, foreign_keys: fk, index: indexCheck, orphan_tokens: orphanTokens }
  }

  backup(destDir: string, note = ''): Record<string, unknown> {
    mkdirSync(destDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    const dbFile = join(destDir, `metadata-${stamp}.sqlite3`)
    const { bytes } = this.db.backupTo(dbFile)
    const indexDir = this.index.copyTo(join(destDir, `index-${stamp}`))
    const sha = createFileHash(dbFile)
    const manifest = {
      created_at: utcnowIso(),
      db: dbFile,
      index: indexDir,
      chunks: this.countChunks(),
      chunks_sha256: sha,
      bytes,
      note,
      embedder: this.index.embedderId,
      schema_version: SCHEMA_VERSION,
    }
    const manifestPath = join(destDir, `backup-${stamp}.json`)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { ...manifest, manifest_path: manifestPath }
  }

  verifyBackup(manifestPath: string): { ok: boolean; issues: string[]; warnings: string[]; manifest?: Record<string, unknown> } {
    if (!existsSync(manifestPath)) return { ok: false, issues: ['备份清单不存在'], warnings: [] }
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      return { ok: false, issues: ['备份清单不是合法 JSON'], warnings: [] }
    }
    const issues: string[] = []
    const warnings: string[] = []
    const dbFile = String(manifest.db ?? '')
    if (!dbFile || !existsSync(dbFile)) issues.push('备份数据库文件缺失')
    else if (String(manifest.chunks_sha256 ?? '') !== createFileHash(dbFile)) issues.push('备份数据库校验和不匹配')
    if (Number(manifest.schema_version ?? 0) > SCHEMA_VERSION) issues.push('备份 schema 版本高于当前代码')
    if (String(manifest.embedder ?? '') !== this.index.embedderId) warnings.push('备份向量器与当前不同，恢复后需要 rebuild_vector_index')
    return { ok: issues.length === 0, issues, warnings, manifest }
  }

  restore(dbFile: string, indexDir?: string, manifestPath?: string): Record<string, unknown> {
    if (manifestPath) {
      const verification = this.verifyBackup(manifestPath)
      if (!verification.ok) throw new AutolearnError(`备份校验失败，拒绝恢复: ${verification.issues.join('; ')}`, { code: ERROR_CODES.STORAGE_ERROR })
    }
    const safetyCopy = `${this.db.path}.pre-restore.sqlite3`
    this.db.backupTo(safetyCopy)
    const restored = this.db.restoreFrom(dbFile)
    if (indexDir) this.index.restoreFromDir(indexDir)
    return {
      restored_from: dbFile,
      safety_copy: safetyCopy,
      migrated: restored.migrated,
      integrity: this.checkIntegrity(),
    }
  }

  export(path: string, format: 'jsonl' | 'json' | 'csv' = 'jsonl', filter: ChunkFilter = {}): Record<string, unknown> {
    const chunks = this.listChunks({ ...filter, limit: filter.limit ?? 5000 })
    mkdirSync(join(path, '..'), { recursive: true })
    let content: string
    if (format === 'json') content = JSON.stringify(chunks, null, 2)
    else if (format === 'csv') {
      const header = 'chunk_id,title,knowledge_type,status,verification_status,confidence,source_url'
      const lines = chunks.map((chunk) =>
        [chunk.chunk_id, chunk.title, chunk.knowledge_type, chunk.status, chunk.verification_status, chunk.confidence, chunk.source_url]
          .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
          .join(','),
      )
      content = [header, ...lines].join('\n')
    } else content = chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
    writeFileSync(path, `${content}\n`, 'utf8')
    return { path, count: chunks.length, format }
  }

  /** 迁移/调试：从旧库复制一个片段（保留 id 与核验状态）。 */
  importChunk(raw: Partial<ChunkRow>): ChunkRow {
    return this.addChunks([raw]) ? (this.getChunk(String(raw.chunk_id)) as ChunkRow) : ({} as ChunkRow)
  }
}

/** 备份清单校验和：与旧版 chunks_sha256 口径一致（文件字节 sha256）。 */
function createFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export type { ChunkFilterInput }
