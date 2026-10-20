/**
 * 知识缺口分析：按主题计算 L0-L5 覆盖，识别无知识/未达标/单一来源/
 * 过时/冲突/未规划/重复，并可选登记为 gap（同主题同子主题只保留一个 open）。
 */
import { newId, round, utcnowIso } from '../../core/ids.ts'
import type { ChunkRow, GapRow } from '../../core/types.ts'
import type { Database } from '../../infrastructure/database/database.ts'
import type { KnowledgeStore } from '../knowledge/store.ts'
import type { LearningRepository } from './repository.ts'
import type { LearningLevel } from '../../core/types.ts'
import { atLeast, maxLevel } from './state-machine.ts'

export interface TopicCoverage {
  topic: string
  total: number
  level: string
  verified: number
  pending: number
  stale: number
  disputed: number
  practiced: number
  sources: number
}

export interface GapItem {
  kind: string
  topic: string
  priority: number
  level?: string
  reason: string
}

export interface GapAnalysis {
  project_id: string
  target_level: string
  coverage: TopicCoverage[]
  coverage_rate: number
  gaps: GapItem[]
  recorded_gaps: number
  unverified_chunks: number
  stale_chunks: number
  duplicates: number
  timestamp: string
}

export class GapAnalyzer {
  private readonly db: Database
  private readonly store: KnowledgeStore
  private readonly repo: LearningRepository

  constructor(db: Database, store: KnowledgeStore, repo: LearningRepository) {
    this.db = db
    this.store = store
    this.repo = repo
  }

  topics(projectId: string): string[] {
    const rows = this.db.query('SELECT inputs FROM tasks WHERE project_id=? ORDER BY created_at', [projectId])
    const out: string[] = []
    for (const row of rows) {
      let inputs: Record<string, unknown> = {}
      try {
        inputs = JSON.parse(String(row.inputs ?? '{}')) as Record<string, unknown>
      } catch {
        continue
      }
      const topic = typeof inputs.topic === 'string' ? inputs.topic : ''
      if (topic && !out.includes(topic)) out.push(topic)
    }
    return out
  }

  analyze(projectId: string, options: { targetLevel?: string; record?: boolean } = {}): GapAnalysis {
    const targetLevel = options.targetLevel ?? 'L3'
    const topics = this.topics(projectId)
    const coverage: TopicCoverage[] = topics.map((topic) => this.coverageFor(projectId, topic))
    const gaps: GapItem[] = []

    for (const item of coverage) {
      if (item.total === 0) {
        gaps.push({ kind: 'no_knowledge', topic: item.topic, priority: 0.95, level: 'L0', reason: '没有任何知识片段' })
      } else if (!atLeast(item.level, targetLevel)) {
        gaps.push({
          kind: 'below_target', topic: item.topic,
          priority: item.pending > 0 ? 0.8 : 0.7, level: item.level,
          reason: `覆盖等级 ${item.level} 低于目标 ${targetLevel}（未核验/未实践）`,
        })
      }
      if (item.total > 0 && item.sources <= 1 && item.verified === 0) {
        gaps.push({ kind: 'single_source', topic: item.topic, priority: 0.75, level: item.level, reason: '只有单一来源且未核验，需要独立来源交叉验证' })
      }
      if (item.stale > 0) {
        gaps.push({ kind: 'stale', topic: item.topic, priority: 0.6, level: item.level, reason: `${item.stale} 条知识可能过时，需要检查更新版本` })
      }
      if (item.disputed > 0) {
        gaps.push({ kind: 'conflict', topic: item.topic, priority: 0.7, level: item.level, reason: `${item.disputed} 条知识存在冲突或争议，需要冲突分析` })
      }
    }

    // 未规划主题：库里存在但没有计划
    const planned = new Set(topics)
    const unplanned = this.db.query(
      `SELECT DISTINCT topic FROM chunks WHERE project_id=? AND topic <> '' AND invalidated_at=''`,
      [projectId],
    ) as Array<{ topic: string }>
    for (const row of unplanned) {
      if (planned.has(row.topic)) continue
      gaps.push({ kind: 'unplanned', topic: row.topic, priority: 0.5, reason: '知识存在但未纳入学习计划' })
    }

    const duplicatePairs = this.store.findDuplicates({ filter: { projectId }, maxPairs: 200 })
    if (duplicatePairs.length > 0) {
      gaps.push({ kind: 'duplicates', topic: '__duplicates__', priority: 0.35, reason: `${duplicatePairs.length} 组重复知识待合并` })
    }

    let recorded = 0
    if (options.record !== false) {
      for (const gap of gaps) {
        if (gap.topic === '__duplicates__') continue
        if (this.recordGap(projectId, gap)) recorded += 1
      }
    }

    const covered = coverage.filter((item) => atLeast(item.level, targetLevel)).length
    const coverageRate = coverage.length > 0 ? round(covered / coverage.length, 3) : 0
    return {
      project_id: projectId,
      target_level: targetLevel,
      coverage,
      coverage_rate: coverageRate,
      gaps,
      recorded_gaps: recorded,
      unverified_chunks: Number(
        this.db.scalar<number>("SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND verification_status<>'verified'", [projectId], 0) ?? 0,
      ),
      stale_chunks: Number(
        this.db.scalar<number>(
          "SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND (status='stale' OR freshness_status IN ('stale','expired'))",
          [projectId], 0,
        ) ?? 0,
      ),
      duplicates: duplicatePairs.length,
      timestamp: utcnowIso(),
    }
  }

