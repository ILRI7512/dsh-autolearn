/**
 * 高风险操作确认（独立运行时的本地令牌流程）。
 *
 * 安全规则：
 * - 令牌由可信存储生成（SQLite confirmations），带作用域（action+target）与有效期；
 * - 只有用户侧通道能批准（CLI/宿主 UI），模型可见工具没有 approve；
 * - 单次使用：consume 后立即置 consumed，重放返回 false；
 * - 失败关闭：未批准、过期、作用域不匹配一律拒绝，绝不自动放行。
 */
import { randomBytes } from 'node:crypto'
import { AutolearnError, ERROR_CODES } from '../core/errors.ts'
import { utcnowIso } from '../core/ids.ts'
import type { Database } from '../infrastructure/database/database.ts'
import { AuditLogger } from './audit.ts'

export const CONFIRM_TTL_SECONDS = 900

export interface ConfirmationRow {
  token: string
  action: string
  target: string
  project_id: string
  status: string
  created_at: string
  expires_at: string
  approved_at: string
  note: string
}

export class ApprovalService {
  private readonly db: Database
  private readonly audit: AuditLogger
  private readonly ttlSeconds: number

  constructor(db: Database, options: { ttlSeconds?: number; audit?: AuditLogger } = {}) {
    this.db = db
    this.ttlSeconds = options.ttlSeconds ?? CONFIRM_TTL_SECONDS
    this.audit = options.audit ?? new AuditLogger(db)
  }

  /** 创建待批准请求；返回令牌（作用域绑定 action+target）。 */
  request(action: string, target = '', projectId = ''): { token: string; expires_at: string } {
    const token = randomBytes(24).toString('hex')
    const now = new Date()
    const expires = new Date(now.getTime() + this.ttlSeconds * 1000)
    this.db.insert('confirmations', {
      token,
      action,
      target,
      project_id: projectId,
      status: 'pending',
      created_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      approved_at: '',
      note: '',
    })
    this.audit.log({ action: 'confirmation_requested', target, risk: 'destructive', allowed: false, projectId, detail: { action } })
    return { token, expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }

  /** 仅用户侧可调用；模型通道不暴露该方法。 */
  approve(token: string, actor = 'user'): boolean {
    if (!['user', 'human', 'cli'].includes(actor.toLowerCase())) {
      throw new AutolearnError('只有用户侧通道可以批准高风险操作', { code: ERROR_CODES.POLICY_DENIED })
    }
    const row = this.get(token)
    if (!row) return false
    if (row.status !== 'pending' || this.expired(row)) return false
    this.db.update('confirmations', token, {
      status: 'approved',
      approved_at: utcnowIso(),
      note: `approved by ${actor}`,
    })
    this.audit.log({ action: 'confirmation_approved', target: row.target, risk: 'destructive', allowed: true, detail: { action: row.action } })
    return true
  }

  reject(token: string, note = ''): boolean {
    const row = this.get(token)
    if (!row || row.status !== 'pending') return false
    this.db.update('confirmations', token, { status: 'rejected', note: note.slice(0, 500) })
    this.audit.log({ action: 'confirmation_rejected', target: row.target, risk: 'destructive', allowed: false, detail: { note } })
    return true
  }

  /** 消费令牌：作用域匹配 + 未过期 + 单次使用。 */
  consume(token: string, action: string, target: string): boolean {
    const row = this.get(token)
    if (!row) return false
    if (row.status !== 'approved') return false
    if (this.expired(row)) return false
    if (row.action !== action || row.target !== target) return false
    const changes = this.db.executeWrite(
      `UPDATE confirmations SET status='consumed' WHERE token=? AND status='approved'`,
      [token],
    )
    return changes === 1
  }

  pending(): ConfirmationRow[] {
    return this.db.query(
      `SELECT * FROM confirmations WHERE status='pending' AND expires_at > ? ORDER BY created_at DESC`,
      [utcnowIso()],
    ) as unknown as ConfirmationRow[]
  }

  get(token: string): ConfirmationRow | null {
    return this.db.get('confirmations', token) as unknown as ConfirmationRow | null
  }

  private expired(row: ConfirmationRow): boolean {
    const expires = Date.parse(row.expires_at)
    return !Number.isFinite(expires) || expires <= Date.now()
  }
}
