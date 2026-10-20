/**
 * 规则式知识抽取 + 分类：不伪造字段，不在没有证据时给出高置信度。
 *
 * 产出固定落 pending_knowledge / pending_verification / unverified，
 * core_principle/reasoning/application 等结构性字段留空——它们需要模型或实践
 * 环节的独立证据，不能由规则凭空填写。
 */
import { contentFingerprint, makeChunkId, round, utcnowIso } from '../../core/ids.ts'
import type { ChunkRow } from '../../core/types.ts'
import { KnowledgeStatus, LearningLevel, Partition } from '../../core/types.ts'
import type { LearningConfig } from '../../core/config.ts'
import { defaultVisibility, partitionForDomain, REGISTRY } from '../knowledge/domains.ts'
import { chunkText, detectLanguage, extractCodeBlocks, splitSections, summarize } from '../../infrastructure/sources/parser.ts'

const TYPE_PATTERNS: Record<string, Array<[RegExp, number]>> = {
  definition: [[/是指|指的是|定义为|称为|\bis defined as\b|\brefers to\b|意味着/i, 3.0]],
  formula: [
    [/\$[^$\n]{2,80}\$/, 4.0],
    [/\b[a-zA-Z_]\w*\s*=\s*[^=\n]{2,60}/, 4.0],
    [/[\u4e00-\u9fff]{2,12}\s*=\s*[^=\n]{2,60}/, 4.0],
    [/公式/, 4.0],
    [/\bformula\b/i, 4.0],
  ],
  code_example: [
    [/```/, 3.5],
    [/\bdef\s+\w+\(/, 3.5],
    [/\bfn\s+\w+\(/, 3.5],
    [/\bclass\s+\w+/, 3.5],
    [/import\s+\w+/, 3.5],
  ],
  procedure: [
    [/步骤|流程|第[一二三四五六七八九十]步/, 2.6],
    [/^\s*\d+\.\s/m, 2.6],
    [/\bstep\s+\d/i, 2.6],
    [/\bfirst\b[\s\S]*\bthen\b/i, 2.6],
  ],
  warning: [
    [/风险提示|存在风险|警告|注意[：:]|坑|不要/, 2.8],
    [/\bwarning\b|\bcaution\b|\bavoid\b|可能导致/i, 2.8],
  ],
  best_practice: [
    [/最佳实践|推荐做法|建议/, 2.4],
    [/\bbest practice\b|\bshould\b|\brecommend/i, 2.4],
  ],
  case_study: [
    [/案例|例如|举个/, 2.2],
    [/\bcase study\b|\bfor example\b/i, 2.2],
  ],
  principle: [
    [/原理|机制|本质|因为|由于/, 2.3],
    [/\bprinciple\b|\bbecause\b|\bmechanism\b/i, 2.3],
  ],
  hypothesis: [
    [/假设|假定|推测/, 3.0],
    [/\bhypothes|\bassume\b|\bsuppose\b|可能是/i, 3.0],
  ],
  opinion: [
    [/我认为|笔者|个人观点/, 3.0],
    [/\bi think\b|\bin my opinion\b|\barguably\b/i, 3.0],
  ],
  unresolved_question: [
    [/未解决|尚未确定|待验证|开放问题/, 3.0],
    [/\bopen question\b|\bunresolved\b|\btodo\b/i, 3.0],
  ],
  experimental_result: [
    [/实验结果|测试结果|实测|复现/, 2.9],
    [/\bbenchmark\b|\bmeasured\b|\bexperiment\b/i, 2.9],
  ],
  concept: [
    [/概念|术语|范畴/, 1.2],
    [/\bconcept\b|\bterminology\b/i, 1.2],
  ],
  fact: [
    [/\d{4}年/, 1.0],
    [/\d+\s*(?:%|％|倍|个|次)/, 1.0],
    [/\baccording to\b/i, 1.0],
    [/据.{0,6}(?:报道|统计|研究)/, 1.0],
  ],
}

const KNOWN_TYPES = new Set(Object.keys(TYPE_PATTERNS))

export interface Classification {
  type: string
  scores: Record<string, number>
  basis: string
  lowConfidence: boolean
}

export function classifyKnowledgeType(text: string, title = ''): Classification {
  const sample = `${title}\n${text}`.slice(0, 6000)
  const scores: Record<string, number> = {}
  for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
    let score = 0
    for (const [pattern, weight] of patterns) if (pattern.test(sample)) score += weight
    if (score > 0) scores[type] = score
  }
  const entries = Object.entries(scores)
  if (entries.length === 0) {
    return {
      type: 'fact',
      scores: {},
      basis: '未命中任何类型模式，默认按 fact 处理（未经核验）',
      lowConfidence: true,
    }
  }
  let bestType = entries[0]?.[0] as string
  let bestScore = -1
  for (const [type, score] of entries) {
    if (score > bestScore) {
      bestType = type
      bestScore = score
    }
  }
  const sorted = entries.sort((a, b) => b[1] - a[1])
  const runnerUp = sorted[1]?.[1] ?? 0
  const basis = runnerUp > 0 && bestScore - runnerUp < 0.6
    ? `规则分类=${bestType}（得分 ${bestScore}）；前两名接近，分类可能不准确，建议交叉确认`
    : `规则分类=${bestType}（得分 ${bestScore}）`
  return { type: bestType, scores, basis, lowConfidence: bestScore < 2 }
}

const FORMULA_PATTERNS: RegExp[] = [
  /\$([^$\n]{2,120})\$/g,
  /\\\((.+?)\\\)/g,
  /^\s*([A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=\n]{2,120})$/gm,
]

export function extractFormulas(text: string): Array<{ expression: string; kind: string }> {
  const out: Array<{ expression: string; kind: string }> = []
  const seen = new Set<string>()
  for (const pattern of FORMULA_PATTERNS) {
    for (const match of (text ?? '').matchAll(pattern)) {
      const expression = (match[1] ?? '').trim()
      if (!expression || expression.length > 200 || seen.has(expression)) continue
      if (!/[=+\-*/^<>≤≥∑√π]/.test(expression) && !/\\frac|\\sum|\\int/.test(expression)) continue
      seen.add(expression)
      out.push({ expression, kind: 'inline' })
      if (out.length >= 20) return out
    }
  }
  return out
}

export function extractConcepts(text: string): Array<{ term: string; definition: string }> {
  const out: Array<{ term: string; definition: string }> = []
  const patterns: RegExp[] = [
    /([\u4e00-\u9fffA-Za-z0-9\- ]{2,24})\s*(?:是指|指的是|定义为)\s*([^。\n]{2,120})/g,
    /([A-Za-z][A-Za-z0-9_\- ]{2,40})\s+(?:is defined as|refers to)\s+([^.\n]{2,160})/gi,
  ]
  for (const pattern of patterns) {
    for (const match of (text ?? '').matchAll(pattern)) {
      const term = (match[1] ?? '').trim()
      const definition = (match[2] ?? '').trim()
      if (term && definition) out.push({ term, definition })
      if (out.length >= 20) return out
    }
  }
  return out
}

const ASSUMPTION_MARKERS = ['假设', '假定', '前提是', '若', '如果', '在……条件下', 'assuming', 'given that', 'suppose', 'if ']
const UNCERTAINTY_MARKERS = ['可能', '也许', '尚不清楚', '不确定', '待验证', '估计', '推测', 'may ', 'might ', 'likely', 'probably', 'unclear', 'unverified']

function sentences(text: string): string[] {
  return (text ?? '').split(/(?<=[。！？.!?])\s*|\n/).map((item) => item.trim()).filter(Boolean)
}

export function identifyMarkers(text: string, markers: readonly string[], max = 10, minLength = 4): string[] {
  const out: string[] = []
  const loweredText = (text ?? '').toLowerCase()
  for (const sentence of sentences(text)) {
    if (sentence.length < minLength || sentence.length > 300) continue
    const lowered = sentence.toLowerCase()
    const hit = markers.some((marker) => loweredText.includes(marker) && (sentence.includes(marker) || lowered.includes(marker)))
    if (hit && !out.includes(sentence)) out.push(sentence)
    if (out.length >= max) break
  }
  return out
}

function deriveTags(text: string, concepts: Array<{ term: string }>, formulas: unknown[], code: unknown[]): string[] {
  const tags: string[] = []
  for (const concept of concepts.slice(0, 6)) {
    const term = concept.term.trim()
    if (term.length > 0 && term.length <= 24) tags.push(term)
  }
  if (formulas.length > 0) tags.push('含公式')
  if (code.length > 0) tags.push('含代码')
  for (const keyword of ['滑点', '回测', '夏普', '对比度', '无障碍', '杠杆', '保证金']) {
    if (text.includes(keyword)) tags.push(keyword)
  }
  return [...new Set(tags)].slice(0, 10)
}

export interface ExtractionDocument {
  document_id: string
  title: string
  source_id?: string
  source_url?: string
  source_title?: string
  source_type?: string
  author_or_publisher?: string
  published_at?: string
  accessed_at?: string
  language?: string
  quality?: number
  parser?: string
  source_version?: string
}

export interface ExtractionInput {
  project: { project_id: string; domain: string }
  document: ExtractionDocument
  text: string
  topic?: string
  config: LearningConfig
}

export interface ExtractionOutcome {
  drafts: Array<Partial<ChunkRow>>
  stats: {
    sections: number
    candidates: number
    kept: number
    skipped_short: number
    model_items: number
    warnings: string[]
  }
  warnings: string[]
}

export function extractKnowledge(input: ExtractionInput): ExtractionOutcome {
  const warnings: string[] = []
  const stats = { sections: 0, candidates: 0, kept: 0, skipped_short: 0, model_items: 0, warnings }
  const text = (input.text ?? '').trim()
  if (!text) return { drafts: [], stats, warnings: ['文档正文为空，未提取到知识'] }

  const cfg = input.config
  const sections = splitSections(text)
  stats.sections = sections.length
  const domain = REGISTRY.has(input.project.domain) ? input.project.domain : REGISTRY.resolveByKeywords(text)
  const sourceQuality = Number(input.document.quality ?? 0.5)
  const now = utcnowIso()
  const drafts: Array<Partial<ChunkRow>> = []
  const seenHashes = new Set<string>()

  sections.forEach((section, sectionIndex) => {
    const chunks = chunkText(section.text, {
      chunkSize: cfg.chunk_size, overlap: cfg.chunk_overlap,
      minChars: cfg.min_chunk_chars, maxChunks: cfg.max_chunks_per_document,
    })
    chunks.forEach((chunk, chunkIndex) => {
      stats.candidates += 1
      if (chunk.length < cfg.min_chunk_chars) {
        stats.skipped_short += 1
        return
      }
      const contentHash = contentFingerprint(chunk)
      if (seenHashes.has(contentHash)) return
      seenHashes.add(contentHash)
      const title = section.heading.trim() || chunk.split('\n', 1)[0]?.slice(0, 60) || '未命名知识'
      const classification = classifyKnowledgeType(chunk, title)
      const formulas = extractFormulas(chunk)
      const codeBlocks = extractCodeBlocks(chunk)
      const concepts = extractConcepts(chunk)
      const assumptions = identifyMarkers(chunk, ASSUMPTION_MARKERS)
      const uncertainties = identifyMarkers(chunk, UNCERTAINTY_MARKERS)
      const confidence = round(Math.min(0.45, 0.15 + 0.35 * sourceQuality), 3)

      drafts.push({
        chunk_id: makeChunkId(input.project.project_id, contentHash),
        project_id: input.project.project_id,
        document_id: input.document.document_id,
        partition: partitionForDomain(domain),
        domain,
        topic: input.topic ?? '',
        subtopic: section.heading && section.heading !== input.topic ? section.heading : '',
        title,
        content: chunk,
        summary: summarize(chunk),
        knowledge_type: classification.type,
        status: KnowledgeStatus.PENDING_VERIFICATION,
        level: LearningLevel.L2,
        source_id: input.document.source_id ?? '',
        source_url: input.document.source_url ?? '',
        source_title: input.document.source_title ?? input.document.title,
        source_type: input.document.source_type ?? 'unknown',
        author_or_publisher: input.document.author_or_publisher ?? '',
        published_at: input.document.published_at ?? '',
        accessed_at: input.document.accessed_at ?? now,
        language: input.document.language || detectLanguage(text),
        content_hash: contentHash,
        version: 1,
        source_quality: sourceQuality,
        confidence,
        confidence_basis: '规则抽取，尚未核验，不能视作事实',
        verification_status: 'unverified',
        verification_method: 'none',
        verification_evidence: [],
        freshness_status: 'unknown',
        conflict_status: 'none',
        tags: deriveTags(chunk, concepts, formulas, codeBlocks),
        source_excerpt: chunk.slice(0, 300),
        source_version: input.document.source_version || input.document.parser || '',
        visibility: defaultVisibility(Partition.PENDING),
        metadata: {
          extraction_method: 'rules',
          section: section.heading,
          section_index: sectionIndex,
          chunk_index: chunkIndex,
          classification_scores: classification.scores,
          classification_basis: classification.basis,
          classification_low_confidence: classification.lowConfidence,
          intended_partition: partitionForDomain(domain),
          formulas,
          code_blocks: codeBlocks,
          assumptions,
          uncertainties,
          concepts,
          source_content_hash: input.document.source_id ? undefined : undefined,
        },
        created_at: now,
        updated_at: now,
      })
    })
  })

  stats.kept = drafts.length
  if (drafts.length === 0) {
    const reason = stats.skipped_short > 0
      ? `正文被切成 ${stats.candidates} 段，全部短于 min_chunk_chars=${cfg.min_chunk_chars}；请提供更完整的原文`
      : '文档未提取到任何知识单元（内容可能过短或缺少可识别结构）'
    warnings.push(reason)
  }
  return { drafts, stats, warnings }
}

export { KNOWN_TYPES }
