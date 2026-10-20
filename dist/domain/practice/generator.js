/**
 * 练习任务生成：只生成「可被证据检验」的任务，不能自动判分的类型明确说明原因。
 */
import { newId, utcnowIso } from "../../core/ids.js";
import { parseJsonObject } from "../../core/json.js";
export class PracticeGenerator {
    db;
    store;
    constructor(db, store) {
        this.db = db;
        this.store = store;
    }
    generate(projectId, limit = 5) {
        const chunks = this.store.listChunks({
            projectId,
            verificationStatuses: ['verified', 'partial'],
            limit: Math.max(limit * 2, 10),
        });
        const created = [];
        for (const chunk of chunks) {
            if (created.length >= limit)
                break;
            const existing = this.db.query('SELECT practice_id FROM practice_tasks WHERE chunk_id=?', [chunk.chunk_id]);
            if (existing.length > 0)
                continue;
            const metadata = parseJsonObject(chunk.metadata);
            const formulas = Array.isArray(metadata.formulas) ? metadata.formulas : [];
            const codeBlocks = Array.isArray(metadata.code_blocks) ? metadata.code_blocks : [];
            let kind = 'self_check';
            let spec = {
                question: `用自己的话解释：${chunk.title || chunk.summary || chunk.chunk_id}`,
                criteria: ['包含核心概念', '说明适用条件', '指出至少一个限制'],
            };
            if (formulas.length > 0) {
                kind = 'formula';
                spec = {
                    expressions: [String(formulas[0]?.expression ?? '')],
                    variables: {},
                    expected: null,
                    question: `重算公式并核对：${String(formulas[0]?.expression ?? '')}`,
                };
            }
            else if (codeBlocks.length > 0) {
                kind = 'code_example';
                spec = {
                    code: String(codeBlocks[0]?.code ?? ''),
                    language: String(codeBlocks[0]?.language ?? 'text'),
                    question: '在受限目录执行示例代码并记录环境与输出',
                };
            }
            const row = {
                practice_id: newId('prac'),
                project_id: projectId,
                chunk_id: chunk.chunk_id,
                kind,
                title: kind === 'formula' ? '公式重算' : kind === 'code_example' ? '代码执行' : '概念自测',
                spec: spec,
                status: 'created',
                created_at: utcnowIso(),
            };
            this.db.insert('practice_tasks', row);
            created.push(row);
        }
        return created;
    }
    list(projectId) {
        return this.db.query('SELECT * FROM practice_tasks WHERE project_id=? ORDER BY created_at DESC', [projectId]);
    }
    addResult(result) {
        this.db.insert('practice_results', result);
        this.db.update('practice_tasks', String(result.practice_id), { status: String(result.status ?? 'created') });
    }
}
