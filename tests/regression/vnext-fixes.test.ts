import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEngine } from '../helpers.ts'
import { isPublicAddress } from '../../src/security/network.ts'
import { apply as applyPlugin } from '../../src/adapters/dsh/plugin.ts'
import { AutolearnEngine } from '../../src/index.ts'

describe('vNext 缺陷回归：数据形状', () => {
  it('JSON 列中的对象数组必须读回数组，而不是对象', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', {
        project_id: 'prj_shape', title: 'S', goal: 'G',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      })
      const evidence = [{ source_id: 's1', url: 'https://example.com/a' }]
      engine.store.addChunks([{
        chunk_id: 'chunk_shape', project_id: 'prj_shape', title: 'T', content: '正文',
        knowledge_type: 'concept', source_id: 's1', source_url: 'https://example.com/a',
        source_quality: 0.6, verification_evidence: evidence,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }])
      const row = engine.store.getChunk('chunk_shape')
      assert.ok(Array.isArray(row?.verification_evidence))
      assert.deepEqual(row?.verification_evidence, evidence)
      // 标签也是数组；不能因为标签里出现 '{' 就退化成对象
      assert.ok(Array.isArray(row?.tags))
    } finally {
      close()
    }
  })
})

describe('vNext 缺陷回归：IPv6 SSRF 判定', () => {
  it('非规范写法的 loopback/unspecified/site-local/mapped 必须判为非公网', () => {
    const blocked = [
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
      'fec0::1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '64:ff9b::a00:1',
      '2002:7f00:1::',
    ]
    for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip)
    for (const ip of ['2606:4700:4700::1111', '2400:cb00::1', '8.8.8.8']) {
      assert.equal(isPublicAddress(ip), true, ip)
    }
  })
})

describe('vNext 缺陷回归：宿主审批', () => {
  it('没有 tools/pre-execute hook 时，destructive 不能交给宿主放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-no-hook-'))
    const previous = process.env.DSH_AL_HOME
    try {
      const seed = AutolearnEngine.open({ home: dir, hostApproval: false })
      seed.db.insert('projects', { project_id: 'prj_x', title: 'X', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      seed.store.addChunks([{ chunk_id: 'chunk_x', project_id: 'prj_x', title: 'X', content: '待删除', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }])
      seed.close()

      const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>()
      const ctx = {
        tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => {} } },
        effect: (callback: () => (() => void) | void) => callback(),
      }
      process.env.DSH_AL_HOME = dir
      applyPlugin(ctx as never, { home: dir })
      const maintenance = tools.get('system_maintenance')
      assert.ok(maintenance)
      const result = await maintenance.execute({ action: 'delete_chunk', chunkId: 'chunk_x' })
      assert.equal((result as { ok: boolean }).ok, false)
      assert.match(JSON.stringify(result), /APPROVAL_REQUIRED|需要用户确认|批准/)
      const check = AutolearnEngine.open({ home: dir })
      assert.ok(check.store.getChunk('chunk_x'))
      check.close()
    } finally {
      if (previous === undefined) delete process.env.DSH_AL_HOME
      else process.env.DSH_AL_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('vNext 缺陷回归：交叉来源核验', () => {
  it('同一说法的第二条独立来源应被自动收集，事实类可升级', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', {
        project_id: 'prj_cross', title: 'C', goal: 'G', domain: 'quant',
        partitions: ['pending_knowledge', 'quant_knowledge'], depth: 'working', mode: 'assisted',
        status: 'active', acceptance_criteria: [], deliverables: [], allowed_sources: [],
        budget: {}, scope: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      })
      const base = {
        project_id: 'prj_cross', title: '最大回撤定义', summary: '回撤是峰值到当前净值的跌幅',
        domain: 'quant', topic: '风险管理', knowledge_type: 'fact', source_quality: 0.9,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }
      engine.store.addChunks([
        { ...base, chunk_id: 'chunk_c1', content: '最大回撤是指净值从峰值下跌的幅度，计算方式为峰值净值减去当前净值再除以峰值净值。', source_id: 'src_1', source_url: 'https://a.example.com/risk' },
        { ...base, chunk_id: 'chunk_c2', content: '最大回撤的定义是净值从峰值下跌的幅度，等于峰值净值减当前净值除以峰值净值。', source_id: 'src_2', source_url: 'https://b.example.com/risk' },
      ])
      const outcome = engine.verifier.verify('chunk_c1', { method: 'source_check' })
      assert.ok(outcome.independence >= 2, `independence=${outcome.independence}`)
      assert.equal(outcome.requirements.met, true)
      assert.equal(outcome.status_after, 'verified')
    } finally {
      close()
    }
  })
})

describe('vNext 缺陷回归：标题变更后的向量索引', () => {
  it('只改标题也必须刷新向量索引（不能只刷新关键词倒排）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_t', title: 'T', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([{
        chunk_id: 'chunk_t', project_id: 'prj_t', title: '旧标题甲', summary: '无关摘要',
        content: 'zzz qqq 完全无关的正文 zzz。',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }])
      engine.store.updateChunk('chunk_t', { title: '量子纠缠实验记录' }, 'rename')
      const vector = engine.store.search('量子纠缠实验记录', { projectId: 'prj_t' }, { mode: 'vector' })
      assert.equal(vector.results.length, 1)
      assert.equal(vector.results[0]?.chunk_id, 'chunk_t')
    } finally {
      close()
    }
  })
})

describe('vNext 缺陷回归：排序与时效', () => {
  it('同主题下 current 版本必须排在 stale 版本之前（排序分必须真正生效）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_f', title: 'F', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      const base = {
        project_id: 'prj_f', domain: 'quant', topic: '风险管理', knowledge_type: 'concept',
        summary: '最大回撤计算口径', source_quality: 0.7,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }
      engine.store.addChunks([
        { ...base, chunk_id: 'chunk_stale', title: '最大回撤（旧版）', content: '最大回撤是净值从峰值下跌的幅度，旧版用简单差值计算，未除以峰值。', freshness_status: 'stale' },
        { ...base, chunk_id: 'chunk_current', title: '最大回撤（当前版）', content: '最大回撤是净值从峰值下跌的幅度，现行口径为峰值减当前除以峰值。', freshness_status: 'fresh' },
      ])
      const outcome = engine.store.search('最大回撤 计算口径', { projectId: 'prj_f' }, { mode: 'hybrid', topK: 5 })
      assert.equal(outcome.results[0]?.chunk_id, 'chunk_current')
      // 返回结果必须按最终分降序，而不是“算了分但按融合顺序返回”
      for (let i = 1; i < outcome.results.length; i += 1) {
        assert.ok((outcome.results[i - 1]?.score ?? 0) >= (outcome.results[i]?.score ?? 0))
      }
      assert.ok(outcome.results.some((row) => row.chunk_id === 'chunk_stale'))
    } finally {
      close()
    }
  })
})
