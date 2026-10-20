/**
 * 来源元数据：类型判定、质量先验、时效、许可（数值与 v1.2 完全一致）。
 * 这些是「可解释」评分：每个分数都带 basis，而不是模型拍脑袋。
 */
import { resolve } from 'node:path'
import { round } from '../../core/ids.ts'
import { LicenseStatus, SourceType, type FreshnessStatus } from '../../core/types.ts'

export const OFFICIAL_DOMAINS = new Set([
  'developer.android.com', 'developer.mozilla.org', 'docs.python.org', 'doc.rust-lang.org',
  'kotlinlang.org', 'www.w3.org', 'w3.org', 'www.ietf.org', 'ietf.org',
  'www.iso.org', 'iso.org', 'docs.oracle.com', 'learn.microsoft.com',
  'www.rfc-editor.org', 'arxiv.org', 'dl.acm.org', 'ieeexplore.ieee.org',
  'www.nature.com', 'www.sciencedirect.com', 'pubmed.ncbi.nlm.nih.gov',
  'github.com', 'gitlab.com', 'www.material.io', 'm3.material.io', 'm2.material.io',
  'www.nngroup.com', 'www.w3.org/WAI',
])

const STANDARD_HINTS = ['rfc', 'iso', 'iec', 'ieee', 'gb/t', 'gb ', 'standard', 'specification']

export const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.rst', '.txt', '.pdf', '.docx', '.html', '.htm', '.ipynb'])

export const CODE_EXTENSIONS = new Set([
  '.py', '.rs', '.kt', '.java', '.ts', '.tsx', '.js', '.jsx', '.go', '.c', '.cpp',
  '.h', '.cs', '.rb', '.php', '.sh', '.sql',
])

const LICENSE_BY_DOMAIN: Record<string, readonly [string, string]> = {
  'developer.mozilla.org': [LicenseStatus.PERMITTED, 'MDN 内容采用 CC-BY-SA 2.5'],
  'docs.python.org': [LicenseStatus.PERMITTED, 'Python 文档许可（PSF）'],
  'developer.android.com': [LicenseStatus.PERMITTED, 'Android 文档 CC-BY 4.0'],
  'doc.rust-lang.org': [LicenseStatus.PERMITTED, 'Rust 文档 MIT/Apache-2.0 双许可'],
  'www.w3.org': [LicenseStatus.PERMITTED, 'W3C 文档许可'],
  'wikipedia.org': [LicenseStatus.PERMITTED, 'CC-BY-SA'],
  'zh.wikipedia.org': [LicenseStatus.PERMITTED, 'CC-BY-SA'],
  'arxiv.org': [LicenseStatus.RESTRICTED, '作者保留部分权利，需逐篇确认'],
}

export const FRESHNESS_HALF_LIFE_DAYS: Record<string, number> = {
  official_doc: 730, standard: 1825, paper: 3650, tech_doc: 540, code_repo: 365,
  web_page: 365, local_file: 730, user_note: 365, experiment: 3650, unknown: 365,
}

export const QUALITY_PRIOR: Record<string, number> = {
  official_doc: 0.9, standard: 0.92, paper: 0.85, tech_doc: 0.75, code_repo: 0.7,
  web_page: 0.5, local_file: 0.6, user_note: 0.45, experiment: 0.65, unknown: 0.35,
}

const PAYWALL_BLACKLIST = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'weibo.com', 'zhihu.com/people', 'patreon.com', 'udemy.com',
]

