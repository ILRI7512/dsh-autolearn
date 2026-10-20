import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEngine } from '../helpers.ts'
import { Database } from '../../src/infrastructure/database/database.ts'

const CHUNK = {
  chunk_id: 'chunk_i', project_id: 'prj_i', partition: 'pending_knowledge', domain: 'general',
  title: '索引一致性', content: '用于验证索引与元数据一致性的知识片段。', knowledge_type: 'fact',
  source_id: 'src_i', source_url: 'https://example.com/i', source_type: 'web_page',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

describe('系统诊断与索引一致性', () => {
  it('诊断包含 schema 版本、路径、权限、网络与完整性结果', () => {
    const { engine, close } = makeEngine()
    try {
      const diagnostics = engine.services.systemDiagnostics()
      assert.equal(diagnostics.schema_version, 7)
      assert.equal(diagnostics.ok, true)
      assert.ok((diagnostics.tools as string[]).includes('knowledge_verify'))
      assert.equal((diagnostics.permissions as Record<string, unknown>).mode, 'assisted')
      assert.equal((diagnostics.network as Record<string, unknown>).allow_network, false)
      assert.ok(diagnostics.storage)
    } finally {
      close()
    }
  })

  it('数据库行被绕过索引删除时，一致性检查报告孤儿向量', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_i', title: 'I', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK])
      assert.equal(engine.store.checkIntegrity().index && (engine.store.checkIntegrity().index as { ok: boolean }).ok, true)
      // 直接删行（模拟旧版未同步索引的缺陷路径）
      engine.db.executeWrite("DELETE FROM chunks WHERE chunk_id='chunk_i'")
      const integrity = engine.store.checkIntegrity()
      assert.equal((integrity.index as { ok: boolean }).ok, false)
      assert.ok((integrity.index as { problems: string[] }).problems.some((item) => item.includes('孤儿')))
    } finally {
      close()
    }
  })

  it('备份清单被篡改时 verify_backup 拒绝恢复', () => {
    const { engine, dir, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_i', title: 'I', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK])
      const backup = engine.store.backup(join(dir, 'b1'), 'x')
      const manifestPath = String(backup.manifest_path)
      assert.equal(engine.store.verifyBackup(manifestPath).ok, true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.chunks_sha256 = 'deadbeef'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const verification = engine.store.verifyBackup(manifestPath)
      assert.equal(verification.ok, false)
      assert.ok(verification.issues.some((item) => item.includes('校验和')))
      engine.db.insert('meta', { key: 'post_backup', value: '1' })
      assert.throws(() => engine.store.restore(String(backup.db), undefined, manifestPath), /校验失败/)
      // 校验失败时在动数据库之前就拒绝：原库保持不变
      assert.equal(engine.db.scalar("SELECT value FROM meta WHERE key='post_backup'"), '1')
      assert.equal(existsSync(`${engine.config.paths.db_path}.pre-restore.sqlite3`), false)
    } finally {
      close()
    }
  })

  it('危险维护操作在无宿主审批时 refused（需要确认）', () => {
    const { engine, close } = makeEngine()
    try {
      engine.db.insert('projects', { project_id: 'prj_i', title: 'I', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK])
      assert.throws(
        () => engine.services.systemMaintenance({ action: 'delete_chunk', chunkId: 'chunk_i' }),
        /需要用户确认|批准/,
      )
      assert.ok(engine.store.getChunk('chunk_i'))
    } finally {
      close()
    }
  })

  it('宿主审批生效时维护操作可执行（删除并清理索引）', () => {
    const { engine, close } = makeEngine({ hostApproval: true })
    try {
      engine.db.insert('projects', { project_id: 'prj_i', title: 'I', goal: 'G', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
      engine.store.addChunks([CHUNK])
      const result = engine.services.systemMaintenance({ action: 'delete_chunk', chunkId: 'chunk_i' })
      assert.equal(result.deleted, true)
      assert.equal(engine.store.getChunk('chunk_i'), null)
      assert.equal(engine.index.size, 0)
    } finally {
      close()
    }
  })

  it('插件卸载后数据库连接被释放（可用新连接打开）', async () => {
    const { engine, dir, close } = makeEngine()
    const dbPath = engine.config.paths.db_path
    engine.close()
    try {
      const reopened = new Database(dbPath)
      assert.equal(reopened.schemaVersion(), 7)
      reopened.close()
      void dir
    } finally {
      close()
    }
  })
})
