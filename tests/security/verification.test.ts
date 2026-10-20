import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeEngine } from '../helpers.ts'

function seedProject(engine: ReturnType<typeof makeEngine>['engine'], id = 'prj_v'): void {
  engine.db.insert('projects', {
    project_id: id, title: id, goal: '核验测试', domain: 'quant',
    partitions: ['pending_knowledge', 'quant_knowledge'], depth: 'working', mode: 'assisted',
    status: 'active', acceptance_criteria: [], deliverables: [], allowed_sources: [],
    budget: {}, scope: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  })
}

function seedChunk(engine: ReturnType<typeof makeEngine>['engine'], overrides: Record<string, unknown> = {}): string {
  const chunkId = String(overrides.chunk_id ?? 'chunk_v')
  engine.store.addChunks([{
    chunk_id: chunkId, project_id: 'prj_v', partition: 'pending_knowledge', domain: 'quant',
    title: '风险度量', content: '最大回撤 = (峰值净值 - 当前净值) / 峰值净值。',
    summary: '', knowledge_type: 'formula', status: 'pending_verification',
    source_id: 'src_v', source_url: 'https://example.com/risk', source_type: 'official_doc',
    source_quality: 0.9, metadata: { formulas: [{ expression: '(peak - now) / peak', kind: 'inline' }] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides,
  }])
  return chunkId
}

describe('知识核验：证据规则不可绕过', () => {
  it('无证据 → fail，绝不升级为 verified', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { knowledge_type: 'fact', source_id: '', source_url: '', source_type: 'unknown' })
      const outcome = engine.verifier.verify('chunk_v', { method: 'source_check' })
      assert.equal(outcome.result, 'fail')
      assert.notEqual(outcome.status_after, 'verified')
      assert.equal(engine.store.getChunk('chunk_v')?.verification_status, 'failed')
      assert.equal(engine.store.getChunk('chunk_v')?.status, 'disputed')
    } finally {
      close()
    }
  })

  it('单一来源的事实不达标（转载/镜像不算独立来源）', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { knowledge_type: 'fact', source_quality: 0.9 })
      const outcome = engine.verifier.verify('chunk_v', { method: 'source_check' })
      assert.equal(outcome.requirements.met, false)
      assert.notEqual(outcome.status_after, 'verified')
      assert.equal(outcome.result, 'partial')
      assert.equal(outcome.status_after, 'pending_verification')
    } finally {
      close()
    }
  })

  it('公式重算通过 + 满足门槛 → verified（正向路径）', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, {})
      const outcome = engine.verifier.verify('chunk_v', {
        method: 'formula_recompute',
        expression: '(peak - now) / peak',
        variables: { peak: 10000, now: 8000 },
        expected: 0.2,
      })
      assert.equal(outcome.result, 'pass')
      assert.equal(outcome.requirements.met, true)
      assert.equal(outcome.status_after, 'verified')
      assert.ok(outcome.confidence <= 0.95)
      assert.ok(outcome.confidence > 0)
      const chunk = engine.store.getChunk('chunk_v')
      assert.equal(chunk?.verification_status, 'verified')
      assert.equal(chunk?.level, 'L3')
      // 证据 = 条目自身来源 + 公式重算结果（与旧版口径一致）
      assert.equal(chunk?.evidence_count, 2)
      assert.equal(chunk?.quality_score !== undefined, true)
    } finally {
      close()
    }
  })

  it('公式重算不一致 → fail 并保留证据', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, {})
      const outcome = engine.verifier.verify('chunk_v', {
        method: 'formula_recompute', expression: '(peak - now) / peak',
        variables: { peak: 10000, now: 8000 }, expected: 0.5,
      })
      assert.equal(outcome.result, 'fail')
      const records = engine.store.listVerifications('chunk_v')
      assert.equal(records.length, 1)
      assert.equal((records[0]?.evidence as unknown[]).length > 0, true)
    } finally {
      close()
    }
  })

  it('缺少 expected 或表达式 → inconclusive（不能声称通过）', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { metadata: {} })
      const outcome = engine.verifier.verify('chunk_v', { method: 'formula_recompute' })
      assert.equal(outcome.result, 'inconclusive')
      assert.notEqual(outcome.status_after, 'verified')
    } finally {
      close()
    }
  })

  it('观点/假设永远 unverifiable', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { chunk_id: 'chunk_opinion', knowledge_type: 'opinion', content: '我认为杠杆越高越好。' })
      const outcome = engine.verifier.verify('chunk_opinion')
      assert.equal(outcome.status_after, 'pending_verification')
      assert.equal(engine.store.getChunk('chunk_opinion')?.verification_status, 'unverifiable')
      assert.ok(outcome.warnings.some((warning) => warning.includes('永远不能')))
    } finally {
      close()
    }
  })

  it('没有执行结果时不能声称代码/实验通过', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { knowledge_type: 'code_example', content: 'console.log(1)' })
      const outcome = engine.verifier.verify('chunk_v', { method: 'code_test' })
      assert.equal(outcome.result, 'inconclusive')
    } finally {
      close()
    }
  })

  it('模型通道不能自称为人工复核（服务层强制 system）', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { knowledge_type: 'concept' })
      const result = engine.services.knowledgeVerify({
        action: 'verify', chunkId: 'chunk_v', method: 'manual_review', verifier: 'user',
        evidence: [{ kind: 'user_review', actor: 'user', note: '我看过了' }],
      })
      assert.equal(result.result, 'partial')
      assert.ok((result.reasons as string[]).some((reason) => reason.includes('人工复核不成立')))
    } finally {
      close()
    }
  })

  it('用户侧人工复核（verifier=user + 人工证据）可以通过', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { knowledge_type: 'concept', source_quality: 0.9 })
      const outcome = engine.verifier.verify('chunk_v', {
        method: 'manual_review', verifier: 'user',
        evidence: [{ kind: 'user_review', actor: 'user', note: '人工核对过原始来源' }],
      })
      assert.equal(outcome.result, 'pass')
      assert.equal(outcome.status_after, 'verified')
    } finally {
      close()
    }
  })

  it('核验记录完整可追溯（方法、结果、证据、时间、验证者）', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, {})
      engine.verifier.verify('chunk_v', {
        method: 'formula_recompute', expression: '(peak-now)/peak',
        variables: { peak: 100, now: 80 }, expected: 0.2,
      })
      const record = engine.store.listVerifications('chunk_v')[0]
      assert.equal(record?.method, 'formula_recompute')
      assert.equal(record?.result, 'pass')
      assert.equal(record?.verifier, 'system')
      assert.ok(String(record?.created_at).endsWith('Z'))
      assert.ok(Array.isArray(record?.evidence))
    } finally {
      close()
    }
  })

  it('置信度由公式计算且封顶 0.95，不会出现 1.0', () => {
    const { engine, close } = makeEngine()
    try {
      seedProject(engine)
      seedChunk(engine, { source_quality: 1 })
      const outcome = engine.verifier.verify('chunk_v', {
        method: 'formula_recompute', expression: '(peak-now)/peak',
        variables: { peak: 100, now: 80 }, expected: 0.2,
      })
      assert.ok(outcome.confidence <= 0.95)
      assert.match(outcome.confidence_basis, /上限 0\.95/)
    } finally {
      close()
    }
  })
})
