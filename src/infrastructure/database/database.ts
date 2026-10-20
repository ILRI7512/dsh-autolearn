/**
 * SQLite 访问层（node:sqlite，Node 22.5+ 内置，零原生依赖）。
 *
 * 事务：单连接 + 自增深度，最外层 BEGIN IMMEDIATE / COMMIT / ROLLBACK。
 * 旧版 Python 的事务是 RLock 可重入但**没有保存点**；这里用深度计数实现
 * 「内层不提交、外层统一提交」，语义更严格且不会出现嵌套 BEGIN 报错。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StorageError } from '../../core/errors.ts'
import { utcnowIso } from '../../core/ids.ts'
import { parseJsonArray, parseJsonObject } from '../../core/json.ts'
import {
  BOOL_COLUMNS,
  COLUMNS,
  JSON_COLUMNS,
  PRIMARY_KEYS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  STAT_TABLES,
  type TableName,
} from './schema.ts'
import { MIGRATIONS, isIdempotentMigrationError, migrationError } from './migrations.ts'

export type Row = Record<string, unknown>

const BOOL_SET = new Set(BOOL_COLUMNS.map(([table, column]) => `${table}.${column}`))

/** JSON 列中语义为数组的列：坏 JSON/`null` 时退化为 []，其余退化为 {}。 */
const ARRAY_JSON_COLUMNS = new Set([
  'projects.partitions', 'projects.acceptance_criteria', 'projects.deliverables',
  'projects.allowed_sources', 'tasks.steps', 'tasks.depends_on', 'tasks.acceptance',
  'chunks.verification_evidence', 'chunks.tags', 'verification_records.evidence',
  'conflicts.evidence',
])

function columnsOf(table: string): readonly string[] {
  const columns = COLUMNS[table]
  if (!columns) throw new StorageError(`未知表: ${table}`)
  return columns
}