export function hostOf(location: string): string {
  try {
    const url = new URL(location)
    return url.hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function suffixOf(location: string): string {
  const base = (location ?? '').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function classifySource(location: string, options: { docType?: string; title?: string } = {}): SourceType {
  const loc = (location ?? '').toLowerCase()
  const host = hostOf(loc)
  const suffix = suffixOf(loc)
  const title = (options.title ?? '').toLowerCase()

  if (['github.com', 'gitlab.com'].includes(host) || loc.includes('/repos/') || loc.endsWith('.git')) {
    return SourceType.CODE_REPO
  }
  if (['arxiv.org', 'dl.acm.org', 'ieee', 'nature.com', 'sciencedirect', 'pubmed'].some((part) => host.includes(part))) {
    return SourceType.PAPER
  }
  if (STANDARD_HINTS.some((token) => title.includes(token)) || ['www.w3.org', 'w3.org', 'www.iso.org', 'iso.org', 'www.rfc-editor.org'].includes(host)) {
    return SourceType.STANDARD
  }
  if (OFFICIAL_DOMAINS.has(host)) return SourceType.OFFICIAL_DOC
  if (options.docType === 'pdf') return SourceType.PAPER
  if (CODE_EXTENSIONS.has(suffix)) return SourceType.CODE_REPO
  if (DOC_EXTENSIONS.has(suffix) && !host) return SourceType.LOCAL_FILE
  if (host) return SourceType.WEB_PAGE
  if (location) return SourceType.LOCAL_FILE
  return SourceType.UNKNOWN
}

export function sourceQuality(
  sourceType: string,
  location = '',
  publisher = '',
): { quality: number; basis: string } {
  let base = QUALITY_PRIOR[sourceType] ?? 0.4
  const host = hostOf(location)
  const basis = [`来源类型=${sourceType}`]
  if (host) {
    basis.push(`域名=${host}`)
    if (OFFICIAL_DOMAINS.has(host)) {
      base = Math.min(1, base + 0.05)
      basis.push('命中官方/权威域名白名单 +0.05')
    }
    if (host.endsWith('.edu') || host.endsWith('.gov') || host.endsWith('.ac.cn')) {
      base = Math.min(1, base + 0.03)
      basis.push('教育/政府域名 +0.03')
    }
  }
  if (publisher) basis.push(`发布机构=${publisher}`)
  if (!host && location) basis.push('本地文件，质量取决于原始出处')
  return { quality: round(Math.min(1, base), 3), basis: basis.join('；') }
}

export function guessLicense(location: string, sourceType = ''): { status: string; note: string } {
  const host = hostOf(location).replace(/^www\./, '')
  for (const [domain, [status, note]] of Object.entries(LICENSE_BY_DOMAIN)) {
    const normalized = domain.replace(/^www\./, '')
    if (host === normalized || host.endsWith(`.${normalized}`)) return { status, note }
  }
  if (!host) return { status: LicenseStatus.UNKNOWN, note: '本地文件：许可未知，需人工确认来源与授权' }
  if (sourceType === SourceType.PAPER || sourceType === SourceType.WEB_PAGE) {
    return { status: LicenseStatus.UNKNOWN, note: '网页/论文：未自动判定许可，转载或商用前需确认' }
  }
  if (sourceType === SourceType.CODE_REPO) {
    return { status: LicenseStatus.UNKNOWN, note: '代码仓库：需检查仓库 LICENSE 文件' }
  }
  return { status: LicenseStatus.UNKNOWN, note: '未判定' }
}

/** 日期解析：6 种格式，无时区按 UTC；失败返回 null（不猜）。 */
export function parseDate(value: string): Date | null {
  const text = (value ?? '').trim()
  if (!text) return null
  const normalized = text.replace(/Z$/i, '+00:00').replace(/年|月/g, '-').replace(/日/g, '')
  const direct = new Date(normalized)
  if (!Number.isNaN(direct.getTime())) return direct
  const dateOnly = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(normalized)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  }
  return null
}

export function checkFreshness(
  publishedAt: string,
  sourceType: string,
  now = new Date(),
): { status: FreshnessStatus; basis: string } {
  const halfLife = FRESHNESS_HALF_LIFE_DAYS[sourceType] ?? 365
  const published = parseDate(publishedAt)
  if (!published) return { status: 'unknown', basis: '未提供发布时间，无法判定时效' }
  const ageDays = Math.floor((now.getTime() - published.getTime()) / 86_400_000)
  if (ageDays < 0) return { status: 'unknown', basis: '发布时间晚于当前时间，数据可能有误' }
  if (ageDays <= halfLife * 0.5) return { status: 'fresh', basis: `年龄 ${ageDays} 天 ≤ 半衰期一半（${halfLife} 天）` }
  if (ageDays <= halfLife) return { status: 'aging', basis: `年龄 ${ageDays} 天 ≤ 半衰期（${halfLife} 天）` }
  if (ageDays <= halfLife * 2) return { status: 'stale', basis: `年龄 ${ageDays} 天 > 半衰期（${halfLife} 天），建议核验更新版本` }
  return { status: 'expired', basis: `年龄 ${ageDays} 天 > 两倍半衰期（${halfLife * 2} 天），很可能已过时` }
}

/** 付费墙/登录墙站点不做抓取（不绕过访问控制）。 */
export function isPaywalledOrLogin(location: string): boolean {
  const host = hostOf(location)
  if (!host) return false
  return PAYWALL_BLACKLIST.some((entry) => host.endsWith(entry) || host.includes(entry))
}

/** 去重用的位置归一：去掉跟踪参数、去 fragment、去尾斜杠。 */
export function normalizeLocation(location: string): string {
  const raw = (location ?? '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return resolve(raw)
  try {
    const url = new URL(raw)
    const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from', 'fr', 'ref', 'fbclid', 'gclid']
    for (const key of tracking) url.searchParams.delete(key)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    url.protocol = url.protocol.toLowerCase()
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    url.search = ''
    for (const [key, value] of params) url.searchParams.append(key, value)
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return raw
  }
}

/** 来源描述：类型 + 质量 + 许可 + 时效（一处组装，避免调用方各写一遍）。 */
export function describeSource(location: string, options: { title?: string; publisher?: string; docType?: string; publishedAt?: string } = {}): Record<string, unknown> {
  const sourceType = classifySource(location, { docType: options.docType, title: options.title })
  const quality = sourceQuality(sourceType, location, options.publisher)
  const license = guessLicense(location, sourceType)
  const freshness = checkFreshness(options.publishedAt ?? '', sourceType)
  return {
    location,
    source_type: sourceType,
    quality: quality.quality,
    quality_basis: quality.basis,
    license_status: license.status,
    license_note: license.note,
    freshness_status: freshness.status,
    freshness_basis: freshness.basis,
    paywalled: isPaywalledOrLogin(location),
  }
}

export function describeSourceType(): Array<Record<string, unknown>> {
  return Object.values(SourceType).map((type) => ({
    source_type: type,
    quality_prior: QUALITY_PRIOR[type] ?? 0.4,
    half_life_days: FRESHNESS_HALF_LIFE_DAYS[type] ?? 365,
  }))
}
