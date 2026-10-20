/**
 * 引擎装配：唯一的依赖注入点。
 *
 * 入口（DSH 原生 Tools / MCP / CLI）都只拿这个对象，
 * 业务逻辑不在适配层复制——这是「单一引擎」约束的落地。
 */
import { mkdirSync } from 'node:fs';
import { loadConfig, ensurePaths, applyHostSettings } from "./core/config.js";
import { AutolearnError, ERROR_CODES } from "./core/errors.js";
import { Database } from "./infrastructure/database/database.js";
import { SCHEMA_VERSION } from "./infrastructure/database/schema.js";
import { HashingEmbedder } from "./infrastructure/embeddings/hashing-embedder.js";
import { VectorIndex } from "./infrastructure/embeddings/vector-index.js";
import { bm25Search } from "./infrastructure/retrieval/bm25.js";
import { tokenize } from "./infrastructure/retrieval/tokenizer.js";
import { KnowledgeStore } from "./domain/knowledge/store.js";
import { KnowledgeVerifier } from "./domain/learning/verifier.js";
import { LearningPlanner } from "./domain/learning/planner.js";
import { LearningRepository } from "./domain/learning/repository.js";
import { GapAnalyzer } from "./domain/learning/gaps.js";
import { LearningEvaluator } from "./domain/learning/evaluator.js";
import { LearningOrchestrator } from "./domain/learning/orchestrator.js";
import { ReportGenerator } from "./domain/learning/report.js";
import { PracticeGenerator } from "./domain/practice/generator.js";
import { CodeTestRunner } from "./domain/practice/runner.js";
import { SourceReader } from "./infrastructure/sources/reader.js";
import { AuditLogger } from "./security/audit.js";
import { ApprovalService } from "./security/approval.js";
import { PathPolicy } from "./security/paths.js";
import { PermissionManager } from "./security/permissions.js";
import { describeNetworkPolicy } from "./security/network.js";
import { describeSandbox } from "./security/sandbox.js";
import { ensurePartitionAllowed, describePartitions } from "./domain/knowledge/domains.js";
import { AutolearnServices } from "./application/services.js";
export class AutolearnEngine {
    config;
    db;
    store;
    repo;
    verifier;
    planner;
    gaps;
    evaluator;
    orchestrator;
    report;
    practice;
    runner;
    reader;
    permissions;
    audit;
    approval;
    pathPolicy;
    index;
    services;
    hostApproval;
    closed = false;
    constructor(config, hostApproval, telemetry) {
        this.config = config;
        this.hostApproval = hostApproval;
        ensurePaths(config.paths);
        this.db = new Database(config.paths.db_path);
        this.db.migrate();
        this.audit = new AuditLogger(this.db, {
            enabled: config.security.audit_log,
            sink: (line) => telemetry?.('audit', { line }),
        });
        this.approval = new ApprovalService(this.db, { audit: this.audit });
        this.pathPolicy = new PathPolicy({
            allowedRoots: config.security.allowed_roots,
            dataDir: config.paths.data_dir,
        });
        this.permissions = new PermissionManager({
            security: config.security,
            learning: config.learning,
            pathPolicy: this.pathPolicy,
            approvals: this.approval,
            audit: this.audit,
            mode: config.learning.default_mode,
            delegateToHost: hostApproval,
        });
        const embedder = new HashingEmbedder(config.embedding.dim, config.embedding.model || 'hashed-ngram');
        this.index = new VectorIndex({
            indexDir: config.paths.index_dir,
            embedder,
            cache: config.embedding.cache,
            maxCacheEntries: config.embedding.max_cache_entries,
        });
        this.index.load();
        this.store = new KnowledgeStore(this.db, this.index, config.retrieval);
        this.repo = new LearningRepository(this.db);
        this.verifier = new KnowledgeVerifier(this.store);
        this.planner = new LearningPlanner(this.repo, config.learning);
        this.gaps = new GapAnalyzer(this.db, this.store, this.repo);
        this.evaluator = new LearningEvaluator(this.db, this.store, this.repo, this.gaps);
        this.practice = new PracticeGenerator(this.db, this.store);
        this.runner = new CodeTestRunner({
            timeoutSeconds: config.security.exec_timeout_s,
            maxOutputBytes: config.security.max_output_bytes,
            experimentsDir: config.paths.experiments_dir,
            pathPolicy: this.pathPolicy,
            sandboxMode: config.security.exec_sandbox,
            memoryMb: config.security.exec_memory_mb,
            artifactMb: config.security.exec_artifact_mb,
        });
        this.report = new ReportGenerator({
            db: this.db, repo: this.repo, evaluator: this.evaluator, gaps: this.gaps,
            reportsDir: config.paths.reports_dir,
        });
        this.reader = new SourceReader({
            pathPolicy: this.pathPolicy,
            network: this.networkOptions(),
            maxBytes: config.security.max_download_bytes,
            maxChars: config.learning.max_doc_chars,
            allowNetwork: config.security.allow_network,
        });
        this.orchestrator = new LearningOrchestrator({
            config, db: this.db, store: this.store, repo: this.repo, planner: this.planner,
            gaps: this.gaps, evaluator: this.evaluator, verifier: this.verifier, reader: this.reader,
            practice: this.practice, runner: this.runner, report: this.report,
            permissions: this.permissions, audit: this.audit, pathPolicy: this.pathPolicy, telemetry,
            reloadSettings: () => this.reloadHostSettings(),
        });
        this.services = new AutolearnServices(this);
    }
    static open(options = {}) {
        const config = options.config ?? loadConfig({ home: options.home, env: options.env });
        mkdirSync(config.paths.data_dir, { recursive: true });
        return new AutolearnEngine(config, options.hostApproval ?? false, options.telemetry);
    }
    networkOptions() {
        const security = this.config.security;
        return {
            allowNetwork: security.allow_network,
            allowedDomains: security.allowed_domains,
            allowPrivateNetworks: security.allow_private_networks,
            maxRedirects: security.max_redirects,
            maxBytes: security.max_download_bytes,
            allowedContentTypes: security.allowed_content_types,
        };
    }
    get hostApprovalActive() {
        return this.hostApproval;
    }
    /**
     * 仅在 DSH 适配层成功注册 `tools/pre-execute` 审批 hook 后调用。
     * 没有 hook 就开启委托，等于把 destructive 自动放行（vNext 审计 SEC-09）。
     */
    enableHostApproval() {
        this.permissions.setDelegateToHost(true);
        this.hostApproval = true;
    }
    /**
     * 宿主设置卡热生效：模式与每日预算在每轮开始时重读（与旧版行为一致）。
     * 只接受白名单键，非法值被忽略；dataDir 变更仍需重启（数据库已打开）。
     */
    reloadHostSettings(env = process.env) {
        const applied = applyHostSettings(this.config, this.config.paths.home, env);
        if (typeof applied.mode === 'string')
            this.permissions.setMode(applied.mode);
        return applied;
    }
    /** 插件的所有句柄都在这里释放：数据库连接 + 索引文件锁。 */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.db.close();
    }
    get isClosed() {
        return this.closed;
    }
    diagnostics() {
        if (this.closed) {
            throw new AutolearnError('引擎已关闭', { code: ERROR_CODES.INVALID_STATE });
        }
        const storage = this.db.stats();
        const integrity = this.store.checkIntegrity();
        return {
            ok: Boolean(integrity.database?.ok),
            schema_version: this.db.schemaVersion(),
            schema_supported: SCHEMA_VERSION,
            paths: {
                home: this.config.paths.home,
                data_dir: this.config.paths.data_dir,
                db_path: this.config.paths.db_path,
                index_dir: this.config.paths.index_dir,
                corpus_dir: this.config.paths.corpus_dir,
            },
            config: {
                mode: this.permissions.mode,
                network: this.config.security.allow_network,
                embedding: this.config.embedding.provider,
                model: this.config.model.provider,
                daily_budget_usd: this.config.learning.daily_budget_usd,
                max_tasks_per_run: this.config.learning.max_tasks_per_run,
                host_approval: this.hostApproval,
            },
            permissions: {
                mode: this.permissions.mode,
                allowed_roots: this.pathPolicy.allowedRoots,
                delegate_to_host: this.hostApproval,
                pending_confirmations: this.approval.pending().length,
            },
            network: describeNetworkPolicy(this.networkOptions()),
            execution: describeSandbox(),
            storage: { ...storage, counts: storage },
            integrity,
            index: this.index.stats(),
            tools: [],
            partitions: describePartitions(),
        };
    }
    // 供服务层复用的内部能力
    assertPartitionAllowed(project, partition) {
        ensurePartitionAllowed(project, partition);
    }
    bm25(query, allowed, topK = 20) {
        return bm25Search(this.db, query, allowed, topK);
    }
    tokenize(text) {
        return tokenize(text);
    }
}
export { loadConfig, AutolearnServices };
