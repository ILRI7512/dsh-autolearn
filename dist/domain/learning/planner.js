/**
 * 学习计划器：目标 → 主题 → 4 阶段任务链 + 收尾任务。
 *
 * 幂等：每个任务都有稳定 idempotency_key，重复规划返回既有任务而不是翻倍。
 * 注意：run_round 的真实调度用 nextReadyTasks（priority DESC），
 * priorities() 只给调用方做展示/批量调整。
 */
import { round } from "../../core/ids.js";
import { REGISTRY } from "../knowledge/domains.js";
const DEPTH_TOPIC_LIMIT = { overview: 3, working: 5, deep: 8 };
const ACTION_PREFIXES = ['学习', '建立', '总结', '验证', '生成', '区分', '完成', '掌握', '研究', '构建', '要求'];
export class LearningPlanner {
    repo;
    config;
    constructor(repo, config) {
        this.repo = repo;
        this.config = config;
    }
    decomposeGoal(goal, options = {}) {
        const domain = options.domain ?? 'general';
        const depth = options.depth ?? 'working';
        const limit = DEPTH_TOPIC_LIMIT[depth] ?? 5;
        const templates = REGISTRY.topicTemplates(domain);
        const topics = templates.slice(0, limit).map((name) => ({ name, subtopics: [], origin: 'template' }));
        const dropped = [];
        const segments = goal.split(/[，,、；;。.\n]|以及|并且/);
        for (const raw of segments) {
            const segment = raw.trim().replace(/^[：:*-]+|[：:*-]+$/g, '');
            if (segment.length < 3 || segment.length > 40)
                continue;
            if (ACTION_PREFIXES.some((prefix) => segment.startsWith(prefix)) && segment.length > 12) {
                dropped.push(segment);
                continue;
            }
            if (topics.some((topic) => topic.name.includes(segment)))
                continue;
            topics.push({ name: segment, subtopics: [], origin: 'goal' });
            if (topics.length >= limit + 2)
                break;
        }
        const selected = topics.slice(0, Math.max(limit, 3));
        return {
            goal,
            domain,
            depth,
            topics: selected,
            dropped,
            basis: `领域模板 ${domain} 提供 ${templates.length} 个主题；目标文本补充 ${selected.filter((t) => t.origin === 'goal').length} 个`,
        };
    }
    createPlan(project) {
        const decomposition = this.decomposeGoal(project.goal, { domain: project.domain, depth: project.depth });
        const tasks = [];
        const topicTasks = [];
        decomposition.topics.forEach((topic, order) => {
            const base = round(Math.max(0.2, 1 - order * 0.12), 3);
            const discover = this.repo.createTask({
                projectId: project.project_id, kind: 'discover', title: `发现资料：${topic.name}`,
                inputs: { topic: topic.name, subtopics: topic.subtopics },
                acceptance: ['至少 1 个来源被成功记录', '每个来源都有类型、质量与许可判定'],
                priority: base, maxRetries: this.config.max_retries_per_task,
                timeoutSeconds: this.config.max_task_seconds,
                idempotencyKey: `discover::${project.project_id}::${topic.name}`,
            });
            const extract = this.repo.createTask({
                projectId: project.project_id, kind: 'extract', title: `提取知识：${topic.name}`,
                inputs: { topic: topic.name }, dependsOn: [discover.task_id],
                acceptance: ['至少 1 条知识进入待核验区', '每条知识都有来源与内容指纹'],
                priority: round(base - 0.02, 3), maxRetries: this.config.max_retries_per_task,
                timeoutSeconds: this.config.max_task_seconds,
                idempotencyKey: `extract::${project.project_id}::${topic.name}`,
            });
            const verify = this.repo.createTask({
                projectId: project.project_id, kind: 'verify', title: `核验知识：${topic.name}`,
                inputs: { topic: topic.name }, dependsOn: [extract.task_id],
                acceptance: ['每条待核验知识都有核验记录或明确失败原因', 'verified 必须满足证据门槛'],
                priority: round(base - 0.04, 3), maxRetries: this.config.max_retries_per_task,
                timeoutSeconds: this.config.max_task_seconds,
                idempotencyKey: `verify::${project.project_id}::${topic.name}`,
            });
            const practice = this.repo.createTask({
                projectId: project.project_id, kind: 'practice', title: `实践检验：${topic.name}`,
                inputs: { topic: topic.name }, dependsOn: [verify.task_id],
                acceptance: ['公式需重算通过或明确记录无法重算', '代码需执行并记录环境与输出'],
                priority: round(base - 0.06, 3), maxRetries: this.config.max_retries_per_task,
                timeoutSeconds: this.config.max_task_seconds,
                idempotencyKey: `practice::${project.project_id}::${topic.name}`,
            });
            tasks.push(discover, extract, verify, practice);
            topicTasks.push({ discover, extract, verify, practice });
        });
        const gap = this.repo.createTask({
            projectId: project.project_id, kind: 'gap_analysis', title: '分析知识缺口',
            priority: 0.8, maxRetries: this.config.max_retries_per_task,
            timeoutSeconds: this.config.max_task_seconds,
            idempotencyKey: `gap::${project.project_id}::v1`,
        });
        const evaluate = this.repo.createTask({
            projectId: project.project_id, kind: 'evaluate', title: '评估学习成果',
            dependsOn: [gap.task_id], priority: 0.9, maxRetries: this.config.max_retries_per_task,
            timeoutSeconds: this.config.max_task_seconds,
            idempotencyKey: `evaluate::${project.project_id}::v1`,
        });
        const report = this.repo.createTask({
            projectId: project.project_id, kind: 'report', title: '生成学习报告',
            dependsOn: [evaluate.task_id], priority: 1.0, maxRetries: this.config.max_retries_per_task,
            timeoutSeconds: this.config.max_task_seconds,
            idempotencyKey: `report::${project.project_id}::v1`,
        });
        tasks.push(gap, evaluate, report);
        return { project_id: project.project_id, decomposition, tasks, task_count: tasks.length };
    }
    /** 缺口补充：发现 + 提取两个任务（带 gap_id 保证同一缺口只补一次）。 */
    tasksForGap(project, gap) {
        const priority = Number(gap.priority ?? 0.6);
        const discover = this.repo.createTask({
            projectId: project.project_id, kind: 'discover', title: `补充资料：${gap.topic}`,
            inputs: { topic: gap.topic, reason: gap.reason ?? '', gap_id: gap.gap_id },
            priority, maxRetries: this.config.max_retries_per_task,
            timeoutSeconds: this.config.max_task_seconds,
            idempotencyKey: `gapfix-discover::${project.project_id}::${gap.topic}::${gap.gap_id}`,
        });
        const extract = this.repo.createTask({
            projectId: project.project_id, kind: 'extract', title: `补充提取：${gap.topic}`,
            inputs: { topic: gap.topic, gap_id: gap.gap_id }, dependsOn: [discover.task_id],
            priority: round(priority - 0.02, 3), maxRetries: this.config.max_retries_per_task,
            timeoutSeconds: this.config.max_task_seconds,
            idempotencyKey: `gapfix-extract::${project.project_id}::${gap.topic}::${gap.gap_id}`,
        });
        return [discover, extract];
    }
    tasksForConflict(project, conflict) {
        return [this.repo.createTask({
                projectId: project.project_id, kind: 'verify', title: '冲突分析任务',
                inputs: { conflict_id: conflict.conflict_id, chunk_a: conflict.chunk_a, chunk_b: conflict.chunk_b },
                objective: conflict.detail ?? '比较两个知识片段的来源、说法与数值，给出裁定依据',
                priority: 0.85, maxRetries: this.config.max_retries_per_task,
                timeoutSeconds: this.config.max_task_seconds,
                idempotencyKey: `conflict::${conflict.conflict_id}`,
            })];
    }
    /** 展示用排序：优先级 × 就绪折扣 − 依赖深度惩罚。 */
    priorities(tasks) {
        const byId = new Map(tasks.map((task) => [task.task_id, task]));
        const depth = (taskId, guard = 0) => {
            if (guard > 50)
                return 50;
            const task = byId.get(taskId);
            if (!task || task.depends_on.length === 0)
                return 0;
            return 1 + Math.max(...task.depends_on.map((dep) => depth(dep, guard + 1)));
        };
        return [...tasks].sort((a, b) => {
            const score = (task) => {
                const ready = ['pending', 'retrying'].includes(task.status) ? 1 : 0.3;
                return round(Number(task.priority ?? 0.5) * ready - 0.03 * depth(task.task_id), 4);
            };
            return score(b) - score(a) || a.created_at.localeCompare(b.created_at);
        });
    }
}
