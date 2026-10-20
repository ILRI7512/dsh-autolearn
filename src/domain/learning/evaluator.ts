/**
 * 学习评估：覆盖率 / 核验率 / 来源完整率 / 冲突 / 实践通过率 / 成本。
 * goal_met 只是「量化指标达标」，不等于人工验收，也不等于模型掌握了知识。
 */
import { round, utcnowIso } from '../../core/ids.ts'
import type { Database } from '../../infrastructure/database/database.ts'
import type { KnowledgeStore } from '../knowledge/store.ts'
import type { GapAnalysis, GapAnalyzer } from './gaps.ts'
import type { LearningRepository } from './repository.ts'

export interface EvaluationMetrics {
  chunks_total: number
  source_completeness: number
  verification_rate: number
  pending_verification: number
  disputed: number
  stale: number
  duplicates: number
  open_conflicts: number
  coverage_rate: number
  target_level: string
  practice: { total: number; executed: number; passed: number; failed: number; pass_rate: number }
  tasks: Record<string, number>
  llm: { calls: number; prompt_tokens: number; completion_tokens: number; cost_estimate: number }
  cost_per_task: number
}

export interface Evaluation {
  project_id: string
  goal: string
  metrics: EvaluationMetrics
  coverage: GapAnalysis['coverage']
  gaps: GapAnalysis['gaps']
  goal_met: boolean
  remaining: string[]
  conclusion: string
  acceptance_criteria: string[]
  evaluated_at: string
}

export class LearningEvaluator {
  private readonly db: Database
  private readonly store: KnowledgeStore
  private readonly repo: LearningRepository
  private readonly gaps: GapAnalyzer

  constructor(db: Database, store: KnowledgeStore, repo: LearningRepository, gaps: GapAnalyzer) {
    this.db = db
    this.store = store
    this.repo = repo
    this.gaps = gaps
  }

  evaluate(projectId: string): Evaluation {
    const project = this.repo.requireProject(projectId)
    const total = Number(this.db.scalar<number>('SELECT COUNT(*) AS n FROM chunks WHERE project_id=?', [projectId], 0) ?? 0)
    const withSource = Number(
      this.db.scalar<number>(
        "SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND (source_id<>'' OR source_url<>'')",
        [projectId], 0,
      ) ?? 0,
    )
    const verified = Number(
      this.db.scalar<number>("SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND verification_status='verified'", [projectId], 0) ?? 0,
    )
    const pending = Number(
      this.db.scalar<number>("SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND status='pending_verification'", [projectId], 0) ?? 0,
    )
    const disputed = Number(
      this.db.scalar<number>(
        "SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND (status='disputed' OR conflict_status IN ('potential','confirmed'))",
        [projectId], 0,
      ) ?? 0,
    )
    const stale = Number(
      this.db.scalar<number>(
        "SELECT COUNT(*) AS n FROM chunks WHERE project_id=? AND (status='stale' OR freshness_status IN ('stale','expired'))",
        [projectId], 0,
      ) ?? 0,
    )
    const duplicates = this.store.findDuplicates({ filter: { projectId }, maxPairs: 200 }).length
    const openConflicts = Number(
      this.db.scalar<number>("SELECT COUNT(*) AS n FROM conflicts WHERE project_id=? AND status='open'", [projectId], 0) ?? 0,
    )
    const analysis = this.gaps.analyze(projectId, { record: false })

    const practice = this.db.query(
      `SELECT r.status AS status, COUNT(*) AS n
       FROM practice_results r JOIN practice_tasks p ON p.practice_id=r.practice_id
       WHERE p.project_id=? GROUP BY r.status`,
      [projectId],
    ) as Array<{ status: string; n: number }>
    const practiceTotal = Number(
      this.db.scalar<number>('SELECT COUNT(*) AS n FROM practice_tasks WHERE project_id=?', [projectId], 0) ?? 0,
    )
    let passed = 0
    let failed = 0
    for (const row of practice) {
      if (row.status === 'pass') passed += Number(row.n)
      if (row.status === 'fail') failed += Number(row.n)
    }
    const executed = passed + failed
    const tasks = this.repo.taskCounts(projectId)
    const llmRaw = this.db.query(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, COALESCE(SUM(cost_estimate),0) AS cost
       FROM llm_calls WHERE project_id=?`,
      [projectId],
    )[0] ?? {}
    const llm = {
      calls: Number(llmRaw.calls ?? 0),
      prompt_tokens: Number(llmRaw.pt ?? 0),
      completion_tokens: Number(llmRaw.ct ?? 0),
      cost_estimate: Number(llmRaw.cost ?? 0),
    }
    const taskTotal = Object.values(tasks).reduce((sum, value) => sum + value, 0)
    const metrics: EvaluationMetrics = {
      chunks_total: total,
      source_completeness: round(total > 0 ? withSource / total : 0, 3),
      verification_rate: round(total > 0 ? verified / total : 0, 3),
      pending_verification: pending,
      disputed,
      stale,
      duplicates,
      open_conflicts: openConflicts,
      coverage_rate: analysis.coverage_rate,
      target_level: analysis.target_level,
      practice: {
        total: practiceTotal,
        executed,
        passed,
        failed,
        pass_rate: executed > 0 ? round(passed / executed, 3) : 0,
      },
      tasks,
      llm,
      cost_per_task: round(llm.cost_estimate / Math.max(1, taskTotal), 6),
    }

    const remaining: string[] = []
    if (total === 0) remaining.push('知识库为空：尚未完成任何资料提取')
    if (metrics.coverage_rate < 0.8) {
      remaining.push(`覆盖率 ${Math.round(metrics.coverage_rate * 100)}% < 80%（目标等级 ${metrics.target_level}）`)
    }
    if (total > 0 && metrics.verification_rate < 0.5) {
      remaining.push(`核验率 ${Math.round(metrics.verification_rate * 100)}% < 50%`)
    }
    if (total > 0 && metrics.source_completeness < 0.9) {
      remaining.push('存在缺少来源信息的知识，违反可追溯性要求')
    }
    if (openConflicts > 0) remaining.push(`${openConflicts} 个冲突尚未裁定`)
    if (executed > 0 && metrics.practice.pass_rate < 0.5) remaining.push('实践任务通过率低于 50%')
    if (practiceTotal > 0 && executed === 0) {
      remaining.push('已生成实践任务但尚未执行（缺少执行结果，不能判定掌握程度）')
    }
    const unfinished = Object.entries(tasks)
      .filter(([status]) => status !== 'completed')
      .reduce((sum, [, count]) => sum + count, 0)
    if (unfinished > 0) remaining.push(`${unfinished} 个任务未完成`)

    return {
      project_id: projectId,
      goal: project.goal,
      metrics,
      coverage: analysis.coverage,
      gaps: analysis.gaps,
      goal_met: remaining.length === 0,
      remaining,
      conclusion: remaining.length === 0
        ? '所有量化指标达标，可进入人工评审；这不等于模型永久掌握知识'
        : `未达标：${remaining.join('；')}`,
      acceptance_criteria: project.acceptance_criteria ?? [],
      evaluated_at: utcnowIso(),
    }
  }
}
