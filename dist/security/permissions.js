/**
 * 分级自主权限（assisted / auto / lab）。
 *
 * 判定矩阵与 v1.2 一致，但显式区分「宿主审批」与「本地令牌」：
 * - DSH 原生工具：宿主在 execute 之前 ask，engine 侧 delegate=true；
 * - MCP / CLI：delegate=false，走 ApprovalService 令牌（用户侧批准）。
 * 无论哪种通道，拒绝都不会被自动放行。
 */
import { AutolearnError, ERROR_CODES } from "../core/errors.js";
import { AuditLogger } from "./audit.js";
import { ApprovalService } from "./approval.js";
import { PathPolicy } from "./paths.js";
import { containsSecret } from "./secrets.js";
const MODES = ['assisted', 'auto', 'lab'];
export class PermissionManager {
    currentMode;
    security;
    learning;
    pathPolicy;
    approvals;
    audit;
    delegateDefault;
    constructor(options) {
        this.security = options.security;
        this.learning = options.learning;
        this.pathPolicy = options.pathPolicy;
        this.approvals = options.approvals ?? null;
        this.audit = options.audit ?? new AuditLogger(null, { enabled: options.security.audit_log });
        this.currentMode = options.mode ?? options.learning.default_mode;
        this.delegateDefault = options.delegateToHost ?? false;
        if (!MODES.includes(this.currentMode))
            throw new AutolearnError(`非法模式: ${this.currentMode}`, { code: ERROR_CODES.CONFIG_INVALID });
    }
    get mode() {
        return this.currentMode;
    }
    /**
     * 宿主审批是否**真的**已挂载。
     * 只允许在成功注册 tools/pre-execute hook 之后调用；否则 destructive 会绕过确认。
     */
    setDelegateToHost(active) {
        this.delegateDefault = active;
    }
    setMode(mode) {
        const normalized = mode.trim().toLowerCase();
        if (!MODES.includes(normalized)) {
            throw new AutolearnError(`模式取值非法: ${mode}（允许 assisted/auto/lab）`, { code: ERROR_CODES.CONFIG_INVALID });
        }
        this.currentMode = normalized;
        return this.currentMode;
    }
    get paths() {
        return this.pathPolicy;
    }
    decide(action, risk, target = '', options = {}) {
        const delegate = options.delegateToHost ?? this.delegateDefault;
        let decision = this.evaluate(risk, target, options.content ?? '', delegate);
        if (!decision.allowed && decision.needs_confirmation) {
            const token = options.confirmedToken ?? '';
            if (token && this.approvals?.consume(token, action, target)) {
                decision = {
                    allowed: true,
                    reason: `已确认高风险操作: ${action}`,
                    needs_confirmation: false,
                    confirm_token: '',
                    risk,
                };
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
        });
        return decision;
    }
    /** 需要确认时创建令牌（模型只能拿到令牌，不能批准）。 */
    requestConfirmation(action, target, projectId = '') {
        if (!this.approvals) {
            throw new AutolearnError('本地确认通道未启用（无数据库连接）', { code: ERROR_CODES.POLICY_DENIED });
        }
        return this.approvals.request(action, target, projectId).token;
    }
    evaluate(risk, target, content, delegate) {
        if (content && this.security.block_secret_patterns) {
            const hit = containsSecret(content);
            if (hit) {
                return this.deny(`内容疑似包含密钥/令牌（模式 ${hit}），禁止写入知识库`, risk);
            }
        }
        if (risk === 'read') {
            if (target && this.looksLikePath(target) && this.pathPolicy.exists(target) && !this.pathPolicy.isAllowed(target)) {
                return this.deny('路径不在授权根目录内；如确需读取，请把路径加入 security.allowed_roots，或先把文件复制到 data/corpus', risk);
            }
            return this.allow('读取操作允许', risk);
        }
        if (risk === 'write') {
            if (this.looksLikePath(target) && !this.pathPolicy.isAllowed(target)) {
                return this.deny(`写入路径不在允许范围内（仅允许 data 目录与授权根目录）: ${target}`, risk);
            }
            if (delegate)
                return this.allow('写入允许（高风险动作已由 DSH 宿主审批）', risk);
            if (this.currentMode === 'assisted')
                return this.allow('assisted 模式允许写入待审分区；正式分区需确认', risk);
            return this.allow('写入操作允许', risk);
        }
        if (risk === 'external') {
            if (!this.security.allow_network) {
                return this.deny('未开启 security.allow_network，外部网络访问被拒绝', risk);
            }
            if (delegate)
                return this.allow('外部访问允许（宿主审批 + 域名/体积限制）', risk);
            if (this.currentMode === 'assisted')
                return this.needConfirmation('外部访问需要用户确认', risk);
            return this.allow('外部访问允许（受域名与体积限制）', risk);
        }
        if (risk === 'execute') {
            if (this.currentMode !== 'lab') {
                return this.deny(`代码执行仅在 lab（受控实验）模式下允许；当前为 ${this.currentMode}`, risk);
            }
            if (delegate)
                return this.allow('执行允许（宿主审批；仍为进程级隔离，非安全沙箱）', risk);
            return this.allow('lab 模式可在受限目录执行（进程级隔离，非安全沙箱）', risk);
        }
        if (risk === 'destructive') {
            if (delegate)
                return this.allow('删除/覆盖/迁移允许（宿主审批，用户拒绝则不会执行）', risk);
            return this.needConfirmation('删除/覆盖/迁移必须显式确认', risk);
        }
        return this.deny(`未知风险等级: ${risk}`, risk);
    }
    looksLikePath(target) {
        const value = (target ?? '').trim();
        if (!value || value.startsWith('http://') || value.startsWith('https://'))
            return false;
        if (value.startsWith('/') || value.startsWith('~') || value.startsWith('./') || value.startsWith('../'))
            return true;
        return value.includes('/') && !value.startsWith('action:');
    }
    allow(reason, risk) {
        return { allowed: true, reason, needs_confirmation: false, confirm_token: '', risk };
    }
    deny(reason, risk) {
        return { allowed: false, reason, needs_confirmation: false, confirm_token: '', risk };
    }
    needConfirmation(reason, risk) {
        return { allowed: false, reason, needs_confirmation: true, confirm_token: '', risk };
    }
}
