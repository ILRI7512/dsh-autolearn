/**
 * 领域类型：枚举常量、实体与行类型。
 *
 * 与 Python 版保持**落库值完全一致**（数据库兼容的前提）。
 * 约束：只用可擦除语法（NO enum / namespace），值全部是字符串字面量。
 */

export const KnowledgeStatus = {
  DISCOVERED: 'discovered',
  EXTRACTED: 'extracted',
  PENDING_VERIFICATION: 'pending_verification',
  VERIFIED: 'verified',
  PRACTICED: 'practiced',
  EVALUATED: 'evaluated',
  STALE: 'stale',
  DISPUTED: 'disputed',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
} as const
export type KnowledgeStatus = (typeof KnowledgeStatus)[keyof typeof KnowledgeStatus]

export const KnowledgeType = {
  DEFINITION: 'definition',
  FACT: 'fact',
  CONCEPT: 'concept',
  PRINCIPLE: 'principle',
  PROCEDURE: 'procedure',
  FORMULA: 'formula',
  CODE_EXAMPLE: 'code_example',
  BEST_PRACTICE: 'best_practice',
  CASE_STUDY: 'case_study',
  HYPOTHESIS: 'hypothesis',
  OPINION: 'opinion',
  WARNING: 'warning',
  UNRESOLVED_QUESTION: 'unresolved_question',
  EXPERIMENTAL_RESULT: 'experimental_result',
} as const
export type KnowledgeType = (typeof KnowledgeType)[keyof typeof KnowledgeType]

export const LearningLevel = {
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
  L5: 'L5',
} as const
export type LearningLevel = (typeof LearningLevel)[keyof typeof LearningLevel]

export const VerificationMethod = {
  SOURCE_CHECK: 'source_check',
  CROSS_SOURCE: 'cross_source',
  OFFICIAL_DOC_CHECK: 'official_doc_check',
  FORMULA_RECOMPUTE: 'formula_recompute',
  CODE_TEST: 'code_test',
  EXPERIMENT: 'experiment',
  USABILITY_TEST: 'usability_test',
  STATIC_ANALYSIS: 'static_analysis',
  MANUAL_REVIEW: 'manual_review',
} as const
export type VerificationMethod = (typeof VerificationMethod)[keyof typeof VerificationMethod]

export const VerificationResult = {
  PASS: 'pass',
  FAIL: 'fail',
  PARTIAL: 'partial',
  INCONCLUSIVE: 'inconclusive',
} as const
export type VerificationResult = (typeof VerificationResult)[keyof typeof VerificationResult]

export const VerificationStatus = {
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
  PARTIAL: 'partial',
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNVERIFIABLE: 'unverifiable',
} as const
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus]

export const TaskKind = {
  PLAN: 'plan',
  GAP_ANALYSIS: 'gap_analysis',
  DISCOVER: 'discover',
  EXTRACT: 'extract',
  VERIFY: 'verify',
  PRACTICE: 'practice',
  EVALUATE: 'evaluate',
  REPORT: 'report',
} as const
export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind]

export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  RETRYING: 'retrying',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

export const ProjectStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
} as const
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus]

export const AutonomyMode = {
  ASSISTED: 'assisted',
  AUTO: 'auto',
  LAB: 'lab',
} as const
export type AutonomyMode = (typeof AutonomyMode)[keyof typeof AutonomyMode]

export const RiskLevel = {
  READ: 'read',
  WRITE: 'write',
  EXECUTE: 'execute',
  EXTERNAL: 'external',
  DESTRUCTIVE: 'destructive',
} as const
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel]

export const SourceType = {
  OFFICIAL_DOC: 'official_doc',
  STANDARD: 'standard',
  PAPER: 'paper',
  TECH_DOC: 'tech_doc',
  CODE_REPO: 'code_repo',
  WEB_PAGE: 'web_page',
  LOCAL_FILE: 'local_file',
  USER_NOTE: 'user_note',
  EXPERIMENT: 'experiment',
  UNKNOWN: 'unknown',
} as const
export type SourceType = (typeof SourceType)[keyof typeof SourceType]

export const LicenseStatus = {
  UNKNOWN: 'unknown',
  PERMITTED: 'permitted',
  RESTRICTED: 'restricted',
  PROHIBITED: 'prohibited',
} as const
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus]

export const FreshnessStatus = {
  FRESH: 'fresh',
  AGING: 'aging',
  STALE: 'stale',
  EXPIRED: 'expired',
  UNKNOWN: 'unknown',
} as const
export type FreshnessStatus = (typeof FreshnessStatus)[keyof typeof FreshnessStatus]

export const Partition = {
  PENDING: 'pending_knowledge',
  GENERAL: 'general_knowledge',
} as const

