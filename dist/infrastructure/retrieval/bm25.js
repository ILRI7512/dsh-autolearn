import { DEFAULT_BM25, expandQuery } from "./tokenizer.js";
export function bm25Search(db, query, allowedIds = null, topK = 20, params = DEFAULT_BM25) {
    const terms = expandQuery(query);
    if (terms.length === 0)
        return [];
    const conn = db.connection;
    const restricted = allowedIds !== null && allowedIds !== undefined;
    conn.exec('CREATE TEMP TABLE IF NOT EXISTS _allow (chunk_id TEXT PRIMARY KEY)');
    conn.exec('DELETE FROM _allow');
    if (restricted) {
        const insert = conn.prepare('INSERT OR IGNORE INTO _allow(chunk_id) VALUES (?)');
        db.transaction(() => {
            for (const id of allowedIds)
                insert.run(id);
        });
    }
    const joinTokens = restricted ? ' JOIN _allow a ON a.chunk_id=t.chunk_id' : '';
    const joinLex = restricted ? ' JOIN _allow a ON a.chunk_id=chunk_lex.chunk_id' : '';
    const placeholders = terms.map(() => '?').join(',');
    const tokenRows = db.query(`SELECT t.chunk_id AS chunk_id, t.token AS token, t.tf AS tf FROM tokens t${joinTokens} WHERE t.token IN (${placeholders})`, terms);
    if (tokenRows.length === 0)
        return [];
    const totalDocs = Number(db.scalar(`SELECT COUNT(*) FROM chunk_lex${joinLex}`, [], 0) ?? 0);
    if (totalDocs <= 0)
        return [];
    const avgRaw = db.scalar(`SELECT AVG(length) FROM chunk_lex${joinLex}`, [], null);
    const avgLength = Number(avgRaw ?? 0) || 1;
    const lengthRows = db.query(`SELECT chunk_id, length FROM chunk_lex${restricted ? ' JOIN _allow a USING(chunk_id)' : ''}`);
    const lengths = new Map();
    for (const row of lengthRows)
        lengths.set(row.chunk_id, Number(row.length));
    // 保持 SQL 返回顺序：同分时排序稳定（等价 Python dict 插入序）。
    const docOrder = [];
    const freqs = new Map();
    for (const row of tokenRows) {
        let doc = freqs.get(row.chunk_id);
        if (!doc) {
            doc = new Map();
            freqs.set(row.chunk_id, doc);
            docOrder.push(row.chunk_id);
        }
        doc.set(row.token, Number(row.tf));
    }
    const df = new Map();
    for (const term of terms) {
        let count = 0;
        for (const doc of freqs.values())
            if (doc.has(term))
                count += 1;
        df.set(term, count);
    }
    const scored = [];
    for (const chunkId of docOrder) {
        const doc = freqs.get(chunkId);
        const dl = lengths.get(chunkId) || sumValues(doc) || 1;
        let score = 0;
        for (const term of terms) {
            const tf = doc.get(term) ?? 0;
            if (!tf)
                continue;
            const n = df.get(term) ?? 0;
            const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
            const denom = tf + params.k1 * (1 - params.b + (params.b * dl) / avgLength);
            score += (idf * (tf * (params.k1 + 1))) / denom;
        }
        if (score > 0)
            scored.push({ chunkId, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}
function sumValues(map) {
    let sum = 0;
    for (const value of map.values())
        sum += value;
    return sum;
}
