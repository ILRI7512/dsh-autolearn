import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { makeEngine, writeCorpus, SAMPLE_DOC } from '../helpers.ts'

describe('学习项目与计划', () => {
  it('创建项目生成主题链任务，规划幂等', () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '学习风险管理与仓位控制', domain: 'quant', depth: 'working' })
      const projectId = String(created.project.project_id)
      assert.ok(created.project.project_id.startsWith('prj_'))
      const tasks = engine.repo.listTasks(projectId)
      assert.ok(tasks.length >= 7)
      assert.ok(tasks.some((task) => task.kind === 'gap_analysis'))
      assert.ok(tasks.some((task) => task.kind === 'report'))
      const first = tasks.find((task) => task.kind === 'extract')
      assert.ok(first)
      const planAgain = engine.orchestrator.plan(projectId)
      assert.equal(planAgain.already_planned, true)
      assert.equal(engine.repo.listTasks(projectId).length, tasks.length)
    } finally {
      close()
    }
  })

  it('项目参数校验：空目标、非法深度被拒绝', () => {
    const { engine, close } = makeEngine()
    try {
      assert.throws(() => engine.services.learningCreate({ goal: '  ' }), /goal 不能为空/)
      assert.throws(() => engine.services.learningCreate({ goal: 'x', depth: 'deepest' }), /depth/)
    } finally {
      close()
    }
  })

  it('任务依赖：extract 在 discover 完成前不可运行', () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '学习风险管理', domain: 'quant' })
      const projectId = String(created.project.project_id)
      const ready = engine.repo.nextReadyTasks(projectId, 5)
      assert.ok(ready.length > 0)
      assert.ok(ready.every((task) => task.kind === 'discover' || task.kind === 'gap_analysis'))
    } finally {
      close()
    }
  })
})

describe('run_round 闭环', () => {
  it('跑通 discover→extract→verify，产出待核验知识', async () => {
    const { engine, dir, close } = makeEngine()
    try {
      const corpus = writeCorpus(dir, 'risk.md', SAMPLE_DOC)
      const created = engine.services.learningCreate({
        goal: '学习风险管理与仓位控制', domain: 'quant', depth: 'overview', allowedSources: [corpus],
      })
      const projectId = String(created.project.project_id)
      const run = await engine.services.learningRun({ projectId, maxTasks: 4 })
      assert.ok(run.tasks_executed.length > 0)
      assert.ok(run.tasks_executed.some((task) => task.kind === 'discover' && task.status === 'completed'))
      assert.ok(run.tasks_executed.some((task) => task.kind === 'extract' && task.status === 'completed'))
      const chunks = engine.store.listChunks({ projectId })
      assert.ok(chunks.length > 0)
      assert.ok(chunks.every((chunk) => chunk.status === 'pending_verification'))
      assert.ok(chunks.every((chunk) => chunk.verification_status !== 'verified'))
      const runRow = engine.repo.getRun(String(run.run_id))
      assert.ok(runRow)
      assert.ok(runRow.summary && typeof runRow.summary === 'object')
    } finally {
      close()
    }
  })

  it('同一份资料重复导入不产生重复文档（内容指纹去重）', async () => {
    const { engine, dir, close } = makeEngine()
    try {
      const corpus = writeCorpus(dir, 'risk.md', SAMPLE_DOC)
      const created = engine.services.learningCreate({
        goal: '学习风险管理', domain: 'quant', depth: 'overview', allowedSources: [corpus],
      })
      const projectId = String(created.project.project_id)
      await engine.services.learningRun({ projectId, maxTasks: 1 })
      const docsBefore = engine.db.count('documents', 'project_id=?', [projectId])
      // 第二轮 discover 会再次读到同一文件，但 content_hash 命中去重
      await engine.services.learningRun({ projectId, maxTasks: 30 })
      const docsAfter = engine.db.count('documents', 'project_id=?', [projectId])
      assert.equal(docsAfter, docsBefore)
    } finally {
      close()
    }
  })

  it('maxTasks 限制生效并写入 stop_reason', async () => {
    const { engine, dir, close } = makeEngine()
    try {
      const corpus = writeCorpus(dir, 'risk.md', SAMPLE_DOC)
      const created = engine.services.learningCreate({
        goal: '学习风险管理', domain: 'quant', depth: 'overview', allowedSources: [corpus],
      })
      const run = await engine.services.learningRun({ projectId: String(created.project.project_id), maxTasks: 1 })
      assert.equal(run.tasks_executed.length, 1)
      assert.equal(run.stop_reason, 'max_tasks_per_run')
    } finally {
      close()
    }
  })

  it('非 active 项目拒绝运行', async () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '暂停测试' })
      const projectId = String(created.project.project_id)
      engine.orchestrator.setStatus(projectId, 'paused')
      const run = await engine.services.learningRun({ projectId })
      assert.match(run.stop_reason, /不是 active/)
      assert.equal(run.tasks_executed.length, 0)
    } finally {
      close()
    }
  })

  it('中断的 running 任务可恢复为 retrying/failed', () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '恢复测试', plan: false })
      const projectId = String(created.project.project_id)
      const task = engine.repo.createTask({
        projectId, kind: 'extract', title: 'stale', maxRetries: 3,
      })
      engine.repo.updateTask(task.task_id, {
        status: 'running', attempts: 1,
        started_at: new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      })
      const recovered = engine.orchestrator.recover(projectId)
      assert.equal(recovered.count, 1)
      assert.equal(engine.repo.getTask(task.task_id)?.status, 'retrying')
    } finally {
      close()
    }
  })

  it('任务失败按重试上限进入 failed 并阻塞依赖者', async () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '失败测试', plan: false })
      const projectId = String(created.project.project_id)
      const bad = engine.repo.createTask({
        projectId, kind: 'not_a_kind', title: 'bad', priority: 1, maxRetries: 0,
      })
      const dependent = engine.repo.createTask({
        projectId, kind: 'extract', title: 'dependent', priority: 0.1, dependsOn: [bad.task_id],
      })
      await engine.services.learningRun({ projectId, maxTasks: 1 })
      assert.equal(engine.repo.getTask(bad.task_id)?.status, 'failed')
      assert.equal(engine.repo.getTask(dependent.task_id)?.status, 'blocked')
      assert.match(String(engine.repo.getTask(dependent.task_id)?.error), /依赖任务/)
    } finally {
      close()
    }
  })

  it('错误敏感内容不能写入知识库', () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '密钥测试' })
      const projectId = String(created.project.project_id)
      assert.throws(
        () => engine.orchestrator.saveKnowledge(projectId, [{
          content: '配置示例 api_key = sk-abcdefghijklmnopqrstuvwxyz123456',
        }]),
        /密钥|令牌/,
      )
    } finally {
      close()
    }
  })
})

describe('评估与报告', () => {
  it('空知识库明确报告未达标，而不是伪造完成', async () => {
    const { engine, close } = makeEngine()
    try {
      const created = engine.services.learningCreate({ goal: '评估测试', plan: false })
      const projectId = String(created.project.project_id)
      const evaluation = engine.evaluator.evaluate(projectId)
      assert.equal(evaluation.goal_met, false)
      assert.ok(evaluation.remaining.some((item) => item.includes('知识库为空')))
      const report = engine.report.generate(projectId)
      const markdown = readFileSync(report.report_path, 'utf8')
      assert.ok(markdown.includes('未达标'))
      assert.ok(markdown.includes('不等于人工验收'))
    } finally {
      close()
    }
  })
})
