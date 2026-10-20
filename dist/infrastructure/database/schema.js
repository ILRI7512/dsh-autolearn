/**
 * SQLite 表结构：与 v1.2（Python）数据库**逐列兼容**。
 *
 * 兼容性策略：
 * - DDL 原文照搬，新增字段只允许通过 migrations 追加；
 * - COLUMNS 从 DDL 解析生成（单一真相），避免两处定义漂移；
 * - JSON 列、BOOL 列、主键显式声明，编码/解码规则与旧版一致。
 */
export const SCHEMA_VERSION = 7;
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    project_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    goal              TEXT NOT NULL,
    domain            TEXT NOT NULL DEFAULT 'general_knowledge',
    partitions        TEXT NOT NULL DEFAULT '[]',
    depth             TEXT NOT NULL DEFAULT 'working',
    mode              TEXT NOT NULL DEFAULT 'assisted',
    status            TEXT NOT NULL DEFAULT 'active',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    deliverables      TEXT NOT NULL DEFAULT '[]',
    allowed_sources   TEXT NOT NULL DEFAULT '[]',
    budget            TEXT NOT NULL DEFAULT '{}',
    scope             TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id         TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    objective       TEXT NOT NULL DEFAULT '',
    inputs          TEXT NOT NULL DEFAULT '{}',
    steps           TEXT NOT NULL DEFAULT '[]',
    depends_on      TEXT NOT NULL DEFAULT '[]',
    expected_output TEXT NOT NULL DEFAULT '',
    acceptance      TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'pending',
    priority        REAL NOT NULL DEFAULT 0.5,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    timeout_s       INTEGER NOT NULL DEFAULT 300,
    error           TEXT NOT NULL DEFAULT '',
    result          TEXT NOT NULL DEFAULT '{}',
    iteration       INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL DEFAULT '',
    started_at      TEXT NOT NULL DEFAULT '',
    finished_at     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem
    ON tasks(project_id, idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    iteration   INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'running',
    summary     TEXT NOT NULL DEFAULT '{}',
    stop_reason TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at);