export const LearningDepth = {
  OVERVIEW: 'overview',
  WORKING: 'working',
  DEEP: 'deep',
} as const
export type LearningDepth = (typeof LearningDepth)[keyof typeof LearningDepth]

// --------------------------------------------------------------------------- //
// 实体
// --------------------------------------------------------------------------- //

export interface ProjectRow {
  project_id: string
  title: string
  goal: string
  domain: string
  partitions: string[]
  depth: string
  mode: string
  status: string
  acceptance_criteria: string[]
  deliverables: string[]
  allowed_sources: string[]
  budget: Record<string, unknown>
  scope: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface TaskRow {
  task_id: string
  project_id: string
  kind: string
  title: string
  objective: string
  inputs: Record<string, unknown>
  steps: unknown[]
  depends_on: string[]
  expected_output: string
  acceptance: string[]
  status: string
  priority: number
  attempts: number
  max_retries: number
  timeout_s: number
  error: string
  result: Record<string, unknown>
  iteration: number
  idempotency_key: string
  started_at: string
  finished_at: string
  created_at: string
  updated_at: string
}

export interface SourceRow {
  source_id: string
  project_id: string
  source_type: string
  location: string
  title: string
  publisher: string
  published_at: string
  accessed_at: string
  license_status: string
  quality: number
  quality_basis: string
  freshness_status: string
  content_hash: string
  fetch_ok: number
  error: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface DocumentRow {
  document_id: string
  project_id: string
  source_id: string
  title: string
  doc_type: string
  language: string
  content_path: string
  content_hash: string
  char_count: number
  parser: string
  parse_status: string
  error: string
  stages: Record<string, unknown>
  created_at: string
}

export interface ChunkRow {
  chunk_id: string
  project_id: string
  document_id: string
  partition: string
  domain: string
  topic: string
  subtopic: string
  title: string
  content: string
  summary: string
  knowledge_type: string
  status: string
  level: string
  source_id: string
  source_url: string
  source_title: string
  source_type: string
  author_or_publisher: string
  published_at: string
  accessed_at: string
  language: string
  content_hash: string
  version: number
  source_quality: number
  evidence_count: number
  evidence_independence: number
  confidence: number
  confidence_basis: string
  verification_status: string
  verification_method: string
  verification_evidence: unknown[]
  freshness_status: string
  conflict_status: string
  limitations: string
  tags: string[]
  source_version: string
  source_excerpt: string
  core_principle: string
  reasoning: string
  application: string
  implementation: string
  anti_patterns: string
  quality_score: number
  quality_components: Record<string, unknown>
  license_status: string
  visibility: string
  metadata: Record<string, unknown>
  invalidated_at: string
  superseded_by: string
  created_at: string
  updated_at: string
}

export interface VerificationRecordRow {
  record_id: string
  chunk_id: string
  method: string
  result: string
  evidence: unknown[]
  notes: string
  verifier: string
  created_at: string
}

export interface RunRow {
  run_id: string
  project_id: string
  iteration: number
  status: string
  summary: Record<string, unknown>
  stop_reason: string
  started_at: string
  finished_at: string
}

export interface GapRow {
  gap_id: string
  project_id: string
  topic: string
  subtopic: string
  level: string
  reason: string
  status: string
  priority: number
  created_at: string
  resolved_at: string
}

export interface ConflictRow {
  conflict_id: string
  project_id: string
  chunk_a: string
  chunk_b: string
  kind: string
  detail: string
  status: string
  evidence: unknown[]
  resolution: string
  created_at: string
  resolved_at: string
}

export interface PracticeTaskRow {
  practice_id: string
  project_id: string
  chunk_id: string
  kind: string
  title: string
  spec: Record<string, unknown>
  status: string
  created_at: string
}

export interface PracticeResultRow {
  result_id: string
  practice_id: string
  status: string
  input_data: Record<string, unknown>
  environment: Record<string, unknown>
  output: string
  error: string
  exit_code: number | null
  conclusion: string
  artifact_dir: string
  duration_ms: number
  created_at: string
}

export interface AuditRow {
  id?: number
  ts: string
  actor: string
  action: string
  target: string
  risk: string
  allowed: number
  project_id: string
  detail: Record<string, unknown>
}

export interface LlmCallRow {
  id?: number
  ts: string
  project_id: string
  stage: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  cost_estimate: number
  ok: number
  error: string
}

/** 写入训练/工具层返回的稳定结果形状。 */
export type ToolResult<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string; recoverable: boolean; details: Record<string, unknown> } }

export interface ChunkFilterInput {
  projectId?: string
  projectIds?: string[]
  statuses?: string[]
  partitions?: string[]
  domains?: string[]
  topics?: string[]
  subtopics?: string[]
  knowledgeTypes?: string[]
  levels?: string[]
  verificationStatuses?: string[]
  sourceTypes?: string[]
  visibility?: string[]
  includeInvalidated?: boolean
  limit?: number
}
