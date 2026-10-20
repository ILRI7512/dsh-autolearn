import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BudgetTracker } from '../../src/security/budget.ts'
import { BudgetExceededError } from '../../src/core/errors.ts'
import { makeEngine } from '../helpers.ts'

function learningConfig(overrides: Record<string, unknown> = {}) {
  return {
    default_mode: 'assisted', max_iterations_per_run: 2, max_tasks_per_run: 2,
    max_sources_per_task: 2, max_retries_per_task: 3, max_llm_calls_per_run: 2,
    max_task_seconds: 300, max_run_seconds: 3600, stop_when_no_new_knowledge: true,
    no_progress_rounds: 3, stop_when_budget_exceeded: true, require_source_tracking: true,
    require_verification_status: true, auto_execute_untrusted_code: false,
    auto_install_dependencies: false, auto_modify_other_plugins: false,
    daily_budget_usd: 1, max_doc_chars: 400_000, chunk_size: 900, chunk_overlap: 120,
    min_chunk_chars: 40, max_chunks_per_document: 400, ...overrides,
  } as never
}

const modelConfig = {
  provider: 'mock', base_url: '', api_key_env: 'X', model: 'm', timeout_s: 60,
  max_retries: 2, max_tokens: 100, temperature: 0, rate_limit_per_min: 60,
  max_cost_usd: 0, price_input_per_1k: 0, price_output_per_1k: 0, stages: {},
} as never

describe('资源预算必须在真实路径上生效', () => {
  it('任务数超限抛 BudgetExceededError（带 dimension）', () => {
    const tracker = new BudgetTracker(learningConfig({ max_tasks_per_run: 1 }), modelConfig)
    tracker.startTask()
    assert.throws(() => tracker.startTask(), (error: unknown) =>
      error instanceof BudgetExceededError && error.details.dimension === 'max_tasks_per_run')
  })

  it('来源数超限抛错', () => {
    const tracker = new BudgetTracker(learningConfig({ max_sources_per_task: 2 }), modelConfig)
    tracker.consumeSources(2)
    assert.throws(() => tracker.consumeSources(1), /来源读取数超过上限/)
  })

  it('模型调用数超限抛错', () => {
    const tracker = new BudgetTracker(learningConfig({ max_llm_calls_per_run: 1 }), modelConfig)
    tracker.consumeLlm({ promptTokens: 1 })
    assert.throws(() => tracker.consumeLlm({ promptTokens: 1 }), /模型调用超过上限/)
  })

  it('每日费用超限抛错（严格大于）', () => {
    const tracker = new BudgetTracker(learningConfig({ daily_budget_usd: 1 }), modelConfig, { dailySpent: 0.95 })
    assert.throws(() => tracker.consumeLlm({ costEstimate: 0.1 }), /当日费用超过预算/)
  })

  it('shouldStop 把耗尽转成 stop_reason 而不是抛异常', () => {
    const tracker = new BudgetTracker(learningConfig({ max_tasks_per_run: 1 }), modelConfig)
    tracker.startTask()
    assert.deepEqual(tracker.shouldStop(), { stop: true, reason: 'max_tasks_per_run' })
  })

  it('轮次上限生效', () => {
    const tracker = new BudgetTracker(learningConfig({ max_iterations_per_run: 2 }), modelConfig)
    tracker.setIteration(2)
    assert.deepEqual(tracker.shouldStop(), { stop: true, reason: 'max_iterations_per_run' })
  })

  it('快照包含额度与真实用量', () => {
    const tracker = new BudgetTracker(learningConfig(), modelConfig)
    tracker.startTask()
    tracker.consumeSources(1)
    tracker.consumeLlm({ promptTokens: 10, completionTokens: 5, costEstimate: 0.01 })
    const snapshot = tracker.snapshot()
    assert.equal(snapshot.tasks_run, 1)
    assert.equal(snapshot.sources_read, 1)
    assert.equal(snapshot.llm_calls, 1)
    assert.equal(snapshot.cost_estimate, 0.01)
    assert.equal(snapshot.limits.max_tasks_per_run, 2)
  })
})

describe('预算与编排器集成', () => {
  it('每日预算为 0 时不做费用限制', () => {
    const tracker = new BudgetTracker(learningConfig({ daily_budget_usd: 0 }), modelConfig, { dailySpent: 999 })
    assert.doesNotThrow(() => tracker.consumeLlm({ costEstimate: 100 }))
  })

  it('run_round 的 budget 快照写入返回值', async () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '预算测试', plan: false })
      const run = await engine.services.learningRun({ projectId: String(created.project.project_id), maxTasks: 1 })
      const budget = run.budget as Record<string, unknown>
      assert.equal(typeof budget.tasks_run, 'number')
      assert.equal(typeof budget.elapsed_s, 'number')
      assert.ok(budget.limits)
    } finally {
      close()
    }
  })
})
