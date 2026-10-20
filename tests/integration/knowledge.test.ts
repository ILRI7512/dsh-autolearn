import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEngine } from '../helpers.ts'

const CHUNK_A = {
  chunk_id: 'chunk_a', project_id: 'prj_a', partition: 'pending_knowledge', domain: 'quant',
  topic: '风险管理', title: '风险管理与仓位', summary: '仓位控制与止损',
  content: '风险管理是指通过仓位控制与止损，把最大回撤限制在可接受范围。滑点与点差会影响实际收益。',
  knowledge_type: 'concept', status: 'pending_verification', source_id: 'src_a',
  source_url: 'https://example.com/a', source_type: 'web_page', source_quality: 0.6,
  content_hash: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

describe('知识写入 / 读取 / 检索', () => {
  it('写入后行、倒排、向量三者一致', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', {
        project_id: 'prj_a', title: 'A', goal: 'G', domain: 'quant', partitions: ['pending_knowledge', 'quant_knowledge'],
        depth: 'working', mode: 'assisted', status: 'active', acceptance_criteria: [], deliverables: [],
        allowed_sources: [], budget: {}, scope: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      })
      const result = engine.store.addChunks([CHUNK_A])
      assert.equal(result.added, 1)
      const tokens = engine.db.count('tokens', 'chunk_id=?', ['chunk_a'])
      assert.ok(tokens > 0)
      assert.equal(engine.db.count('chunk_lex', 'chunk_id=?', ['chunk_a']), 1)
      assert.equal(engine.index.size, 1)
      const row = engine.store.getChunk('chunk_a')
      assert.equal(row?.content_hash.length, 64)
      assert.equal(row?.verification_status, 'unverified')
      assert.equal(row?.visibility, 'project')
    } finally {
      close()
    }
  })

  it('关键词检索可命中中文（bigram）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK_A])
      const outcome = engine.store.search('滑点', { projectId: 'prj_a' }, { mode: 'keyword' })
      assert.equal(outcome.results.length, 1)
      assert.equal(outcome.results[0]?.chunk_id, 'chunk_a')
      assert.ok(outcome.results[0]?.warnings.some((warning) => warning.includes('不能当作既定事实')))
    } finally {
      close()
    }
  })

  it('混合检索同时使用向量与关键词，结果按分数排序', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([
        CHUNK_A,
        { ...CHUNK_A, chunk_id: 'chunk_b', title: '保证金制度', content: '保证金与杠杆决定强平价格，杠杆越高风险越大。', topic: '杠杆' },
      ])
      const outcome = engine.store.search('杠杆保证金', { projectId: 'prj_a' }, { mode: 'hybrid', topK: 5 })
      assert.ok(outcome.results.length >= 1)
      assert.equal(outcome.results[0]?.chunk_id, 'chunk_b')
      assert.ok(outcome.elapsed_ms >= 0)
    } finally {
      close()
    }
  })

  it('更新内容会写入版本快照并重置核验状态', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([{ ...CHUNK_A, status: 'verified', verification_status: 'verified' }])
      const updated = engine.store.updateChunk('chunk_a', { content: '新的正文：滑点必须计入回测。' }, '修正内容')
      assert.equal(updated.version, 2)
      assert.equal(updated.verification_status, 'unverified')
      assert.equal(updated.status, 'pending_verification')
      const versions = engine.store.listVersions('chunk_a')
      assert.equal(versions.length, 1)
      const rolled = engine.store.rollbackVersion('chunk_a', 1)
      assert.ok(rolled.content.includes('风险管理是指'))
      assert.equal(rolled.version, 3) // 回滚本身也是一次内容变更（v1→v2 修改，v3 回滚）
      assert.equal(engine.store.listVersions('chunk_a').length, 2)
    } finally {
      close()
    }
  })

  it('只改标题也会重建倒排（旧版踩过的坑）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK_A])
      engine.store.updateChunk('chunk_a', { title: '全新的标题专用词组' }, 'rename')
      const hits = engine.store.search('全新的标题专用词组', { projectId: 'prj_a' }, { mode: 'keyword' })
      assert.equal(hits.results.length, 1)
    } finally {
      close()
    }
  })

  it('删除片段同时清理倒排、词长与向量', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK_A])
      assert.equal(engine.store.deleteChunk('chunk_a'), true)
      assert.equal(engine.db.count('tokens', 'chunk_id=?', ['chunk_a']), 0)
      assert.equal(engine.db.count('chunk_lex', 'chunk_id=?', ['chunk_a']), 0)
      assert.equal(engine.index.size, 0)
      assert.equal(engine.store.deleteChunk('chunk_a'), false)
    } finally {
      close()
    }
  })

  it('失效片段默认不参与检索，但显式 includeInvalidated 可查', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK_A])
      engine.store.invalidateChunk('chunk_a', '来源更新', 'chunk_new')
      assert.equal(engine.store.search('滑点', { projectId: 'prj_a' }).results.length, 0)
      assert.equal(engine.store.listChunks({ projectId: 'prj_a', includeInvalidated: true }).length, 1)
    } finally {
      close()
    }
  })

  it('相同正文幂等写入，不会产生两条活的重复知识', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      const first = engine.store.addChunks([{ ...CHUNK_A, chunk_id: 'chunk_x' }])
      assert.equal(first.added, 1)
      // 同一内容再写一次：chunk_id 由内容指纹推导，命中同一实体（更新而非新增）
      const second = engine.store.addChunks([{ ...CHUNK_A, chunk_id: 'chunk_x' }])
      assert.equal(second.added, 0)
      assert.equal(second.updated, 1)
      assert.equal(engine.store.countChunks({ projectId: 'prj_a' }), 1)
      // 唯一索引兜底：不同 chunk_id 但同内容会被数据库拒绝
      assert.throws(() => engine.store.addChunks([{ ...CHUNK_A, chunk_id: 'chunk_y' }]), /UNIQUE/)
    } finally {
      close()
    }
  })

  it('近似重复可被向量相似度识别', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([
        { ...CHUNK_A, chunk_id: 'chunk_x' },
        {
          ...CHUNK_A, chunk_id: 'chunk_y',
          content: '风险管理是指通过仓位控制与止损，把最大回撤限制在可接受范围。滑点与点差会影响实际收益！',
        },
      ])
      const pairs = engine.store.findDuplicates({ filter: { projectId: 'prj_a' }, threshold: 0.5 })
      assert.ok(pairs.some((pair) => pair.reason === 'vector_similarity'))
    } finally {
      close()
    }
  })

  it('索引文件落盘为 legacy 兼容格式', () => {
    const { engine, dir, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_a', title: 'A', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK_A])
      for (const file of ['ids.json', 'vectors.npy', 'manifest.json']) {
        assert.ok(existsSync(join(dir, 'data', 'index', file)), file)
      }
      const manifest = JSON.parse(readFileSync(join(dir, 'data', 'index', 'manifest.json'), 'utf8'))
      assert.equal(manifest.embedder_id, 'hashing:hashed-ngram:512')
      assert.equal(manifest.dim, 512)
    } finally {
      close()
    }
  })
})

describe('跨项目数据隔离', () => {
  it('项目内检索只返回本项目（或 global）知识', () => {
    const { engine, close } = makeEngine()
    try {
      for (const id of ['prj_a', 'prj_b']) {
        engine.db.insert('projects', { project_id: id, title: id, goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      }
      engine.store.addChunks([
        { ...CHUNK_A, chunk_id: 'chunk_a', project_id: 'prj_a' },
        { ...CHUNK_A, chunk_id: 'chunk_b', project_id: 'prj_b' },
        { ...CHUNK_A, chunk_id: 'chunk_g', project_id: 'prj_b', visibility: 'global', content: '全局共享：风险管理的通用定义。' },
      ])
      const aOnly = engine.store.listChunkIds({ projectId: 'prj_a' })
      assert.deepEqual(aOnly.sort(), ['chunk_a', 'chunk_g'])
      const unscoped = engine.store.listChunkIds({})
      assert.deepEqual(unscoped, ['chunk_g'])
      const search = engine.store.search('风险管理', { projectId: 'prj_a' })
      assert.ok(search.results.every((item) => item.chunk_id !== 'chunk_b'))
    } finally {
      close()
    }
  })
})
