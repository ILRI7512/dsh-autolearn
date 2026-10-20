import { utcnowIso } from "../core/ids.js";
import { redact } from "./secrets.js";
export class AuditLogger {
    db;
    enabled;
    sink;
    constructor(db, options = {}) {
        this.db = db;
        this.enabled = options.enabled ?? true;
        this.sink = options.sink ?? (() => { });
    }
    log(entry) {
        if (!this.enabled)
            return;
        const row = {
            ts: utcnowIso(),
            actor: entry.actor ?? 'agent',
            action: entry.action,
            target: (entry.target ?? '').slice(0, 500),
            risk: entry.risk ?? 'read',
            allowed: entry.allowed ?? true,
            project_id: entry.projectId ?? '',
            detail: JSON.stringify(redact(entry.detail ?? {})),
        };
        try {
            this.db?.insert('audit_log', row);
        }
        catch (error) {
            // 审计写入失败不能掩盖业务结果，但必须让运维看见。
            this.sink(`[audit] 写入失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.sink(JSON.stringify({ kind: 'audit', ...row }));
    }
    tail(limit = 50, projectId) {
        if (!this.db)
            return [];
        const rows = projectId
            ? this.db.query('SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?', [projectId, limit])
            : this.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
        return rows;
    }
}
