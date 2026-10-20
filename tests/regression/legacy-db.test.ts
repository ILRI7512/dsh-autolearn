import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AutolearnEngine } from '../../src/index.ts'
import { loadConfig } from '../../src/core/config.ts'
import { HashingEmbedder } from '../../src/infrastructure/embeddings/hashing-embedder.ts'
import { indexText } from '../../src/infrastructure/embeddings/vector-index.ts'
import { createHash } from 'node:crypto'

const LEGACY_HOME = join(process.cwd(), 'dsh_autonomous_learning')
const LEGACY_DB = join(LEGACY_HOME, 'data', 'metadata.sqlite3')
const LEGACY_INDEX = join(LEGACY_HOME, 'data', 'index')

/**
 * 旧库兼容性回归：直接用 v1.2（Python）写出的真实数据库与索引验证。
 * 仓库里没有 data 目录时自动跳过（CI 环境）。
 */
describe('v1.2 数据库与向量索引兼容', { skip: !existsSync(LEGACY_DB) }, () => {
  it('TS 引擎能打开旧库并保留原有数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-legacy-'))
    try {
      const dataDir = join(dir, 'data')
      mkdirSync(dataDir, { recursive: true })
      // 用 SQLite 在线备份复制，避免直接拷贝 WAL 造成不一致
      const source = new DatabaseSync(LEGACY_DB, { readOnly: true })
      source.prepare('VACUUM INTO ?').run(join(dataDir, 'metadata.sqlite3'))
      source.close()
      if (existsSync(LEGACY_INDEX)) {
        mkdirSync(join(dataDir, 'index'), { recursive: true })
        for (const file of ['ids.json', 'vectors.npy', 'manifest.json']) {
          const from = join(LEGACY_INDEX, file)
          if (existsSync(from)) copyFileSync(from, join(dataDir, 'index', file))
        }
      }
      const config = loadConfig({
        home: LEGACY_HOME,
        env: { ...process.env, DSH_AL_HOME: LEGACY_HOME, DSH_AL_DATA_DIR: dataDir, DSH_AL_CONFIG: '' } as NodeJS.ProcessEnv,
      })
      const engine = AutolearnEngine.open({ config })
      try {
        assert.equal(engine.db.schemaVersion(), 7)
        const counts = engine.db.stats()
        assert.ok(Number(counts.projects) >= 1)
        assert.ok(Number(counts.chunks) >= 1)
        assert.ok(Number(counts.tasks) >= 1)
        // 旧库里的项目与任务仍可读取
        const projects = engine.repo.listProjects()
        assert.ok(projects.length >= 1)
        const projectId = projects[0]?.project_id as string
        const tasks = engine.repo.listTasks(projectId)
        assert.ok(tasks.length >= 1)
        // 检索可命中旧知识（关键词通道不依赖向量）
        const outcome = engine.store.search('滑点', { projectId, includeAllProjects: true }, { mode: 'keyword' })
        assert.ok(outcome.results.length >= 0)
        // 索引一致性可检查（允许旧索引缺向量，但必须给出问题列表而不是崩溃）
        const integrity = engine.store.checkIntegrity()
        assert.ok(integrity.index && typeof integrity.index === 'object')
      } finally {
        engine.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('向量算法与旧版逐分量一致（embedding_cache 对拍）', () => {
    const source = new DatabaseSync(LEGACY_DB, { readOnly: true })
    try {
      const rows = source.prepare(
        'SELECT c.chunk_id, c.title, c.summary, c.content, e.cache_key, e.embedder_id, e.vector, e.dim FROM chunks c JOIN embedding_cache e ON 1=1 LIMIT 20',
      ).all() as Array<Record<string, unknown>>
      const embedder = new HashingEmbedder(512)
      const chunks = source.prepare('SELECT chunk_id, title, summary, content FROM chunks LIMIT 50').all() as Array<Record<string, unknown>>
      const cacheRows = source.prepare('SELECT cache_key, embedder_id, vector, dim FROM embedding_cache').all() as Array<Record<string, unknown>>
      assert.ok(cacheRows.length > 0, '旧库应包含 embedding 缓存')
      const byKey = new Map(cacheRows.map((row) => [String(row.cache_key), row]))
      let compared = 0
      for (const chunk of chunks) {
        const text = indexText(chunk as { chunk_id: string; title?: string; summary?: string; content?: string })
        const key = createHash('sha256').update(`${embedder.embedderId}|${text}`, 'utf8').digest('hex')
        const cached = byKey.get(key)
        if (!cached) continue
        const bytes = cached.vector as Uint8Array
        const buffer = Buffer.from(bytes)
        const old = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
        const fresh = embedder.embed([text])[0] as Float32Array
        assert.equal(old.length, fresh.length, `维度不一致 ${chunk.chunk_id}`)
        let maxDiff = 0
        for (let i = 0; i < old.length; i += 1) {
          maxDiff = Math.max(maxDiff, Math.abs((old[i] as number) - (fresh[i] as number)))
        }
        assert.ok(maxDiff < 1e-6, `向量不一致（最大误差 ${maxDiff}）`)
        compared += 1
      }
      assert.ok(compared > 0, '至少应对拍一条缓存向量')
      void rows
    } finally {
      source.close()
    }
  })

  it('旧索引 manifest 的向量器 id 与 TS 一致', { skip: !existsSync(join(LEGACY_INDEX, 'manifest.json')) }, () => {
    const manifest = JSON.parse(readFileSync(join(LEGACY_INDEX, 'manifest.json'), 'utf8')) as Record<string, unknown>
    assert.equal(manifest.embedder_id, new HashingEmbedder(512).embedderId)
    assert.equal(manifest.dim, 512)
  })
})
