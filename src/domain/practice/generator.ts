/**
 * 练习任务生成：只生成「可被证据检验」的任务，不能自动判分的类型明确说明原因。
 */
import { newId, utcnowIso } from '../../core/ids.ts'
import { parseJsonObject } from '../../core/json.ts'
import type { PracticeTaskRow } from '../../core/types.ts'
import type { Database } from '../../infrastructure/database/database.ts'
import type { KnowledgeStore } from '../knowledge/store.ts'

export interface PracticeSpec {
  question?: string
  expressions?: string[]
  variables?: Record<string, number>
  expected?: number | null
  code?: string
  language?: string
  criteria?: string[]
}

export class PracticeGenerator {
  private readonly db: Database
  private readonly store: KnowledgeStore

  constructor(db: Database, store: KnowledgeStore) {
    this.db = db
    this.store = store
  }

  generate(projectId: string, limit = 5): PracticeTaskRow[] {
    const chunks = this.store.listChunks({
      projectId,
      verificationStatuses: ['verified', 'partial'],
      limit: Math.max(limit * 2, 10),
    })
    const created: PracticeTaskRow[] = []
    for (const chunk of chunks) {
      if (created.length >= limit) break
      const existing = this.db.query(
        'SELECT practice_id FROM practice_tasks WHERE chunk_id=?',
        [chunk.chunk_id],
      )
      if (existing.length > 0) continue
      const metadata = parseJsonObject(chunk.metadata)
      const formulas = Array.isArray(metadata.formulas) ? metadata.formulas as Array<Record<string, unknown>> : []
      const codeBlocks = Array.isArray(metadata.code_blocks) ? metadata.code_blocks as Array<Record<string, unknown>> : []
      let kind = 'self_check'
      let spec: PracticeSpec = {
        question: `用自己的话解释：${chunk.title || chunk.summary || chunk.chunk_id}`,
        criteria: ['包含核心概念', '说明适用条件', '指出至少一个限制'],
      }
      if (formulas.length > 0) {
        kind = 'formula'
        spec = {
          expressions: [String(formulas[0]?.expression ?? '')],
          variables: {},
          expected: null,
          question: `重算公式并核对：${String(formulas[0]?.expression ?? '')}`,
        }
      } else if (codeBlocks.length > 0) {
        kind = 'code_example'
        spec = {
          code: String(codeBlocks[0]?.code ?? ''),
          language: String(codeBlocks[0]?.language ?? 'text'),
          question: '在受限目录执行示例代码并记录环境与输出',
        }
      }
      const row: PracticeTaskRow = {
        practice_id: newId('prac'),
        project_id: projectId,
        chunk_id: chunk.chunk_id,
        kind,
        title: kind === 'formula' ? '公式重算' : kind === 'code_example' ? '代码执行' : '概念自测',
        spec: spec as unknown as Record<string, unknown>,
        status: 'created',
        created_at: utcnowIso(),
      }
      this.db.insert('practice_tasks', row as unknown as Record<string, unknown>)
      created.push(row)
    }
    return created
  }

  list(projectId: string): PracticeTaskRow[] {
    return this.db.query(
      'SELECT * FROM practice_tasks WHERE project_id=? ORDER BY created_at DESC',
      [projectId],
    ) as unknown as PracticeTaskRow[]
  }

  addResult(result: Record<string, unknown>): void {
    this.db.insert('practice_results', result)
    this.db.update('practice_tasks', String(result.practice_id), { status: String(result.status ?? 'created') })
  }
}
