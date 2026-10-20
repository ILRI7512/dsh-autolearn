/**
 * 向量索引：ids.json + vectors.npy + manifest.json（与 v1.2 文件格式一致）。
 *
 * 设计要点（审计结论落地）：
 * - embedding_cache 是向量化结果的持久缓存（同内容同向量器只算一次）；
 * - 索引只保存「chunk_id → 行号」，矩阵是 L2 归一化 float32，点积即余弦；
 * - 写索引用 tmp + rename，避免半截文件；manifest 记录 embedder_id 与维度，
 *   换向量器必须显式 rebuild，绝不静默混用不同语义空间；
 * - 旧的 .npy 直接可读（writeNpy/readNpy），旧实现可以继续使用新写出的索引。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StorageError } from '../../core/errors.ts'
import { utcnowIso } from '../../core/ids.ts'
import type { Database } from '../database/database.ts'
import type { Embedder } from '../embeddings/hashing-embedder.ts'
import { normalizeInPlace } from '../embeddings/hashing-embedder.ts'
import { readNpy, writeNpy } from '../embeddings/npy.ts'

const IDS_FILE = 'ids.json'
const VECTORS_FILE = 'vectors.npy'
const MANIFEST_FILE = 'manifest.json'
const LOCK_FILE = '.index.lock'
const INDEX_VERSION = 1

export interface VectorIndexManifest {
  index_version: number
  embedder_id: string
  dim: number
  count: number
  updated_at: string
  backend: string
}

export interface VectorHit {
  chunkId: string
  score: number
}

interface ChunkLike {
  chunk_id: string
  title?: string
  summary?: string
  content?: string
}

/** 索引文本：标题重复两次以提高权重（与旧版一致）。 */
export function indexText(chunk: ChunkLike): string {
  const title = chunk.title ?? ''
  return `${title}\n${title}\n${chunk.summary ?? ''}\n${chunk.content ?? ''}`
}

function cacheKey(embedderId: string, text: string): string {
  return createHash('sha256').update(`${embedderId}|${text}`, 'utf8').digest('hex')
}

export interface VectorIndexOptions {
  indexDir: string
  embedder: Embedder
  /** 关闭缓存用于测试/排障（默认 true）。 */
  cache?: boolean
  maxCacheEntries?: number
}

export class VectorIndex {
  private readonly indexDir: string
  private readonly embedder: Embedder
  private readonly useCache: boolean
  private readonly maxCacheEntries: number
  private ids: string[] = []
  private pos = new Map<string, number>()
  private matrix: Float32Array = new Float32Array(0)
  private dim: number
  private lastError = ''
  private loadedMtimeMs = 0

  constructor(options: VectorIndexOptions) {
    this.indexDir = options.indexDir
    this.embedder = options.embedder
    this.useCache = options.cache ?? true
    this.maxCacheEntries = options.maxCacheEntries ?? 20000
    this.dim = options.embedder.dim
    mkdirSync(this.indexDir, { recursive: true })
  }

  get size(): number { return this.ids.length }
  get dimension(): number { return this.dim }
  get error(): string { return this.lastError }
  get embedderId(): string { return this.embedder.embedderId }

  private manifestPath(): string { return join(this.indexDir, MANIFEST_FILE) }

