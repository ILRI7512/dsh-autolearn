/**
 * 审计日志：写入 SQLite（与旧版同表），并对敏感字段脱敏。
 * 所有 allow/deny 都记录，便于事后回答「谁在什么时候放行了什么」。
 */
import type { Database } from '../infrastructure/database/database.ts'
import { utcnowIso } from '../core/ids.ts'
import { redact } from './secrets.ts'
import type { RiskLevel } from '../core/types.ts'

export interface AuditEntry {
  action: string
  target?: string
  risk?: RiskLevel | string
  allowed?: boolean
  projectId?: string
  actor?: string
  detail?: Record<string, unknown>
}

export class AuditLogger {
  private readonly db: Database | null
  private readonly enabled: boolean
  private readonly sink: (line: string) => void

  constructor(db: Database | null, options: { enabled?: boolean; sink?: (line: string) => void } = {}) {
    this.db = db
    this.enabled = options.enabled ?? true
    this.sink = options.sink ?? (() => {})
  }

  log(entry: AuditEntry): void {
    if (!this.enabled) return
    const row = {
      ts: utcnowIso(),
      actor: entry.actor ?? 'agent',
      action: entry.action,
      target: (entry.target ?? '').slice(0, 500),
      risk: entry.risk ?? 'read',
      allowed: entry.allowed ?? true,
      project_id: entry.projectId ?? '',
      detail: JSON.stringify(redact(entry.detail ?? {})),
    }
    try {
      this.db?.insert('audit_log', row)
    } catch (error) {
      // 审计写入失败不能掩盖业务结果，但必须让运维看见。
      this.sink(`[audit] 写入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.sink(JSON.stringify({ kind: 'audit', ...row }))
  }

  tail(limit = 50, projectId?: string): Array<Record<string, unknown>> {
    if (!this.db) return []
    const rows = projectId
      ? this.db.query('SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?', [projectId, limit])
      : this.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit])
    return rows
  }
}
