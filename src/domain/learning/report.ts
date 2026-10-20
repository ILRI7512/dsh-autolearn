/** 学习报告：Markdown + JSON，内容全部来自数据库真实状态（不编造进展）。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { utcnowIso } from '../../core/ids.ts'
import type { Database } from '../../infrastructure/database/database.ts'
import type { LearningRepository } from './repository.ts'
import type { LearningEvaluator } from './evaluator.ts'
import type { GapAnalyzer } from './gaps.ts'

export class ReportGenerator {
  private readonly db: Database
  private readonly repo: LearningRepository
  private readonly evaluator: LearningEvaluator
  private readonly gaps: GapAnalyzer
  private readonly reportsDir: string

  constructor(options: {
    db: Database
    repo: LearningRepository
    evaluator: LearningEvaluator
    gaps: GapAnalyzer
    reportsDir: string
  }) {
    this.db = options.db
    this.repo = options.repo
    this.evaluator = options.evaluator
    this.gaps = options.gaps
    this.reportsDir = options.reportsDir
  }

  generate(projectId: string): { report_path: string; json_path: string; goal_met: boolean } {
    const project = this.repo.requireProject(projectId)
    const evaluation = this.evaluator.evaluate(projectId)
    const openGaps = this.gaps.openGaps(projectId)
    const conflicts = this.db.query(
      "SELECT conflict_id, kind, detail, status, created_at FROM conflicts WHERE project_id=? ORDER BY created_at DESC",
      [projectId],
    )
    const sources = this.db.query(
      'SELECT source_type, location, quality, license_status, fetch_ok, error FROM sources WHERE project_id=? ORDER BY created_at DESC',
      [projectId],
    )
    const runs = this.repo.lastRuns(projectId, 10)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)

    const lines: string[] = [
      `# 学习报告：${project.title}`,
      '',
      `- 项目 ID：\`${project.project_id}\``,
      `- 目标：${project.goal}`,
      `- 领域 / 深度 / 模式：${project.domain} / ${project.depth} / ${project.mode}`,
      `- 生成时间：${utcnowIso()}`,
      '',
      '## 量化指标',
      '',
      '| 指标 | 值 |',
      '| --- | --- |',
      `| 知识片段数 | ${evaluation.metrics.chunks_total} |`,
      `| 覆盖率（目标 ${evaluation.metrics.target_level}） | ${(evaluation.metrics.coverage_rate * 100).toFixed(1)}% |`,
      `| 核验率 | ${(evaluation.metrics.verification_rate * 100).toFixed(1)}% |`,
      `| 来源完整率 | ${(evaluation.metrics.source_completeness * 100).toFixed(1)}% |`,
      `| 待核验 / 争议 / 过时 | ${evaluation.metrics.pending_verification} / ${evaluation.metrics.disputed} / ${evaluation.metrics.stale} |`,
      `| 开放冲突 | ${evaluation.metrics.open_conflicts} |`,
      `| 重复知识组 | ${evaluation.metrics.duplicates} |`,
      `| 实践通过率 | ${(evaluation.metrics.practice.pass_rate * 100).toFixed(1)}%（${evaluation.metrics.practice.passed}/${evaluation.metrics.practice.executed}） |`,
      `| 模型调用 / 费用 | ${evaluation.metrics.llm.calls} / $${evaluation.metrics.llm.cost_estimate.toFixed(6)} |`,
      '',
      `## 结论`,
      '',
      evaluation.conclusion,
      '',
      evaluation.remaining.length > 0 ? '### 未达标项\n' : '',
      ...evaluation.remaining.map((item) => `- ${item}`),
      '',
      '## 主题覆盖',
      '',
      '| 主题 | 片段 | 等级 | 已核验 | 独立来源 |',
      '| --- | --- | --- | --- | --- |',
      ...evaluation.coverage.map(
        (item) => `| ${item.topic} | ${item.total} | ${item.level} | ${item.verified} | ${item.sources} |`,
      ),
      '',
      '## 未解决缺口',
      '',
      ...(openGaps.length > 0
        ? openGaps.map((gap) => `- [${gap.level}] ${gap.topic}：${gap.reason}（优先级 ${gap.priority}）`)
        : ['无']),
      '',
      '## 冲突',
      '',
      ...(conflicts.length > 0
        ? conflicts.map((row) => `- ${String(row.kind)}：${String(row.detail)}（${String(row.status)}）`)
        : ['无']),
      '',
      '## 来源',
      '',
      ...(sources.length > 0
        ? sources.map(
            (row) =>
              `- ${String(row.location)}（类型 ${String(row.source_type)}，质量 ${String(row.quality)}，许可 ${String(row.license_status)}${row.fetch_ok ? '' : `，抓取失败: ${String(row.error)}`}）`,
          )
        : ['无']),
      '',
      '## 最近运行',
      '',
      ...(runs.length > 0
        ? runs.map(
            (run) =>
              `- #${run.iteration} ${run.status}${run.stop_reason ? `（${run.stop_reason}）` : ''}，新知识 ${Number((run.summary as Record<string, unknown>).new_knowledge ?? 0)}`,
          )
        : ['无']),
      '',
      '> 说明：量化指标达标不等于人工验收；核验状态以数据库记录为准。',
      '',
    ]

    mkdirSync(this.reportsDir, { recursive: true })
    const mdPath = join(this.reportsDir, `${projectId}-${stamp}.md`)
    const jsonPath = join(this.reportsDir, `${projectId}-${stamp}.json`)
    writeFileSync(mdPath, lines.filter((line) => line !== undefined).join('\n'), 'utf8')
    writeFileSync(jsonPath, `${JSON.stringify({ project, evaluation, open_gaps: openGaps, conflicts, sources, runs }, null, 2)}\n`, 'utf8')
    return { report_path: mdPath, json_path: jsonPath, goal_met: evaluation.goal_met }
  }
}
