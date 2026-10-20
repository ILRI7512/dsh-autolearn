import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Database } from '../../src/infrastructure/database/database.ts'
import { COLUMNS, SCHEMA_VERSION, JSON_COLUMNS } from '../../src/infrastructure/database/schema.ts'
import { makeEngine } from '../helpers.ts'

describe('数据库 schema 与迁移', () => {
  it('新库迁移到 v7，核心表与列齐全', () => {
    const db = Database.openMemory()
    const result = db.migrate()
    assert.equal(result.from, 0)
    assert.equal(result.to, SCHEMA_VERSION)
    assert.equal(db.schemaVersion(), 7)
    for (const table of ['projects', 'tasks', 'chunks', 'sources', 'documents', 'verification_records', 'audit_log', 'embedding_cache']) {
      assert.ok(COLUMNS[table], `缺少表 ${table}`)
      assert.ok((COLUMNS[table] as readonly string[]).length > 0)
    }
    assert.ok((COLUMNS.chunks as readonly string[]).includes('quality_score'))
    assert.ok((COLUMNS.chunks as readonly string[]).includes('tags'))
    db.close()
  })

  it('迁移可重复执行（幂等）', () => {
    const db = Database.openMemory()
    db.migrate()
    const second = db.migrate()
    assert.equal(second.from, SCHEMA_VERSION)
    assert.equal(second.to, SCHEMA_VERSION)
    db.close()
  })

  it('JSON 列写入后读回为对象/数组，布尔列读回为 boolean', () => {
    const db = Database.openMemory()
    db.migrate()
    db.insert('projects', {
      project_id: 'prj_1', title: 'T', goal: 'G', domain: 'general', partitions: ['pending_knowledge'],
      depth: 'working', mode: 'assisted', status: 'active', acceptance_criteria: ['a'],
      deliverables: [], allowed_sources: [], budget: { cap: 1 }, scope: {},
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    })
    const row = db.get('projects', 'prj_1')
    assert.deepEqual(row?.partitions, ['pending_knowledge'])
    assert.deepEqual(row?.acceptance_criteria, ['a'])
    assert.deepEqual(row?.budget, { cap: 1 })
    db.insert('sources', {
      source_id: 'src_1', project_id: 'prj_1', source_type: 'web_page', location: 'https://x',
      title: '', publisher: '', published_at: '', accessed_at: '', license_status: 'unknown',
      quality: 0.5, quality_basis: '', freshness_status: 'unknown', content_hash: '',
      fetch_ok: 1, error: '', metadata: {}, created_at: '2026-01-01T00:00:00Z',
    })
    assert.equal(db.get('sources', 'src_1')?.fetch_ok, true)
    db.close()
  })

  it('事务失败整体回滚（不留半条记录）', () => {
    const db = Database.openMemory()
    db.migrate()
    assert.throws(() => {
      db.transaction(() => {
        db.insert('meta', { key: 'a', value: '1' })
        throw new Error('boom')
      })
    })
    assert.equal(db.count('meta', "key='a'"), 0)
    // 内层事务不提前提交
    db.transaction(() => {
      db.insert('meta', { key: 'outer', value: '1' })
      db.transaction(() => db.insert('meta', { key: 'inner', value: '1' }))
    })
    assert.equal(db.count('meta'), 3) // schema_version + outer + inner
    db.close()
  })

  it('只读查询门禁拒绝写语句', () => {
    const db = Database.openMemory()
    db.migrate()
    assert.throws(() => db.query("INSERT INTO meta(key,value) VALUES('x','1')"), /只读/)
    assert.throws(() => db.query(''), /只读/)
    db.close()
  })

  it('完整性检查与备份/恢复可用', () => {
    const { engine, dir, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '备份测试', plan: false })
      const projectId = String(created.project.project_id)
      engine.db.insert('meta', { key: 'probe', value: 'ok' })
      const backup = engine.store.backup(`${dir}/backup`, 'test')
      assert.ok(backup.db)
      engine.db.executeWrite("UPDATE meta SET value='changed' WHERE key='probe'")
      engine.store.restore(String(backup.db), String(backup.index), String(backup.manifest_path))
      assert.equal(engine.db.scalar("SELECT value FROM meta WHERE key='probe'"), 'ok')
      assert.ok(engine.repo.getProject(projectId))
    } finally {
      close()
    }
  })

  it('两个连接并发写入不丢数据（WAL + busy_timeout）', () => {
    const { engine, dir, close } = makeEngine()
    try {
      const dbPath = engine.config.paths.db_path
      const second = new Database(dbPath)
      second.migrate()
      engine.db.insert('meta', { key: 'a', value: '1' })
      second.insert('meta', { key: 'b', value: '2' })
      assert.equal(second.count('meta', "key IN ('a','b')"), 2)
      second.close()
    } finally {
      close()
    }
  })
})
