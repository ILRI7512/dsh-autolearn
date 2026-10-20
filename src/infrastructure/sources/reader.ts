/**
 * 资料读取：本地文件 + 受策略保护的 HTTP。
 *
 * 失败一律返回结构化结果（不把网络/权限错误包装成「空内容」）：
 * ok=false + error 明确写原因，调用方据此决定跳过、告警或阻塞。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { AutolearnError } from '../../core/errors.ts'
import { utcnowIso } from '../../core/ids.ts'
import type { PathPolicy } from '../../security/paths.ts'
import { fetchText, type NetworkPolicyOptions } from '../../security/network.ts'
import {
  classifySource, checkFreshness, describeSource, guessLicense, hostOf,
  isPaywalledOrLogin, sourceQuality,
} from './metadata.ts'
import { detectLanguage, docTypeOf, parseDocument, type DocType } from './parser.ts'

export interface ReadResult {
  ok: boolean
  location: string
  text: string
  title: string
  doc_type: string
  source_type: string
  quality: number
  quality_basis: string
  license_status: string
  license_note: string
  freshness_status: string
  freshness_basis: string
  published_at: string
  accessed_at: string
  content_hash: string
  bytes: number
  char_count: number
  language: string
  parser: string
  metadata: Record<string, unknown>
  preview: string
  error: string
  not_modified: boolean
}

export interface ReaderOptions {
  pathPolicy: PathPolicy
  network: NetworkPolicyOptions
  maxBytes: number
  maxChars: number
  allowNetwork: boolean
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.xml',
])

function emptyResult(location: string): ReadResult {
  return {
    ok: false, location, text: '', title: '', doc_type: 'text', source_type: 'unknown',
    quality: 0.4, quality_basis: '', license_status: 'unknown', license_note: '',
    freshness_status: 'unknown', freshness_basis: '', published_at: '', accessed_at: utcnowIso(),
    content_hash: '', bytes: 0, char_count: 0, language: 'unknown', parser: '',
    metadata: {}, preview: '', error: '', not_modified: false,
  }
}

export class SourceReader {
  private readonly options: ReaderOptions

  constructor(options: ReaderOptions) {
    this.options = options
  }

  async read(location: string, previousMeta: Record<string, unknown> = {}): Promise<ReadResult> {
    const raw = (location ?? '').trim()
    if (!raw) return this.fail('', 'location 不能为空')
    if (/^https?:\/\//i.test(raw)) return this.readHttp(raw, previousMeta)
    return this.readLocal(raw)
  }

  private fail(location: string, message: string): ReadResult {
    const result = emptyResult(location)
    result.error = message
    return result
  }

  readLocal(location: string): ReadResult {
    const path = this.options.pathPolicy.resolveTarget(location)
    if (!existsSync(path)) return this.fail(location, `文件不存在: ${location}`)
    let stat
    try {
      stat = statSync(path)
    } catch (error) {
      return this.fail(location, `无法读取文件状态: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (stat.isDirectory()) return this.fail(location, '这是一个目录；请用 discover_sources 扫描目录')
    if (stat.size > this.options.maxBytes) {
      return this.fail(location, `文件大小 ${stat.size} 超过上限 ${this.options.maxBytes} 字节`)
    }
    const suffix = extname(path).toLowerCase()
    if (!TEXT_EXTENSIONS.has(suffix) && docTypeOf(path) === 'text' && suffix !== '') {
      return this.fail(location, `不支持的扩展名 ${suffix}；可转换为 .md/.txt/.html 后再导入`)
    }
    let buffer: Buffer
    try {
      buffer = readFileSync(path)
    } catch (error) {
      return this.fail(location, `读取失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    const decoded = decodeText(buffer)
    const docType = (TEXT_EXTENSIONS.has(suffix) ? 'text' : docTypeOf(path)) as DocType
    let parsed: { text: string; title: string; parser: string }
    try {
      parsed = parseDocument(decoded, docType)
    } catch (error) {
      return this.fail(location, error instanceof Error ? error.message : String(error))
    }
    const text = parsed.text.trim()
    if (!text) return this.fail(location, '解析结果为空：文件可能是扫描件或加密文档')
    const title = parsed.title || markdownTitle(text) || basename(path, extname(path))
    return this.finish(location, text, {
      title, docType, parser: parsed.parser, bytes: stat.size,
      metadata: { path, encoding: decoded.startsWith('\uFEFF') ? 'utf-8-sig' : 'utf-8' },
    })
  }

  private async readHttp(location: string, previousMeta: Record<string, unknown>): Promise<ReadResult> {
    if (!this.options.allowNetwork) {
      return this.fail(location, '未开启 security.allow_network，外部网络访问被拒绝')
    }
    if (isPaywalledOrLogin(location)) {
      return this.fail(location, '该站点需要登录或有付费墙，插件不绕过访问控制；请改用手边可合法获取的资料')
    }
    const headers: Record<string, string> = {}
    const etag = String(previousMeta.etag ?? '')
    const lastModified = String(previousMeta.last_modified ?? '')
    if (etag) headers['if-none-match'] = etag
    if (lastModified) headers['if-modified-since'] = lastModified
    try {
      const response = await fetchText(location, this.options.network, headers)
      if (response.notModified) {
        const result = emptyResult(location)
        result.not_modified = true
        result.ok = false
        result.error = '内容未修改（304）'
        result.source_type = classifySource(location)
        return result
      }
      const contentType = response.contentType.toLowerCase()
      const looksHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(response.body)
      const docType: DocType = looksHtml ? 'html' : 'text'
      const parsed = parseDocument(response.body, docType)
      const text = parsed.text.trim()
      if (!text) return this.fail(location, '解析结果为空（页面可能由脚本动态渲染）')
      const title = parsed.title || markdownTitle(text) || text.split('\n', 1)[0]?.slice(0, 120) || hostOf(location)
      return this.finish(location, text, {
        title, docType, parser: parsed.parser, bytes: response.bytes,
        metadata: {
          requested_url: location,
          final_url: response.finalUrl,
          etag: String(response.headers.etag ?? ''),
          last_modified: String(response.headers['last-modified'] ?? ''),
          content_type: response.contentType,
          redirects: response.redirects,
        },
      })
    } catch (error) {
      const message = error instanceof AutolearnError ? error.message : error instanceof Error ? error.message : String(error)
      return this.fail(location, message)
    }
  }

  private finish(
    location: string,
    text: string,
    extra: { title: string; docType: DocType; parser: string; bytes: number; metadata: Record<string, unknown> },
  ): ReadResult {
    const sourceType = classifySource(location, { docType: extra.docType, title: extra.title })
    const quality = sourceQuality(sourceType, location)
    const license = guessLicense(location, sourceType)
    const freshness = checkFreshness('', sourceType)
    const content = text.slice(0, this.options.maxChars)
    return {
      ok: true,
      location,
      text: content,
      title: extra.title,
      doc_type: extra.docType,
      source_type: sourceType,
      quality: quality.quality,
      quality_basis: quality.basis,
      license_status: license.status,
      license_note: license.note,
      freshness_status: freshness.status,
      freshness_basis: freshness.basis,
      published_at: '',
      accessed_at: utcnowIso(),
      content_hash: createHash('sha256').update(content.trim(), 'utf8').digest('hex'),
      bytes: extra.bytes,
      char_count: content.length,
      language: detectLanguage(content),
      parser: extra.parser,
      metadata: { ...extra.metadata, source_type: sourceType },
      preview: content.slice(0, 300),
      error: '',
      not_modified: false,
    }
  }

  /** 只做元数据研判，不读取正文（用于发现阶段）。 */
  describe(location: string): Record<string, unknown> {
    return describeSource(location)
  }
}

function decodeText(buffer: Buffer): string {
  for (const encoding of ['utf-8', 'gb18030', 'utf-16le'] as const) {
    try {
      return new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(buffer)
    } catch {
      continue
    }
  }
  return new TextDecoder('utf-8').decode(buffer)
}

function markdownTitle(text: string): string {
  const match = /^\s*#\s+(.+)$/m.exec(text)
  return match?.[1]?.trim() ?? ''
}
