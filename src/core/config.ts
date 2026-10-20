/**
 * 配置系统：默认值 → 配置文件 → 宿主设置卡 → 环境变量 → 显式覆盖。
 *
 * 与 Python 版保持一致：
 * - 未知配置项直接报错（拼写错误不允许静默失效）；
 * - 密钥只从环境变量读取，绝不写进配置文件；
 * - 相对路径不参与解析，home/dataDir 缺省由 DSH_AL_HOME 或引擎目录推导。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AutolearnError, ERROR_CODES } from './errors.ts'
import { isPlainObject } from './json.ts'

export interface PathsConfig {
  home: string
  data_dir: string
  documents_dir: string
  processed_dir: string
  experiments_dir: string
  reports_dir: string
  db_path: string
  index_dir: string
  corpus_dir: string
  log_dir: string
}

export interface EmbeddingConfig {
  provider: 'hashing' | 'openai'
  dim: number
  model: string
  base_url: string
  api_key_env: string
  timeout_s: number
  batch_size: number
  cache: boolean
  max_cache_entries: number
}

export interface ModelConfig {
  provider: 'mock' | 'openai' | 'none'
  base_url: string
  api_key_env: string
  model: string
  timeout_s: number
  max_retries: number
  max_tokens: number
  temperature: number
  rate_limit_per_min: number
  max_cost_usd: number
  price_input_per_1k: number
  price_output_per_1k: number
  stages: Record<string, string>
}

export interface LearningConfig {
  default_mode: 'assisted' | 'auto' | 'lab'
  max_iterations_per_run: number
  max_tasks_per_run: number
  max_sources_per_task: number
  max_retries_per_task: number
  max_llm_calls_per_run: number
  max_task_seconds: number
  max_run_seconds: number
  stop_when_no_new_knowledge: boolean
  no_progress_rounds: number
  stop_when_budget_exceeded: boolean
  require_source_tracking: boolean
  require_verification_status: boolean
  auto_execute_untrusted_code: boolean
  auto_install_dependencies: boolean
  auto_modify_other_plugins: boolean
  daily_budget_usd: number
  max_doc_chars: number
  chunk_size: number
  chunk_overlap: number
  min_chunk_chars: number
  max_chunks_per_document: number
}

export interface SecurityConfig {
  allowed_roots: string[]
  allow_network: boolean
  allowed_domains: string[]
  max_download_bytes: number
  max_output_bytes: number
  exec_timeout_s: number
  exec_memory_mb: number
  /** strict = 降权 + 网络命名空间 + Node 权限模型；process = 仅进程隔离（显式选择）。 */
  exec_sandbox: 'strict' | 'process'
  /** 单次执行产物目录的软上限（MB），超出判失败。 */
  exec_artifact_mb: number
  audit_log: boolean
  block_secret_patterns: boolean
  delegate_approval_to_host: boolean
  allow_private_networks: boolean
  max_redirects: number
  allowed_content_types: string[]
}

export interface RetrievalConfig {
  top_k: number
  min_score: number
  hybrid: boolean
  vector_weight: number
  keyword_weight: number
  rrf_k: number
  dedupe_similarity: number
  conflict_similarity: number
}

export interface SchedulerConfig {
  enabled: boolean
  tick_interval_s: number
  max_parallel_projects: number
  auto_start: boolean
}

export interface LoggingConfig {
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'
  jsonl: boolean
  file: string
}

export interface Config {
  paths: PathsConfig
  embedding: EmbeddingConfig
  model: ModelConfig
  learning: LearningConfig
  security: SecurityConfig
  retrieval: RetrievalConfig
  scheduler: SchedulerConfig
  logging: LoggingConfig
}

