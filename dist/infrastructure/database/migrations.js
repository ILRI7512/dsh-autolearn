import { AutolearnError, ERROR_CODES } from "../../core/errors.js";
import { utcnowIso } from "../../core/ids.js";
/** v3：活跃片段在同一项目内按内容指纹唯一，先收敛历史重复行（不删数据）。 */
function migrateV3(conn) {
    const now = utcnowIso();
    const groups = conn
        .prepare(`SELECT project_id, content_hash, COUNT(*) AS n FROM chunks
       WHERE invalidated_at = '' AND content_hash <> ''
       GROUP BY project_id, content_hash HAVING n > 1`)
        .all();
    for (const group of groups) {
        const rows = conn
            .prepare(`SELECT chunk_id FROM chunks
         WHERE project_id = ? AND content_hash = ? AND invalidated_at = ''
         ORDER BY (verification_status = 'verified') DESC, version DESC, created_at ASC`)
            .all(group.project_id, group.content_hash);
        const keep = rows[0]?.chunk_id;
        if (!keep)
            continue;
        const update = conn.prepare(`UPDATE chunks SET invalidated_at=?, superseded_by=?, status='superseded', updated_at=?
       WHERE chunk_id=?`);
        for (const row of rows.slice(1))
            update.run(now, keep, now, row.chunk_id);
    }
}
export const MIGRATIONS = [
    { version: 1, statements: [] },
    {
        version: 2,
        statements: [
            'CREATE INDEX IF NOT EXISTS idx_chunks_content_proj ON chunks(project_id, content_hash)',
            'CREATE INDEX IF NOT EXISTS idx_sources_location ON sources(project_id, location)',
        ],
    },
    {
        version: 3,
        hook: migrateV3,
        statements: [
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_chunks_live_content
       ON chunks(project_id, content_hash)
       WHERE invalidated_at = '' AND content_hash <> ''`,
        ],
    },
    {
        version: 4,
        statements: [`ALTER TABLE documents ADD COLUMN stages TEXT NOT NULL DEFAULT '{}'`],
    },
    {
        version: 5,
        statements: [
            `ALTER TABLE chunks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
            `ALTER TABLE chunks ADD COLUMN source_version TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN source_excerpt TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN core_principle TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN application TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN implementation TEXT NOT NULL DEFAULT ''`,
            `ALTER TABLE chunks ADD COLUMN anti_patterns TEXT NOT NULL DEFAULT ''`,
        ],
    },
    {
        version: 6,
        statements: [
            `CREATE TABLE IF NOT EXISTS embedding_cache (
         cache_key TEXT PRIMARY KEY,
         embedder_id TEXT NOT NULL,
         dim INTEGER NOT NULL,
         vector BLOB NOT NULL,
         created_at TEXT NOT NULL)`,
            'CREATE INDEX IF NOT EXISTS idx_embedding_cache_embedder ON embedding_cache(embedder_id)',
        ],
    },
    {
        version: 7,
        statements: [
            'ALTER TABLE chunks ADD COLUMN quality_score REAL NOT NULL DEFAULT 0',
            `ALTER TABLE chunks ADD COLUMN quality_components TEXT NOT NULL DEFAULT '{}'`,
        ],
    },
];
/** 旧库重跑迁移时「列/索引已存在」必须视为成功，其余错误照常抛出。 */
export function isIdempotentMigrationError(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('already exists') || message.includes('duplicate column name');
}
export function migrationError(version, cause) {
    return new AutolearnError(`数据库迁移到 v${version} 失败：${cause instanceof Error ? cause.message : String(cause)}`, {
        code: ERROR_CODES.STORAGE_ERROR,
        cause,
        details: { version },
    });
}