  private lock<T>(fn: () => T): T {
    const lockPath = join(this.indexDir, LOCK_FILE)
    let fd: number | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = openSync(lockPath, 'wx')
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 60_000) {
            rmSync(lockPath)
            continue
          }
        } catch {
          /* 锁刚释放 */
        }
        throw new StorageError('向量索引被其它进程占用（.index.lock）；请稍后重试')
      }
    }
    try {
      return fn()
    } finally {
      if (fd !== null) {
        closeSync(fd)
        try { rmSync(lockPath) } catch { /* 已删除 */ }
      }
    }
  }

  /** 磁盘上 manifest 比内存新时重新加载（跨进程一致性）。 */
  syncFromDisk(): void {
    const manifest = this.manifestPath()
    if (!existsSync(manifest)) return
    try {
      const mtime = statSync(manifest).mtimeMs
      if (mtime > this.loadedMtimeMs) this.load()
    } catch {
      /* 读取失败保持当前索引，并在 search 里带 warning */
    }
  }

  load(): void {
    const manifestPath = this.manifestPath()
    if (!existsSync(manifestPath)) {
      this.ids = []
      this.pos = new Map()
      this.matrix = new Float32Array(0)
      return
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as VectorIndexManifest
      if (manifest.embedder_id !== this.embedder.embedderId) {
        this.lastError = `索引向量器 ${manifest.embedder_id} 与当前 ${this.embedder.embedderId} 不一致，需要 rebuild_vector_index`
        this.ids = []
        this.pos = new Map()
        this.matrix = new Float32Array(0)
        this.loadedMtimeMs = statSync(manifestPath).mtimeMs
        return
      }
      const idsPath = join(this.indexDir, IDS_FILE)
      const vectorsPath = join(this.indexDir, VECTORS_FILE)
      if (!existsSync(idsPath) || !existsSync(vectorsPath)) {
        this.lastError = '索引清单存在但 ids.json/vectors.npy 缺失，需要 rebuild_vector_index'
        return
      }
      const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as string[]
      const npy = readNpy(readFileSync(vectorsPath))
      if (!Array.isArray(ids) || ids.length !== npy.rows) {
        throw new Error(`ids 数量 ${Array.isArray(ids) ? ids.length : 'n/a'} 与矩阵行数 ${npy.rows} 不一致`)
      }
      this.ids = ids
      this.pos = new Map(ids.map((id, index) => [id, index]))
      this.dim = npy.cols || this.embedder.dim
      this.matrix = npy.data
      this.loadedMtimeMs = statSync(manifestPath).mtimeMs
      this.lastError = ''
    } catch (error) {
      this.lastError = `向量索引加载失败: ${error instanceof Error ? error.message : String(error)}`
      this.ids = []
      this.pos = new Map()
      this.matrix = new Float32Array(0)
    }
  }

  private save(): void {
    this.lock(() => {
      const idsTmp = join(this.indexDir, `${IDS_FILE}.tmp`)
      const vectorsTmp = join(this.indexDir, `${VECTORS_FILE}.tmp`)
      const manifestTmp = join(this.indexDir, `${MANIFEST_FILE}.tmp`)
      writeFileSync(idsTmp, JSON.stringify(this.ids), 'utf8')
      writeFileSync(vectorsTmp, writeNpy({ rows: this.ids.length, cols: this.dim, data: this.matrix }))
      const manifest: VectorIndexManifest = {
        index_version: INDEX_VERSION,
        embedder_id: this.embedder.embedderId,
        dim: this.dim,
        count: this.ids.length,
        updated_at: utcnowIso(),
        backend: 'local_float32',
      }
      writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      renameSync(idsTmp, join(this.indexDir, IDS_FILE))
      renameSync(vectorsTmp, join(this.indexDir, VECTORS_FILE))
      renameSync(manifestTmp, this.manifestPath())
      this.loadedMtimeMs = statSync(this.manifestPath()).mtimeMs
    })
  }

  private ensureCapacity(rows: number): void {
    const current = this.matrix.length / (this.dim || 1)
    if (this.matrix.length === 0 && this.dim > 0) {
      this.matrix = new Float32Array(rows * this.dim)
      return
    }
    if (rows <= current) return
    const next = new Float32Array(rows * this.dim)
    next.set(this.matrix)
    this.matrix = next
  }

  /** 批量向量化（带 embedding_cache），返回按输入顺序的矩阵行。 */
  embedTexts(db: Database | null, texts: readonly string[]): Float32Array[] {
    const embedderId = this.embedder.embedderId
    const keys = texts.map((text) => cacheKey(embedderId, text))
    const cached = new Map<string, Uint8Array>()
    if (this.useCache && db) {
      for (const batch of chunkArray(keys, 400)) {
        const placeholders = batch.map(() => '?').join(',')
        const rows = db.query(
          `SELECT cache_key, vector FROM embedding_cache WHERE embedder_id=? AND cache_key IN (${placeholders})`,
          [embedderId, ...batch],
        ) as Array<{ cache_key: string; vector: Uint8Array }>
        for (const row of rows) cached.set(row.cache_key, row.vector)
      }
    }

    const output: Float32Array[] = []
    const missing: number[] = []
    for (let i = 0; i < texts.length; i += 1) {
      const key = keys[i] as string
      const blob = cached.get(key)
      if (!blob) {
        output.push(new Float32Array(0))
        missing.push(i)
        continue
      }
      const copy = Buffer.from(blob)
      const vector = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
      output.push(vector)
    }
    if (missing.length > 0) {
      const fresh = this.embedder.embed(missing.map((index) => texts[index] as string))
      const now = utcnowIso()
      const rows: Array<{ key: string; vector: Float32Array }> = []
      missing.forEach((index, offset) => {
        const vector = fresh[offset] as Float32Array
        output[index] = vector
        rows.push({ key: keys[index] as string, vector })
      })
      if (this.useCache && db) {
        db.transaction(() => {
          const statement = db.connection.prepare(
            'INSERT OR REPLACE INTO embedding_cache(cache_key, embedder_id, dim, vector, created_at) VALUES (?,?,?,?,?)',
          )
          for (const row of rows) {
            statement.run(row.key, embedderId, row.vector.length, Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), now)
          }
        })
        if (this.maxCacheEntries > 0) {
          const total = db.count('embedding_cache', 'embedder_id=?', [embedderId])
          if (total > this.maxCacheEntries) {
            db.executeWrite(
              `DELETE FROM embedding_cache WHERE embedder_id=? AND cache_key IN (
                 SELECT cache_key FROM embedding_cache WHERE embedder_id=? ORDER BY created_at ASC, cache_key ASC LIMIT ?
               )`,
              [embedderId, embedderId, total - this.maxCacheEntries],
            )
          }
        }
      }
    }
    for (const vector of output) normalizeInPlace(vector)
    return output
  }

  upsertChunks(db: Database | null, chunks: readonly ChunkLike[]): number {
    if (chunks.length === 0) return 0
    const vectors = this.embedTexts(db, chunks.map(indexText))
    this.syncFromDisk()
    let added = 0
    let updated = 0
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] as ChunkLike
      const vector = vectors[i] as Float32Array
      const existing = this.pos.get(chunk.chunk_id)
      if (existing !== undefined) {
        this.matrix.set(vector, existing * this.dim)
        updated += 1
        continue
      }
      this.ensureCapacity(this.ids.length + 1)
      this.matrix.set(vector, this.ids.length * this.dim)
      this.pos.set(chunk.chunk_id, this.ids.length)
      this.ids.push(chunk.chunk_id)
      added += 1
    }
    this.save()
    return added + updated
  }

  remove(chunkIds: readonly string[]): number {
    const remove = new Set(chunkIds)
    if (remove.size === 0) return 0
    const keepIds: string[] = []
    const keepRows: Float32Array[] = []
    let removed = 0
    for (let i = 0; i < this.ids.length; i += 1) {
      const id = this.ids[i] as string
      if (remove.has(id)) {
        removed += 1
        continue
      }
      keepIds.push(id)
      keepRows.push(this.matrix.subarray(i * this.dim, (i + 1) * this.dim))
    }
    if (removed === 0) return 0
    const next = new Float32Array(keepIds.length * this.dim)
    keepRows.forEach((row, index) => next.set(row, index * this.dim))
    this.ids = keepIds
    this.pos = new Map(keepIds.map((id, index) => [id, index]))
    this.matrix = next
    this.save()
    return removed
  }

  /** 只搜索允许集合内的片段（数据隔离由 allowedIds 保证）。 */
  search(query: string, allowedIds: readonly string[] | null, topK: number): VectorHit[] {
    if (this.ids.length === 0) return []
    this.syncFromDisk()
    if (this.lastError) return []
    const queryVector = this.embedTexts(null, [query])[0] as Float32Array
    if (queryVector.length !== this.dim) {
      this.lastError = `查询向量维度 ${queryVector.length} 与索引维度 ${this.dim} 不一致`
      return []
    }
    const allowed = allowedIds === null ? null : new Set(allowedIds)
    const hits: VectorHit[] = []
    for (let i = 0; i < this.ids.length; i += 1) {
      const id = this.ids[i] as string
      if (allowed && !allowed.has(id)) continue
      let dot = 0
      const offset = i * this.dim
      for (let j = 0; j < this.dim; j += 1) dot += (this.matrix[offset + j] as number) * (queryVector[j] as number)
      if (dot > 0) hits.push({ chunkId: id, score: dot })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  /**
   * 批量余弦相似对（阈值过滤、最多 maxPairs）。
   *
   * 旧实现（store.findDuplicates）对每个 chunk 都做一次“embedding 全库查询”，
   * 800 条时约 4.2s（实测）；这里直接复用内存矩阵做块内点积，
   * 避免 N 次向量化和 N 次 statSync。onlyIds 用于“只找与这些 id 相关的对”。
   */
  similarPairs(
    allowedIds: readonly string[],
    threshold: number,
    maxPairs = 200,
    onlyIds?: readonly string[],
  ): Array<{ a: string; b: string; score: number }> {
    this.syncFromDisk()
    if (this.lastError || this.ids.length === 0) return []
    const allowedRows: number[] = []
    for (const id of allowedIds) {
      const row = this.pos.get(id)
      if (row !== undefined) allowedRows.push(row)
    }
    if (allowedRows.length < (onlyIds && onlyIds.length > 0 ? 1 : 2)) return []
    const onlyRows = onlyIds
      ? onlyIds.map((id) => this.pos.get(id)).filter((row): row is number => row !== undefined)
      : null
    const dim = this.dim
    const matrix = this.matrix
    const ids = this.ids
    const pairs: Array<{ a: string; b: string; score: number }> = []
    const limit = Math.max(1, maxPairs)

    const pushIfSimilar = (i: number, j: number): boolean => {
      let dot = 0
      const oi = i * dim
      const oj = j * dim
      for (let k = 0; k < dim; k += 1) dot += (matrix[oi + k] as number) * (matrix[oj + k] as number)
      if (dot < threshold || dot <= 0) return false
      pairs.push({ a: ids[i] as string, b: ids[j] as string, score: dot })
      return pairs.length >= limit
    }

    if (onlyRows && onlyRows.length > 0) {
      for (const i of onlyRows) {
        for (const j of allowedRows) {
          if (i === j) continue
          if (pushIfSimilar(i, j)) {
            pairs.sort((a, b) => b.score - a.score)
            return pairs.slice(0, limit)
          }
        }
      }
    } else {
      for (let x = 0; x < allowedRows.length; x += 1) {
        const i = allowedRows[x] as number
        for (let y = x + 1; y < allowedRows.length; y += 1) {
          const j = allowedRows[y] as number
          if (pushIfSimilar(i, j)) {
            pairs.sort((a, b) => b.score - a.score)
            return pairs.slice(0, limit)
          }
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score)
    return pairs.slice(0, limit)
  }

  /** 按元数据重建（换向量器/索引损坏）。 */
  rebuild(db: Database, batchSize = 64): { indexed: number; embedder: string; dim: number } {
    const ids = (db.query('SELECT chunk_id FROM chunks') as Array<{ chunk_id: string }>).map((row) => row.chunk_id)
    const rows: Float32Array[] = []
    const kept: string[] = []
    for (const batch of chunkArray(ids, batchSize)) {
      const placeholders = batch.map(() => '?').join(',')
      const chunks = db.query(
        `SELECT chunk_id, title, summary, content FROM chunks WHERE chunk_id IN (${placeholders})`,
        batch,
      ) as unknown as ChunkLike[]
      if (chunks.length === 0) continue
      const vectors = this.embedTexts(db, chunks.map(indexText))
      for (let i = 0; i < chunks.length; i += 1) {
        kept.push((chunks[i] as ChunkLike).chunk_id)
        rows.push(vectors[i] as Float32Array)
      }
    }
    const dim = this.embedder.dim
    const matrix = new Float32Array(kept.length * dim)
    rows.forEach((row, index) => {
      if (row.length !== dim) throw new StorageError(`向量维度 ${row.length} 与 embedder 维度 ${dim} 不一致`)
      matrix.set(row, index * dim)
    })
    this.ids = kept
    this.pos = new Map(kept.map((id, index) => [id, index]))
    this.matrix = matrix
    this.dim = dim
    this.lastError = ''
    this.save()
    return { indexed: kept.length, embedder: this.embedder.embedderId, dim }
  }

  stats(): Record<string, unknown> {
    return { count: this.ids.length, dim: this.dim, embedder: this.embedder.embedderId, backend: 'local_float32' }
  }

  /** 索引与元数据一致性检查（旧版 check_integrity 的等价实现）。 */
  checkIntegrity(db: Database): Record<string, unknown> {
    this.syncFromDisk()
    const dbIds = new Set((db.query('SELECT chunk_id FROM chunks') as Array<{ chunk_id: string }>).map((r) => r.chunk_id))
    const indexIds = new Set(this.ids)
    const problems: string[] = []
    const warnings: string[] = []
    if (this.ids.length !== this.pos.size) problems.push('ids 与位置映射数量不一致')
    if (this.matrix.length !== this.ids.length * this.dim) problems.push('矩阵元素数与 ids×dim 不一致')
    for (let i = 0; i < this.matrix.length; i += 1) {
      if (!Number.isFinite(this.matrix[i] as number)) {
        problems.push('矩阵包含 NaN/Inf')
        break
      }
    }
    for (let i = 0; i < this.ids.length; i += 1) {
      let norm = 0
      for (let j = 0; j < this.dim; j += 1) {
        const value = this.matrix[i * this.dim + j] as number
        norm += value * value
      }
      if (norm < 1e-12) {
        warnings.push(`零向量: ${this.ids[i]}`)
        break
      }
    }
    const orphans: string[] = []
    for (const id of indexIds) if (!dbIds.has(id)) orphans.push(id)
    const missing: string[] = []
    for (const id of dbIds) if (!indexIds.has(id)) missing.push(id)
    if (orphans.length > 0) problems.push(`索引中存在 ${orphans.length} 个数据库已删除的孤儿向量`)
    if (missing.length > 0) problems.push(`${missing.length} 个片段缺少向量（需要 rebuild 或补索引）`)
    if (this.lastError) problems.push(this.lastError)
    return {
      ok: problems.length === 0,
      problems,
      warnings,
      chunks: dbIds.size,
      vectors: this.ids.length,
      dim: this.dim,
      embedder: this.embedder.embedderId,
      missing_vectors: missing.slice(0, 20),
      orphans: orphans.slice(0, 20),
    }
  }

  /** 复制索引文件到备份目录（旧版 backup 的一部分）。 */
  copyTo(destDir: string): string {
    mkdirSync(destDir, { recursive: true })
    for (const file of [MANIFEST_FILE, IDS_FILE, VECTORS_FILE]) {
      const source = join(this.indexDir, file)
      if (existsSync(source)) writeFileSync(join(destDir, file), readFileSync(source))
    }
    return destDir
  }

  /** 从备份目录恢复索引（作为整体目录替换）。 */
  restoreFromDir(sourceDir: string): void {
    for (const file of [MANIFEST_FILE, IDS_FILE, VECTORS_FILE]) {
      const source = join(sourceDir, file)
      if (existsSync(source)) writeFileSync(join(this.indexDir, file), readFileSync(source))
    }
    this.loadedMtimeMs = 0
    this.load()
  }
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