function defaults(): Config {
  return {
    paths: {
      home: '', data_dir: '', documents_dir: '', processed_dir: '', experiments_dir: '',
      reports_dir: '', db_path: '', index_dir: '', corpus_dir: '', log_dir: '',
    },
    embedding: {
      provider: 'hashing', dim: 512, model: 'hashed-ngram', base_url: '',
      api_key_env: 'DSH_AL_EMBEDDING_API_KEY', timeout_s: 30, batch_size: 32,
      cache: true, max_cache_entries: 20000,
    },
    model: {
      provider: 'mock', base_url: '', api_key_env: 'DSH_AL_MODEL_API_KEY', model: 'mock-1',
      timeout_s: 60, max_retries: 2, max_tokens: 2048, temperature: 0.2,
      rate_limit_per_min: 60, max_cost_usd: 0, price_input_per_1k: 0,
      price_output_per_1k: 0, stages: {},
    },
    learning: {
      default_mode: 'assisted', max_iterations_per_run: 10, max_tasks_per_run: 30,
      max_sources_per_task: 20, max_retries_per_task: 3, max_llm_calls_per_run: 200,
      max_task_seconds: 300, max_run_seconds: 3600, stop_when_no_new_knowledge: true,
      no_progress_rounds: 3, stop_when_budget_exceeded: true, require_source_tracking: true,
      require_verification_status: true, auto_execute_untrusted_code: false,
      auto_install_dependencies: false, auto_modify_other_plugins: false,
      daily_budget_usd: 1.0, max_doc_chars: 400_000, chunk_size: 900,
      chunk_overlap: 120, min_chunk_chars: 40, max_chunks_per_document: 400,
    },
    security: {
      allowed_roots: [], allow_network: false, allowed_domains: [],
      max_download_bytes: 8 * 1024 * 1024, max_output_bytes: 64 * 1024,
      exec_timeout_s: 10, exec_memory_mb: 512,
      exec_sandbox: 'strict', exec_artifact_mb: 16,
      audit_log: true,
      block_secret_patterns: true, delegate_approval_to_host: false,
      allow_private_networks: false, max_redirects: 5,
      allowed_content_types: [
        'text/', 'application/json', 'application/xml',
        'application/xhtml+xml', 'application/pdf',
      ],
    },
    retrieval: {
      top_k: 8, min_score: 0, hybrid: true, vector_weight: 0.65,
      keyword_weight: 0.35, rrf_k: 60, dedupe_similarity: 0.94, conflict_similarity: 0.82,
    },
    scheduler: { enabled: false, tick_interval_s: 300, max_parallel_projects: 1, auto_start: false },
    logging: { level: 'INFO', jsonl: true, file: '' },
  }
}

export const CONFIG_ENV = 'DSH_AL_CONFIG'
export const HOME_ENV = 'DSH_AL_HOME'
export const SETTINGS_FILE_ENV = 'DSH_AL_SETTINGS_FILE'

function configError(message: string): AutolearnError {
  return new AutolearnError(message, { code: ERROR_CODES.CONFIG_INVALID })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

/** 深合并：未知键报错，类型不匹配报错（与 dataclass 语义一致）。 */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, prefix = ''): void {
  for (const [key, value] of Object.entries(source)) {
    const path = `${prefix}${key}`
    if (!(key in target)) throw configError(`未知配置项: ${path}`)
    const current = target[key]
    if (isObject(current)) {
      if (!isObject(value)) throw configError(`配置项 ${path} 需要对象`)
      mergeInto(current, value, `${path}.`)
      continue
    }
    target[key] = value
  }
}

export function projectHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env[ HOME_ENV ]) return resolve(env[HOME_ENV] as string)
  // dist/core/config.js → 引擎根是上上级；源码运行时同理（src/core）
  return resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
}

export function hostSettingsFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[SETTINGS_FILE_ENV] || join(home, 'data', 'settings.json')
}

/** 宿主设置卡（设置卡与引擎共享的唯一真相）。只接受白名单键。 */
export function applyHostSettings(cfg: Config, home: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const file = hostSettingsFile(home, env)
  const applied: Record<string, unknown> = {}
  if (!existsSync(file)) return applied
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return applied
  }
  if (!isObject(raw)) return applied
  const mode = raw.mode
  if (typeof mode === 'string' && ['assisted', 'auto', 'lab'].includes(mode)) {
    cfg.learning.default_mode = mode as LearningConfig['default_mode']
    applied.mode = mode
  }
  const budget = raw.dailyBudgetUsd
  if (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 && budget <= 1000) {
    cfg.learning.daily_budget_usd = budget
    applied.dailyBudgetUsd = budget
  }
  const tasks = raw.maxTasksPerRun
  if (typeof tasks === 'number' && Number.isInteger(tasks) && tasks >= 1 && tasks <= 200) {
    cfg.learning.max_tasks_per_run = tasks
    applied.maxTasksPerRun = tasks
  }
  return applied
}