export class Database {
  readonly path: string
  private conn: DatabaseSync | null = null
  private depth = 0

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.connect()
  }

  static openMemory(): Database {
    // 必须走构造函数：字段初始化（depth/conn）不能被 Object.create 跳过。
    return new Database(':memory:')
  }

  private connect(): void {
    if (this.conn) return
    this.conn = new DatabaseSync(this.path)
    this.applyPragmas()
  }

  private applyPragmas(): void {
    const conn = this.requireConn()
    conn.exec('PRAGMA journal_mode=WAL')
    conn.exec('PRAGMA foreign_keys=ON')
    conn.exec('PRAGMA synchronous=NORMAL')
    // Python 用 connect(timeout=30) 达到同样效果；node:sqlite 没有该参数。
    conn.exec('PRAGMA busy_timeout=30000')
  }

  private requireConn(): DatabaseSync {
    if (!this.conn) throw new StorageError('数据库连接已关闭')
    return this.conn
  }

  get connection(): DatabaseSync {
    return this.requireConn()
  }

  close(): void {
    if (!this.conn) return
    if (this.depth > 0) {
      try {
        this.conn.exec('ROLLBACK')
      } catch {
        /* 已回滚 */
      }
      this.depth = 0
    }
    this.conn.close()
    this.conn = null
  }

  /** 事务：最外层 BEGIN IMMEDIATE；内层复用外层事务（不提前提交）。 */
  transaction<T>(fn: () => T): T {
    const conn = this.requireConn()
    if (this.depth === 0) conn.exec('BEGIN IMMEDIATE')
    this.depth += 1
    try {
      const result = fn()
      this.depth -= 1
      if (this.depth === 0) conn.exec('COMMIT')
      return result
    } catch (error) {
      this.depth -= 1
      if (this.depth === 0) {
        try {
          conn.exec('ROLLBACK')
        } catch {
          /* 事务可能已由 SQLite 回滚 */
        }
      }
      throw error
    }
  }

  migrate(): { from: number; to: number } {
    return this.transaction(() => {
      const conn = this.requireConn()
      conn.exec(SCHEMA_SQL)
      const row = conn.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
        | { value: string }
        | undefined
      let found = 0
      if (row === undefined) {
        conn.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '0')`).run()
      } else {
        found = Number.parseInt(row.value, 10)
      }
      if (Number.isNaN(found)) throw new StorageError('meta.schema_version 不是合法整数')
      if (found > SCHEMA_VERSION) {
        throw new StorageError(`数据库 schema 版本 ${found} 高于代码支持的 ${SCHEMA_VERSION}，请升级插件`)
      }
      for (const migration of MIGRATIONS) {
        if (migration.version <= found) continue
        try {
          migration.hook?.(conn)
          for (const statement of migration.statements) {
            try {
              conn.exec(statement)
            } catch (error) {
              if (!isIdempotentMigrationError(error)) throw error
            }
          }
        } catch (error) {
          throw migrationError(migration.version, error)
        }
      }
      if (found < SCHEMA_VERSION) {
        conn.prepare(`UPDATE meta SET value=? WHERE key='schema_version'`).run(String(SCHEMA_VERSION))
      }
      return { from: found, to: SCHEMA_VERSION }
    })
  }

  // ------------------------------------------------------------------ //
  // 编码 / 解码
  // ------------------------------------------------------------------ //
  encode(table: string, row: Row): Row {
    const allowed = new Set(columnsOf(table))
    const jsonColumns = new Set(JSON_COLUMNS[table] ?? [])
    const out: Row = {}
    for (const [key, value] of Object.entries(row)) {
      if (!allowed.has(key)) throw new StorageError(`表 ${table} 不存在列 ${key}`)
      if (jsonColumns.has(key)) out[key] = JSON.stringify(value ?? null)
      else if (BOOL_SET.has(`${table}.${key}`)) out[key] = value ? 1 : 0
      else out[key] = value === undefined ? null : value
    }
    return out
  }

  decode(table: string, row: Row | undefined): Row | null {
    if (!row) return null
    const out: Row = { ...row }
    for (const column of JSON_COLUMNS[table] ?? []) {
      if (!(column in out)) continue
      const raw = out[column]
      if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) continue
      // 先按 JSON 解析，再按**解析后的类型**决定形状：
      // 之前的实现用 "文本里是否包含 {" 猜测对象/数组，导致
      // `[{...}]` 这类对象数组被错误解码成 {}（vNext 审计 D-01）。
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      const fallback = ARRAY_JSON_COLUMNS.has(`${table}.${column}`)
        ? parseJsonArray(text)
        : parseJsonObject(text)
      try {
        const parsed: unknown = JSON.parse(text)
        out[column] = parsed === null || parsed === undefined ? fallback : parsed
      } catch {
        // 损坏的 JSON 退化为与列语义一致的空容器，避免类型化读取崩溃。
        out[column] = fallback
      }
    }
    for (const [t, column] of BOOL_COLUMNS) {
      if (t !== table || !(column in out)) continue
      out[column] = Boolean(out[column])
    }
    return out
  }

  // ------------------------------------------------------------------ //
  // 通用 CRUD
  // ------------------------------------------------------------------ //
  insert(table: string, row: Row): Row {
    const encoded = this.encode(table, row)
    const keys = Object.keys(encoded)
    if (keys.length === 0) throw new StorageError(`表 ${table} 插入缺少字段`)
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
    this.transaction(() => this.requireConn().prepare(sql).run(...keys.map((key) => encoded[key] as never)))
    return row
  }

  upsert(table: string, row: Row, key?: string): Row {
    const primaryKey = key ?? PRIMARY_KEYS[table]
    if (!primaryKey) throw new StorageError(`表 ${table} 没有主键定义`)
    const encoded = this.encode(table, row)
    if (!encoded[primaryKey]) throw new StorageError(`表 ${table} upsert 缺少主键 ${primaryKey}`)
    const stamp = this.stamp(table, row)
    const encodedStamp = this.encode(table, stamp)
    const keys = Object.keys(encodedStamp)
    const updates = keys.filter((k) => k !== primaryKey).map((k) => `${k}=excluded.${k}`)
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(${primaryKey}) DO UPDATE SET ${updates.join(',')}`
    this.transaction(() => this.requireConn().prepare(sql).run(...keys.map((k) => encodedStamp[k] as never)))
    return stamp
  }

  update(table: string, idValue: string, fields: Row): number {
    const encoded = this.encode(table, fields)
    const keys = Object.keys(encoded)
    if (keys.length === 0) return 0
    const primaryKey = PRIMARY_KEYS[table]
    if (!primaryKey) throw new StorageError(`表 ${table} 没有主键定义`)
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${primaryKey}=?`
    let changes = 0
    this.transaction(() => {
      const result = this.requireConn()
        .prepare(sql)
        .run(...keys.map((k) => encoded[k] as never), idValue)
      changes = Number(result.changes)
    })
    return changes
  }

  get(table: string, idValue: string, key?: string): Row | null {
    const primaryKey = key ?? PRIMARY_KEYS[table]
    if (!primaryKey) throw new StorageError(`表 ${table} 没有主键定义`)
    const row = this.requireConn().prepare(`SELECT * FROM ${table} WHERE ${primaryKey}=?`).get(idValue) as Row | undefined
    return this.decode(table, row)
  }

  delete(table: string, idValue: string, key?: string): number {
    const primaryKey = key ?? PRIMARY_KEYS[table]
    if (!primaryKey) throw new StorageError(`表 ${table} 没有主键定义`)
    let changes = 0
    this.transaction(() => {
      const result = this.requireConn().prepare(`DELETE FROM ${table} WHERE ${primaryKey}=?`).run(idValue)
      changes = Number(result.changes)
    })
    return changes
  }

  /** 只读查询门禁：只允许 SELECT / WITH / PRAGMA / EXPLAIN 开头。 */
  query(sql: string, params: unknown[] = []): Row[] {
    const head = sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
    if (!['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN'].some((prefix) => head.startsWith(prefix))) {
      throw new StorageError('只读查询接口拒绝非查询语句（写操作请使用 transaction/executeWrite）')
    }
    return this.requireConn().prepare(sql).all(...(params as never[])) as Row[]
  }

  executeWrite(sql: string, params: unknown[] = []): number {
    let changes = 0
    this.transaction(() => {
      const result = this.requireConn().prepare(sql).run(...(params as never[]))
      changes = Number(result.changes)
    })
    return changes
  }

  scalar<T = unknown>(sql: string, params: unknown[] = [], fallback: T | null = null): T | null {
    const rows = this.query(sql, params)
    if (rows.length === 0) return fallback
    const first = rows[0]
    if (!first) return fallback
    const values = Object.values(first)
    return (values[0] as T) ?? fallback
  }

  count(table: string, where = '', params: unknown[] = []): number {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`
    return Number(this.scalar<number>(sql, params, 0) ?? 0)
  }

  private stamp(table: string, row: Row): Row {
    const columns = columnsOf(table)
    const out: Row = { ...row }
    const now = utcnowIso()
    if (columns.includes('created_at') && !out.created_at) out.created_at = now
    if (columns.includes('updated_at') && !out.updated_at) out.updated_at = now
    return out
  }

  /** created_at/updated_at 补齐（供领域层构造实体时使用）。 */
  stampRow(table: string, row: Row): Row {
    return this.stamp(table, row)
  }

  // ------------------------------------------------------------------ //
  // 运维
  // ------------------------------------------------------------------ //
  integrityCheck(): { ok: boolean; messages: string[] } {
    const rows = this.query('PRAGMA integrity_check') as Array<{ integrity_check: string }>
    const messages = rows.map((row) => String(row.integrity_check))
    return { ok: messages.length === 1 && messages[0] === 'ok', messages }
  }

  foreignKeyCheck(): Array<Record<string, unknown>> {
    return this.query('PRAGMA foreign_key_check')
  }

  /** 在线备份：VACUUM INTO（等价于旧版 conn.backup，且是单条原子语句）。 */
  backupTo(destPath: string): { path: string; bytes: number } {
    mkdirSync(dirname(destPath), { recursive: true })
    if (existsSync(destPath)) rmSync(destPath)
    const conn = this.requireConn()
    conn.prepare('VACUUM INTO ?').run(destPath)
    return { path: destPath, bytes: statSync(destPath).size }
  }

  /** 从备份文件恢复：先落 .pre-restore 安全副本，再替换并重开连接。 */
  restoreFrom(sourcePath: string): { safetyCopy: string; migrated: { from: number; to: number } } {
    if (!existsSync(sourcePath)) throw new StorageError(`备份数据库不存在: ${sourcePath}`)
    const safetyCopy = `${this.path}.pre-restore.sqlite3`
    if (this.path !== ':memory:') {
      this.backupTo(safetyCopy)
      this.close()
      copyFileSync(sourcePath, this.path)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${this.path}${suffix}`)) rmSync(`${this.path}${suffix}`)
      }
      this.connect()
    }
    const migrated = this.migrate()
    return { safetyCopy, migrated }
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const table of STAT_TABLES) out[table] = this.count(table)
    return out
  }

  schemaVersion(): number {
    return Number(this.scalar<number>(`SELECT value FROM meta WHERE key='schema_version'`, [], 0) ?? 0)
  }
}

export { SCHEMA_VERSION }
export type { TableName }
