/**
 * 可重复检索评测：固定知识集 + 固定问题集。
 *
 * 用法：node scripts/retrieval-eval.ts
 * 输出：控制台摘要 + reports/retrieval-eval.json
 *
 * 说明：
 * - 这是**小型固定集**，用于比较同一实现下 keyword / vector / hybrid 的相对差异，
 *   不是大规模基准；结果会受特征哈希的词面重合度影响。
 * - 每个问题带类别，便于看清「同义/改写/混合语言」等薄弱环节。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/core/config.ts'
import { AutolearnEngine } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dataDir = join(root, 'reports', '.eval-data')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const now = '2026-01-01T00:00:00Z'
const docs = [
  ['slip', '交易滑点与点差成本', '滑点是指成交价与预期价的偏差，点差是买卖报价差。高频交易中滑点会显著侵蚀收益。', 'fresh'],
  ['drawdown', '最大回撤与净值曲线', '最大回撤衡量净值从峰值下跌的幅度，公式为峰值减当前除以峰值。回撤超过20%需要降低仓位。', 'fresh'],
  ['sharpe', '夏普比率计算', '夏普比率等于超额收益除以收益波动率，用于衡量单位风险的回报。', 'fresh'],
  ['leverage', '杠杆与保证金占用', '杠杆放大收益与亏损，保证金占用决定强平价格；杠杆越高，维持保证金要求越容易被触发。', 'fresh'],
  ['position', '仓位控制与单笔风险', '单笔风险不超过账户1%，按止损距离反推仓位规模，避免连续亏损击穿本金。', 'fresh'],
  ['stoploss', '止损与强平风险', '强平由保证金不足触发；设置止损可以避免爆仓，但仍可能跳空穿价。', 'fresh'],
  ['backtest', '回测偏差与过拟合', '回测需要防止前视偏差、幸存者偏差与过拟合；样本外测试与滚动验证是基本要求。', 'fresh'],
  ['mixed', 'drawdown 回撤控制', 'drawdown 与回撤同义，控制回撤需要仓位管理与止损纪律。', 'fresh'],
  ['ma_a', '均线策略A：双均线交叉', '短期均线上穿长期均线买入，下穿卖出，参数为5日与20日。', 'fresh'],
  ['ma_b', '均线策略B：三均线过滤', '在双均线基础上加入60日均线过滤，减少震荡市假信号。', 'fresh'],
  ['ma_c', '均线策略C：波动率自适应', '根据ATR调整均线周期，高波动时缩短周期。', 'fresh'],
  ['stale_drawdown', '最大回撤（旧版）', '最大回撤是净值从峰值下跌的幅度，旧版用简单差值计算，未除以峰值。', 'stale'],
  ['current_drawdown', '最大回撤（当前版）', '最大回撤是净值从峰值下跌的幅度，现行口径为峰值减当前除以峰值。', 'fresh'],
  ['edge', '执行成本与冲击成本', '大单冲击成本与滑点不同，冲击成本来自订单簿消耗。', 'fresh'],
  ['funding', '资金费率与持仓成本', '永续合约资金费率影响持仓成本，正费率时多头付费。', 'fresh'],
  ['kelly', '凯利公式与仓位', '凯利公式 f=(bp-q)/b 给出理论最优仓位，实务通常减半。', 'fresh'],
  ['correlation', '相关性约束与组合风险', '多品种相关性上升时组合风险集中，需要限制同向暴露。', 'fresh'],
  ['var', 'VaR 与压力测试', 'VaR 衡量给定置信度下的最大预期损失，压力测试覆盖极端情景。', 'fresh'],
  ['options', '期权希腊值入门', 'Delta 衡量标的价格变化对期权价格的影响，Gamma 衡量 Delta 的变化率。', 'fresh'],
  ['execution', '订单类型与执行', '限价单保证价格不保证成交，市价单保证成交不保证价格。', 'fresh'],
] as const

const queries: Array<{ id: string; query: string; expected: string[]; category: string; note?: string }> = [
  { id: 'q1', query: '滑点', expected: ['slip'], category: 'exact_short' },
  { id: 'q2', query: '夏普比率', expected: ['sharpe'], category: 'exact_term' },
  { id: 'q3', query: '持仓规模', expected: ['position'], category: 'synonym', note: '文档用“仓位规模”' },
  { id: 'q4', query: '交易滑价', expected: ['slip'], category: 'synonym', note: '文档用“滑点”' },
  { id: 'q5', query: '怎样避免被强制平仓', expected: ['stoploss'], category: 'paraphrase' },
  { id: 'q6', query: 'drawdown 回撤', expected: ['mixed'], category: 'mixed_lang' },
  { id: 'q7', query: '在高杠杆的情况下，保证金不足会导致什么后果，应该如何设置止损', expected: ['leverage', 'stoploss'], category: 'long_question' },
  { id: 'q8', query: '保证金 强平 风险', expected: ['leverage', 'stoploss'], category: 'multi_term' },
  { id: 'q9', query: '三均线 60日 过滤', expected: ['ma_b'], category: 'similar_entries' },
  { id: 'q10', query: '最大回撤 计算口径', expected: ['current_drawdown'], category: 'stale_vs_current' },
  { id: 'q11', query: '天气衍生品 定价模型', expected: [], category: 'missing_knowledge' },
]

const config = loadConfig({
  home: dataDir,
  env: { ...process.env, DSH_AL_HOME: dataDir, DSH_AL_DATA_DIR: join(dataDir, 'data'), DSH_AL_CONFIG: '' } as NodeJS.ProcessEnv,
})
const engine = AutolearnEngine.open({ config })
const projectId = 'prj_eval'
engine.db.insert('projects', {
  project_id: projectId, title: 'eval', goal: 'retrieval eval', domain: 'quant',
  partitions: ['pending_knowledge', 'quant_knowledge'], depth: 'working', mode: 'assisted',
  status: 'active', acceptance_criteria: [], deliverables: [], allowed_sources: [],
  budget: {}, scope: {}, created_at: now, updated_at: now,
})
for (const [id, title, content, freshness] of docs) {
  engine.store.addChunks([{
    chunk_id: `chunk_${id}`, project_id: projectId, partition: 'pending_knowledge', domain: 'quant',
    title, content, summary: title, knowledge_type: 'concept', status: 'pending_verification',
    source_id: `src_${id}`, source_url: `https://example.com/${id}`, source_type: 'web_page',
    source_quality: 0.7, freshness_status: freshness,
    created_at: now, updated_at: now,
  }])
}

function dcg(rels: number[]): number {
  return rels.reduce((sum, rel, index) => sum + (rel ? 1 / Math.log2(index + 2) : 0), 0)
}

interface ModeResult { mode: string; latency: number[]; rows: Array<Record<string, unknown>> }

const modes = ['keyword', 'vector', 'hybrid'] as const
const results: Record<string, ModeResult> = {}

for (const mode of modes) {
  const result: ModeResult = { mode, latency: [], rows: [] }
  for (const item of queries) {
    const started = performance.now()
    const outcome = engine.store.search(item.query, { projectId }, { mode, topK: 8 })
    const latency = performance.now() - started
    result.latency.push(latency)
    const ids = outcome.results.map((row) => row.chunk_id.replace('chunk_', ''))
    const rank = item.expected.length === 0
      ? (ids.length === 0 ? 1 : ids.length + 1)
      : (() => {
          const positions = item.expected.map((id) => ids.indexOf(id)).filter((pos) => pos >= 0)
          return positions.length > 0 ? Math.min(...positions) + 1 : 0
        })()
    const hits = item.expected.filter((id) => ids.includes(id)).length
    const recall = item.expected.length === 0 ? (ids.length === 0 ? 1 : 0) : hits / item.expected.length
    const mrr = rank > 0 ? 1 / rank : 0
    const rels = ids.map((id) => (item.expected.includes(id) ? 1 : 0))
    const ideal = Array.from({ length: item.expected.length }, () => 1)
    const ndcg = item.expected.length === 0
      ? (ids.length === 0 ? 1 : 0)
      : dcg(rels) / (dcg(ideal) || 1)
    result.rows.push({
      id: item.id, category: item.category, query: item.query, expected: item.expected,
      top: ids.slice(0, 5), rank, recall, mrr, ndcg: Number(ndcg.toFixed(3)),
      latency_ms: Number(latency.toFixed(2)), warnings: outcome.warnings.length,
    })
  }
  results[mode] = result
}

function summarize(result: ModeResult): Record<string, number> {
  const n = result.rows.length
  const avg = (key: string): number => result.rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / n
  const sorted = [...result.latency].sort((a, b) => a - b)
  return {
    queries: n,
    recall_at_8: Number(avg('recall').toFixed(3)),
    mrr: Number(avg('mrr').toFixed(3)),
    ndcg_at_8: Number(avg('ndcg').toFixed(3)),
    latency_p50_ms: Number((sorted[Math.floor(n * 0.5)] ?? 0).toFixed(2)),
    latency_p95_ms: Number((sorted[Math.ceil(n * 0.95) - 1] ?? 0).toFixed(2)),
  }
}

const summary = Object.fromEntries(Object.values(results).map((result) => [result.mode, summarize(result)]))
const byCategory: Record<string, Record<string, Record<string, number>>> = {}
for (const mode of modes) {
  byCategory[mode] = {}
  for (const category of [...new Set(queries.map((q) => q.category))]) {
    const rows = results[mode]?.rows.filter((row) => row.category === category) ?? []
    byCategory[mode][category] = {
      queries: rows.length,
      recall_at_8: Number((rows.reduce((sum, row) => sum + Number(row.recall ?? 0), 0) / rows.length).toFixed(3)),
      mrr: Number((rows.reduce((sum, row) => sum + Number(row.mrr ?? 0), 0) / rows.length).toFixed(3)),
    }
  }
}

const payload = { generated_at: new Date().toISOString(), docs: docs.length, queries: queries.length, summary, by_category: byCategory, results }
mkdirSync(join(root, 'reports'), { recursive: true })
writeFileSync(join(root, 'reports', 'retrieval-eval.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ summary, by_category: byCategory }, null, 2))
engine.close()