CREATE TABLE IF NOT EXISTS sources (
    source_id      TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    source_type    TEXT NOT NULL DEFAULT 'unknown',
    location       TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL DEFAULT '',
    publisher      TEXT NOT NULL DEFAULT '',
    published_at   TEXT NOT NULL DEFAULT '',
    accessed_at    TEXT NOT NULL,
    license_status TEXT NOT NULL DEFAULT 'unknown',
    quality        REAL NOT NULL DEFAULT 0.5,
    quality_basis  TEXT NOT NULL DEFAULT '',
    freshness_status TEXT NOT NULL DEFAULT 'unknown',
    content_hash   TEXT NOT NULL DEFAULT '',
    fetch_ok       INTEGER NOT NULL DEFAULT 0,
    error          TEXT NOT NULL DEFAULT '',
    metadata       TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(content_hash);

CREATE TABLE IF NOT EXISTS documents (
    document_id  TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    source_id    TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    doc_type     TEXT NOT NULL DEFAULT 'text',
    language     TEXT NOT NULL DEFAULT 'unknown',
    content_path TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    char_count   INTEGER NOT NULL DEFAULT 0,
    parser       TEXT NOT NULL DEFAULT '',
    parse_status TEXT NOT NULL DEFAULT 'parsed',
    error        TEXT NOT NULL DEFAULT '',
    stages       TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

CREATE TABLE IF NOT EXISTS chunks (
    chunk_id              TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    document_id           TEXT NOT NULL DEFAULT '',
    partition             TEXT NOT NULL DEFAULT 'pending_knowledge',
    domain                TEXT NOT NULL DEFAULT 'general',
    topic                 TEXT NOT NULL DEFAULT '',
    subtopic              TEXT NOT NULL DEFAULT '',
    title                 TEXT NOT NULL DEFAULT '',
    content               TEXT NOT NULL DEFAULT '',
    summary               TEXT NOT NULL DEFAULT '',
    knowledge_type        TEXT NOT NULL DEFAULT 'fact',
    status                TEXT NOT NULL DEFAULT 'pending_verification',
    level                 TEXT NOT NULL DEFAULT 'L2',
    source_id             TEXT NOT NULL DEFAULT '',
    source_url            TEXT NOT NULL DEFAULT '',
    source_title          TEXT NOT NULL DEFAULT '',
    source_type           TEXT NOT NULL DEFAULT 'unknown',
    author_or_publisher   TEXT NOT NULL DEFAULT '',
    published_at          TEXT NOT NULL DEFAULT '',
    accessed_at           TEXT NOT NULL DEFAULT '',
    language              TEXT NOT NULL DEFAULT 'unknown',
    content_hash          TEXT NOT NULL DEFAULT '',
    version               INTEGER NOT NULL DEFAULT 1,
    source_quality        REAL NOT NULL DEFAULT 0.5,
    evidence_count        INTEGER NOT NULL DEFAULT 0,
    evidence_independence INTEGER NOT NULL DEFAULT 0,
    confidence            REAL NOT NULL DEFAULT 0.3,
    confidence_basis      TEXT NOT NULL DEFAULT '',
    verification_status   TEXT NOT NULL DEFAULT 'unverified',
    verification_method   TEXT NOT NULL DEFAULT 'none',
    verification_evidence TEXT NOT NULL DEFAULT '[]',
    freshness_status      TEXT NOT NULL DEFAULT 'unknown',
    conflict_status       TEXT NOT NULL DEFAULT 'none',
    limitations           TEXT NOT NULL DEFAULT '',
    tags                  TEXT NOT NULL DEFAULT '[]',
    source_version        TEXT NOT NULL DEFAULT '',
    source_excerpt        TEXT NOT NULL DEFAULT '',
    core_principle        TEXT NOT NULL DEFAULT '',
    reasoning             TEXT NOT NULL DEFAULT '',
    application           TEXT NOT NULL DEFAULT '',
    implementation        TEXT NOT NULL DEFAULT '',
    anti_patterns         TEXT NOT NULL DEFAULT '',
    quality_score         REAL NOT NULL DEFAULT 0,
    quality_components    TEXT NOT NULL DEFAULT '{}',
    license_status        TEXT NOT NULL DEFAULT 'unknown',
    visibility            TEXT NOT NULL DEFAULT 'project',
    metadata              TEXT NOT NULL DEFAULT '{}',
    invalidated_at        TEXT NOT NULL DEFAULT '',
    superseded_by         TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_chunks_partition ON chunks(partition);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_content_proj ON chunks(project_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_sources_location ON sources(project_id, location);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain, topic);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status, verification_status);

CREATE TABLE IF NOT EXISTS embedding_cache (
    cache_key   TEXT PRIMARY KEY,
    embedder_id TEXT NOT NULL,
    dim         INTEGER NOT NULL,
    vector      BLOB NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embedding_cache_embedder ON embedding_cache(embedder_id);

CREATE TABLE IF NOT EXISTS chunk_versions (
    id            TEXT PRIMARY KEY,
    chunk_id      TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    content_hash  TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT '',
    change_reason TEXT NOT NULL DEFAULT '',
    changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_chunk ON chunk_versions(chunk_id, version);

CREATE TABLE IF NOT EXISTS verification_records (
    record_id  TEXT PRIMARY KEY,
    chunk_id   TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    method     TEXT NOT NULL,
    result     TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '[]',
    notes      TEXT NOT NULL DEFAULT '',
    verifier   TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_chunk ON verification_records(chunk_id);

CREATE TABLE IF NOT EXISTS conflicts (
    conflict_id TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    chunk_a     TEXT NOT NULL,
    chunk_b     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'contradiction',
    detail      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    evidence    TEXT NOT NULL DEFAULT '[]',
    resolution  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conflicts_project ON conflicts(project_id, status);

CREATE TABLE IF NOT EXISTS duplicates (
    dup_id      TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    chunk_a     TEXT NOT NULL,
    chunk_b     TEXT NOT NULL,
    similarity  REAL NOT NULL DEFAULT 0.0,
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    edge_id    TEXT PRIMARY KEY,
    src_id     TEXT NOT NULL,
    dst_id     TEXT NOT NULL,
    relation   TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0,
    metadata   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, relation);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, relation);

CREATE TABLE IF NOT EXISTS gaps (
    gap_id     TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    topic      TEXT NOT NULL,
    subtopic   TEXT NOT NULL DEFAULT '',
    level      TEXT NOT NULL DEFAULT 'L0',
    reason     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open',
    priority   REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gaps_project ON gaps(project_id, status);

CREATE TABLE IF NOT EXISTS practice_tasks (
    practice_id  TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    chunk_id     TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL DEFAULT 'formula',
    title        TEXT NOT NULL DEFAULT '',
    spec         TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'created',
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practice_results (
    result_id    TEXT PRIMARY KEY,
    practice_id  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'created',
    input_data   TEXT NOT NULL DEFAULT '{}',
    environment  TEXT NOT NULL DEFAULT '{}',
    output       TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',
    exit_code    INTEGER,
    conclusion   TEXT NOT NULL DEFAULT '',
    artifact_dir TEXT NOT NULL DEFAULT '',
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_results ON practice_results(practice_id);

CREATE TABLE IF NOT EXISTS experiments (
    experiment_id TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    task_id       TEXT NOT NULL DEFAULT '',
    spec          TEXT NOT NULL DEFAULT '{}',
    result        TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'created',
    artifact_dir  TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL DEFAULT '',
    run_id     TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      REAL NOT NULL DEFAULT 0.0,
    metadata   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id, kind);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    actor      TEXT NOT NULL DEFAULT 'agent',
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    risk       TEXT NOT NULL DEFAULT 'read',
    allowed    INTEGER NOT NULL DEFAULT 1,
    project_id TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS llm_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    project_id        TEXT NOT NULL DEFAULT '',
    stage             TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_estimate     REAL NOT NULL DEFAULT 0.0,
    ok                INTEGER NOT NULL DEFAULT 1,
    error             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schedules (
    schedule_id   TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'interval',
    expression    TEXT NOT NULL DEFAULT '',
    next_run_at   TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmations (
    token      TEXT PRIMARY KEY,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_confirmations_status ON confirmations(status, expires_at);

CREATE TABLE IF NOT EXISTS tokens (
    chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    token    TEXT NOT NULL,
    tf       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (chunk_id, token)
);
CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);

CREATE TABLE IF NOT EXISTS chunk_lex (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    length   INTEGER NOT NULL DEFAULT 0
);
`;
/** 从 DDL 解析列名：唯一真相，防止手写列表与建表语句漂移。 */
export function parseColumns(sql = SCHEMA_SQL) {
    const out = {};
    const tableRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
    for (const match of sql.matchAll(tableRe)) {
        const table = match[1];
        const body = match[2];
        if (!table || body === undefined)
            continue;
        const columns = [];
        for (const rawLine of body.split('\n')) {
            const line = rawLine.trim();
            if (!line)
                continue;
            if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line))
                continue;
            const name = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);
            if (name?.[1])
                columns.push(name[1]);
        }
        out[table] = columns;
    }
    return out;
}
export const COLUMNS = parseColumns();
export const PRIMARY_KEYS = {
    meta: 'key',
    projects: 'project_id',
    tasks: 'task_id',
    runs: 'run_id',
    sources: 'source_id',
    documents: 'document_id',
    chunks: 'chunk_id',
    embedding_cache: 'cache_key',
    chunk_versions: 'id',
    verification_records: 'record_id',
    conflicts: 'conflict_id',
    duplicates: 'dup_id',
    edges: 'edge_id',
    gaps: 'gap_id',
    practice_tasks: 'practice_id',
    practice_results: 'result_id',
    experiments: 'experiment_id',
    metrics: 'id',
    audit_log: 'id',
    llm_calls: 'id',
    schedules: 'schedule_id',
    confirmations: 'token',
};
export const JSON_COLUMNS = {
    projects: ['partitions', 'acceptance_criteria', 'deliverables', 'allowed_sources', 'budget', 'scope'],
    tasks: ['inputs', 'steps', 'depends_on', 'acceptance', 'result'],
    runs: ['summary'],
    sources: ['metadata'],
    documents: ['stages'],
    chunks: ['verification_evidence', 'metadata', 'tags', 'quality_components'],
    verification_records: ['evidence'],
    conflicts: ['evidence'],
    edges: ['metadata'],
    practice_tasks: ['spec'],
    practice_results: ['input_data', 'environment'],
    experiments: ['spec', 'result'],
    metrics: ['metadata'],
    audit_log: ['detail'],
};
export const BOOL_COLUMNS = [
    ['sources', 'fetch_ok'],
    ['audit_log', 'allowed'],
    ['llm_calls', 'ok'],
    ['schedules', 'enabled'],
];
/** 统计用表清单（与旧版 stats() 一致，13 张）。 */
export const STAT_TABLES = [
    'projects', 'tasks', 'runs', 'sources', 'documents', 'chunks',
    'conflicts', 'duplicates', 'gaps', 'practice_tasks', 'verification_records',
    'audit_log', 'metrics',
];
