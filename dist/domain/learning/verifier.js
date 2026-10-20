/**
 * 知识核验器：证据规则的唯一执行点。
 *
 * 硬纪律（逐条对应验收标准）：
 * 1. 没有证据 → fail，绝不升级；模型自述不算证据；
 * 2. 方法必须与知识类型匹配；观点/假设/未解决问题永不 verified；
 * 3. 转载/镜像不算独立来源（按 source_id/发布机构/域名去重）；
 * 4. 置信度是确定性公式，不是模型打分；
 * 5. 核验失败保留记录并转 disputed，不删除知识。
 */
import { NotFoundError } from "../../core/errors.js";
import { clamp, newId, round, utcnowIso } from "../../core/ids.js";
import { parseJsonObject } from "../../core/json.js";
import { KnowledgeStatus, VerificationMethod, VerificationResult, } from "../../core/types.js";
import { evaluateFormula, FormulaError } from "../practice/formula.js";
import { assessQuality } from "../knowledge/quality.js";
import { computeLevel, effectiveRequirements, evaluateTransition, isNonVerifiable, allowedMethods, } from "./state-machine.js";
export class KnowledgeVerifier {
    store;
    constructor(store) {
        this.store = store;
    }
    autoMethod(chunk) {
        if (chunk.knowledge_type === 'formula')
            return VerificationMethod.FORMULA_RECOMPUTE;
        if (chunk.knowledge_type === 'code_example')
            return VerificationMethod.CODE_TEST;
        if (chunk.knowledge_type === 'experimental_result')
            return VerificationMethod.EXPERIMENT;
        if (chunk.source_type === 'official_doc' || chunk.source_type === 'standard')
            return VerificationMethod.OFFICIAL_DOC_CHECK;
        return VerificationMethod.SOURCE_CHECK;
    }
    verify(chunkId, options = {}) {
        const chunk = this.store.getChunk(chunkId);
        if (!chunk)
            throw new NotFoundError(`知识片段不存在: ${chunkId}`);
        const method = (options.method ?? this.autoMethod(chunk));
        if (!Object.values(VerificationMethod).includes(method))
            throw new Error(`未知核验方法: ${method}`);
        const reasons = [];
        const warnings = [];
        const verifier = options.verifier ?? 'system';
        if (isNonVerifiable(chunk.knowledge_type)) {
            return this.finishNonVerifiable(chunk, reasons);
        }
        let evidenceList = this.normalizeEvidence(chunk, options.evidence ?? []);
        let result = VerificationResult.INCONCLUSIVE;
        let independence = 0;
        if (['source_check', 'official_doc_check', 'cross_source'].includes(method)) {
            evidenceList = this.enrichEvidence(chunk, evidenceList);
            independence = this.independence(evidenceList);
            const judged = this.judgeSource(chunk, method, evidenceList, independence);
            result = judged.result;
            reasons.push(...judged.reasons);
        }
        else if (method === VerificationMethod.FORMULA_RECOMPUTE) {
            const judged = this.recomputeFormula(chunk, options);
            result = judged.result;
            evidenceList.push(...judged.evidence);
            reasons.push(...judged.reasons);
            independence = 1;
        }
        else if (method === VerificationMethod.CODE_TEST ||
            method === VerificationMethod.EXPERIMENT ||
            method === VerificationMethod.USABILITY_TEST) {
            const judged = this.judgePractice(method, options.codeResult);
            result = judged.result;
            evidenceList.push(...judged.evidence);
            reasons.push(...judged.reasons);
            independence = 1;
        }
        else if (method === VerificationMethod.STATIC_ANALYSIS) {
            const judged = this.judgeStatic(chunk);
            result = judged.result;
            reasons.push(...judged.reasons);
            independence = 1;
        }
        else if (method === VerificationMethod.MANUAL_REVIEW) {
            const manual = (options.evidence ?? []).filter((item) => {
                const kind = String(item.kind ?? '');
                const actor = String(item.actor ?? item.verifier ?? 'user').toLowerCase();
                return ['user_review', 'human_review', 'manual_review'].includes(kind) && ['user', 'human'].includes(actor);
            });
            if (verifier !== 'user' || manual.length === 0) {
                result = VerificationResult.PARTIAL;
                reasons.push('人工复核不成立：需要 verifier=user 且提供人工证据（条目自身来源与模型自述都不算人工复核）');
            }
            else {
                evidenceList.push(...manual);
                result = VerificationResult.PASS;
                reasons.push(`人工复核证据 ${manual.length} 条`);
            }
            independence = this.independence(evidenceList);
        }
        else {
            warnings.push(`未知核验方法 ${method}，按无证据处理`);
            independence = 0;
        }
        if (evidenceList.length === 0) {
            result = VerificationResult.FAIL;
            reasons.push('核验未产生任何证据，按失败处理（无证据不得升级）');
        }
        const record = this.store.addVerification({
            record_id: newId('vrf'),
            chunk_id: chunkId,
            method,
            result,
            evidence: evidenceList,
            notes: reasons.join('；').slice(0, 2000),
            verifier,
        });
        const records = this.store.listVerifications(chunkId);
        const passed = records.filter((item) => item.result === VerificationResult.PASS);
        const independenceTotal = Math.max(independence, new Set(evidenceList.map((item) => item.source_id).filter(Boolean)).size);
        const evidenceCount = passed.reduce((sum, item) => sum + (Array.isArray(item.evidence) ? item.evidence.length : 0), 0);
        const [minCount, minIndependent, minQuality] = effectiveRequirements(chunk.knowledge_type, chunk.source_type, records, chunk.domain);
        const requirementsMet = evidenceCount >= minCount && independenceTotal >= minIndependent && Number(chunk.source_quality) >= minQuality;
        const confidence = this.estimateConfidence(chunk, records, independenceTotal, requirementsMet);
        const statusBefore = chunk.status;
        let statusAfter = statusBefore;
        // 守卫读取的是「本次核验后的证据统计」，必须先把 evidence_* 合入判定对象，
        // 否则公式重算/人工复核这类不带 source_id 的证据会被误判为独立来源不足。
        const working = {
            ...chunk,
            evidence_count: evidenceCount,
            evidence_independence: independenceTotal,
        };
        let verificationStatus;
        if (result === VerificationResult.PASS && requirementsMet) {
            verificationStatus = 'verified';
            const decision = evaluateTransition(working, KnowledgeStatus.VERIFIED, records);
            if (decision.allowed) {
                statusAfter = KnowledgeStatus.VERIFIED;
                reasons.push(...decision.reasons);
            }
            else {
                verificationStatus = 'partial';
                warnings.push(...decision.reasons);
            }
        }
        else if (result === VerificationResult.PASS) {
            verificationStatus = 'partial';
            warnings.push(`核验通过但未达到 ${chunk.knowledge_type} 的升级门槛（需要证据 ${minCount} 条/独立来源 ${minIndependent} 个/来源质量 ${minQuality.toFixed(2)}）`);
        }
        else if (result === VerificationResult.PARTIAL) {
            verificationStatus = 'partial';
        }
        else if (result === VerificationResult.FAIL) {
            verificationStatus = 'failed';
            if ([KnowledgeStatus.PENDING_VERIFICATION, KnowledgeStatus.VERIFIED].includes(chunk.status)) {
                statusAfter = KnowledgeStatus.DISPUTED;
                reasons.push('核验失败，按规则转入 disputed 而不是直接删除');
            }
        }
        else {
            verificationStatus = 'unverified';
        }
        const updated = {
            ...chunk,
            status: statusAfter,
            verification_status: verificationStatus,
            verification_method: method,
            verification_evidence: evidenceList,
            evidence_count: evidenceCount,
            evidence_independence: independenceTotal,
            confidence: confidence.value,
            confidence_basis: confidence.basis,
            updated_at: utcnowIso(),
        };
        updated.level = computeLevel(updated, records);
        const quality = assessQuality(updated, records);
        this.store.forceVerificationState(chunkId, {
            status: updated.status,
            level: updated.level,
            verification_status: updated.verification_status,
            verification_method: updated.verification_method,
            verification_evidence: updated.verification_evidence,
            evidence_count: updated.evidence_count,
            evidence_independence: updated.evidence_independence,
            confidence: updated.confidence,
            confidence_basis: updated.confidence_basis,
            quality_score: quality.score,
            quality_components: quality.components,
            updated_at: updated.updated_at,
        });
        return {
            chunk_id: chunkId,
            method,
            result,
            status_before: statusBefore,
            status_after: statusAfter,
            level: updated.level,
            confidence: confidence.value,
            confidence_basis: confidence.basis,
            evidence_count: evidenceCount,
            independence: independenceTotal,
            record_id: record.record_id,
            reasons,
            warnings,
            requirements: {
                min_evidence: minCount, min_independent: minIndependent,
                min_quality: minQuality, met: requirementsMet,
            },
        };
    }
    verifyFormula(chunkId, options) {
        return this.verify(chunkId, { ...options, method: VerificationMethod.FORMULA_RECOMPUTE });
    }
    // ------------------------------------------------------------------ //
    normalizeEvidence(chunk, extra) {
        const evidence = [];
        if (chunk.source_url || chunk.source_id) {
            evidence.push({
                kind: 'source',
                source_id: chunk.source_id,
                url: chunk.source_url,
                title: chunk.source_title,
                publisher: chunk.author_or_publisher,
                published_at: chunk.published_at,
                accessed_at: chunk.accessed_at,
                snippet: (chunk.content ?? '').slice(0, 300),
            });
        }
        for (const item of extra)
            evidence.push({ kind: 'manual', ...item });
        return evidence;
    }
    /** 内容相近的其他来源才算交叉证据；同主题不同结论不能互相印证。 */
    enrichEvidence(chunk, evidence) {
        if (!chunk.topic)
            return evidence;
        const filter = { projectId: chunk.project_id, topics: [chunk.topic] };
        const similar = this.store.findDuplicates({ chunkId: chunk.chunk_id, threshold: 0.5, filter, maxPairs: 20 });
        const seen = new Set(evidence.map((item) => item.source_id || item.url));
        for (const pair of similar) {
            if (evidence.length >= 6)
                break;
            const row = this.store.getChunk(pair.chunk_b);
            if (!row)
                continue;
            const key = row.source_id || row.source_url;
            if (!key || seen.has(key))
                continue;
            seen.add(key);
            evidence.push({
                kind: 'cross_source',
                chunk_id: row.chunk_id,
                source_id: row.source_id,
                url: row.source_url,
                title: row.source_title,
                publisher: row.author_or_publisher,
                similarity: pair.similarity,
                snippet: (row.content ?? '').slice(0, 200),
            });
        }
        return evidence;
    }
    independence(evidence) {
        const keys = new Set();
        for (const item of evidence) {
            const key = String(item.source_id || item.publisher || hostOf(String(item.url ?? '')) || item.kind || '');
            if (key)
                keys.add(key);
        }
        return keys.size;
    }
    judgeSource(chunk, method, evidence, independence) {
        const reasons = [];
        const [minCount, minIndependent, minQuality] = effectiveRequirements(chunk.knowledge_type, chunk.source_type, [], chunk.domain);
        if (evidence.length === 0)
            return { result: VerificationResult.FAIL, reasons: ['没有任何来源证据'] };
        reasons.push(`收集到 ${evidence.length} 条来源证据，独立来源 ${independence} 个`);
        if (method === VerificationMethod.OFFICIAL_DOC_CHECK) {
            const official = evidence.filter((item) => item.kind === 'source');
            if (official.length === 0 || !['official_doc', 'standard'].includes(chunk.source_type)) {
                return { result: VerificationResult.FAIL, reasons: [...reasons, '来源类型不是官方文档/标准，不适用官方文档核验'] };
            }
            reasons.push('来源为官方文档/标准');
            return { result: VerificationResult.PASS, reasons };
        }
        if (independence < minIndependent) {
            return { result: VerificationResult.PARTIAL, reasons: [...reasons, `独立来源 ${independence} < 要求的 ${minIndependent}（转载/镜像不算独立来源）`] };
        }
        if (Number(chunk.source_quality) < minQuality) {
            return { result: VerificationResult.PARTIAL, reasons: [...reasons, `来源质量 ${Number(chunk.source_quality).toFixed(2)} < 要求的 ${minQuality.toFixed(2)}`] };
        }
        if (evidence.length < minCount) {
            return { result: VerificationResult.PARTIAL, reasons: [...reasons, `证据条数 ${evidence.length} < 要求的 ${minCount}`] };
        }
        reasons.push('来源质量与独立性满足该知识类型的门槛');
        return { result: VerificationResult.PASS, reasons };
    }
    recomputeFormula(chunk, options) {
        let expression = options.expression ?? '';
        if (!expression) {
            const metadata = parseJsonObject(chunk.metadata);
            const formulas = Array.isArray(metadata.formulas) ? metadata.formulas : [];
            const first = formulas[0];
            if (first?.expression)
                expression = String(first.expression);
        }
        if (!expression) {
            return { result: VerificationResult.INCONCLUSIVE, evidence: [], reasons: ['未提供公式表达式，也无法从提取结果中找到公式，无法重算'] };
        }
        if (options.expected === undefined || options.expected === null) {
            return { result: VerificationResult.INCONCLUSIVE, evidence: [], reasons: ['未提供期望值 expected，无法判断公式计算结果是否正确'] };
        }
        const tolerance = options.tolerance ?? 1e-6;
        let computed;
        try {
            computed = evaluateFormula(expression, options.variables ?? {});
        }
        catch (error) {
            const message = error instanceof FormulaError ? error.message : String(error);
            return {
                result: VerificationResult.FAIL,
                evidence: [{ kind: 'formula_recompute', expression, variables: options.variables ?? {}, error: message }],
                reasons: [`公式求值失败: ${message}`],
            };
        }
        const diff = Math.abs(computed - options.expected);
        const evidence = {
            kind: 'formula_recompute', expression,
            variables: options.variables ?? {}, computed,
            expected: options.expected, tolerance, abs_diff: diff,
        };
        if (diff <= tolerance) {
            return {
                result: VerificationResult.PASS, evidence: [evidence],
                reasons: [`重算结果 ${computed} 与期望 ${options.expected} 差异 ${diff.toExponential(3)} ≤ 容差 ${tolerance}`],
            };
        }
        return {
            result: VerificationResult.FAIL, evidence: [evidence],
            reasons: [`重算结果 ${computed} 与期望 ${options.expected} 差异 ${diff.toPrecision(6)} > 容差 ${tolerance}`],
        };
    }
    judgePractice(method, codeResult) {
        if (!codeResult) {
            return { result: VerificationResult.INCONCLUSIVE, evidence: [], reasons: ['没有执行结果（code_result），不能声称代码/实验已通过'] };
        }
        const ok = Boolean(codeResult.ok);
        const evidence = {
            kind: method,
            exit_code: codeResult.exit_code ?? codeResult.exitCode ?? null,
            timed_out: Boolean(codeResult.timed_out ?? codeResult.timedOut),
            duration_ms: codeResult.duration_ms ?? codeResult.durationMs ?? null,
            environment: codeResult.environment ?? {},
            stdout_head: String(codeResult.stdout ?? '').slice(0, 500),
            stderr_head: String(codeResult.stderr ?? '').slice(0, 500),
            isolation: codeResult.isolation ?? 'process',
        };
        if (ok) {
            return { result: VerificationResult.PASS, evidence: [evidence], reasons: [`${method} 执行成功`] };
        }
        return {
            result: VerificationResult.FAIL, evidence: [evidence],
            reasons: [`${method} 执行失败（exit_code=${String(evidence.exit_code)}, timeout=${String(evidence.timed_out)}）`],
        };
    }
    judgeStatic(chunk) {
        const metadata = parseJsonObject(chunk.metadata);
        const blocks = Array.isArray(metadata.code_blocks) ? metadata.code_blocks : [];
        if (blocks.length === 0)
            return { result: VerificationResult.INCONCLUSIVE, reasons: ['没有可静态检查的代码块'] };
        const findings = [];
        for (const block of blocks) {
            const source = String(block.code ?? '');
            if (/\b(eval|exec)\s*\(/.test(source))
                findings.push('代码包含 eval/exec，存在执行风险');
            if (/\b(TODO|FIXME)\b/.test(source))
                findings.push('代码含 TODO/FIXME，可能未完成');
        }
        if (findings.length > 0)
            return { result: VerificationResult.PARTIAL, reasons: findings };
        // 静态检查只能说明「没发现明显问题」，永远不足以支撑 verified。
        return { result: VerificationResult.PARTIAL, reasons: ['静态检查未发现明显问题（这不等于代码正确，需执行验证才能升级）'] };
    }
    estimateConfidence(chunk, records, independence, requirementsMet) {
        const passed = records.filter((record) => record.result === VerificationResult.PASS);
        const parts = [];
        let value = 0.5 * Number(chunk.source_quality ?? 0);
        parts.push(`0.5*来源质量(${Number(chunk.source_quality).toFixed(2)})=${value.toFixed(3)}`);
        if (requirementsMet && passed.length > 0) {
            value += 0.2;
            parts.push('+0.2 证据达标');
        }
        if (independence) {
            const bonus = Math.min(0.2, 0.1 * independence);
            value += bonus;
            parts.push(`+${bonus.toFixed(2)} 独立来源=${independence}`);
        }
        if (passed.length > 0) {
            value += 0.1;
            parts.push('+0.1 核验通过');
        }
        if (chunk.conflict_status === 'confirmed') {
            value -= 0.15;
            parts.push('-0.15 存在确认冲突');
        }
        value = round(clamp(value, 0.05, 0.95), 3);
        parts.push(`= ${value}（上限 0.95，不允许 1.0）`);
        return { value, basis: parts.join('；') };
    }
    finishNonVerifiable(chunk, reasons) {
        const evidenceList = this.normalizeEvidence({
            ...chunk,
            metadata: {},
        }, []);
        const record = this.store.addVerification({
            record_id: newId('vrf'),
            chunk_id: chunk.chunk_id,
            method: VerificationMethod.MANUAL_REVIEW,
            result: VerificationResult.INCONCLUSIVE,
            evidence: evidenceList,
            notes: `${chunk.knowledge_type} 类型不可核验为事实；已记录来源以便追溯`,
            verifier: 'system',
        });
        reasons.push(`${chunk.knowledge_type} 属于观点/假设/未解决问题，系统不会把它标记为已验证事实`);
        const confidence = Math.min(Number(chunk.confidence ?? 0), 0.4);
        this.store.forceVerificationState(chunk.chunk_id, {
            verification_status: 'unverifiable',
            verification_method: VerificationMethod.MANUAL_REVIEW,
            verification_evidence: evidenceList,
            confidence,
            confidence_basis: '观点/假设类内容：只保留来源与论据，不判定为事实',
            updated_at: utcnowIso(),
        });
        return {
            chunk_id: chunk.chunk_id,
            method: VerificationMethod.MANUAL_REVIEW,
            result: VerificationResult.INCONCLUSIVE,
            status_before: chunk.status,
            status_after: chunk.status,
            level: chunk.level,
            confidence,
            confidence_basis: '观点/假设类内容不参与事实核验',
            evidence_count: 0,
            independence: evidenceList.length,
            record_id: record.record_id,
            reasons,
            warnings: ['该类型知识永远不能升级为 verified'],
            requirements: { min_evidence: 0, min_independent: 0, min_quality: 0, met: false },
        };
    }
}
function hostOf(url) {
    if (!url)
        return '';
    try {
        return new URL(url).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
export { allowedMethods };
