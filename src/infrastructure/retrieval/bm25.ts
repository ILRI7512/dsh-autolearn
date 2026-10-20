/**
 * BM25 检索（SQL 取候选 + 内存打分，与 v1.2 完全同公式）。
 *
 * 注意 allowedIds 语义：`null/undefined` = 不限制；`[]` = 空允许集 → 返回空。
 */
import type { Database } from '../database/database.ts'
import { DEFAULT_BM25, expandQuery, type Bm25Params } from './tokenizer.ts'

export interface Bm25Hit {
  chunkId: string
  score: number
}

export function bm25Search(
  db: Database,
  query: string,
  allowedIds: readonly string[] | null | undefined = null,
  topK = 20,
  params: Bm25Params = DEFAULT_BM25,
): Bm25Hit[] {
  const terms = expandQuery(query)
  if (terms.length === 0) return []
  const conn = db.connection
  const restricted = allowedIds !== null && allowedIds !== undefined

  conn.exec('CREATE TEMP TABLE IF NOT EXISTS _allow (chunk_id TEXT PRIMARY KEY)')
  conn.exec('DELETE FROM _allow')
  if (restricted) {
    const insert = conn.prepare('INSERT OR IGNORE INTO _allow(chunk_id) VALUES (?)')
    db.transaction(() => {
      for (const id of allowedIds as readonly string[]) insert.run(id)
    })
  }

  const joinTokens = restricted ? ' JOIN _allow a ON a.chunk_id=t.chunk_id' : ''
  const joinLex = restricted ? ' JOIN _allow a ON a.chunk_id=chunk_lex.chunk_id' : ''
  const placeholders = terms.map(() => '?').join(',')

  const tokenRows = db.query(
    `SELECT t.chunk_id AS chunk_id, t.token AS token, t.tf AS tf FROM tokens t${joinTokens} WHERE t.token IN (${placeholders})`,
    terms,
  ) as Array<{ chunk_id: string; token: string; tf: number }>

  if (tokenRows.length === 0) return []

  const totalDocs = Number(
    db.scalar<number>(`SELECT COUNT(*) FROM chunk_lex${joinLex}`, [], 0) ?? 0,
  )
  if (totalDocs <= 0) return []
  const avgRaw = db.scalar<number | null>(`SELECT AVG(length) FROM chunk_lex${joinLex}`, [], null)
  const avgLength = Number(avgRaw ?? 0) || 1

  const lengthRows = db.query(
    `SELECT chunk_id, length FROM chunk_lex${restricted ? ' JOIN _allow a USING(chunk_id)' : ''}`,
  ) as Array<{ chunk_id: string; length: number }>
  const lengths = new Map<string, number>()
  for (const row of lengthRows) lengths.set(row.chunk_id, Number(row.length))

  // 保持 SQL 返回顺序：同分时排序稳定（等价 Python dict 插入序）。
  const docOrder: string[] = []
  const freqs = new Map<string, Map<string, number>>()
  for (const row of tokenRows) {
    let doc = freqs.get(row.chunk_id)
    if (!doc) {
      doc = new Map()
      freqs.set(row.chunk_id, doc)
      docOrder.push(row.chunk_id)
    }
    doc.set(row.token, Number(row.tf))
  }

  const df = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const doc of freqs.values()) if (doc.has(term)) count += 1
    df.set(term, count)
  }

  const scored: Bm25Hit[] = []
  for (const chunkId of docOrder) {
    const doc = freqs.get(chunkId) as Map<string, number>
    const dl = lengths.get(chunkId) || sumValues(doc) || 1
    let score = 0
    for (const term of terms) {
      const tf = doc.get(term) ?? 0
      if (!tf) continue
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5))
      const denom = tf + params.k1 * (1 - params.b + (params.b * dl) / avgLength)
      score += (idf * (tf * (params.k1 + 1))) / denom
    }
    if (score > 0) scored.push({ chunkId, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

function sumValues(map: Map<string, number>): number {
  let sum = 0
  for (const value of map.values()) sum += value
  return sum
}
