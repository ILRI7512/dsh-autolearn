/** 学习项目 / 任务 / 运行 的持久化访问（SQL 集中在此，避免散落）。 */
import { NotFoundError } from "../../core/errors.js";
import { newId, utcnowIso } from "../../core/ids.js";
import { parseJsonArray, parseJsonObject } from "../../core/json.js";
export class LearningRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    // ------------------------------------------------------------------ //
    // 项目
    // ------------------------------------------------------------------ //
    createProject(input) {
        const now = utcnowIso();
        const project = {
            project_id: newId('prj'),
            title: input.title,
            goal: input.goal,
            domain: input.domain,
            partitions: input.partitions,
            depth: input.depth,
            mode: input.mode,
            status: 'active',
            acceptance_criteria: input.acceptanceCriteria ?? [],
            deliverables: input.deliverables ?? [],
            allowed_sources: input.allowedSources ?? [],
            budget: input.budget ?? {},
            scope: { explicit_acceptance: (input.acceptanceCriteria ?? []).length > 0 },
            created_at: now,
            updated_at: now,
        };
        this.db.insert('projects', project);
        return this.getProject(project.project_id);
    }
    getProject(projectId) {
        return this.db.get('projects', projectId);
    }
    requireProject(projectId) {
        const project = this.getProject(projectId);
        if (!project)
            throw new NotFoundError(`项目不存在: ${projectId}`);
        return project;
    }
    listProjects(status) {
        const rows = status
            ? this.db.query('SELECT * FROM projects WHERE status=? ORDER BY created_at DESC', [status])
            : this.db.query('SELECT * FROM projects ORDER BY created_at DESC');
        return rows;
    }
    updateProject(projectId, fields) {
        this.db.update('projects', projectId, { ...fields, updated_at: utcnowIso() });
    }
    setProjectStatus(projectId, status) {
        this.requireProject(projectId);
        this.updateProject(projectId, { status });
        return this.getProject(projectId);
    }
    // ------------------------------------------------------------------ //
    // 任务
    // ------------------------------------------------------------------ //
    createTask(input) {
        const now = utcnowIso();
        const task = {
            task_id: newId('task'),
            project_id: input.projectId,
            kind: input.kind,
            title: input.title,
            objective: input.objective ?? '',
            inputs: input.inputs ?? {},
            steps: [],
            depends_on: input.dependsOn ?? [],
            expected_output: '',
            acceptance: input.acceptance ?? [],
            status: 'pending',
            priority: input.priority ?? 0.5,
            attempts: 0,
            max_retries: input.maxRetries ?? 3,
            timeout_s: input.timeoutSeconds ?? 300,
            error: '',
            result: {},
            iteration: input.iteration ?? 0,
            idempotency_key: input.idempotencyKey ?? '',
            started_at: '',
            finished_at: '',
            created_at: now,
            updated_at: now,
        };
        try {
            this.db.insert('tasks', task);
        }
        catch (error) {
            const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
            if (!message.includes('unique') && !message.includes('constraint'))
                throw error;
            if (!task.idempotency_key)
                throw error;
            const existing = this.db.query('SELECT * FROM tasks WHERE project_id=? AND idempotency_key=?', [input.projectId, task.idempotency_key])[0];
            if (!existing)
                throw error;
            return this.mapTask(existing);
        }
        return this.getTask(task.task_id);
    }
    mapTask(row) {
        return {
            ...row,
            inputs: parseJsonObject(row.inputs),
            steps: parseJsonArray(row.steps),
            depends_on: parseJsonArray(row.depends_on).map(String),
            acceptance: parseJsonArray(row.acceptance).map(String),
            result: parseJsonObject(row.result),
        };
    }
    getTask(taskId) {
        const row = this.db.get('tasks', taskId);
        return row ? this.mapTask(row) : null;
    }
    updateTask(taskId, fields) {
        this.db.update('tasks', taskId, { ...fields, updated_at: utcnowIso() });
    }
    listTasks(projectId, status, kind) {
        const clauses = ['project_id = ?'];
        const params = [projectId];
        if (status) {
            const list = Array.isArray(status) ? status : [status];
            if (list.length === 1) {
                clauses.push('status = ?');
                params.push(list[0]);
            }
            else if (list.length > 1) {
                clauses.push(`status IN (${list.map(() => '?').join(',')})`);
                params.push(...list);
            }
        }
        if (kind) {
            clauses.push('kind = ?');
            params.push(kind);
        }
        const rows = this.db.query(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY priority DESC, created_at ASC`, params);
        return rows.map((row) => this.mapTask(row));
    }
    /** 就绪任务：依赖必须全部 completed；priority DESC, created_at ASC。 */
    nextReadyTasks(projectId, limit = 10) {
        const candidates = this.listTasks(projectId, ['pending', 'retrying']);
        const completed = new Set(this.listTasks(projectId, 'completed').map((task) => task.task_id));
        const ready = candidates.filter((task) => task.depends_on.every((dep) => completed.has(dep)));
        return ready.slice(0, Math.max(1, limit));
    }
    taskCounts(projectId) {
        const rows = this.db.query('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id=? GROUP BY status', [projectId]);
        return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
    }
    blockDependents(taskId, projectId, reason) {
        const candidates = this.listTasks(projectId, ['pending', 'retrying']);
        let blocked = 0;
        for (const task of candidates) {
            if (!task.depends_on.includes(taskId))
                continue;
            this.updateTask(task.task_id, {
                status: 'blocked',
                error: `依赖任务 ${taskId} 永久失败，已阻塞：${reason}`.slice(0, 1000),
            });
            blocked += 1;
        }
        return blocked;
    }
    // ------------------------------------------------------------------ //
    // 运行
    // ------------------------------------------------------------------ //
    startRun(run) {
        this.db.insert('runs', run);
        return run;
    }
    finishRun(runId, status, summary, stopReason = '') {
        this.db.update('runs', runId, {
            status,
            summary,
            stop_reason: stopReason,
            finished_at: utcnowIso(),
        });
    }
    getRun(runId) {
        const row = this.db.get('runs', runId);
        return row;
    }
    lastRuns(projectId, limit = 5) {
        return this.db.query('SELECT * FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?', [projectId, limit]);
    }
    nextIteration(projectId) {
        const value = this.db.scalar('SELECT MAX(iteration) AS m FROM runs WHERE project_id=?', [projectId], 0);
        return Number(value ?? 0) + 1;
    }
    todaySpend() {
        const today = utcnowIso().slice(0, 10);
        return Number(this.db.scalar('SELECT SUM(cost_estimate) AS s FROM llm_calls WHERE ts LIKE ?', [`${today}%`], 0) ?? 0);
    }
    // ------------------------------------------------------------------ //
    // 指标
    // ------------------------------------------------------------------ //
    recordMetric(kind, name, value, projectId = '', runId = '', metadata = {}) {
        this.db.insert('metrics', {
            project_id: projectId,
            run_id: runId,
            kind,
            name,
            value,
            metadata,
            created_at: utcnowIso(),
        });
    }
    metricsSummary(projectId) {
        const rows = this.db.query(`SELECT kind, name, SUM(value) AS total, MAX(value) AS peak, COUNT(*) AS count
       FROM metrics WHERE project_id=? GROUP BY kind, name`, [projectId]);
        const out = {};
        for (const row of rows) {
            const kind = String(row.kind);
            out[kind] = out[kind] ?? {};
            out[kind][String(row.name)] = {
                total: Number(row.total ?? 0),
                peak: Number(row.peak ?? 0),
                count: Number(row.count ?? 0),
            };
        }
        return out;
    }
}
