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
};
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
};
export const LearningLevel = {
    L0: 'L0',
    L1: 'L1',
    L2: 'L2',
    L3: 'L3',
    L4: 'L4',
    L5: 'L5',
};
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
};
export const VerificationResult = {
    PASS: 'pass',
    FAIL: 'fail',
    PARTIAL: 'partial',
    INCONCLUSIVE: 'inconclusive',
};
export const VerificationStatus = {
    UNVERIFIED: 'unverified',
    PENDING: 'pending',
    PARTIAL: 'partial',
    VERIFIED: 'verified',
    FAILED: 'failed',
    UNVERIFIABLE: 'unverifiable',
};
export const TaskKind = {
    PLAN: 'plan',
    GAP_ANALYSIS: 'gap_analysis',
    DISCOVER: 'discover',
    EXTRACT: 'extract',
    VERIFY: 'verify',
    PRACTICE: 'practice',
    EVALUATE: 'evaluate',
    REPORT: 'report',
};
export const TaskStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    RETRYING: 'retrying',
    PAUSED: 'paused',
    BLOCKED: 'blocked',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};
export const ProjectStatus = {
    ACTIVE: 'active',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    BLOCKED: 'blocked',
};
export const AutonomyMode = {
    ASSISTED: 'assisted',
    AUTO: 'auto',
    LAB: 'lab',
};
export const RiskLevel = {
    READ: 'read',
    WRITE: 'write',
    EXECUTE: 'execute',
    EXTERNAL: 'external',
    DESTRUCTIVE: 'destructive',
};
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
};
export const LicenseStatus = {
    UNKNOWN: 'unknown',
    PERMITTED: 'permitted',
    RESTRICTED: 'restricted',
    PROHIBITED: 'prohibited',
};
export const FreshnessStatus = {
    FRESH: 'fresh',
    AGING: 'aging',
    STALE: 'stale',
    EXPIRED: 'expired',
    UNKNOWN: 'unknown',
};
export const Partition = {
    PENDING: 'pending_knowledge',
    GENERAL: 'general_knowledge',
};
export const LearningDepth = {
    OVERVIEW: 'overview',
    WORKING: 'working',
    DEEP: 'deep',
};