function applyEnv(cfg: Config, env: NodeJS.ProcessEnv): void {
  const pick = (name: string): string | undefined => {
    const value = env[name]
    return value === undefined || value === '' ? undefined : value
  }
  const mode = pick('DSH_AL_MODE')?.trim().toLowerCase()
  if (mode && ['assisted', 'auto', 'lab'].includes(mode)) cfg.learning.default_mode = mode as LearningConfig['default_mode']
  const provider = pick('DSH_AL_MODEL_PROVIDER')?.trim().toLowerCase()
  if (provider && ['mock', 'openai', 'none'].includes(provider)) cfg.model.provider = provider as ModelConfig['provider']
  const baseUrl = pick('DSH_AL_MODEL_BASE_URL')
  if (baseUrl) cfg.model.base_url = baseUrl.trim()
  const model = pick('DSH_AL_MODEL_NAME')
  if (model) cfg.model.model = model.trim()
  const emb = pick('DSH_AL_EMBEDDING_PROVIDER')?.trim().toLowerCase()
  if (emb === 'hashing' || emb === 'openai') cfg.embedding.provider = emb
  const net = pick('DSH_AL_ALLOW_NETWORK')
  if (net !== undefined) cfg.security.allow_network = ['1', 'true', 'yes', 'on'].includes(net.trim().toLowerCase())
  const hostApproval = pick('DSH_AL_HOST_APPROVAL')
  if (hostApproval !== undefined) {
    cfg.security.delegate_approval_to_host = ['1', 'true', 'yes', 'on'].includes(hostApproval.trim().toLowerCase())
  }
  const level = pick('DSH_AL_LOG_LEVEL')?.trim().toUpperCase()
  if (level && ['DEBUG', 'INFO', 'WARNING', 'ERROR'].includes(level)) cfg.logging.level = level as LoggingConfig['level']
  const dataDir = pick('DSH_AL_DATA_DIR')
  if (dataDir) cfg.paths.data_dir = dataDir.trim()
  const corpus = pick('DSH_AL_CORPUS_DIR')
  if (corpus) cfg.paths.corpus_dir = corpus.trim()
}

export function resolveConfigPaths(paths: PathsConfig, defaultHome: string): PathsConfig {
  const home = paths.home ? resolve(paths.home) : resolve(defaultHome)
  const data = paths.data_dir ? resolve(paths.data_dir) : join(home, 'data')
  const pick = (value: string, fallback: string): string => (value ? resolve(value) : fallback)
  return {
    home,
    data_dir: data,
    documents_dir: pick(paths.documents_dir, join(data, 'documents')),
    processed_dir: pick(paths.processed_dir, join(data, 'processed')),
    experiments_dir: pick(paths.experiments_dir, join(data, 'experiments')),
    reports_dir: pick(paths.reports_dir, join(data, 'reports')),
    db_path: pick(paths.db_path, join(data, 'metadata.sqlite3')),
    index_dir: pick(paths.index_dir, join(data, 'index')),
    corpus_dir: pick(paths.corpus_dir, join(data, 'corpus')),
    log_dir: pick(paths.log_dir, join(data, 'logs')),
  }
}

