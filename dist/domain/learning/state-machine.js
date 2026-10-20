/**
 * 知识状态机 + 学习等级推导（纯函数，可审计重放）。
 *
 * 硬规则：verified 是受保护状态——必须有方法匹配、result=pass、带证据的核验记录，
 * 且满足知识类型的证据门槛；模型自评/摘要/向量化都不能提升状态。
 */
import { InvalidStateError } from "../../core/errors.js";
import { KnowledgeStatus, KnowledgeType, LearningLevel, VerificationMethod, VerificationResult, } from "../../core/types.js";
import { REGISTRY } from "../knowledge/domains.js";
export const ALLOWED_TRANSITIONS = {
    discovered: ['extracted', 'rejected', 'stale'],
    extracted: ['pending_verification', 'disputed', 'rejected', 'superseded', 'stale'],
    pending_verification: ['verified', 'disputed', 'rejected', 'stale', 'superseded', 'extracted'],
    verified: ['practiced', 'disputed', 'stale', 'superseded', 'rejected'],
    practiced: ['evaluated', 'disputed', 'stale', 'superseded'],
    evaluated: ['stale', 'disputed', 'superseded'],
    stale: ['pending_verification', 'superseded', 'rejected'],
    disputed: ['pending_verification', 'verified', 'rejected', 'superseded'],
    rejected: ['pending_verification'],
    superseded: [],
};
export const VERIFICATION_METHODS = {
    definition: ['official_doc_check', 'source_check', 'cross_source'],
    fact: ['source_check', 'cross_source', 'official_doc_check', 'experiment'],
    concept: ['source_check', 'cross_source', 'official_doc_check', 'manual_review'],
    principle: ['source_check', 'cross_source', 'official_doc_check', 'experiment', 'formula_recompute'],
    procedure: ['official_doc_check', 'cross_source', 'code_test', 'experiment'],
    formula: ['formula_recompute', 'code_test', 'official_doc_check'],
    code_example: ['code_test', 'static_analysis'],
    best_practice: ['cross_source', 'official_doc_check', 'usability_test', 'manual_review'],
    case_study: ['source_check', 'cross_source', 'manual_review'],
    hypothesis: [],
    opinion: [],
    warning: ['official_doc_check', 'source_check', 'experiment'],
    unresolved_question: [],
    experimental_result: ['experiment', 'code_test'],
};
export const NON_VERIFIABLE_TYPES = new Set([
    KnowledgeType.HYPOTHESIS,
    KnowledgeType.OPINION,
    KnowledgeType.UNRESOLVED_QUESTION,
]);
/** (最少证据条数, 最少独立来源数, 最低来源质量) */
export const EVIDENCE_REQUIREMENTS = {
    definition: [1, 1, 0.8],
    fact: [2, 2, 0.55],
    concept: [1, 1, 0.65],
    principle: [2, 1, 0.7],
    procedure: [1, 1, 0.75],
    formula: [1, 1, 0.6],
    code_example: [1, 1, 0.5],
    best_practice: [1, 1, 0.65],
    case_study: [1, 1, 0.55],
    warning: [1, 1, 0.6],
    experimental_result: [1, 1, 0.5],
};
export const TASK_TRANSITIONS = {
    pending: ['running', 'cancelled', 'blocked', 'paused'],
    running: ['completed', 'failed', 'paused', 'blocked', 'cancelled', 'retrying'],
    retrying: ['running', 'failed', 'cancelled', 'blocked'],
    paused: ['running', 'cancelled', 'pending'],
    blocked: ['pending', 'running', 'cancelled'],
    failed: ['retrying', 'cancelled', 'pending'],
    completed: [],
    cancelled: ['pending'],
};
export function allowedMethods(knowledgeType) {
    return VERIFICATION_METHODS[knowledgeType] ?? [];
}
export function isNonVerifiable(knowledgeType) {
    return NON_VERIFIABLE_TYPES.has(knowledgeType);
}
export function evidenceRequirements(knowledgeType, domain = '') {
    if (domain) {
        const override = REGISTRY.get(domain).qualityOverrides[knowledgeType];
        if (override)
            return override;
    }
    return EVIDENCE_REQUIREMENTS[knowledgeType] ?? [1, 1, 0.6];
}
/** 官方文档/标准 + 通过的官方核验：单来源即可（其余门槛不变）。 */
export function effectiveRequirements(knowledgeType, sourceType, records = [], domain = '') {
    const [minCount, minIndependent, minQuality] = evidenceRequirements(knowledgeType, domain);
    const official = records.some((record) => record.result === VerificationResult.PASS && record.method === VerificationMethod.OFFICIAL_DOC_CHECK);
    if (official && (sourceType === 'official_doc' || sourceType === 'standard')) {
        return [1, 1, minQuality];
    }
    return [minCount, minIndependent, minQuality];
}
function verifyGuard(chunk, records) {
    const knowledgeType = chunk.knowledge_type;
    if (isNonVerifiable(knowledgeType)) {
        return { ok: false, reasons: [`${knowledgeType} 不能作为已验证事实（观点/假设必须保持标记）`] };
    }
    const methods = allowedMethods(knowledgeType);
    if (methods.length === 0)
        return { ok: false, reasons: [`${knowledgeType} 没有定义任何可接受的核验方法`] };
    const passing = records.filter((record) => record.result === VerificationResult.PASS &&
        methods.includes(record.method) &&
        Array.isArray(record.evidence) &&
        record.evidence.length > 0);
    if (passing.length === 0) {
        return {
            ok: false,
            reasons: [`缺少合格的核验记录：方法必须属于 ${methods.join('/')}，结果必须是 pass 且包含证据`],
        };
    }
    const [minCount, minIndependent, minQuality] = effectiveRequirements(knowledgeType, chunk.source_type, records, chunk.domain);
    const independent = new Set();
    for (const record of passing) {
        for (const entry of record.evidence) {
            const item = (entry ?? {});
            const key = String(item.source_id || item.publisher || item.url || '');
            if (key)
                independent.add(key);
        }
    }
    const evidenceCount = passing.reduce((sum, record) => sum + (Array.isArray(record.evidence) ? record.evidence.length : 0), 0);
    const independence = Math.max(independent.size, Number(chunk.evidence_independence ?? 0));
    if (evidenceCount < minCount) {
        return { ok: false, reasons: [`${knowledgeType} 至少需要 ${minCount} 条通过证据，当前 ${evidenceCount} 条`] };
    }
    if (independence < minIndependent) {
        return {
            ok: false,
            reasons: [
                `${knowledgeType} 至少需要 ${minIndependent} 个独立来源，当前 ${independence} 个（转载/镜像不算独立来源）`,
            ],
        };
    }
    if (Number(chunk.source_quality) < minQuality) {
        return {
            ok: false,
            reasons: [`来源质量 ${Number(chunk.source_quality).toFixed(2)} 低于 ${knowledgeType} 要求的 ${minQuality.toFixed(2)}`],
        };
    }
    return {
        ok: true,
        reasons: [
            `核验方法 ${[...new Set(passing.map((r) => r.method))].sort().join(', ')} 合格`,
            `独立证据 ${independence} 条，来源质量 ${Number(chunk.source_quality).toFixed(2)}`,
        ],
    };
}
export function evaluateTransition(chunk, target, records = []) {
    const current = chunk.status;
    const reasons = [];
    const warnings = [];
    const fail = (why) => ({ allowed: false, target, reasons: why, warnings });
    if (!Object.values(KnowledgeStatus).includes(target)) {
        return fail([`目标状态非法: ${target}`]);
    }
    if (current === target)
        return { allowed: true, target, reasons: ['状态未变化（幂等）'], warnings };
    if (!(ALLOWED_TRANSITIONS[current] ?? []).includes(target)) {
        return fail([`不允许从 ${current} 迁移到 ${target}`]);
    }
    if (target === KnowledgeStatus.VERIFIED) {
        const guard = verifyGuard(chunk, records);
        if (!guard.ok)
            return fail(guard.reasons);
        reasons.push(...guard.reasons);
    }
    if (target === KnowledgeStatus.PRACTICED) {
        const practiced = records.filter((record) => record.result === VerificationResult.PASS &&
            ['code_test', 'experiment', 'usability_test', 'formula_recompute'].includes(record.method));
        if (practiced.length === 0)
            return fail(['没有成功的实践/测试/实验记录，不能进入 practiced']);
        reasons.push(`存在 ${practiced.length} 条通过的实践证据`);
    }
    if (target === KnowledgeStatus.EVALUATED) {
        const metadata = (chunk.metadata ?? {});
        if (chunk.status !== KnowledgeStatus.PRACTICED && !metadata.evaluation) {
            return fail(['必须先完成实践或存在评估记录才能进入 evaluated']);
        }
        reasons.push('存在评估依据');
    }
    if (target === KnowledgeStatus.SUPERSEDED && !chunk.superseded_by) {
        return fail(['标记 superseded 必须提供 superseded_by（新知识 ID）']);
    }
    if (target === KnowledgeStatus.STALE)
        warnings.push('stale 只是时效标记，不代表知识错误');
    if (isNonVerifiable(chunk.knowledge_type) && (target === KnowledgeStatus.VERIFIED || target === KnowledgeStatus.PRACTICED)) {
        return fail([`${chunk.knowledge_type} 类型不允许升级为 ${target}（规则 3.5）`]);
    }
    return { allowed: true, target, reasons, warnings };
}
const LEVEL_ORDER = [
    LearningLevel.L0, LearningLevel.L1, LearningLevel.L2,
    LearningLevel.L3, LearningLevel.L4, LearningLevel.L5,
];
export function levelIndex(level) {
    const index = LEVEL_ORDER.indexOf(level);
    return index < 0 ? 0 : index;
}
export function maxLevel(...levels) {
    let best = LearningLevel.L0;
    for (const level of levels)
        if (levelIndex(level) > levelIndex(best))
            best = level;
    return best;
}
export function atLeast(level, threshold) {
    return levelIndex(level) >= levelIndex(threshold);
}
export function computeLevel(chunk, records = []) {
    const status = chunk.status;
    if (status === KnowledgeStatus.DISCOVERED)
        return LearningLevel.L1;
    if (status === KnowledgeStatus.EXTRACTED || status === KnowledgeStatus.PENDING_VERIFICATION)
        return LearningLevel.L2;
    if (status === KnowledgeStatus.VERIFIED || status === KnowledgeStatus.STALE)
        return LearningLevel.L3;
    if (status === KnowledgeStatus.PRACTICED)
        return LearningLevel.L4;
    if (status === KnowledgeStatus.EVALUATED)
        return LearningLevel.L5;
    if (status === KnowledgeStatus.DISPUTED || status === KnowledgeStatus.REJECTED) {
        return Number(chunk.evidence_count ?? 0) === 0 ? LearningLevel.L1 : LearningLevel.L2;
    }
    const passCount = records.filter((record) => record.result === VerificationResult.PASS).length;
    if (passCount >= 2)
        return LearningLevel.L3;
    if (passCount === 1)
        return LearningLevel.L2;
    return LearningLevel.L1;
}
export function canTransitionTask(current, target) {
    if (current === target)
        return true;
    return (TASK_TRANSITIONS[current] ?? []).includes(target);
}
export function assertTaskTransition(current, target) {
    if (!canTransitionTask(current, target)) {
        throw new InvalidStateError(`任务状态不允许从 ${current} 迁移到 ${target}`);
    }
}
