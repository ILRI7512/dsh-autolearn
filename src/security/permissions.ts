/**
 * 分级自主权限（assisted / auto / lab）。
 *
 * 判定矩阵与 v1.2 一致，但显式区分「宿主审批」与「本地令牌」：
 * - DSH 原生工具：宿主在 execute 之前 ask，engine 侧 delegate=true；
 * - MCP / CLI：delegate=false，走 ApprovalService 令牌（用户侧批准）。
 * 无论哪种通道，拒绝都不会被自动放行。
 */
import { AutolearnError, ERROR_CODES } from '../core/errors.ts'
import type { AutonomyMode, RiskLevel } from '../core/types.ts'
import type { LearningConfig, SecurityConfig } from '../core/config.ts'
import { AuditLogger } from './audit.ts'
import { ApprovalService } from './approval.ts'
import { PathPolicy } from './paths.ts'
import { containsSecret } from './secrets.ts'

export interface PermissionDecision {
  allowed: boolean
  reason: string
  needs_confirmation: boolean
  confirm_token: string
  risk: string
}

export interface DecideOptions {
  projectId?: string
  confirmedToken?: string
  content?: string
  /** 宿主审批已生效（DSH 原生工具在 execute 前 ask 过）。 */
  delegateToHost?: boolean
}

const MODES: readonly AutonomyMode[] = ['assisted', 'auto', 'lab']

export class PermissionManager {
  private currentMode: AutonomyMode
  private readonly security: SecurityConfig
  private readonly learning: LearningConfig
  private readonly pathPolicy: PathPolicy
  private readonly approvals: ApprovalService | null
  private readonly audit: AuditLogger
  private readonly delegateDefault: boolean

  constructor(options: {
    security: SecurityConfig
    learning: LearningConfig
    pathPolicy: PathPolicy
    approvals?: ApprovalService | null
    audit?: AuditLogger
    mode?: AutonomyMode
    delegateToHost?: boolean
  }) {
    this.security = options.security
    this.learning = options.learning
    this.pathPolicy = options.pathPolicy
    this.approvals = options.approvals ?? null
    this.audit = options.audit ?? new AuditLogger(null, { enabled: options.security.audit_log })
    this.currentMode = options.mode ?? options.learning.default_mode
    this.delegateDefault = options.delegateToHost ?? false
    if (!MODES.includes(this.currentMode)) throw new AutolearnError(`非法模式: ${this.currentMode}`, { code: ERROR_CODES.CONFIG_INVALID })
  }

  get mode(): AutonomyMode {
    return this.currentMode
  }

  setMode(mode: string): AutonomyMode {
    const normalized = mode.trim().toLowerCase()
    if (!MODES.includes(normalized as AutonomyMode)) {
      throw new AutolearnError(`模式取值非法: ${mode}（允许 assisted/auto/lab）`, { code: ERROR_CODES.CONFIG_INVALID })
    }
    this.currentMode = normalized as AutonomyMode
    return this.currentMode
  }

  get paths(): PathPolicy {
    return this.pathPolicy
  }

  decide(action: string, risk: RiskLevel, target = '', options: DecideOptions = {}): PermissionDecision {
    const delegate = options.delegateToHost ?? this.delegateDefault
    let decision = this.evaluate(risk, target, options.content ?? '', delegate)

    if (!decision.allowed && decision.needs_confirmation) {
      const token = options.confirmedToken ?? ''
      if (token && this.approvals?.consume(token, action, target)) {
        decision = {
          allowed: true,
          reason: `已确认高风险操作: ${action}`,
          needs_confirmation: false,
          confirm_token: '',
          risk,
        }
      }
    }

    this.audit.log({
      action,
      target,
      risk,
      allowed: decision.allowed,
      projectId: options.projectId ?? '',
      detail: {
        mode: this.currentMode,
        needs_confirmation: decision.needs_confirmation,
        reason: decision.reason,
        delegate_to_host: delegate,
      },
    })
    return decision
  }

  /** 需要确认时创建令牌（模型只能拿到令牌，不能批准）。 */
  requestConfirmation(action: string, target: string, projectId = ''): string {
    if (!this.approvals) {
      throw new AutolearnError('本地确认通道未启用（无数据库连接）', { code: ERROR_CODES.POLICY_DENIED })
    }
    return this.approvals.request(action, target, projectId).token
  }

  private evaluate(risk: RiskLevel, target: string, content: string, delegate: boolean): PermissionDecision {
    if (content && this.security.block_secret_patterns) {
      const hit = containsSecret(content)
      if (hit) {
        return this.deny(`内容疑似包含密钥/令牌（模式 ${hit}），禁止写入知识库`, risk)
      }
    }

    if (risk === 'read') {
      if (target && this.looksLikePath(target) && this.pathPolicy.exists(target) && !this.pathPolicy.isAllowed(target)) {
        return this.deny(
          '路径不在授权根目录内；如确需读取，请把路径加入 security.allowed_roots，或先把文件复制到 data/corpus',
          risk,
        )
      }
      return this.allow('读取操作允许', risk)
    }

    if (risk === 'write') {
      if (this.looksLikePath(target) && !this.pathPolicy.isAllowed(target)) {
        return this.deny(`写入路径不在允许范围内（仅允许 data 目录与授权根目录）: ${target}`, risk)
      }
      if (delegate) return this.allow('写入允许（高风险动作已由 DSH 宿主审批）', risk)
      if (this.currentMode === 'assisted') return this.allow('assisted 模式允许写入待审分区；正式分区需确认', risk)
      return this.allow('写入操作允许', risk)
    }

    if (risk === 'external') {
      if (!this.security.allow_network) {
        return this.deny('未开启 security.allow_network，外部网络访问被拒绝', risk)
      }
      if (delegate) return this.allow('外部访问允许（宿主审批 + 域名/体积限制）', risk)
      if (this.currentMode === 'assisted') return this.needConfirmation('外部访问需要用户确认', risk)
      return this.allow('外部访问允许（受域名与体积限制）', risk)
    }

    if (risk === 'execute') {
      if (this.currentMode !== 'lab') {
        return this.deny(`代码执行仅在 lab（受控实验）模式下允许；当前为 ${this.currentMode}`, risk)
      }
      if (delegate) return this.allow('执行允许（宿主审批；仍为进程级隔离，非安全沙箱）', risk)
      return this.allow('lab 模式可在受限目录执行（进程级隔离，非安全沙箱）', risk)
    }

    if (risk === 'destructive') {
      if (delegate) return this.allow('删除/覆盖/迁移允许（宿主审批，用户拒绝则不会执行）', risk)
      return this.needConfirmation('删除/覆盖/迁移必须显式确认', risk)
    }

    return this.deny(`未知风险等级: ${risk}`, risk)
  }

  private looksLikePath(target: string): boolean {
    const value = (target ?? '').trim()
    if (!value || value.startsWith('http://') || value.startsWith('https://')) return false
    if (value.startsWith('/') || value.startsWith('~') || value.startsWith('./') || value.startsWith('../')) return true
    return value.includes('/') && !value.startsWith('action:')
  }

  private allow(reason: string, risk: RiskLevel): PermissionDecision {
    return { allowed: true, reason, needs_confirmation: false, confirm_token: '', risk }
  }

  private deny(reason: string, risk: RiskLevel): PermissionDecision {
    return { allowed: false, reason, needs_confirmation: false, confirm_token: '', risk }
  }

  private needConfirmation(reason: string, risk: RiskLevel): PermissionDecision {
    return { allowed: false, reason, needs_confirmation: true, confirm_token: '', risk }
  }
}