  private coverageFor(projectId: string, topic: string): TopicCoverage {
    const chunks = this.store.listChunks({ projectId, topics: [topic], limit: 5000, includeInvalidated: false })
    const levels = chunks.map((chunk: ChunkRow) => chunk.level || 'L2')
    const verified = chunks.filter((chunk) => chunk.status === 'verified' || chunk.verification_status === 'verified').length
    const pending = chunks.filter((chunk) => chunk.status === 'pending_verification').length
    const stale = chunks.filter((chunk) => chunk.status === 'stale' || ['stale', 'expired'].includes(chunk.freshness_status)).length
    const disputed = chunks.filter(
      (chunk) => chunk.status === 'disputed' || ['potential', 'confirmed'].includes(chunk.conflict_status),
    ).length
    const practiced = chunks.filter((chunk) => ['practiced', 'evaluated'].includes(chunk.status)).length
    const sources = new Set(chunks.map((chunk) => chunk.source_id || chunk.source_url).filter(Boolean)).size
    return {
      topic,
      total: chunks.length,
      level: (levels.length > 0 ? maxLevel(...levels) : 'L0') as LearningLevel,
      verified, pending, stale, disputed, practiced, sources,
    }
  }

  private recordGap(projectId: string, gap: GapItem): boolean {
    const existing = this.db.query(
      `SELECT gap_id FROM gaps WHERE project_id=? AND topic=? AND subtopic='' AND status='open'`,
      [projectId, gap.topic],
    )
    if (existing.length > 0) return false
    const row: GapRow = {
      gap_id: newId('gap'),
      project_id: projectId,
      topic: gap.topic,
      subtopic: '',
      level: gap.level ?? 'L0',
      reason: gap.reason,
      status: 'open',
      priority: gap.priority,
      created_at: utcnowIso(),
      resolved_at: '',
    }
    this.db.insert('gaps', row as unknown as Record<string, unknown>)
    return true
  }

  openGaps(projectId: string): GapRow[] {
    return this.db.query(
      "SELECT * FROM gaps WHERE project_id=? AND status='open' ORDER BY priority DESC, created_at ASC",
      [projectId],
    ) as unknown as GapRow[]
  }

  resolveGap(gapId: string): boolean {
    return this.db.executeWrite(
      "UPDATE gaps SET status='resolved', resolved_at=? WHERE gap_id=? AND status='open'",
      [utcnowIso(), gapId],
    ) > 0
  }
}
