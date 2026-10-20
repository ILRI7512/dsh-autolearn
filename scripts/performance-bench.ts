/**
 * 性能基线（可重复）：冷启动、写入、检索、重复检测、文档摄入、内存/磁盘。
 * 用法：node scripts/performance-bench.ts
 * 输出：reports/performance-benchmark.json + 控制台摘要
 *
 * 注意：这是本机单次测量，不含预热统计；数值用于同一实现的前后对比，
 * 不应外推为跨设备基准。
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { loadConfig } from '../src/core/config.ts'
import { AutolearnEngine } from '../src/index.ts'
import { extractKnowledge } from '../src/domain/knowledge/extractor.ts'
import { SAMPLE_DOC } from '../tests/helpers.ts'

const root = join(import.meta.dirname ?? '.', '..')
const now = '2026-01-01T00:00:00Z'

function open(dir: string): AutolearnEngine {
  const config = loadConfig({
    home: dir,
    env: { ...process.env, DSH_AL_HOME: dir, DSH_AL_DATA_DIR: join(dir, 'data'), DSH_AL_CONFIG: '' } as NodeJS.ProcessEnv,
  })
  return AutolearnEngine.open({ config })
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return Number((sorted[index] ?? 0).toFixed(2))
}

function seed(engine: AutolearnEngine, projectId: string, count: number): string[] {
  const existing = engine.store.countChunks({ projectId })
  if (existing >= count) return []
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']
  const chunks = Array.from({ length: count - existing }, (_, index) => {
    const id = existing + index
    const content = `doc ${id} ` + Array.from({ length: 16 }, (_, k) => words[(id * 5 + k * 7) % words.length]).join(' ')
    return {
      chunk_id: `chunk_${id}`, project_id: projectId, topic: `t${id % 10}`,
      title: `note ${id}`, summary: `summary ${id}`, content,
      knowledge_type: 'concept', source_id: `src_${id}`, source_url: `https://example.com/${id}`,
      source_quality: 0.6, freshness_status: 'fresh', created_at: now, updated_at: now,
    }
  })
  engine.store.addChunks(chunks)
  return chunks.map((chunk) => chunk.chunk_id)
}

function ensureProject(engine: AutolearnEngine, id: string): void {
  if (engine.repo.getProject(id)) return
  engine.db.insert('projects', {
    project_id: id, title: id, goal: 'bench', domain: 'quant',
    partitions: ['pending_knowledge', 'quant_knowledge'], depth: 'working', mode: 'assisted',
    status: 'active', acceptance_criteria: [], deliverables: [], allowed_sources: [],
    budget: {}, scope: {}, created_at: now, updated_at: now,
  })
}

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpus: cpus().length,
  },
}

// A. 冷启动（每个样本全新目录，包含建库/迁移/索引加载）
{
  const samples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'al-cold-'))
    const started = performance.now()
    const engine = open(dir)
    samples.push(performance.now() - started)
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
  result.cold_start_ms = { samples: samples.map((v) => Number(v.toFixed(1))), median: percentile(samples, 0.5) }
}

// B/C/D：单一引擎里逐步扩大语料
{
  const dir = mkdtempSync(join(tmpdir(), 'al-bench-'))
  const engine = open(dir)
  try {
    ensureProject(engine, 'prj_b')
    const write: Array<Record<string, number>> = []
    const search: Array<Record<string, number>> = []
    for (const count of [100, 500, 1000]) {
      const before = engine.store.countChunks({ projectId: 'prj_b' })
      const started = performance.now()
      seed(engine, 'prj_b', count)
      write.push({ chunks: count, added: count - before, write_ms: Number((performance.now() - started).toFixed(1)) })

      const queries = ['alpha beta', 'gamma delta', '风险管理', 'note', 'epsilon zeta eta', 'lambda mu', 'doc 42', 't3', 'summary', 'alpha gamma epsilon']
      const modes: Record<string, number[]> = { keyword: [], vector: [], hybrid: [] }
      for (let round = 0; round < 3; round += 1) {
        for (const query of queries) {
          for (const mode of Object.keys(modes)) {
            const t = performance.now()
            engine.store.search(query, { projectId: 'prj_b' }, { mode, topK: 8 })
            ;(modes[mode] as number[]).push(performance.now() - t)
          }
        }
      }
      search.push({
        chunks: count,
        keyword_p50_ms: percentile(modes.keyword as number[], 0.5),
        keyword_p95_ms: percentile(modes.keyword as number[], 0.95),
        vector_p50_ms: percentile(modes.vector as number[], 0.5),
        vector_p95_ms: percentile(modes.vector as number[], 0.95),
        hybrid_p50_ms: percentile(modes.hybrid as number[], 0.5),
        hybrid_p95_ms: percentile(modes.hybrid as number[], 0.95),
      })
    }
    result.write = write
    result.search = search

    ensureProject(engine, 'prj_dedupe')
    const dedupe: Array<Record<string, number>> = []
    for (const count of [200, 500, 800]) {
      seed(engine, 'prj_dedupe', count)
      const t = performance.now()
      const pairs = engine.store.findDuplicates({ filter: { projectId: 'prj_dedupe' }, maxPairs: 1000, threshold: 0.95 })
      dedupe.push({ chunks: engine.store.countChunks({ projectId: 'prj_dedupe' }), pairs: pairs.length, find_duplicates_ms: Number((performance.now() - t).toFixed(1)) })
    }
    result.find_duplicates = dedupe

    const readStart = performance.now()
    for (let i = 0; i < 100; i += 1) engine.store.getChunk(`chunk_${i}`)
    result.read_100_ms = Number((performance.now() - readStart).toFixed(1))

    result.memory_rss_mb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1))
    result.db_bytes = statSync(engine.config.paths.db_path).size
    const indexDir = engine.config.paths.index_dir
    result.index_bytes = statSync(join(indexDir, 'vectors.npy')).size + statSync(join(indexDir, 'ids.json')).size
    result.embedding_cache_entries = engine.db.count('embedding_cache')
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// E. 文档摄入：解析 + 规则抽取 + 写库（10KB / 100KB）
{
  const dir = mkdtempSync(join(tmpdir(), 'al-doc-'))
  const engine = open(dir)
  try {
    ensureProject(engine, 'prj_doc')
    const project = engine.repo.requireProject('prj_doc')
    const ingest: Array<Record<string, number>> = []
    for (const targetKB of [10, 100]) {
      // 每段加唯一编号，避免内容指纹把重复文本合并（否则测的是一次去重而不是切块/抽取）
      const units: string[] = []
      let size = 0
      let index = 0
      while (size < targetKB * 1024) {
        const unit = `${SAMPLE_DOC}\n\n补充段落 ${index}：唯一的第 ${index} 段内容，用于避免内容指纹去重。\n`
        units.push(unit)
        size += unit.length
        index += 1
      }
      const body = units.join('\n')
      const started = performance.now()
      const extraction = extractKnowledge({
        project, document: { document_id: `doc_${targetKB}`, title: `doc ${targetKB}`, quality: 0.7 }, text: body, topic: '风险管理', config: engine.config.learning,
      })
      const writeStart = performance.now()
      engine.store.addChunks(extraction.drafts)
      ingest.push({
        target_kb: targetKB, actual_chars: body.length,
        drafts: extraction.drafts.length,
        extract_ms: Number((writeStart - started).toFixed(1)),
        write_ms: Number((performance.now() - writeStart).toFixed(1)),
        total_ms: Number((performance.now() - started).toFixed(1)),
      })
      void extraction
    }
    result.ingest = ingest
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// F. 一轮学习（discover→extract→verify）耗时
{
  const dir = mkdtempSync(join(tmpdir(), 'al-round-'))
  const engine = open(dir)
  try {
    const corpus = join(dir, 'corpus')
    mkdirSync(corpus, { recursive: true })
    const fs = await import('node:fs')
    fs.writeFileSync(join(corpus, 'risk.md'), SAMPLE_DOC, 'utf8')
    const created = engine.orchestrator.createProject({ goal: '学习风险管理与仓位控制', domain: 'quant', depth: 'overview', allowedSources: [join(corpus, 'risk.md')] })
    const projectId = created.project.project_id
    const started = performance.now()
    const run = await engine.orchestrator.runRound(projectId, { maxTasks: 6 })
    result.learning_round = {
      elapsed_ms: Number((performance.now() - started).toFixed(1)),
      tasks: run.tasks_executed.length,
      stop_reason: run.stop_reason,
      chunks: engine.store.countChunks({ projectId }),
    }
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

mkdirSync(join(root, 'reports'), { recursive: true })
writeFileSync(join(root, 'reports', 'performance-benchmark.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
