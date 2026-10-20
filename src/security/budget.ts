/**
 * 资源预算：请求数、模型调用、来源数、耗时、费用。
 *
 * 硬要求：预算必须在**真实执行路径**上检查，耗尽后进入明确状态，
 * 不能只声明字段。耗尽抛 BudgetExceededError（含 dimension），
 * 编排器把它转成 run.stop_reason。
 */
import { BudgetExceededError } from '../core/errors.ts'
import { utcnowIso } from '../core/ids.ts'
import type { Database } from '../infrastructure/database/database.ts'
import type { LearningConfig, ModelConfig } from '../core/config.ts'

export interface BudgetSnapshot {
  run_id: string
  project_id: string
  iteration: number
  tasks_run: number
  sources_read: number
  llm_calls: number
  cost_estimate: number
  daily_spent: number
  new_knowledge: number
  elapsed_s: number
  limits: Record<string, number>
}

export interface ModelUsage {
  promptTokens?: number
  completionTokens?: number
  costEstimate?: number
  model?: string
  stage?: string
}

export class BudgetTracker {
  private readonly learning: LearningConfig
  private readonly model: ModelConfig
  private readonly db: Database | null
  private readonly runId: string
  private readonly projectId: string
  private readonly startedAt = Date.now()
  private iteration = 0
  private tasksRun = 0
  private sourcesRead = 0
  private llmCalls = 0
  private costEstimate = 0
  private dailySpent: number
  private newKnowledge = 0
  private noProgressRounds = 0

  constructor(
    learning: LearningConfig,
    model: ModelConfig,
    options: { db?: Database | null; runId?: string; projectId?: string; dailySpent?: number } = {},
  ) {
    this.learning = learning
    this.model = model
    this.db = options.db ?? null
    this.runId = options.runId ?? ''
    this.projectId = options.projectId ?? ''
    this.dailySpent = options.dailySpent ?? 0
  }

  setIteration(iteration: number): void {
    this.iteration = iteration
  }

  elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000
  }

  checkTime(): void {
    if (this.elapsedSeconds() > this.learning.max_run_seconds) {
      throw new BudgetExceededError(`单轮运行超过 ${this.learning.max_run_seconds} 秒`, {
        dimension: 'max_run_seconds',
        elapsed_s: Math.round(this.elapsedSeconds()),
      })
    }
  }

  startTask(): void {
    this.checkTime()
    if (this.tasksRun >= this.learning.max_tasks_per_run) {
      throw new BudgetExceededError(`本轮任务数已达上限 ${this.learning.max_tasks_per_run}`, {
        dimension: 'max_tasks_per_run',
      })
    }
    this.tasksRun += 1
  }

  consumeSources(count: number): void {
    if (count <= 0) return
    if (this.sourcesRead + count > this.learning.max_sources_per_task) {
      throw new BudgetExceededError(
        `来源读取数超过上限 ${this.learning.max_sources_per_task}（已读 ${this.sourcesRead}，再读 ${count}）`,
        { dimension: 'max_sources_per_task', sources_read: this.sourcesRead, requested: count },
      )
    }
    this.sourcesRead += count
  }

  /** 模型调用记账：唯一入口（模型适配器成功后调用）。 */
  consumeLlm(usage: ModelUsage): void {
    this.llmCalls += 1
    const cost = Number(usage.costEstimate ?? 0) || 0
    this.costEstimate += cost
    this.dailySpent += cost
    if (this.db) {
      try {
        this.db.insert('llm_calls', {
          ts: utcnowIso(),
          project_id: this.projectId,
          stage: usage.stage ?? '',
          model: usage.model ?? '',
          prompt_tokens: Number(usage.promptTokens ?? 0),
          completion_tokens: Number(usage.completionTokens ?? 0),
          cost_estimate: cost,
          ok: 1,
          error: '',
        })
      } catch {
        /* 记账失败不阻断业务，预算内存值仍然生效 */
      }
    }
    if (this.llmCalls > this.learning.max_llm_calls_per_run) {
      throw new BudgetExceededError(`模型调用超过上限 ${this.learning.max_llm_calls_per_run}`, {
        dimension: 'max_llm_calls_per_run',
        llm_calls: this.llmCalls,
      })
    }
    if (this.learning.daily_budget_usd > 0 && this.dailySpent > this.learning.daily_budget_usd) {
      throw new BudgetExceededError(`当日费用超过预算 $${this.learning.daily_budget_usd}`, {
        dimension: 'daily_budget',
        daily_spent: this.dailySpent,
      })
    }
    if (this.model.max_cost_usd > 0 && this.costEstimate > this.model.max_cost_usd) {
      throw new BudgetExceededError(`本轮费用超过上限 $${this.model.max_cost_usd}`, {
        dimension: 'model_cost',
        cost_estimate: this.costEstimate,
      })
    }
  }

  finishTask(newKnowledge = 0, progress = true): void {
    this.newKnowledge += Math.max(0, newKnowledge)
    this.noProgressRounds = progress ? 0 : this.noProgressRounds + 1
  }

  canContinue(iteration: number): boolean {
    return iteration < this.learning.max_iterations_per_run
  }

  /** 循环检查点：把异常转成 (stop, reason)，不打断 run 记录写入。 */
  shouldStop(): { stop: boolean; reason: string } {
    try {
      this.checkTime()
      if (this.tasksRun >= this.learning.max_tasks_per_run) return { stop: true, reason: 'max_tasks_per_run' }
      if (this.llmCalls >= this.learning.max_llm_calls_per_run) return { stop: true, reason: 'max_llm_calls_per_run' }
      if (this.learning.daily_budget_usd > 0 && this.dailySpent >= this.learning.daily_budget_usd) {
        return { stop: true, reason: 'daily_budget' }
      }
      if (!this.canContinue(this.iteration)) return { stop: true, reason: 'max_iterations_per_run' }
      return { stop: false, reason: '' }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return { stop: true, reason: String(error.details.dimension ?? 'budget') }
      }
      throw error
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      run_id: this.runId,
      project_id: this.projectId,
      iteration: this.iteration,
      tasks_run: this.tasksRun,
      sources_read: this.sourcesRead,
      llm_calls: this.llmCalls,
      cost_estimate: Math.round(this.costEstimate * 1e6) / 1e6,
      daily_spent: Math.round(this.dailySpent * 1e6) / 1e6,
      new_knowledge: this.newKnowledge,
      elapsed_s: Math.round(this.elapsedSeconds() * 100) / 100,
      limits: {
        max_tasks_per_run: this.learning.max_tasks_per_run,
        max_iterations_per_run: this.learning.max_iterations_per_run,
        max_llm_calls_per_run: this.learning.max_llm_calls_per_run,
        max_run_seconds: this.learning.max_run_seconds,
        daily_budget_usd: this.learning.daily_budget_usd,
      },
    }
  }
}
