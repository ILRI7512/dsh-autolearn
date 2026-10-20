/**
 * 业务服务层：模型可见的 10 个业务接口 + 1 个系统维护接口。
 *
 * 规则：
 * - 适配层只做参数校验与结果截断，不复制业务逻辑；
 * - 危险动作（删除/恢复/失效）必须经过 PermissionManager；
 * - 服务层不伪造成功：失败抛 AutolearnError，由适配层转成结构化错误。
 */
import { AutolearnError, ERROR_CODES, NotFoundError } from "../core/errors.js";
import { utcnowIso } from "../core/ids.js";
import { parseJsonObject } from "../core/json.js";
import { discover as discoverSources } from "../infrastructure/sources/discovery.js";
export class AutolearnServices {
    engine;
    constructor(engine) {
        this.engine = engine;
    }
    // ------------------------------------------------------------------ //
    // 1. learning_create
    // ------------------------------------------------------------------ //
    learningCreate(input) {
        const project = this.engine.orchestrator.createProject({
            goal: String(input.goal ?? ''),
            title: input.title === undefined ? undefined : String(input.title),
            domain: input.domain === undefined ? undefined : String(input.domain),
            depth: input.depth === undefined ? undefined : String(input.depth),
            mode: input.mode === undefined ? undefined : String(input.mode),
            partitions: Array.isArray(input.partitions) ? input.partitions.map(String) : undefined,
            acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map(String) : undefined,
            deliverables: Array.isArray(input.deliverables) ? input.deliverables.map(String) : undefined,
            allowedSources: Array.isArray(input.allowedSources) ? input.allowedSources.map(String) : undefined,
            budget: input.budget && typeof input.budget === 'object'
                ? input.budget
                : undefined,
        });
        let plan;
        if (input.plan !== false) {
            plan = this.engine.orchestrator.plan(String(project.project.project_id));
        }
        return { ...project, plan, warnings: input.plan === false ? [] : this.modelWarning(input) };
    }
    // ------------------------------------------------------------------ //
    // 2. learning_run
    // ------------------------------------------------------------------ //
    async learningRun(input) {
        const projectId = String(input.projectId ?? '');
        if (!projectId)
            throw new AutolearnError('learning_run 需要 projectId', { code: ERROR_CODES.VALIDATION_FAILED });
        const result = await this.engine.orchestrator.runRound(projectId, {
            maxTasks: input.maxTasks === undefined ? undefined : Number(input.maxTasks),
        });
        return { ...result, warnings: this.modelWarning(input) };
    }
    // ------------------------------------------------------------------ //
    // 3. learning_status
    // ------------------------------------------------------------------ //
    learningStatus(input) {
        const projectId = String(input.projectId ?? '');
        if (!projectId) {
            return {
                projects: this.engine.orchestrator.listProjects(input.status === undefined ? undefined : String(input.status)),
                engine: {
                    mode: this.engine.permissions.mode,
                    schema_version: this.engine.db.schemaVersion(),
                    chunks: this.engine.store.countChunks(),
                    pending_confirmations: this.engine.approval.pending().length,
                },
            };
        }
        const detail = this.engine.orchestrator.getProject(projectId);
        const evaluation = this.engine.evaluator.evaluate(projectId);
        const runs = this.engine.repo.lastRuns(projectId, 5);
        const tasks = this.engine.repo.listTasks(projectId);
        return {
            ...detail,
            progress: {
                metrics: evaluation.metrics,
                coverage_rate: evaluation.metrics.coverage_rate,
                goal_met: evaluation.goal_met,
                remaining: evaluation.remaining,
            },
            tasks_detail: tasks.slice(0, 50).map((task) => ({
                task_id: task.task_id, kind: task.kind, title: task.title, status: task.status,
                attempts: task.attempts, priority: task.priority, error: task.error.slice(0, 200),
            })),
            recent_runs: runs.map((run) => ({
                run_id: run.run_id, iteration: run.iteration, status: run.status,
                stop_reason: run.stop_reason, started_at: run.started_at,
                new_knowledge: Number(parseJsonObject(run.summary).new_knowledge ?? 0),
            })),
            gaps: this.engine.gaps.openGaps(projectId).slice(0, 20),
        };
    }
    // ------------------------------------------------------------------ //
    // 4. knowledge_search
    // ------------------------------------------------------------------ //
    knowledgeSearch(input) {
        const query = String(input.query ?? '').trim();
        if (!query)
            throw new AutolearnError('knowledge_search 需要 query', { code: ERROR_CODES.VALIDATION_FAILED });
        const filter = this.filterFrom(input);
        const outcome = this.engine.store.search(query, filter, {
            topK: input.topK === undefined ? undefined : Number(input.topK),
            mode: input.mode === undefined ? undefined : String(input.mode),
            includeContent: input.includeContent !== false,
        });
        const limit = Math.max(1, Number(this.engine.config.security.max_output_bytes));
        // 输出长度保护：内容按字节预算截断，避免把整库塞回模型上下文。
        let budget = limit;
        const results = outcome.results.map((item) => {
            if (item.content.length * 2 > budget) {
                budget = Math.max(0, budget - item.content.length * 2);
                return { ...item, content: `${item.content.slice(0, Math.max(200, Math.floor(budget / 2)))}…[truncated]` };
            }
            budget -= item.content.length * 2;
            return item;
        });
        return {
            ...outcome,
            results,
            hints: [
                '相似度只代表相关，不代表正确；使用 verified 之外的知识必须自行核验',
                outcome.gap ? '本次检索为空，这本身是一个知识缺口：可以创建学习任务补充资料' : '',
            ].filter(Boolean),
        };
    }
    filterFrom(input) {
        const raw = (input.filters ?? {});
        const projectId = input.projectId === undefined ? undefined : String(input.projectId);
        const list = (value) => Array.isArray(value) ? value.map(String) : undefined;
        return {
            projectId,
            projectIds: list(input.projectIds),
            includeAllProjects: input.includeAllProjects === true,
            statuses: list(raw.statuses),
            partitions: list(raw.partitions),
            domains: list(raw.domains),
            topics: list(raw.topics),
            subtopics: list(raw.subtopics),
            knowledgeTypes: list(raw.knowledgeTypes),
            levels: list(raw.levels),
            verificationStatuses: list(raw.verificationStatuses),
            sourceTypes: list(raw.sourceTypes),
            includeInvalidated: raw.includeInvalidated === true,
            limit: raw.limit === undefined ? undefined : Number(raw.limit),
        };
    }
    // ------------------------------------------------------------------ //
    // 5. knowledge_manage（危险动作不在此接口）
    // ------------------------------------------------------------------ //
    knowledgeManage(input) {
        const action = String(input.action ?? '');
        const projectId = String(input.projectId ?? '');
        switch (action) {
            case 'save': {
                if (!projectId)
                    throw new AutolearnError('save 需要 projectId', { code: ERROR_CODES.VALIDATION_FAILED });
                const items = Array.isArray(input.items)
                    ? input.items
                    : [{ ...input }];
                return this.engine.orchestrator.saveKnowledge(projectId, items);
            }
            case 'update': {
                const chunkId = String(input.chunkId ?? '');
                if (!chunkId)
                    throw new AutolearnError('update 需要 chunkId', { code: ERROR_CODES.VALIDATION_FAILED });
                const fields = (input.fields ?? {});
                const decision = this.engine.permissions.decide('update_knowledge', 'write', chunkId, {
                    projectId, content: String(fields.content ?? ''),
                });
                if (!decision.allowed)
                    throw new AutolearnError(decision.reason, { code: ERROR_CODES.POLICY_DENIED });
                const chunk = this.engine.store.updateChunk(chunkId, fields, String(input.reason ?? 'tool_update'));
                return { chunk_id: chunk.chunk_id, version: chunk.version, status: chunk.status, verification_status: chunk.verification_status };
            }
            case 'invalidate': {
                const chunkId = String(input.chunkId ?? '');
                if (!chunkId)
                    throw new AutolearnError('invalidate 需要 chunkId', { code: ERROR_CODES.VALIDATION_FAILED });
                this.assertDestructiveAllowed('invalidate_knowledge', chunkId, input, projectId);
                const chunk = this.engine.store.invalidateChunk(chunkId, String(input.reason ?? 'tool_invalidate'), String(input.supersededBy ?? ''));
                return { chunk_id: chunk.chunk_id, status: chunk.status, invalidated_at: chunk.invalidated_at };
            }
            case 'rollback': {
                const chunkId = String(input.chunkId ?? '');
                const version = Number(input.version ?? 0);
                if (!chunkId || !version)
                    throw new AutolearnError('rollback 需要 chunkId 与 version', { code: ERROR_CODES.VALIDATION_FAILED });
                this.assertDestructiveAllowed('rollback_knowledge', chunkId, input, projectId);
                const chunk = this.engine.store.rollbackVersion(chunkId, version);
                return { chunk_id: chunk.chunk_id, version: chunk.version, status: chunk.status };
            }
            case 'export': {
                const path = String(input.path ?? '');
                if (!path)
                    throw new AutolearnError('export 需要 path', { code: ERROR_CODES.VALIDATION_FAILED });
                const target = this.engine.pathPolicy.assertWritable(path);
                const format = String(input.format ?? 'jsonl');
                if (!['jsonl', 'json', 'csv'].includes(format)) {
                    throw new AutolearnError(`不支持的导出格式: ${format}`, { code: ERROR_CODES.VALIDATION_FAILED });
                }
                const decision = this.engine.permissions.decide('export_knowledge', 'write', target, { projectId });
                if (!decision.allowed)
                    throw new AutolearnError(decision.reason, { code: ERROR_CODES.POLICY_DENIED });
                return this.engine.store.export(target, format, this.filterFrom({ projectId }));
            }
            case 'get': {
                const chunkId = String(input.chunkId ?? '');
                const chunk = this.engine.store.getChunk(chunkId);
                if (!chunk)
                    throw new NotFoundError(`知识片段不存在: ${chunkId}`);
                return { chunk, versions: this.engine.store.listVersions(chunkId), records: this.engine.store.listVerifications(chunkId) };
            }
            case 'partitions':
                return { partitions: this.engine.store.partitionStats(projectId || undefined) };
            default:
                throw new AutolearnError(`未知 action: ${action}（允许 save/update/invalidate/rollback/export/get/partitions）`, { code: ERROR_CODES.VALIDATION_FAILED });
        }
    }
    // ------------------------------------------------------------------ //
    // 6. knowledge_verify
    // ------------------------------------------------------------------ //
    knowledgeVerify(input) {
        const action = String(input.action ?? 'verify');
        const projectId = String(input.projectId ?? '');
        switch (action) {
            case 'verify': {
                const chunkId = String(input.chunkId ?? '');
                const chunk = this.engine.store.getChunk(chunkId);
                if (!chunk)
                    throw new NotFoundError(`知识片段不存在: ${chunkId}`);
                return { ...this.engine.verifier.verify(chunkId, {
                        method: input.method === undefined ? undefined : String(input.method),
                        evidence: Array.isArray(input.evidence) ? input.evidence : undefined,
                        // 模型通道永远以 system 身份核验：人工复核必须走用户侧通道，不能由模型自称。
                        verifier: 'system',
                    }) };
            }
            case 'verify_formula': {
                const chunkId = String(input.chunkId ?? '');
                const expected = Number(input.expected);
                if (!Number.isFinite(expected)) {
                    throw new AutolearnError('verify_formula 需要有限数值 expected', { code: ERROR_CODES.VALIDATION_FAILED });
                }
                return { ...this.engine.verifier.verifyFormula(chunkId, {
                        expression: input.expression === undefined ? undefined : String(input.expression),
                        variables: (input.variables ?? {}),
                        expected,
                        tolerance: input.tolerance === undefined ? undefined : Number(input.tolerance),
                    }) };
            }
            case 'list_evidence': {
                const chunkId = String(input.chunkId ?? '');
                return {
                    chunk_id: chunkId,
                    records: this.engine.store.listVerifications(chunkId),
                    versions: this.engine.store.listVersions(chunkId),
                };
            }
            case 'find_duplicates': {
                const pairs = this.engine.store.findDuplicates({
                    chunkId: input.chunkId === undefined ? undefined : String(input.chunkId),
                    filter: { projectId },
                    threshold: input.threshold === undefined ? undefined : Number(input.threshold),
                });
                let recorded = 0;
                for (const pair of pairs) {
                    if (this.engine.db.query('SELECT dup_id FROM duplicates WHERE (chunk_a=? AND chunk_b=?) OR (chunk_a=? AND chunk_b=?)', [pair.chunk_a, pair.chunk_b, pair.chunk_b, pair.chunk_a]).length > 0)
                        continue;
                    this.engine.db.insert('duplicates', {
                        dup_id: `dup_${Date.now().toString(36)}_${recorded}`,
                        project_id: projectId,
                        chunk_a: pair.chunk_a, chunk_b: pair.chunk_b,
                        similarity: pair.similarity, reason: pair.reason,
                        status: 'open', created_at: utcnowIso(),
                    });
                    recorded += 1;
                }
                return { pairs: pairs.slice(0, 100), recorded };
            }
            case 'detect_conflicts': {
                return detectConflictsImpl(this.engine, projectId);
            }
            default:
                throw new AutolearnError(`未知 action: ${action}（允许 verify/verify_formula/list_evidence/find_duplicates/detect_conflicts）`, { code: ERROR_CODES.VALIDATION_FAILED });
        }
    }
    // ------------------------------------------------------------------ //
    // 7. source_manage
    // ------------------------------------------------------------------ //
    async sourceManage(input) {
        const action = String(input.action ?? 'discover');
        const projectId = String(input.projectId ?? '');
        if (action === 'discover') {
            const topics = Array.isArray(input.topics) ? input.topics.map(String) : [];
            const locations = Array.isArray(input.locations) ? input.locations.map(String) : [];
            const found = await discoverSources({
                topics, explicitLocations: locations,
                keywords: topics,
                corpusDir: this.engine.config.paths.corpus_dir,
                limit: input.limit === undefined ? 30 : Number(input.limit),
                allowNetwork: this.engine.config.security.allow_network,
            });
            return found;
        }
        if (action === 'read') {
            const locations = Array.isArray(input.locations) ? input.locations.map(String) : [];
            if (locations.length === 0)
                throw new AutolearnError('read 需要 locations', { code: ERROR_CODES.VALIDATION_FAILED });
            const results = [];
            for (const location of locations) {
                const decision = this.engine.permissions.decide('read_source', 'read', location, { projectId });
                if (!decision.allowed) {
                    results.push({ location, ok: false, error: decision.reason });
                    continue;
                }
                const read = await this.engine.reader.read(location);
                if (read.ok && input.persist !== false && projectId) {
                    const ingested = this.engine.orchestrator.ingestDocument(projectId, read, String(input.topic ?? ''));
                    results.push({ ...summarizeRead(read), ingest: ingested });
                }
                else {
                    results.push(summarizeRead(read));
                }
            }
            return { results };
        }
        if (action === 'list') {
            const rows = this.engine.db.query(projectId
                ? 'SELECT source_id, source_type, location, title, quality, license_status, freshness_status, fetch_ok, error, accessed_at FROM sources WHERE project_id=? ORDER BY created_at DESC LIMIT 200'
                : 'SELECT source_id, source_type, location, title, quality, license_status, freshness_status, fetch_ok, error, accessed_at FROM sources ORDER BY created_at DESC LIMIT 200', projectId ? [projectId] : []);
            return { sources: rows };
        }
        throw new AutolearnError(`未知 action: ${action}（允许 discover/read/list）`, { code: ERROR_CODES.VALIDATION_FAILED });
    }
    // ------------------------------------------------------------------ //
    // 8. learning_evaluate
    // ------------------------------------------------------------------ //
    learningEvaluate(input) {
        const projectId = String(input.projectId ?? '');
        if (!projectId)
            throw new AutolearnError('learning_evaluate 需要 projectId', { code: ERROR_CODES.VALIDATION_FAILED });
        const evaluation = this.engine.evaluator.evaluate(projectId);
        let report;
        if (input.includeReport === true)
            report = this.engine.report.generate(projectId);
        return { evaluation, report };
    }
    // ------------------------------------------------------------------ //
    // 9. learning_review
    // ------------------------------------------------------------------ //
    learningReview(input) {
        const projectId = String(input.projectId ?? '');
        if (!projectId)
            throw new AutolearnError('learning_review 需要 projectId', { code: ERROR_CODES.VALIDATION_FAILED });
        const project = this.engine.repo.requireProject(projectId);
        const failed = this.engine.db.query("SELECT task_id, kind, title, attempts, max_retries, error, updated_at FROM tasks WHERE project_id=? AND status IN ('failed','blocked') ORDER BY updated_at DESC LIMIT 50", [projectId]);
        const exhausted = this.engine.db.query("SELECT task_id, kind, title, attempts, max_retries, error FROM tasks WHERE project_id=? AND status='retrying' AND attempts > max_retries", [projectId]);
        const conflicts = this.engine.db.query("SELECT conflict_id, kind, detail, status, created_at FROM conflicts WHERE project_id=? AND status='open'", [projectId]);
        const gaps = this.engine.gaps.openGaps(projectId).slice(0, 20);
        const audit = this.engine.audit.tail(20, projectId);
        const actions = [];
        if (input.action === 'retry_failed') {
            this.assertDestructiveAllowed('retry_failed_task', projectId, input, projectId);
            let reset = 0;
            for (const row of failed) {
                this.engine.repo.updateTask(String(row.task_id), { status: 'pending', error: '', started_at: '', finished_at: '' });
                reset += 1;
            }
            actions.push({ action: 'retry_failed', reset });
        }
        return {
            project: { project_id: project.project_id, goal: project.goal, status: project.status },
            failed_tasks: failed,
            exhausted_retries: exhausted,
            open_conflicts: conflicts,
            open_gaps: gaps,
            audit_tail: audit,
            actions,
            recommendations: this.recommendations(failed.length, conflicts.length, gaps.length),
        };
    }
    recommendations(failed, conflicts, gaps) {
        const out = [];
        if (failed > 0)
            out.push('先修复失败任务：查看 error 字段，必要时用 retry_failed 重置（会消耗重试预算）');
        if (conflicts > 0)
            out.push('开放冲突需要人工或交叉来源裁定；不要直接删除争议知识');
        if (gaps > 0)
            out.push('缺口已登记：可执行 learning_run 让计划器生成补充任务');
        out.push('核验不通过时不要放宽证据门槛；应补充独立来源或改用更强的核验方法');
        return out;
    }
    // ------------------------------------------------------------------ //
    // 10. system_diagnostics
    // ------------------------------------------------------------------ //
    systemDiagnostics() {
        const diagnostics = this.engine.diagnostics();
        const recentErrors = this.engine.db.query("SELECT ts, action, target, detail FROM audit_log WHERE allowed=0 ORDER BY id DESC LIMIT 20");
        return {
            ...diagnostics,
            tools: this.engine.services.toolNames(),
            recent_denials: recentErrors,
            python_runtime: { required: false, note: '业务逻辑已全部在 TypeScript 引擎内，不需要 Python 运行时' },
        };
    }
    // ------------------------------------------------------------------ //
    // 11. system_maintenance（危险动作独立入口）
    // ------------------------------------------------------------------ //
    systemMaintenance(input) {
        const action = String(input.action ?? '');
        const projectId = String(input.projectId ?? '');
        switch (action) {
            case 'integrity':
                return this.engine.store.checkIntegrity();
            case 'rebuild_index': {
                this.assertDestructiveAllowed('rebuild_vector_index', 'index', input, projectId);
                return this.engine.index.rebuild(this.engine.db);
            }
            case 'backup': {
                const dest = String(input.destDir ?? '');
                if (!dest)
                    throw new AutolearnError('backup 需要 destDir', { code: ERROR_CODES.VALIDATION_FAILED });
                const target = this.engine.pathPolicy.assertWritable(dest);
                const decision = this.engine.permissions.decide('backup_knowledge_base', 'write', target, { projectId });
                if (!decision.allowed)
                    throw new AutolearnError(decision.reason, { code: ERROR_CODES.POLICY_DENIED });
                return this.engine.store.backup(target, String(input.note ?? ''));
            }
            case 'verify_backup': {
                const manifest = String(input.manifestPath ?? '');
                if (!manifest)
                    throw new AutolearnError('verify_backup 需要 manifestPath', { code: ERROR_CODES.VALIDATION_FAILED });
                return this.engine.store.verifyBackup(manifest);
            }
            case 'restore': {
                const dbFile = String(input.dbFile ?? '');
                if (!dbFile)
                    throw new AutolearnError('restore 需要 dbFile', { code: ERROR_CODES.VALIDATION_FAILED });
                this.engine.pathPolicy.assertWritable(dbFile);
                this.assertDestructiveAllowed('restore_knowledge_base', dbFile, input, projectId);
                return this.engine.orchestrator.restoreBackup(dbFile, input.indexDir === undefined ? undefined : String(input.indexDir), input.manifestPath === undefined ? undefined : String(input.manifestPath));
            }
            case 'delete_chunk': {
                const chunkId = String(input.chunkId ?? '');
                if (!chunkId)
                    throw new AutolearnError('delete_chunk 需要 chunkId', { code: ERROR_CODES.VALIDATION_FAILED });
                this.assertDestructiveAllowed('delete_chunk', chunkId, input, projectId);
                return { chunk_id: chunkId, deleted: this.engine.store.deleteChunk(chunkId) };
            }
            case 'vacuum':
                this.engine.db.executeWrite('VACUUM');
                return { vacuumed: true };
            default:
                throw new AutolearnError(`未知 action: ${action}（允许 integrity/rebuild_index/backup/verify_backup/restore/delete_chunk/vacuum）`, { code: ERROR_CODES.VALIDATION_FAILED });
        }
    }
    // ------------------------------------------------------------------ //
    assertDestructiveAllowed(action, target, input, projectId) {
        const decision = this.engine.permissions.decide(action, 'destructive', target, {
            projectId,
            confirmedToken: input.confirmToken === undefined ? undefined : String(input.confirmToken),
        });
        if (!decision.allowed) {
            const hint = decision.needs_confirmation
                ? `该操作需要用户确认；请让用户运行 CLI approve 或在 DSH 审批弹窗中批准（令牌作用域: ${action} / ${target}）`
                : decision.reason;
            throw new AutolearnError(hint, {
                code: decision.needs_confirmation ? ERROR_CODES.APPROVAL_REQUIRED : ERROR_CODES.POLICY_DENIED,
                details: { ...decision, action, target },
            });
        }
    }
    modelWarning(input) {
        return input.useModel === true
            ? ['模型辅助（主题补充/抽取提议）本次重构未迁移；已按纯规则链路执行，use_model 被忽略']
            : [];
    }
    toolNames() {
        return [
            'learning_create', 'learning_run', 'learning_status', 'knowledge_search',
            'knowledge_manage', 'knowledge_verify', 'source_manage', 'learning_evaluate',
            'learning_review', 'system_diagnostics', 'system_maintenance',
        ];
    }
}
function summarizeRead(read) {
    return {
        location: read.location, ok: read.ok, title: read.title, doc_type: read.doc_type,
        source_type: read.source_type, quality: read.quality, license_status: read.license_status,
        freshness_status: read.freshness_status, chars: read.char_count, preview: read.preview,
        error: read.error, not_modified: read.not_modified,
    };
}
function detectConflictsImpl(engine, projectId) {
    const chunks = engine.store.listChunks({ projectId, limit: 300 });
    const findings = [];
    let recorded = 0;
    for (let i = 0; i < chunks.length; i += 1) {
        for (let j = i + 1; j < chunks.length; j += 1) {
            const a = chunks[i];
            const b = chunks[j];
            if (a.content_hash && a.content_hash === b.content_hash)
                continue;
            const finding = compareChunks(a, b);
            if (!finding)
                continue;
            findings.push({ chunk_a: a.chunk_id, chunk_b: b.chunk_id, ...finding });
            if (engine.db.query('SELECT conflict_id FROM conflicts WHERE (chunk_a=? AND chunk_b=?) OR (chunk_a=? AND chunk_b=?)', [a.chunk_id, b.chunk_id, b.chunk_id, a.chunk_id]).length === 0) {
                engine.db.insert('conflicts', {
                    conflict_id: `cfl_${Date.now().toString(36)}_${recorded}`,
                    project_id: projectId,
                    chunk_a: a.chunk_id, chunk_b: b.chunk_id,
                    kind: String(finding.kind), detail: String(finding.detail),
                    status: 'open', evidence: [finding],
                    resolution: '', created_at: utcnowIso(), resolved_at: '',
                });
                for (const id of [a.chunk_id, b.chunk_id]) {
                    engine.db.update('chunks', id, { conflict_status: 'potential', updated_at: utcnowIso() });
                }
                recorded += 1;
            }
            if (findings.length >= 100)
                break;
        }
    }
    return { scanned: chunks.length, findings: findings.slice(0, 100), recorded };
}
const NUMERIC_RE = /(-?\d+(?:\.\d+)?)\s*(%|％|倍|ms|毫秒|秒|px|dp|sp|美元|元|手|点|天|年|个月)?/g;
const NEGATORS = ['不', '未', '没有', '无', '非', '无法', '不能', '禁止', '不应', 'not ', 'no ', 'never', "cannot", "don't", "doesn't"];
const POLARITY_PAIRS = [
    ['支持', '不支持'], ['允许', '不允许'], ['可以', '不可以'], ['推荐', '不推荐'],
    ['有效', '无效'], ['增加', '减少'], ['高于', '低于'], ['大于', '小于'],
    ['正向', '反向'], ['should', 'should not'], ['increase', 'decrease'], ['valid', 'invalid'],
];
function compareChunks(a, b) {
    const textA = `${a.title}\n${a.content}`;
    const textB = `${b.title}\n${b.content}`;
    // 数值矛盾：同一语境 ±2% 才判定为冲突
    const claimsA = numericClaims(textA);
    const claimsB = numericClaims(textB);
    for (const claimA of claimsA) {
        for (const claimB of claimsB) {
            if (claimA.unit !== claimB.unit || claimA.position !== claimB.position)
                continue;
            if (overlap(claimA.context, claimB.context) < 0.55)
                continue;
            const diff = Math.abs(claimA.value - claimB.value);
            if (diff > Math.max(1e-9, Math.abs(claimA.value) * 0.02)) {
                return {
                    kind: 'numeric',
                    detail: `同一语境下数值不一致: ${claimA.value}${claimA.unit} vs ${claimB.value}${claimB.unit}`,
                    evidence: [
                        { chunk_id: a.chunk_id, sentence: claimA.sentence, value: claimA.value },
                        { chunk_id: b.chunk_id, sentence: claimB.sentence, value: claimB.value },
                    ],
                };
            }
        }
    }
    // 极性矛盾
    for (const [positive, negative] of POLARITY_PAIRS) {
        const polarityA = polarityOf(textA, positive, negative);
        const polarityB = polarityOf(textB, positive, negative);
        if (polarityA === 0 || polarityB === 0)
            continue;
        if (polarityA !== polarityB) {
            return {
                kind: 'polarity',
                detail: `极性表述相反: 「${polarityA > 0 ? positive : negative}」vs「${polarityB > 0 ? positive : negative}」`,
                evidence: [{ chunk_id: a.chunk_id, polarity: polarityA }, { chunk_id: b.chunk_id, polarity: polarityB }],
            };
        }
    }
    // 显式否定
    const baseA = stripNegation(textA);
    if (baseA && textB.includes(baseA.slice(0, 120)) && hasNegation(textA) !== hasNegation(textB)) {
        return { kind: 'negation', detail: '一方明确否定另一方的陈述', evidence: [{ chunk_id: a.chunk_id }, { chunk_id: b.chunk_id }] };
    }
    return null;
}
function numericClaims(text) {
    const out = [];
    for (const sentence of text.split(/(?<=[。！？；;])\s*|(?<=[.!?])(?=\s)|\n/)) {
        let position = 0;
        for (const match of sentence.matchAll(NUMERIC_RE)) {
            const value = Number(match[1]);
            if (!Number.isFinite(value))
                continue;
            const context = Array.from(new Set(sentence.replace(NUMERIC_RE, ' ').split(/\s+/).filter(Boolean))).sort().join(' ');
            if (context.split(' ').filter(Boolean).length < 2) {
                position += 1;
                continue;
            }
            out.push({ context, position, value, unit: match[2] ?? '', sentence: sentence.trim().slice(0, 200) });
            position += 1;
        }
    }
    return out;
}
function overlap(a, b) {
    const sa = new Set(a.split(' ').filter(Boolean));
    const sb = new Set(b.split(' ').filter(Boolean));
    if (sa.size === 0 || sb.size === 0)
        return 0;
    let hit = 0;
    for (const item of sa)
        if (sb.has(item))
            hit += 1;
    return hit / Math.min(sa.size, sb.size);
}
function polarityOf(text, positive, negative) {
    // 负向词优先（与旧版一致：同一组只记一个方向）
    if (text.includes(negative))
        return -1;
    if (text.includes(positive))
        return 1;
    return 0;
}
function hasNegation(text) {
    return NEGATORS.some((item) => text.includes(item));
}
function stripNegation(text) {
    let out = text;
    for (const item of NEGATORS)
        out = out.split(item).join(' ');
    return out.replace(/\s+/g, ' ').trim();
}
