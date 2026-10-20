import { clamp, round } from "../../core/ids.js";
export const QUALITY_WEIGHTS = {
    source_trust: 0.22,
    completeness: 0.16,
    factuality: 0.24,
    freshness: 0.1,
    non_duplication: 0.08,
    classification: 0.06,
    applicability: 0.08,
    practice: 0.06,
};
const FRESHNESS_SCORE = {
    fresh: 1.0, aging: 0.7, stale: 0.35, expired: 0.1, unknown: 0.5,
};
const PRACTICE_METHODS = new Set(['code_test', 'experiment', 'formula_recompute', 'usability_test']);
function filled(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (value && typeof value === 'object')
        return Object.keys(value).length > 0;
    return String(value ?? '').trim().length > 0;
}
export function assessQuality(chunk, records = []) {
    const sourceTrust = clamp(Number(chunk.source_quality ?? 0));
    const base = [chunk.summary, chunk.source_url, chunk.source_excerpt, chunk.tags].filter(filled).length / 4;
    const extra = [chunk.core_principle, chunk.reasoning, chunk.application, chunk.implementation].filter(filled).length / 4;
    const lengthScore = clamp((chunk.content ?? '').length / 400);
    const completeness = clamp(0.5 * base + 0.3 * extra + 0.2 * lengthScore);
    const passedWithEvidence = records.some((record) => record.result === 'pass' && Array.isArray(record.evidence) && record.evidence.length > 0);
    const hasPassing = records.some((record) => record.result === 'pass');
    let factuality;
    switch (chunk.verification_status) {
        case 'verified':
            factuality = passedWithEvidence ? 1.0 : 0.8;
            break;
        case 'partial':
            factuality = 0.55;
            break;
        case 'disputed':
            factuality = 0.15;
            break;
        case 'failed':
            factuality = 0.1;
            break;
        default: factuality = hasPassing ? 0.45 : 0.25;
    }
    const freshness = FRESHNESS_SCORE[chunk.freshness_status] ?? 0.5;
    const nonDuplication = chunk.conflict_status === 'confirmed' ? 0.35 : 1.0;
    const metadata = (chunk.metadata ?? {});
    let classification;
    if (metadata.classification_low_confidence === true)
        classification = 0.45;
    else if (metadata.classification_scores && typeof metadata.classification_scores === 'object') {
        const scores = Object.values(metadata.classification_scores)
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
        classification = scores.length > 0
            ? clamp(0.5 + Math.min(1, Math.max(...scores) / 6) * 0.5)
            : 0.6;
    }
    else
        classification = 0.6;
    const hint = [chunk.application, chunk.implementation, chunk.core_principle]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    const applicability = hint
        ? clamp(0.6 + Math.min(hint.length, 200) / 500)
        : chunk.tags.length > 0 ? 0.55 : 0.4;
    let practice = 0.2;
    if (hasPassing && records.some((record) => record.result === 'pass' && PRACTICE_METHODS.has(String(record.method)))) {
        practice = 1.0;
    }
    else if (['practiced', 'evaluated'].includes(chunk.status)) {
        practice = 0.9;
    }
    const components = {
        source_trust: round(sourceTrust, 3),
        completeness: round(completeness, 3),
        factuality: round(factuality, 3),
        freshness: round(freshness, 3),
        non_duplication: round(nonDuplication, 3),
        classification: round(classification, 3),
        applicability: round(applicability, 3),
        practice: round(practice, 3),
    };
    let score = 0;
    for (const [key, weight] of Object.entries(QUALITY_WEIGHTS)) {
        score += weight * (components[key] ?? 0);
    }
    score = round(clamp(score), 3);
    let weakest = '';
    let weakestValue = 2;
    for (const [key, value] of Object.entries(components)) {
        if (value < weakestValue) {
            weakest = key;
            weakestValue = value;
        }
    }
    return {
        score,
        components,
        basis: `质量分 ${score}（加权，见 QUALITY_WEIGHTS）；最弱维度 ${weakest}=${weakestValue}；核验状态 ${chunk.verification_status}`,
    };
}
