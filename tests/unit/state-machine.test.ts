import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allowedMethods, atLeast, canTransitionTask, computeLevel, effectiveRequirements,
  evaluateTransition, evidenceRequirements, isNonVerifiable, maxLevel,
} from '../../src/domain/learning/state-machine.ts'
import type { ChunkRow, VerificationRecordRow } from '../../src/core/types.ts'

function chunk(overrides: Partial<ChunkRow> = {}): ChunkRow {
  return {
    chunk_id: 'chunk_x', project_id: 'p1', document_id: '', partition: 'pending_knowledge',
    domain: 'general', topic: '', subtopic: '', title: 'T', content: 'C', summary: '',
    knowledge_type: 'fact', status: 'pending_verification', level: 'L2',
    source_id: 'src_1', source_url: 'https://example.com', source_title: '', source_type: 'web_page',
    author_or_publisher: '', published_at: '', accessed_at: '', language: 'zh',
    content_hash: 'h', version: 1, source_quality: 0.6, evidence_count: 0,
    evidence_independence: 0, confidence: 0.3, confidence_basis: '',
    verification_status: 'unverified', verification_method: 'none', verification_evidence: [],
    freshness_status: 'unknown', conflict_status: 'none', limitations: '', tags: [],
    source_version: '', source_excerpt: '', core_principle: '', reasoning: '', application: '',
    implementation: '', anti_patterns: '', quality_score: 0, quality_components: {},
    license_status: 'unknown', visibility: 'project', metadata: {},
    invalidated_at: '', superseded_by: '', created_at: '', updated_at: '', ...overrides,
  }
}

function passRecord(overrides: Partial<VerificationRecordRow> = {}): VerificationRecordRow {
  return {
    record_id: 'vrf_1', chunk_id: 'chunk_x', method: 'source_check', result: 'pass',
    evidence: [{ source_id: 's1', url: 'https://a.example.com' }, { source_id: 's2', url: 'https://b.example.com' }],
    notes: '', verifier: 'system', created_at: '', ...overrides,
  }
}

describe('知识状态机', () => {
  it('未核验的 fact 不能升级为 verified（无核验记录）', () => {
    const decision = evaluateTransition(chunk(), 'verified', [])
    assert.equal(decision.allowed, false)
    assert.match(decision.reasons.join(' '), /缺少合格的核验记录/)
  })

  it('两条独立来源的 fact 可以升级', () => {
    const decision = evaluateTransition(chunk({ evidence_count: 2, evidence_independence: 2 }), 'verified', [passRecord()])
    assert.equal(decision.allowed, true)
  })

  it('单一来源的 fact 不达标（转载不算独立来源）', () => {
    const decision = evaluateTransition(chunk({ evidence_count: 1, evidence_independence: 1 }), 'verified', [
      passRecord({ evidence: [{ source_id: 's1' }] }),
    ])
    assert.equal(decision.allowed, false)
    assert.match(decision.reasons.join(' '), /至少需要|独立来源/)
  })

  it('来源质量低于门槛时拒绝', () => {
    const decision = evaluateTransition(chunk({ source_quality: 0.2, evidence_count: 2, evidence_independence: 2 }), 'verified', [passRecord()])
    assert.equal(decision.allowed, false)
    assert.match(decision.reasons.join(' '), /来源质量/)
  })

  it('观点/假设永远不能 verified 或 practiced', () => {
    assert.equal(isNonVerifiable('opinion'), true)
    assert.equal(evaluateTransition(chunk({ knowledge_type: 'opinion' }), 'verified', [passRecord()]).allowed, false)
    assert.equal(evaluateTransition(chunk({ knowledge_type: 'hypothesis', status: 'verified' }), 'practiced', [passRecord()]).allowed, false)
  })

  it('方法必须与知识类型匹配', () => {
    assert.deepEqual(allowedMethods('formula'), ['formula_recompute', 'code_test', 'official_doc_check'])
    const decision = evaluateTransition(chunk({ knowledge_type: 'code_example', evidence_count: 1, evidence_independence: 1 }), 'verified', [
      passRecord({ method: 'source_check' }),
    ])
    assert.equal(decision.allowed, false)
  })

  it('practiced 需要成功的实践记录', () => {
    const verified = chunk({ status: 'verified' })
    assert.equal(evaluateTransition(verified, 'practiced', [passRecord({ method: 'source_check' })]).allowed, false)
    assert.equal(evaluateTransition(verified, 'practiced', [passRecord({ method: 'code_test' })]).allowed, true)
  })

  it('evaluated 需要 practiced 状态或评估记录', () => {
    assert.equal(evaluateTransition(chunk({ status: 'practiced' }), 'evaluated', []).allowed, true)
    assert.equal(
      evaluateTransition(chunk({ status: 'verified', metadata: {} }), 'evaluated', []).allowed,
      false,
    )
  })

  it('superseded 必须提供 superseded_by', () => {
    assert.equal(evaluateTransition(chunk({ status: 'verified' }), 'superseded', []).allowed, false)
    assert.equal(evaluateTransition(chunk({ status: 'verified', superseded_by: 'chunk_new' }), 'superseded', []).allowed, true)
  })

  it('白名单之外的迁移被拒绝', () => {
    assert.equal(evaluateTransition(chunk({ status: 'discovered' }), 'verified', [passRecord()]).allowed, false)
    assert.equal(evaluateTransition(chunk({ status: 'superseded' }), 'verified', [passRecord()]).allowed, false)
  })
})

describe('证据门槛与等级', () => {
  it('领域覆盖优先于默认门槛', () => {
    assert.deepEqual(evidenceRequirements('formula', 'quant'), [1, 1, 0.7])
    assert.deepEqual(evidenceRequirements('formula', 'general'), [1, 1, 0.6])
  })

  it('官方文档 + 通过的 official_doc_check 放宽为单来源', () => {
    const requirements = effectiveRequirements('fact', 'official_doc', [passRecord({ method: 'official_doc_check' })])
    assert.deepEqual([...requirements], [1, 1, 0.55])
  })

  it('L 等级由状态与证据推导，模型无法指定', () => {
    assert.equal(computeLevel(chunk({ status: 'discovered' })), 'L1')
    assert.equal(computeLevel(chunk({ status: 'pending_verification' })), 'L2')
    assert.equal(computeLevel(chunk({ status: 'verified' })), 'L3')
    assert.equal(computeLevel(chunk({ status: 'practiced' })), 'L4')
    assert.equal(computeLevel(chunk({ status: 'evaluated' })), 'L5')
    assert.equal(computeLevel(chunk({ status: 'disputed', evidence_count: 0 })), 'L1')
    assert.equal(computeLevel(chunk({ status: 'disputed', evidence_count: 2 })), 'L2')
  })

  it('等级比较与任务状态迁移', () => {
    assert.equal(maxLevel('L1', 'L4', 'L2'), 'L4')
    assert.equal(atLeast('L3', 'L3'), true)
    assert.equal(atLeast('L2', 'L3'), false)
    assert.equal(canTransitionTask('running', 'completed'), true)
    assert.equal(canTransitionTask('completed', 'running'), false)
  })
})