export function ensurePaths(paths: PathsConfig): void {
  for (const dir of [
    paths.data_dir, paths.documents_dir, paths.processed_dir, paths.experiments_dir,
    paths.reports_dir, paths.index_dir, paths.corpus_dir, paths.log_dir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  mkdirSync(dirname(paths.db_path), { recursive: true })
}

function applyOverrides(cfg: Config, overrides: Record<string, unknown>): void {
  mergeInto(cfg as unknown as Record<string, unknown>, overrides)
}

export function validateConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (!['hashing', 'openai'].includes(cfg.embedding.provider)) {
    throw configError(`embedding.provider 不支持: ${cfg.embedding.provider}`)
  }
  if (cfg.embedding.provider === 'hashing' && (cfg.embedding.dim < 64 || cfg.embedding.dim > 8192)) {
    throw configError('embedding.dim 必须在 64..8192 之间')
  }
  if (cfg.embedding.provider === 'openai' && !cfg.embedding.base_url) {
    throw configError('embedding.provider=openai 时必须配置 base_url')
  }
  if (cfg.embedding.timeout_s <= 0) throw configError('embedding.timeout_s 必须为正数')

  if (!['mock', 'openai', 'none'].includes(cfg.model.provider)) {
    throw configError(`model.provider 不支持: ${cfg.model.provider}`)
  }
  if (cfg.model.provider === 'openai') {
    if (!cfg.model.base_url) throw configError('model.provider=openai 时必须配置 base_url')
    if (!env[cfg.model.api_key_env]) {
      throw configError(`model.provider=openai 但环境变量 ${cfg.model.api_key_env} 未设置（密钥不得写入配置）`)
    }
  }
  if (cfg.model.timeout_s <= 0 || cfg.model.max_tokens <= 0) {
    throw configError('model.timeout_s / max_tokens 必须为正数')
  }
  if (cfg.model.max_retries < 0) throw configError('model.max_retries 不能为负')

  if (!['assisted', 'auto', 'lab'].includes(cfg.learning.default_mode)) {
    throw configError('learning.default_mode 必须是 assisted/auto/lab')
  }
  for (const key of [
    'max_iterations_per_run', 'max_tasks_per_run', 'max_sources_per_task',
    'max_llm_calls_per_run', 'chunk_size', 'max_doc_chars',
  ] as const) {
    if (!Number.isInteger(cfg.learning[key]) || cfg.learning[key] <= 0) {
      throw configError(`learning.${key} 必须为正整数`)
    }
  }
  if (cfg.learning.chunk_overlap >= cfg.learning.chunk_size) {
    throw configError('learning.chunk_overlap 必须小于 chunk_size')
  }
  if (cfg.security.exec_timeout_s <= 0) throw configError('security.exec_timeout_s 必须为正数')
  if (!['strict', 'process'].includes(cfg.security.exec_sandbox)) {
    throw configError('security.exec_sandbox 必须是 strict 或 process')
  }
  if (!Number.isFinite(cfg.security.exec_artifact_mb) || cfg.security.exec_artifact_mb <= 0) {
    throw configError('security.exec_artifact_mb 必须为正数')
  }
  if (cfg.security.max_redirects < 0 || cfg.security.max_redirects > 20) {
    throw configError('security.max_redirects 必须在 0..20 之间')
  }
  if (!['DEBUG', 'INFO', 'WARNING', 'ERROR'].includes(cfg.logging.level)) {
    throw configError('logging.level 非法')
  }
  if (!Number.isInteger(cfg.retrieval.top_k) || cfg.retrieval.top_k <= 0) {
    throw configError('retrieval.top_k 必须为正整数')
  }
}

export interface LoadConfigOptions {
  path?: string
  home?: string
  overrides?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env
  const cfg = defaults()

  let candidate = options.path ?? env[CONFIG_ENV]
  if (!candidate) {
    const home = options.home ?? projectHome(env)
    for (const name of ['config.json', 'config.yaml', 'config.yml']) {
      const file = join(home, name)
      if (existsSync(file)) {
        candidate = file
        break
      }
    }
  }
  if (candidate) {
    if (!existsSync(candidate)) throw configError(`配置文件不存在: ${candidate}`)
    if (/\.ya?ml$/i.test(candidate)) {
      throw configError('YAML 配置已不再支持：请转换为 JSON（重构后移除了 PyYAML 依赖）')
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(candidate, 'utf8') || '{}')
    } catch (error) {
      throw configError(`配置文件不是合法 JSON: ${candidate}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (!isObject(raw)) throw configError('配置文件根节点必须是对象')
    applyOverrides(cfg, raw)
  }

  const baseHome = options.home ? resolve(options.home) : projectHome(env)
  applyHostSettings(cfg, baseHome, env)
  applyEnv(cfg, env)
  if (options.overrides) applyOverrides(cfg, options.overrides)

  cfg.paths = resolveConfigPaths(cfg.paths, baseHome)
  validateConfig(cfg, env)
  if (!isAbsolute(cfg.paths.home)) throw configError('paths.home 必须是绝对路径')
  return cfg
}

export function configToDict(cfg: Config): Record<string, unknown> {
  // 显式重建，避免把内部可变引用暴露出去；密钥从不在配置里。
  return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>
}

export function saveConfig(cfg: Config, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(configToDict(cfg), null, 2)}\n`, 'utf8')
}
